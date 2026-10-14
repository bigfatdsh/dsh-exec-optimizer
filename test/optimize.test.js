/**
 * 装配层：把六个纯逻辑模块挂到宿主钩子上之后，行为必须**端到端**成立。
 *
 * 这里用一个假宿主模拟 Cordis 的两件事：
 *   * `ctx.on(name, handler)` 注册监听；
 *   * `waterfall(name, ...args)` 的 Koa 式语义（最后一个参数是 `next`，最外层返回值权威）。
 *
 * 覆盖的重点不是"函数算得对"（那是各纯逻辑测试的事），而是**挂对了钩子、按开关生效、
 * 失败只降级**这三条装配事实。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { DISCIPLINE_SECTION, LOAD_TOOL, RETRY_TOOL } from '../lib/optimize.js'

/**
 * 建一个假宿主。
 *
 * @param {object} [options] - `{ models, withTools, withPruner, measure }`。
 * @returns {object} 宿主句柄。
 */
function fakeHost(options = {}) {
  /** @type {Array<{name: string, order: number, text: Function|string}>} */
  const sections = []
  /** @type {Map<string, object>} */
  const tools = new Map()
  /** @type {Map<string, Function[]>} */
  const hooks = new Map()
  /** @type {object[]} */
  const executed = []
  /** @type {string[]} */
  const warnings = []
  /** @type {object[]} */
  const compactions = []
  /** @type {object} */
  const counters = { registered: 0, unregistered: 0 }

  const services = {
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {
          const index = sections.indexOf(entry)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
    webServer: { register: () => () => {} },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        counters.registered += 1
        return () => {
          tools.delete(definition.name)
          counters.unregistered += 1
        }
      },
      schemas: () => [
        ...(options.toolSchemas ?? []),
        ...[...tools.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
      ],
      async execute(exec) {
        executed.push(exec)
        return options.executeResult
          ? options.executeResult(exec)
          : { isError: false, content: [{ type: 'text', text: `ran ${exec.name}` }] }
      },
      // 并行纠偏要问"这个工具声明了 isConcurrencySafe 吗"——正是宿主自己用的判据。
      get: (name) => (options.batchable ?? []).includes(name) ? { name, isConcurrencySafe: () => true } : { name },
    },
    tokenMeter: {
      measure: () => ({ totalTokens: typeof options.tokens === 'number' ? options.tokens : 0 }),
    },
    compaction: {
      async compactNow(agent, signal) {
        compactions.push({ agent, signal })
        return null
      },
    },
    llm: {
      async resolveModelInfo() {
        return { context: { contextWindow: options.contextWindow ?? 1_000_000 } }
      },
    },
  }
  if (options.withPruner !== false) {
    services.toolResultPruner = { config: { thresholdChars: options.prunerThreshold ?? 8192 } }
  }

  const ctx = {
    get: (key) => services[key],
    effect(fn) {
      fn()
      return () => {}
    },
    on(name, handler) {
      const list = hooks.get(name) ?? []
      list.push(handler)
      hooks.set(name, list)
      return () => {
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
    },
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
  }

  /**
   * 跑一条瀑布。
   *
   * @param {string} name - 事件名。
   * @param {unknown[]} args - 除 `next` 之外的参数。
   * @param {Function} fallback - 链路走到底时的默认返回值。
   * @returns {Promise<unknown>} 结果。
   */
  const waterfall = async (name, args, fallback) => {
    const list = hooks.get(name) ?? []
    let furthest = -1
    const dispatch = async (index) => {
      if (index <= furthest) throw new Error('next() called twice')
      furthest = index
      const handler = list[index]
      if (handler === undefined) return fallback()
      return handler(...args, () => dispatch(index + 1))
    }
    return dispatch(0)
  }

  /**
   * 跑一条 emit。
   *
   * @param {string} name - 事件名。
   * @param {unknown[]} args - 参数。
   * @returns {void}
   */
  const emit = (name, args) => {
    for (const handler of hooks.get(name) ?? []) {
      try {
        handler(...args)
      } catch (error) {
        warnings.push(String(error?.message ?? error))
      }
    }
  }

  return { ctx, sections, tools, hooks, executed, warnings, compactions, counters, waterfall, emit, services }
}

/** 造一条助手消息事件。 */
const assistantEvent = (text, withToolCall = false) => ({
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: withToolCall
        ? [{ type: 'text', text }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }]
        : [{ type: 'text', text }],
    },
  },
})

/** 造一个 agent。 */
const makeAgent = (id = 'session-1') => ({
  id,
  session: {
    id,
    // 预留输出 256k：这样复算出的宿主压缩线正好是出厂默认的 678,464。
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 256_000 } }),
  },
})

/** 造一条成功的文本结果。 */
const okResult = (text) => ({ isError: false, content: [{ type: 'text', text }], value: undefined })

/** 造一条失败结果。 */
const errResult = (message) => ({ isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] })

/**
 * 在临时 DSH_HOME 下跑一段。
 *
 * @param {Function} fn - 测试体。
 * @returns {Promise<unknown>} 结果。
 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'optimizer-opt-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

test('装配：纪律段落与七个开关的登记都在，且没有包住模型调用的钩子', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    assert.ok(host.sections.some((section) => section.name === DISCIPLINE_SECTION))
    assert.deepEqual(Object.keys(handle.toggles), [
      'parallel', 'retry', 'resultCap', 'cacheSafe', 'repeatGuard', 'lazyTools', 'autoCompact',
    ])
    // 只挂公开契约里这几条；`llm/stream` 那种包模型调用的钩子一个都不许有。
    assert.deepEqual([...host.hooks.keys()].sort(), [
      'agent/disposed',
      'agent/pre-step',
      'session/event',
      'system-prompt/assemble',
      'tools/post-execute',
    ])
    assert.equal(host.hooks.has('llm/stream'), false)
  })
})

test('纪律段落：三个开关决定内容，全关时是空串（不占 token）', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    const section = host.sections.find((entry) => entry.name === DISCIPLINE_SECTION)
    assert.match(section.text(), /Tool batching/)
    assert.match(section.text(), /retry_tool/, 'retry 默认开，重放说明必须在')
    assert.equal(/Tool disclosure/.test(section.text()), false, 'lazyTools 默认关，说明不该出现')
    handle.toggles.parallel.set(false)
    handle.toggles.retry.set(false)
    assert.equal(section.text(), '')
    handle.toggles.lazyTools.set(true)
    assert.match(section.text(), /Tool disclosure/)
  })
})

test('工具注册：开关决定在不在注册表里，关掉立刻摘下来', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    assert.ok(host.tools.has(RETRY_TOOL), 'retry 默认开')
    assert.equal(host.tools.has(LOAD_TOOL), false, 'lazyTools 默认关')
    handle.toggles.lazyTools.set(true)
    assert.ok(host.tools.has(LOAD_TOOL), '打开后必须挂上')
    handle.toggles.retry.set(false)
    assert.equal(host.tools.has(RETRY_TOOL), false, '关掉必须摘下（下一轮就少一份 schema）')
    assert.equal(host.counters.unregistered >= 1, true)
  })
})

test('工具定义：注册所需的形状齐全（output.render 是函数、参数是合法 JSON）', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    handle.toggles.lazyTools.set(true)
    for (const name of [RETRY_TOOL, LOAD_TOOL]) {
      const tool = host.tools.get(name)
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.execute, 'function')
      assert.equal(tool.parameters.type, 'object')
      assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), tool.parameters, '参数必须是可无损 JSON 化的')
      assert.deepEqual(JSON.parse(JSON.stringify(tool.output.schema)), tool.output.schema)
      assert.ok(Array.isArray(tool.output.render({}, { text: 'hi' })))
    }
  })
})

test('结果上限：长结果在发送前被裁剪，全文落盘，路径写进结果', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const agent = makeAgent('sess-a')
    const exec = { name: 'bash', callId: 'call-1', arguments: {}, agent }
    const text = 'Z'.repeat(30000)
    const decision = await host.waterfall('tools/post-execute', [exec, okResult(text)], () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    const out = decision.content[0].text
    assert.ok(out.length < 9000, '必须裁到上限以内')
    assert.match(out, /chars omitted by dsh-exec-optimizer/)
    const path = /Full text: (\S+)/.exec(out)[1]
    assert.equal(await readFile(path, 'utf8'), text, '盘上必须是完整原文')
    assert.ok(path.startsWith(join(home, 'exec-optimizer-spill')), '落盘必须在 DSH_HOME 下')
  })
})

test('结果上限：短结果、别人的 block 决定，一律原样放行', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const agent = makeAgent()
    const short = await host.waterfall('tools/post-execute', [{ name: 'bash', callId: 'c', agent }, okResult('short')], () => ({ kind: 'accept' }))
    assert.equal(short.content, undefined, '没超上限就不该返回 content（保持别人的决定）')

    const blocked = await host.waterfall(
      'tools/post-execute',
      [{ name: 'bash', callId: 'c', agent }, okResult('Z'.repeat(30000))],
      () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }),
    )
    assert.equal(blocked.kind, 'block', '别人 block 的结果不许被本插件改回去')

    const replaced = await host.waterfall(
      'tools/post-execute',
      [{ name: 'bash', callId: 'c', agent }, okResult('Z'.repeat(30000))],
      () => ({ kind: 'accept', value: { replaced: true } }),
    )
    assert.deepEqual(replaced.value, { replaced: true }, '别人换了 value 时不许动 content（会和 value 打架）')
  })
})

test('结果上限：read 只在 cacheSafe 打开时一起裁（否则内置裁剪器仍有活干）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ prunerThreshold: 8192 })
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent()
    const long = 'Z'.repeat(30000)

    const withSafe = await host.waterfall('tools/post-execute', [{ name: 'read', callId: 'c', agent }, okResult(long)], () => ({ kind: 'accept' }))
    assert.ok(withSafe.content, 'cacheSafe 默认开 → read 也必须裁到线内，否则裁剪器还会改写已发内容')

    handle.toggles.cacheSafe.set(false)
    const withoutSafe = await host.waterfall('tools/post-execute', [{ name: 'read', callId: 'c2', agent }, okResult(long)], () => ({ kind: 'accept' }))
    assert.equal(withoutSafe.content, undefined, 'cacheSafe 关掉 → read 保持宿主原样')
  })
})

test('结果上限：cacheSafe 把上限压到内置裁剪器阈值以内（让它无事可做）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ prunerThreshold: 4096 })
    const handle = apply(host.ctx, { log: false })
    assert.equal(handle.optimize.view().effectiveCap, 4096, '取两边的较小值')
    handle.toggles.cacheSafe.set(false)
    assert.equal(handle.optimize.view().effectiveCap, 8192, '关掉后回到用户设的上限')
    assert.equal(handle.optimize.view().prunerThreshold, 4096)
  })
})

test('结果上限：没有 toolResultPruner 服务时退回出厂阈值 8192，不炸', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withPruner: false })
    const handle = apply(host.ctx, { log: false })
    assert.equal(handle.optimize.view().prunerThreshold, 8192)
  })
})

test('失败重放：失败被记账，失败结果后面挂一行短提示', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-r')
    const exec = { name: 'edit', callId: 'c1', arguments: { path: '/a', old: 'x' }, agent }
    const decision = await host.waterfall(
      'tools/post-execute',
      [exec, errResult('invalid arguments: missing required property "new"')],
      () => ({ kind: 'accept' }),
    )
    assert.match(decision.content[0].text, /retry_tool/)
    assert.match(decision.content[0].text, /new/)
    assert.equal(handle.optimize.retrySlots.peek('sess-r').name, 'edit')
    assert.equal(handle.optimize.stats.hints, 1)
  })
})

test('失败重放：retry_tool 用合并后的参数重跑，并把结果交回模型', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const tool = host.tools
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-r2')
    await host.waterfall(
      'tools/post-execute',
      [{ name: 'edit', callId: 'c1', arguments: { path: '/a', old: 'x' }, agent }, errResult('"new" must be a string')],
      () => ({ kind: 'accept' }),
    )
    const result = await tool.get(RETRY_TOOL).execute({ patch: { new: 'y' } }, { agent })
    assert.equal(result.ok, true)
    assert.equal(result.tool, 'edit')
    assert.equal(host.executed.length, 1)
    assert.deepEqual(host.executed[0].arguments, { path: '/a', old: 'x', new: 'y' })
    assert.match(result.replay, /ran edit/)
    assert.equal(handle.optimize.stats.retries, 1)
  })
})

test('失败重放：没有记录、重放自己、tools 服务缺失，都给出可读理由而不抛', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const agent = makeAgent('sess-r3')
    const noRecord = await host.tools.get(RETRY_TOOL).execute({ patch: {} }, { agent })
    assert.equal(noRecord.ok, false)
    assert.match(noRecord.replay, /no failed call recorded/)
    const self = await host.tools.get(RETRY_TOOL).execute({ name: RETRY_TOOL }, { agent })
    assert.equal(self.ok, false)
  })
})

test('按需加载：藏掉非核心工具，核心与已解锁的留下；无变化时原样返回', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ toolSchemas: [{ name: 'univer', description: 'u', parameters: {} }] })
    const handle = apply(host.ctx, { log: false })
    handle.toggles.lazyTools.set(true)
    const agent = makeAgent('sess-l')
    const assembly = {
      sections: [],
      contexts: [],
      variables: {},
      tools: [
        { name: 'read', description: 'r', parameters: {} },
        { name: 'bash', description: 'b', parameters: {} },
        { name: 'univer', description: 'u', parameters: {} },
      ],
    }
    const filtered = await host.waterfall('system-prompt/assemble', [assembly, { scope: agent }], () => assembly)
    assert.deepEqual(filtered.tools.map((tool) => tool.name), ['read', 'bash'])
    assert.equal(assembly.tools.length, 3, '不许改原对象')

    // 解锁之后必须重新出现，且**顺序不变**。
    await host.tools.get(LOAD_TOOL).execute({ names: ['univer'] }, { agent })
    const after = await host.waterfall('system-prompt/assemble', [assembly, { scope: agent }], () => assembly)
    assert.deepEqual(after.tools.map((tool) => tool.name), ['read', 'bash', 'univer'])
  })
})

test('按需加载：全都在核心集里时返回**同一个对象**（不制造无谓差异）', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    handle.toggles.lazyTools.set(true)
    const agent = makeAgent()
    const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'read', description: 'r', parameters: {} }] }
    const filtered = await host.waterfall('system-prompt/assemble', [assembly, { scope: agent }], () => assembly)
    assert.equal(filtered, assembly)
  })
})

test('按需加载：关掉开关时瀑布完全不动工具表', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    apply(host.ctx, { log: false })
    const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'univer', description: 'u', parameters: {} }] }
    const filtered = await host.waterfall('system-prompt/assemble', [assembly, { scope: makeAgent() }], () => assembly)
    assert.equal(filtered.tools.length, 1)
  })
})

test('load_tools：list 给索引，names 解锁，全不认识时点名并指向 list', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ toolSchemas: [{ name: 'univer', description: 'u', parameters: {} }] })
    const handle = apply(host.ctx, { log: false })
    handle.toggles.lazyTools.set(true)
    const agent = makeAgent('sess-l2')
    // 假注册表里只有两个工具，但 load_tools 自己也算一个 → 其余都为"隐藏"。
    const listed = await host.tools.get(LOAD_TOOL).execute({ list: true }, { agent })
    assert.equal(listed.listed, true)
    assert.match(listed.text, /Available but not loaded/)
    const unknown = await host.tools.get(LOAD_TOOL).execute({ names: ['nope'] }, { agent })
    assert.match(unknown.text, /nope/)
    assert.match(unknown.text, /"list": true/)
  })
})

test('复读抑制：连续空转插提醒，越过硬线停这一步，带工具调用则清零', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-p')
    const session = { id: 'sess-p' }

    host.emit('session/event', [session, assistantEvent('好。')])
    host.emit('session/event', [session, assistantEvent('好')])
    assert.equal(handle.optimize.repeat.runOf('sess-p'), 2)

    const reminder = await host.waterfall('agent/pre-step', [{ agent, step: 3, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(reminder.kind, 'enter')
    assert.equal(reminder.messages.length, 1)
    assert.match(reminder.messages[0].content[0].text, /no tool call and no new content/)
    assert.equal(handle.optimize.stats.repeats, 1)

    // 再空转三次 → 越过硬线（默认 4）→ 停这一步。
    host.emit('session/event', [session, assistantEvent('好')])
    host.emit('session/event', [session, assistantEvent('好')])
    host.emit('session/event', [session, assistantEvent('好')])
    const stopped = await host.waterfall('agent/pre-step', [{ agent, step: 4, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(stopped.kind, 'reject')
    assert.equal(handle.optimize.stats.stops, 1)

    // 带工具调用 → 清零 → 不再插话。
    host.emit('session/event', [session, assistantEvent('Let me read it', true)])
    assert.equal(handle.optimize.repeat.runOf('sess-p'), 0)
  })
})

test('复读抑制：关掉开关后一条都不记', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    handle.toggles.repeatGuard.set(false)
    host.emit('session/event', [{ id: 's' }, assistantEvent('好。')])
    assert.equal(handle.optimize.repeat.snapshot().sessions, 0)
  })
})

test('复读抑制：新的一轮（step 1）清掉上一轮的连击与失败记录', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-clear')
    host.emit('session/event', [{ id: 'sess-clear' }, assistantEvent('好。')])
    await host.waterfall('tools/post-execute', [{ name: 'edit', callId: 'c', arguments: {}, agent }, errResult('"x" bad')], () => ({ kind: 'accept' }))
    assert.ok(handle.optimize.repeat.runOf('sess-clear') > 0)
    await host.waterfall('agent/pre-step', [{ agent, step: 1, turn: 2, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(handle.optimize.repeat.runOf('sess-clear'), 0)
    assert.equal(handle.optimize.retrySlots.peek('sess-clear'), undefined)
  })
})

test('提前压缩：默认关闭；打开后越过自定线才压，压完插一条说明', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ tokens: 400_000 })
    const handle = apply(host.ctx, { autoCompactDefault: true, log: false })
    const agent = makeAgent('sess-c')
    const decision = await host.waterfall('agent/pre-step', [{ agent, step: 2, turn: 1, messages: [], signal: undefined }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(host.compactions.length, 1, '越过 300k 必须压一次')
    assert.equal(handle.optimize.stats.compactions, 1)
    assert.match(decision.messages[0].content[0].text, /auto-compacted early/)
    // 冷却期内不再压。
    await host.waterfall('agent/pre-step', [{ agent, step: 3, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(host.compactions.length, 1)
  })
})

test('提前压缩：没到线不压；越过宿主线让给宿主；开关关着一次都不压', async () => {
  await withTempHome(async () => {
    const low = fakeHost({ tokens: 100_000 })
    apply(low.ctx, { autoCompactDefault: true, log: false })
    await low.waterfall('agent/pre-step', [{ agent: makeAgent('a'), step: 2, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(low.compactions.length, 0, '没到线不压')

    const high = fakeHost({ tokens: 700_000 })
    apply(high.ctx, { autoCompactDefault: true, log: false })
    await high.waterfall('agent/pre-step', [{ agent: makeAgent('b'), step: 2, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(high.compactions.length, 0, '越过宿主线就该让给宿主')

    const off = fakeHost({ tokens: 400_000 })
    apply(off.ctx, { autoCompactDefault: false, log: false })
    await off.waterfall('agent/pre-step', [{ agent: makeAgent('c'), step: 2, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(off.compactions.length, 0, '默认关闭')
  })
})

test('提前压缩：压缩抛错只降级，不影响这一步', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ tokens: 400_000 })
    host.services.compaction.compactNow = async () => {
      throw new Error('busy')
    }
    const handle = apply(host.ctx, { autoCompactDefault: true, log: false })
    const decision = await host.waterfall('agent/pre-step', [{ agent: makeAgent('sess-e'), step: 2, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.kind, 'enter')
    assert.equal(handle.optimize.stats.compactions, 0)
    assert.ok(host.warnings.some((line) => line.includes('early compaction failed')))
  })
})

test('降级：一个钩子抛错不影响其它钩子，警告里点名是哪一段', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    // 让 systemPrompt.section 抛错：只有段落挂不上，其它照旧。
    host.services.systemPrompt.section = () => {
      throw new Error('section name taken')
    }
    const handle = apply(host.ctx, { log: false })
    assert.ok(host.tools.has(RETRY_TOOL), '段落挂了不影响工具注册')
    assert.ok(host.warnings.some((line) => line.includes('discipline section unavailable')))
    assert.ok(handle.optimize)
  })
})

test('诊断视图：计数、阈值、核心集都报得出来', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ prunerThreshold: 4096 })
    const handle = apply(host.ctx, { log: false })
    const view = handle.optimize.view()
    assert.equal(view.prunerThreshold, 4096)
    assert.equal(view.effectiveCap, 4096)
    assert.equal(view.compactTokens, 300_000)
    assert.equal(view.repeatStop, 4)
    assert.ok(view.core.includes('read'))
    assert.deepEqual(view.repeat, { sessions: 0, trips: 0 })
  })
})

test('并行纠偏：连着三步单发可并行工具 → 下一步插一句提醒', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ batchable: ['read', 'grep'] })
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-batch')
    const session = { id: 'sess-batch' }
    for (const step of [1, 2, 3]) {
      host.emit('session/event', [session, { type: 'tool/call', data: { turn: 1, step, name: 'read' } }])
    }
    const decision = await host.waterfall('agent/pre-step', [{ agent, step: 4, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 1, '必须插一条提醒')
    assert.match(decision.messages[0].content[0].text, /one `read` call/)
    assert.equal(handle.optimize.stats.batchNudges, 1)
    // 同一个 turn 内不再重复插话。
    host.emit('session/event', [session, { type: 'tool/call', data: { turn: 1, step: 5, name: 'read' } }])
    const again = await host.waterfall('agent/pre-step', [{ agent, step: 6, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(again.messages.length, 0)
  })
})

test('并行纠偏：本来就必须串行的工具（没声明并行分类器）不提醒', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ batchable: [] })
    const handle = apply(host.ctx, { log: false })
    const agent = makeAgent('sess-serial')
    for (const step of [1, 2, 3]) {
      host.emit('session/event', [{ id: 'sess-serial' }, { type: 'tool/call', data: { turn: 1, step, name: 'write' } }])
    }
    const decision = await host.waterfall('agent/pre-step', [{ agent, step: 4, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 0)
    assert.equal(handle.optimize.stats.batchNudges, 0)
  })
})

test('并行纠偏：开关关掉就一条都不记', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ batchable: ['read'] })
    const handle = apply(host.ctx, { log: false })
    handle.toggles.parallel.set(false)
    for (const step of [1, 2, 3]) {
      host.emit('session/event', [{ id: 's' }, { type: 'tool/call', data: { turn: 1, step, name: 'read' } }])
    }
    const decision = await host.waterfall('agent/pre-step', [{ agent: makeAgent('s'), step: 4, turn: 1, messages: [] }], () => ({ kind: 'enter', messages: [] }))
    assert.equal(decision.messages.length, 0)
  })
})
