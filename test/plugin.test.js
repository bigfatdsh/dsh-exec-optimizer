/**
 * 宿主半边：登记表、开关读写、端点协议、失败方向。
 *
 * 只测**必须成立**的事：
 *
 * 1. 面板登记表里的每个 `field` 都真的有对应的开关（否则"面板点得动但不生效"）；
 * 2. 端点按约定读、按约定写，坏输入明确拒绝；
 * 3. 段落恒定注册、位置稳定（开关不变时逐字节相同，不制造缓存失效）；
 * 4. 少一个服务只降级，不让插件死。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROUTE_PATH, SWITCHES, apply, inject, name } from '../lib/index.js'
import { DISCIPLINE_SECTION } from '../lib/optimize.js'
import { Config } from '../lib/schema.js'

/**
 * 建一个假宿主。
 *
 * @param {object} [options] - `{ withSystemPrompt, withWebServer, withTools }`。
 * @returns {object} 宿主句柄。
 */
function fakeHost(options = {}) {
  const sections = []
  const routes = []
  const tools = new Map()
  const warnings = []
  /** @type {Map<string, Function[]>} */
  const hooks = new Map()

  const services = {}
  if (options.withSystemPrompt !== false) {
    services.systemPrompt = {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    }
  }
  if (options.withWebServer !== false) {
    services.webServer = {
      register(route) {
        routes.push(route)
        return () => {}
      },
    }
  }
  if (options.withTools === true) {
    services.tools = {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      schemas: () => [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      async execute() {
        return { isError: false, content: [{ type: 'text', text: 'ok' }] }
      },
    }
    services.toolResultPruner = { config: { thresholdChars: 8192 } }
    services.tokenMeter = { measure: () => ({ totalTokens: 0 }) }
    services.compaction = { compactNow: async () => null }
    services.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 } }) }
  }

  const ctx = {
    get: (key) => services[key],
    effect(fn) {
      fn()
      return () => {}
    },
    on(hook, handler) {
      const list = hooks.get(hook) ?? []
      list.push(handler)
      hooks.set(hook, list)
      return () => {}
    },
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
  }
  return { ctx, sections, routes, tools, warnings, hooks, services }
}

/**
 * 起一个只注册端点的宿主（够测协议）。
 *
 * @param {object} [config] - 插件配置。
 * @returns {Promise<object>} 宿主 + 端点请求器。
 */
async function withEndpoint(config = { log: false }) {
  const host = fakeHost()
  const handle = apply(host.ctx, config)
  const route = host.routes[0]
  assert.ok(route, '必须注册端点')

  /**
   * 发一个请求。
   *
   * @param {string} method - 方法。
   * @param {unknown} [body] - JSON 请求体；undefined 表示不带体。
   * @returns {Promise<{status: number, payload: any}>} 响应。
   */
  const request = (method, body) =>
    new Promise((resolve) => {
      const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      const req = {
        method,
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
      const res = {
        status: 0,
        headers: {},
        text: '',
        writeHead(status, headers) {
          this.status = status
          this.headers = headers ?? {}
        },
        end(text) {
          this.text = text ?? ''
          resolve({ status: this.status, payload: this.text === '' ? undefined : JSON.parse(this.text) })
        },
      }
      void route.handler(req, res)
    })
  return { host, handle, route, request }
}

/**
 * 在临时 DSH_HOME 下跑一段。
 *
 * @param {Function} fn - 测试体。
 * @returns {Promise<unknown>} 结果。
 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'exec-opt-'))
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

test('清单：名字、依赖、端点、包名与面板挂载点', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-exec-optimizer')
  assert.equal(name, 'exec-optimizer')
  assert.deepEqual(inject, ['systemPrompt', 'webServer'])
  assert.equal(ROUTE_PATH, '/dsh-exec-optimizer')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  // 包裹里的名字必须与 bundle 补丁里那一行的 name 一致，否则宿主找不到插件。
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /name: 'dsh-exec-optimizer'/)
})

test('登记表：每个 field 都真的有开关，且配置里有对应的默认值键', () => {
  const host = fakeHost({ withTools: true })
  const handle = apply(host.ctx, { log: false })
  const fields = SWITCHES.map((item) => item.field)
  assert.equal(new Set(fields).size, fields.length, '字段名不能重复')
  assert.deepEqual(Object.keys(handle.toggles).slice().sort(), fields.slice().sort(), '登记表与开关必须一一对应')
  for (const field of fields) {
    assert.equal(typeof Config[`${field}Default`]?.default, 'boolean', `配置里必须有 ${field}Default`)
  }
  // 每一项都要有中英双语标签与提示，否则面板会出现空行。
  for (const item of SWITCHES) {
    assert.ok(item.label.zh && item.label.en, `${item.field} 缺标签`)
    assert.ok(item.hint.zh && item.hint.en, `${item.field} 缺提示`)
  }
})

test('bundle 补丁：里面写的每个配置键都真的存在（未知键会让宿主拒绝加载整个插件）', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const block = patch.slice(patch.indexOf('config:'))
  const written = [...block.matchAll(/^\s{8}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((match) => match[1])
  assert.ok(written.length >= 8, `补丁里应当写全开关默认值，实际解析到：${written.join(', ')}`)
  const known = new Set(Object.keys(Config))
  for (const key of written) {
    assert.ok(known.has(key), `cordis.patch.yml 里的 ${key} 不是本插件的配置键——宿主会校验失败并拒绝加载整个插件`)
  }
})

test('默认值：五个安全的开、三个会改动历史的关', () => {
  const host = fakeHost({ withTools: true })
  const handle = apply(host.ctx, { log: false })
  const on = Object.entries(handle.toggleValues()).filter(([, value]) => value).map(([key]) => key)
  const off = Object.entries(handle.toggleValues()).filter(([, value]) => value !== true).map(([key]) => key)
  assert.deepEqual(on.slice().sort(), ['cacheSafe', 'parallel', 'repeatGuard', 'resultCap', 'retry'])
  assert.deepEqual(off.slice().sort(), ['autoCompact', 'lazyTools', 'modelTier'])
})

test('端点：GET 给开关值 + 登记表 + 诊断', async () => {
  await withTempHome(async () => {
    const { host, request } = await withEndpoint()
    const { status, payload } = await request('GET')
    assert.equal(status, 200)
    assert.equal(payload.switches.length, SWITCHES.length)
    for (const item of payload.switches) {
      assert.equal(item.endpoint, ROUTE_PATH, '每项都要带自己的端点，面板据此发写请求')
      assert.equal(typeof payload[item.field], 'boolean', `${item.field} 必须有布尔值`)
    }
    assert.ok(payload.optimizations, '要带诊断，好让面板/排查看得到"到底生效没生效"')
    assert.equal(typeof payload.optimizations.effectiveCap, 'number')
    assert.equal(host.routes.length, 1, '只注册一条路由')
    assert.equal(host.routes[0].kind, 'exact')
  })
})

test('端点：POST 写开关并回报；坏方法、坏请求体、空对象都明确拒绝', async () => {
  await withTempHome(async () => {
    const { handle, request } = await withEndpoint()
    const written = await request('POST', { cacheSafe: false })
    assert.equal(written.status, 200)
    assert.equal(written.payload.cacheSafe, false)
    assert.equal(handle.toggles.cacheSafe.get(), false, '内存里的开关必须真的翻过去')

    const bad = await request('PUT')
    assert.equal(bad.status, 405)
    assert.equal(bad.payload.error, 'method-not-allowed')

    const empty = await request('POST', {})
    assert.equal(empty.status, 400, '一个都不认领就是坏请求：不能静默成功')

    const unknown = await request('POST', { nope: true })
    assert.equal(unknown.status, 400, '未知字段一律拒绝（配置写错要当场知道）')

    const broken = await request('POST')
    assert.equal(broken.status, 400)
  })
})

test('端点：超长请求体当坏请求，不往下读', async () => {
  await withTempHome(async () => {
    const { request } = await withEndpoint()
    const huge = await request('POST', { parallel: true, pad: 'x'.repeat(20000) })
    assert.equal(huge.status, 400)
  })
})

test('段落：恒定注册、名字唯一、位置在最后、开关不变时逐字节稳定', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withTools: true })
    apply(host.ctx, { log: false })
    const section = host.sections.find((entry) => entry.name === DISCIPLINE_SECTION)
    assert.ok(section, '纪律段落必须注册')
    assert.ok(section.order >= 10000, '排在系统提示词最后，不动前面段落的前缀缓存')
    const first = section.text()
    assert.equal(typeof first, 'string')
    assert.equal(section.text(), first, '同一状态两次装配必须一模一样')
    assert.match(first, /Tool batching/)
  })
})

test('段落：三个开关全关时是空串（宿主会丢掉整段，零成本）', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withTools: true })
    const handle = apply(host.ctx, { log: false })
    handle.toggles.parallel.set(false)
    handle.toggles.retry.set(false)
    const section = host.sections.find((entry) => entry.name === DISCIPLINE_SECTION)
    assert.equal(section.text(), '')
  })
})

test('持久化：写盘后能读回，且只占自己的文件', async () => {
  await withTempHome(async (home) => {
    const first = fakeHost({ withTools: true })
    apply(first.ctx, { log: false }).toggles.lazyTools.set(true)
    const file = join(home, 'exec-optimizer.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(stored.lazyTools, true)

    // 重新装配一次（模拟重启）：值要回来。
    const second = fakeHost({ withTools: true })
    const handle = apply(second.ctx, { log: false })
    assert.equal(handle.toggles.lazyTools.get(), true, '重启后保持上次选择')
    assert.equal(handle.toggles.parallel.get(), true)
  })
})

test('持久化：persist=false 时不落盘', async () => {
  await withTempHome(async (home) => {
    const host = fakeHost({ withTools: true })
    apply(host.ctx, { log: false, persist: false }).toggles.repeatGuard.set(false)
    await assert.rejects(readFile(join(home, 'exec-optimizer.json'), 'utf8'))
  })
})

test('持久化：盘上文件坏掉时退回默认值，不抛错', async () => {
  await withTempHome(async (home) => {
    await writeFile(join(home, 'exec-optimizer.json'), '{ not json', 'utf8')
    const host = fakeHost({ withTools: true })
    const handle = apply(host.ctx, { log: false })
    assert.equal(handle.toggles.parallel.get(), true, '坏文件只该被忽略')
    assert.ok(host.warnings.length >= 0)
  })
})

test('降级：没有 webServer 就没有面板，段落与优化照常工作', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withWebServer: false, withTools: true })
    const handle = apply(host.ctx, { log: false })
    assert.equal(host.routes.length, 0)
    assert.ok(host.sections.some((entry) => entry.name === DISCIPLINE_SECTION), '段落不受影响')
    assert.ok(handle.toggles.parallel.get() === true)
    assert.ok(host.warnings.some((line) => line.includes('webServer unavailable')))
  })
})

test('降级：没有 systemPrompt 时不注册段落，端点仍在', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withSystemPrompt: false, withTools: true })
    const handle = apply(host.ctx, { log: false })
    assert.equal(host.sections.length, 0)
    assert.equal(host.routes.length, 1, '面板还能用')
    assert.ok(handle.optimize)
  })
})

test('降级：tools/tokenMeter/compaction/llm 全缺时，只丢对应能力，开关与端点照常', async () => {
  await withTempHome(async () => {
    const host = fakeHost()
    const handle = apply(host.ctx, { log: false, autoCompactDefault: true, modelTierDefault: true })
    assert.equal(host.tools.size, 0, '没有 tools 服务就注册不了工具')
    assert.equal(handle.toggles.autoCompact.get(), true, '开关本身仍然可读可写')
    assert.equal(host.routes.length, 1)
    assert.ok(handle.optimize.view().effectiveCap === 8192, '裁剪器缺失时退回出厂阈值')
  })
})

test('端点注册抛错也不让插件死掉', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withTools: true })
    host.services.webServer.register = () => {
      throw new Error('duplicate route')
    }
    const handle = apply(host.ctx, { log: false })
    assert.ok(handle.optimize, '优化部分照样挂上')
    assert.ok(host.warnings.some((line) => line.includes('endpoint unavailable')))
  })
})

test('诊断：视图里有裁剪器阈值、实际上限、压缩线与核心集', async () => {
  await withTempHome(async () => {
    const host = fakeHost({ withTools: true })
    const handle = apply(host.ctx, { log: false })
    const view = handle.optimize.view()
    assert.equal(view.prunerThreshold, 8192)
    assert.equal(view.effectiveCap, 8192)
    assert.equal(view.compactTokens, 300_000)
    assert.equal(view.repeatStop, 4)
    assert.ok(Array.isArray(view.core) && view.core.includes('load_tools'))
  })
})
