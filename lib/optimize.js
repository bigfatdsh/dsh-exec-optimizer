/**
 * dsh-exec-optimizer —— 执行优化的落地（七项开关）。
 *
 * 这个文件只做一件事：把 `sections.js` / `spill.js` / `replay.js` / `repeat.js` /
 * `lazy.js` / `pressure.js` / `singlecall.js` 里的纯逻辑，挂到宿主**公开契约**的那几个钩子上。
 *
 * ## 挂在哪些钩子上，为什么
 *
 * | 钩子 | 用途 | 为什么是它 |
 * |---|---|---|
 * | `systemPrompt.section` | 并行纪律 / 重放 / 按需加载三段文字 | 只加文字，不加工具；关掉时返回空串，零成本 |
 * | `tools/post-execute` | 结果发送前裁剪 + 失败调用记账 | 结果**还没进会话、还没发出去**的唯一点，改在这里才不破坏前缀缓存 |
 * | `tools.register` | `retry_tool` / `load_tools` | 官方注册面；只在对应开关打开时注册 |
 * | `system-prompt/assemble` | 藏掉未加载工具的 schema | 每轮重新装配、返回值权威，是宿主给的按需加载点 |
 * | `session/event` | 观察助手消息 | 提交后的只读流水，用来数"复读连击" |
 * | `agent/pre-step` | 插提醒 / 提前压缩 / 判轻重 | 每个 step 的起点，能改这一步进入的消息 |
 *
 * **没有一处包住模型调用**：不改模型目录、不碰选择器、不包 `llm.stream`。历史上把宿主
 * 内存拖爆的正是那些钩子，这里一个都没有。
 *
 * ## 内存纪律
 *
 * 所有跨调用状态都是有界的、且只存字符串/数字：失败记录按 agent 分组最多 3 条 ×
 * 64 个 agent；复读窗口每会话 6 条 × 64 个会话；已解锁工具用 `WeakMap` 挂在 agent 上。
 * **不持有请求对象、不持有消息数组、不持有结果对象。**
 *
 * @module dsh-exec-optimizer/optimize
 */

import { join } from 'node:path'

import { DEFAULT_CORE, UnlockState, parseNameList, planLoad, splitSchemas, toolIndex } from './lazy.js'
import { compactPlan, hostThreshold } from './pressure.js'
import { RepeatTracker } from './repeat.js'
import { CallPattern } from './singlecall.js'
import { RetrySlots, planReplay, retryHint } from './replay.js'
import { batchingReminder, compactedNotice, repeatReminder, resolveDiscipline } from './sections.js'
import { capText, isPurelyText, textOfContent } from './spill.js'
import { loadTool, retryTool } from './tool-defs.js'

/** 纪律段落的注册名。与别的插件撞名会被宿主拒绝注册，所以带插件前缀。 */
export const DISCIPLINE_SECTION = 'exec-optimizer:discipline'

/** 纪律段落顺序：排在精简化（10200）之前，好让"最后一段"仍然是精简化。 */
export const DISCIPLINE_ORDER = 10100

/** 落盘目录名（在 `<DSH_HOME>` 下）。 */
export const SPILL_DIR = 'exec-optimizer-spill'

/** 重放工具名。 */
export const RETRY_TOOL = 'retry_tool'

/** 按需加载工具名。 */
export const LOAD_TOOL = 'load_tools'

/**
 * 这两个工具的结果不裁剪：它们本来就短，而且回放/取回的结果再被裁会让模型看不到自己刚做了什么。
 */
export const SKIP_CAP_TOOLS = new Set([RETRY_TOOL, LOAD_TOOL])

/**
 * `read` 工具自己封顶在 50KB（`dsh-tool-fs` 的 `readMaxBytes`），比内置裁剪器的 8192 字符
 * 大得多。所以 `read` 只在 `cacheSafe` 打开时一起裁——那正是"让裁剪器无事可做"这个承诺
 * 的必要条件；关掉 `cacheSafe` 时保持宿主原样。
 */
export const READ_TOOL = 'read'

/**
 * 裁剪时保留的默认字符数。与宿主内置裁剪器（`tool-result-pruner`，8192）一致，
 * 目的是让它再也找不到可裁的结果 → 已发出去的前缀永不被改写。
 */
export const DEFAULT_CAP_CHARS = 8192

/** 自动压缩的默认触发线（token）。宿主默认线是 678,464，这里默认压到它的四成多。 */
export const DEFAULT_COMPACT_TOKENS = 300_000

/** 连击到几条就插提醒。 */
export const REPEAT_REMIND_AT = 2

/** 连击到几条就停下这一步（0 = 永不停）。 */
export const DEFAULT_REPEAT_STOP = 4

/**
 * 取一个稳定又便宜的 agent 键。
 *
 * @param {object|undefined} agent - agent 对象。
 * @returns {string|undefined} 会话 id（拿不到就 undefined，一切记账直接跳过）。
 */
function agentKeyOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 取消息里的纯文本。
 *
 * @param {object|undefined} message - 用户消息。
 * @returns {string} 文本。
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  return textOfContent(message.content)
}

/**
 * 造一条模型可见的提醒消息。形状与 `createUserMessage()` 完全一致（`{id, role, content, source}`），
 * 因为宿主只是把它当普通用户消息追加进会话。
 *
 * @param {string} text - 正文。
 * @param {() => string} nextId - 生成 id 的函数。
 * @returns {object} 冻结的消息对象。
 */
function reminderMessage(text, nextId) {
  return Object.freeze({
    id: nextId(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: 'exec-optimizer' }),
  })
}

/**
 * 装配全部优化。
 *
 * @param {object} input - `{ ctx, config, service, guard, warn, toggles, makeId }`。
 *   `toggles` 是八个 `ToggleState` / `NumberState`；
 *   `guard(label, fn)` 是主文件里那个"失败只降级"的包装器。
 * @returns {object} 句柄：统计、各状态对象、内部操作（测试用）。
 */
export function installOptimizations(input) {
  const ctx = input.ctx
  const config = input.config
  const service = input.service
  const guard = typeof input.guard === 'function' ? input.guard : (_label, fn) => fn()
  const warn = typeof input.warn === 'function' ? input.warn : () => {}
  const toggles = input.toggles
  const makeId = typeof input.makeId === 'function' ? input.makeId : () => `exec-optimizer-${Date.now()}`

  /** 只存数字的计数器。 */
  const stats = {
    assemblies: 0,
    capped: 0,
    cappedChars: 0,
    hints: 0,
    retries: 0,
    replayErrors: 0,
    repeats: 0,
    stops: 0,
    compactions: 0,
    unlocks: 0,
    /** 并行纠偏插了几次话。 */
    batchNudges: 0,
    /** 因为结果太大而给过几次"下一段从哪读"。 */
    paginated: 0,
    /** 最近一次量到的上下文 token 数（自动压缩看的就是它）。 */
    contextTokens: 0,
    /** 最近一次复算出的宿主自动压缩线。 */
    hostCompactTokens: 0,
    /** 最近一次采样到的工具数（实时值，面板会显示）。 */
    toolCount: 0,
    /** 最近一次采样到的工具 schema 总体积（字符）。 */
    toolSchemaChars: 0,
    /** 按需加载实际藏掉的体积（字符）。 */
    hiddenSchemaChars: 0,
  }

  const retrySlots = new RetrySlots()
  const repeat = new RepeatTracker()
  const pattern = new CallPattern()
  const unlock = new UnlockState()
  /** @type {Map<string, number>} 上次自动压缩时刻（按会话）。 */
  const lastCompact = new Map()

  /**
   * 这个工具是不是"本来可以并行"。
   *
   * 判据用宿主自己的分类器：工具定义里声明了 `isConcurrencySafe` 才可能进并行组
   * （`dsh-tools` 的 `executionMode` 只认它）。所以只有对这类工具说"你可以合并"才是
   * 对的；对 `write`/`bash` 这种本来就必须串行的，一个字都不说。
   *
   * @param {string} name - 工具名。
   * @param {object|undefined} agent - 调用方 agent（作用域键）。
   * @returns {boolean} 可以并行时为 true。
   */
  function isBatchable(name, agent) {
    const tools = service('tools')
    if (typeof tools?.get !== 'function') return false
    try {
      const definition = tools.get(name, agent)
      return typeof definition?.isConcurrencySafe === 'function'
    } catch {
      return false
    }
  }

  const spillDir = join(resolveHome(input.home), SPILL_DIR)
  /** 上次采样工具 schema 体积的时刻：每 5 秒最多量一次，量体积不该成为每轮的固定开销。 */
  let lastSchemaSample = 0
  const capOverride = Number.isFinite(config.resultCapChars) && config.resultCapChars > 0
    ? Math.floor(config.resultCapChars)
    : DEFAULT_CAP_CHARS
  const compactTokens = Number.isFinite(config.autoCompactTokens) && config.autoCompactTokens > 0
    ? Math.floor(config.autoCompactTokens)
    : DEFAULT_COMPACT_TOKENS
  const repeatStop = Number.isInteger(config.repeatStopAfter) && config.repeatStopAfter >= 0
    ? config.repeatStopAfter
    : DEFAULT_REPEAT_STOP
  const core = parseNameList(config.lazyCore)
  // 自己的工具永远可见：`load_tools` 藏了自己就再也取不回任何工具，
  // `retry_tool` 藏了则与系统提示词里那段重放纪律自相矛盾。
  const coreSet = new Set([...(core.length > 0 ? core : DEFAULT_CORE), RETRY_TOOL, LOAD_TOOL])

  /**
   * 内置裁剪器当前的阈值（读不到就按出厂默认 8192）。
   *
   * @returns {number} 阈值字符数。
   */
  const prunerThreshold = () => {
    const pruner = service('toolResultPruner')
    const value = pruner?.config?.thresholdChars
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_CAP_CHARS
  }

  /**
   * 这一轮实际用的裁剪上限。`cacheSafe` 打开时取"用户设的"和"内置裁剪器阈值"的较小值
   * ——这样内置裁剪器下一次压缩时无事可做，已发前缀不会被改写。
   *
   * @returns {number} 字符数。
   */
  const effectiveCap = () => {
    if (toggles.cacheSafe?.get() === true) return Math.min(capOverride, prunerThreshold())
    return capOverride
  }

  // ------------------------------------------------------------------
  // 1. 纪律段落
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('discipline section', () =>
        service('systemPrompt')?.section?.({
          name: DISCIPLINE_SECTION,
          order: DISCIPLINE_ORDER,
          text: () => {
            stats.assemblies += 1
            return resolveDiscipline({
              parallel: toggles.parallel?.get() === true,
              retry: toggles.retry?.get() === true,
              lazy: toggles.lazyTools?.get() === true,
            })
          },
        }),
      ),
    'exec-optimizer: discipline section',
  )

  // ------------------------------------------------------------------
  // 2. 工具：失败重放 + 按需加载
  // ------------------------------------------------------------------
  /**
   * 重放失败调用。
   *
   * @param {unknown} args - 模型入参。
   * @param {object} exec - 工具执行上下文。
   * @returns {Promise<object>} 结构化结果。
   */
  const executeRetry = async (args, exec) => {
    const tools = service('tools')
    const agent = exec?.agent
    const key = agentKeyOf(agent)
    const name = typeof args?.name === 'string' && args.name !== '' ? args.name : undefined
    const record = key === undefined ? undefined : retrySlots.peek(key, name)
    const planned = planReplay({ record, patch: args?.patch, args: args?.args })
    if (planned.ok !== true) {
      stats.replayErrors += 1
      return { ok: false, tool: record?.name ?? '', replay: `retry_tool: ${planned.reason}` }
    }
    if (planned.name === RETRY_TOOL) {
      stats.replayErrors += 1
      return { ok: false, tool: planned.name, replay: 'retry_tool: cannot replay itself' }
    }
    if (typeof tools?.execute !== 'function') {
      stats.replayErrors += 1
      return { ok: false, tool: planned.name, replay: 'retry_tool: the tools service is unavailable' }
    }
    /** @type {unknown} */
    let outcome
    try {
      outcome = await tools.execute({
        callId: `${makeId()}`,
        name: planned.name,
        arguments: planned.args,
        agent,
        signal: exec?.signal,
      })
    } catch (error) {
      stats.replayErrors += 1
      return { ok: false, tool: planned.name, replay: `retry_tool: replay failed: ${error?.message ?? error}` }
    }
    stats.retries += 1
    const text = textOfContent(outcome?.content)
    const body = text === '' ? '(the replayed call returned no text)' : text
    return {
      ok: outcome?.isError !== true,
      tool: planned.name,
      replay: `retry_tool replayed ${planned.name} with the changed arguments.\n${body}`,
    }
  }

  /**
   * 取回被藏起来的工具 schema。
   *
   * @param {unknown} args - 模型入参。
   * @param {object} exec - 工具执行上下文。
   * @returns {Promise<object>} 结构化结果。
   */
  const executeLoad = async (args, exec) => {
    const tools = service('tools')
    const agent = exec?.agent
    const schemas = typeof tools?.schemas === 'function' ? tools.schemas(agent) : []
    const { hidden } = splitSchemas(schemas, { core: coreSet, unlocked: unlock.of(agent) })
    const available = hidden.map((schema) => schema.name)
    const planned = planLoad(args, available)
    if (planned.action === 'error') return { listed: false, loaded: [], text: `load_tools: ${planned.message}` }
    if (planned.action === 'list') {
      return { listed: true, loaded: [], text: toolIndex(hidden) }
    }
    const fresh = unlock.unlock(agent, planned.names)
    stats.unlocks += fresh.length
    const already = planned.names.filter((name) => !fresh.includes(name))
    const lines = []
    if (fresh.length > 0) lines.push(`Loaded: ${fresh.join(', ')}. Their schemas are in your tool list from the next step.`)
    if (already.length > 0) lines.push(`Already loaded: ${already.join(', ')}.`)
    return { listed: false, loaded: fresh, text: lines.join(' ') }
  }

  ctx.effect(() => {
    const tools = service('tools')
    if (typeof tools?.register !== 'function') return () => {}
    /** @type {Array<() => void>} */
    const disposers = []
    const sync = () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch (error) {
          warn(`tool dispose failed: ${error?.message ?? error}`)
        }
      }
      if (toggles.retry?.get() === true) {
        try {
          disposers.push(tools.register(retryTool({ execute: executeRetry })))
        } catch (error) {
          warn(`registering ${RETRY_TOOL} failed: ${error?.message ?? error}`)
        }
      }
      if (toggles.lazyTools?.get() === true) {
        try {
          disposers.push(tools.register(loadTool({ execute: executeLoad })))
        } catch (error) {
          warn(`registering ${LOAD_TOOL} failed: ${error?.message ?? error}`)
        }
      }
    }
    sync()
    // 开关一改就重挂：关掉开关 = 工具从注册表消失 = 下一轮请求少一份 schema。
    const offRetry = toggles.retry?.subscribe?.(sync)
    const offLazy = toggles.lazyTools?.subscribe?.(sync)
    return () => {
      offRetry?.()
      offLazy?.()
      sync()
    }
  }, 'exec-optimizer: tools')

  // ------------------------------------------------------------------
  // 3. 结果发送前裁剪 + 失败记账
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('result pipeline', () =>
        ctx.on('tools/post-execute', async (exec, result, next) => {
          const downstream = await next()
          const key = agentKeyOf(exec?.agent)
          const cacheSafe = toggles.cacheSafe?.get() === true
          // 自己的两个工具不裁；`read` 只在 cacheSafe 打开时裁（见 READ_TOOL 的说明）。
          const skippable = SKIP_CAP_TOOLS.has(String(exec?.name ?? '')) || (exec?.name === READ_TOOL && cacheSafe === false)
          const capOn = toggles.resultCap?.get() === true && skippable === false
          const retryOn = toggles.retry?.get() === true

          // 失败：记一笔，好让模型只发改动的字段。
          if (retryOn && result?.isError === true && key !== undefined) {
            const message = result?.error?.message ?? textOfContent(result?.content)
            if (retrySlots.record(key, String(exec?.name ?? ''), exec?.arguments, String(message))) {
              // 记账本身不产出内容；提示挂在下面。
            }
          }

          if (downstream?.kind !== 'accept') return downstream
          if (Object.hasOwn(downstream, 'value') && downstream.value !== undefined) return downstream
          const content = Array.isArray(downstream.content) ? downstream.content : result?.content
          if (!isPurelyText(content)) return downstream

          const blocks = [...content]

          // 失败结果：后面挂一行极短的"只补这几个字段"提示。
          if (result?.isError === true) {
            if (retryOn === false) return downstream
            const last = blocks[blocks.length - 1]
            const message = String(result?.error?.message ?? last?.text ?? '')
            const hint = retryHint(String(exec?.name ?? ''), message)
            if (hint === '') return downstream
            blocks[blocks.length - 1] = { ...last, text: `${last?.text ?? ''}${hint}` }
            stats.hints += 1
            return { kind: 'accept', content: blocks }
          }

          // 成功结果：超上限就截头留尾 + 落盘。
          if (capOn === false) return downstream
          const text = textOfContent(blocks)
          const capped = capText({
            text,
            dir: join(spillDir, String(key ?? 'unknown')),
            sessionId: String(key ?? 'unknown'),
            callId: String(exec?.callId ?? 'call'),
            capChars: effectiveCap(),
            // `read` 是按行取的：被裁之后给一句"下一段从第几行开始"。
            lineBased: exec?.name === READ_TOOL,
          })
          if (capped === undefined) return downstream
          stats.capped += 1
          stats.cappedChars += capped.dropped
          if (capped.nextOffset !== undefined) stats.paginated += 1
          return { kind: 'accept', content: [{ type: 'text', text: capped.text }] }
        }),
      ),
    'exec-optimizer: result pipeline',
  )

  // ------------------------------------------------------------------
  // 4. 工具 schema 按需加载
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('lazy tools', () =>
        ctx.on('system-prompt/assemble', async (assembly, context, next) => {
          const transformed = await next()
          if (transformed === null || typeof transformed !== 'object') return transformed
          const tools = Array.isArray(transformed.tools) ? transformed.tools : []
          if (tools.length === 0) return transformed
          const now = Date.now()
          if (now - lastSchemaSample > 5000) {
            lastSchemaSample = now
            stats.toolCount = tools.length
            stats.toolSchemaChars = tools.reduce((sum, schema) => sum + schemaChars(schema), 0)
          }
          if (toggles.lazyTools?.get() !== true) return transformed
          const agent = context?.scope ?? context?.agent
          const { visible, hidden } = splitSchemas(tools, { core: [...coreSet], unlocked: unlock.of(agent) })
          // 全部可见时原样返回：不制造无谓的差异，也就不触发 tool-addition 记录。
          if (visible.length === tools.length) return transformed
          stats.hiddenSchemaChars = hidden.reduce((sum, schema) => sum + schemaChars(schema), 0)
          return { ...transformed, tools: visible }
        }),
      ),
    'exec-optimizer: lazy tools',
  )

  // ------------------------------------------------------------------
  // 5. 复读观察（只读流水）+ 手选模型的"锁定"信号
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('session feed', () =>
        ctx.on('session/event', (session, event) => {
          const key = session?.id
          if (typeof key !== 'string' || key === '') return
          if (toggles.repeatGuard?.get() === true && event?.type === 'assistant/message') {
            const message = event.data?.message
            const blocks = Array.isArray(message?.content) ? message.content : []
            const hasToolCall = blocks.some((block) => block?.type === 'tool-call')
            repeat.observe(key, { text: textOfContent(blocks), hasToolCall })
          }
          // 并行纠偏：只看"每个 step 用了几个工具"，不看内容。
          if (event?.type === 'tool/call') {
            pattern.note(key, { turn: event.data?.turn, step: event.data?.step, name: event.data?.name })
          }
        }),
      ),
    'exec-optimizer: session feed',
  )

  // ------------------------------------------------------------------
  // 6. 每个 step 的起点：提醒 / 提前压缩 / 判轻重
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('pre-step', () =>
        ctx.on('agent/pre-step', async (payload, next) => {
          const decision = await next()
          if (decision?.kind === 'reject') return decision
          const agent = payload?.agent
          const key = agentKeyOf(agent)
          if (key === undefined) return decision
          const messages = Array.isArray(decision?.messages) ? [...decision.messages] : []

          // 6a. 新的用户输入 = 新的一轮：清掉上一轮的失败记录与复读连击。
          const isTurnStart = payload?.step === 1
          if (isTurnStart) {
            retrySlots.clear(key)
            repeat.clear(key)
          } else if (toggles.repeatGuard?.get() === true) {
            const run = repeat.runOf(key)
            if (run >= REPEAT_REMIND_AT) {
              if (repeatStop > 0 && run >= repeatStop) {
                stats.stops += 1
                warn(`stopping a step after ${run} consecutive empty assistant turns`)
                return { kind: 'reject' }
              }
              stats.repeats += 1
              repeat.ack(key)
              messages.push(reminderMessage(repeatReminder(run), makeId))
              return { kind: 'enter', messages }
            }
          }

          // 6a-bis. 并行纠偏：连着几步只发一个**本来可以并行**的调用，就当面说一句。
          if (toggles.parallel?.get() === true && payload?.step > 1) {
            const hit = pattern.streak(key, (name) => isBatchable(name, agent))
            if (hit !== undefined) {
              pattern.ack(key)
              stats.batchNudges += 1
              messages.push(reminderMessage(batchingReminder(hit.steps, hit.name), makeId))
              return { kind: 'enter', messages }
            }
          }

          // 6c. 提前压缩。
          if (toggles.autoCompact?.get() === true) {
            const plan = await planCompact({ agent, key, signal: payload?.signal })
            if (plan.compact === true) {
              const compaction = service('compaction')
              if (typeof compaction?.compactNow === 'function') {
                try {
                  await compaction.compactNow(agent, payload?.signal)
                  lastCompact.set(key, Date.now())
                  stats.compactions += 1
                  messages.push(reminderMessage(compactedNotice(plan.tokens), makeId))
                  return { kind: 'enter', messages }
                } catch (error) {
                  warn(`early compaction failed: ${error?.message ?? error}`)
                }
              }
            }
          }

          return decision
        }),
      ),
    'exec-optimizer: pre-step',
  )

  /**
   * 提前压缩的判定。只有当用户的线**低于**宿主自己的线时才动手；越线交给宿主，
   * 避免两边同时压同一个会话。
   *
   * @param {object} input - `{ agent, key, signal }`。
   * @returns {Promise<{compact: boolean, reason: string, tokens: number, threshold: number, host: number}>} 判定。
   */
  async function planCompact(input) {
    const empty = { compact: false, reason: 'disabled', tokens: 0, threshold: compactTokens, host: 0 }
    const meter = service('tokenMeter')
    const session = input.agent?.session
    if (typeof meter?.measure !== 'function' || session === undefined) return empty
    /** @type {number} */
    let tokens = 0
    try {
      const measurement = meter.measure(session, typeof session.requestHeader === 'function' ? session.requestHeader() : undefined)
      tokens = Number(measurement?.totalTokens) || 0
    } catch (error) {
      warn(`token measurement failed: ${error?.message ?? error}`)
      return { ...empty, reason: 'measure-failed' }
    }
    let host = 0
    try {
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const provider = header?.config?.provider
      const model = header?.config?.model
      const llm = service('llm')
      if (typeof llm?.resolveModelInfo === 'function' && typeof provider === 'string' && typeof model === 'string') {
        const info = await llm.resolveModelInfo(provider, model, input.signal)
        host = hostThreshold({ contextWindow: info?.context?.contextWindow, maxTokens: header?.config?.maxTokens })
      }
    } catch {
      host = 0
    }
    stats.contextTokens = tokens
    stats.hostCompactTokens = host
    const plan = compactPlan({
      tokens,
      threshold: compactTokens,
      hostThreshold: host,
      now: Date.now(),
      lastAt: lastCompact.get(input.key) ?? 0,
    })
    return { ...plan, tokens, threshold: compactTokens, host }
  }

  // ------------------------------------------------------------------
  // 6d. 会话结束就把它那点记录丢掉（有界之外再上一道保险）
  // ------------------------------------------------------------------
  ctx.effect(
    () =>
      guard('dispose cleanup', () =>
        ctx.on('agent/disposed', (payload) => {
          const key = agentKeyOf(payload?.agent)
          if (key === undefined) return
          retrySlots.clear(key)
          repeat.clear(key)
          pattern.clear(key)
          lastCompact.delete(key)
        }),
      ),
    'exec-optimizer: dispose cleanup',
  )

  return {
    stats,
    retrySlots,
    repeat,
    unlock,
    lastCompact,
    prunerThreshold,
    effectiveCap,
    planCompact,
    /** @returns {object} 面板用的诊断视图。 */
    view() {
      return {
        ...stats,
        prunerThreshold: prunerThreshold(),
        effectiveCap: effectiveCap(),
        cap: capOverride,
        compactTokens,
        repeatStop,
        core: [...coreSet],
        retrySlots: retrySlots.size(),
        repeat: repeat.snapshot(),
        singleCall: pattern.snapshot(),
      }
    },
  }
}

/**
 * 一个工具 schema 在请求里大约占多少字符。
 *
 * 口径与宿主一致：名字 + 描述 + `parameters` 的 JSON 文本，再加一点骨架开销
 * （`{"name":..,"description":..,"input_schema":..}` 这类固定包装）。
 *
 * @param {object} schema - 工具 schema。
 * @returns {number} 字符数。
 */
function schemaChars(schema) {
  const name = typeof schema?.name === 'string' ? schema.name.length : 0
  const description = typeof schema?.description === 'string' ? schema.description.length : 0
  let parameters = 0
  try {
    parameters = JSON.stringify(schema?.parameters ?? {}).length
  } catch {
    parameters = 0
  }
  return name + description + parameters + 32
}

/**
 * 解析 `<DSH_HOME>`。主文件会传进来，这里只是兜底。
 *
 * @param {string|undefined} home - 外部传入的家目录。
 * @returns {string} 目录。
 */
function resolveHome(home) {
  if (typeof home === 'string' && home !== '') return home
  return resolveDshHomeSafe()
}

/**
 * 兜底的家目录解析（与 `state.js` 同源，避免循环依赖时炸掉）。
 *
 * @returns {string} 目录。
 */
function resolveDshHomeSafe() {
  try {
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return join(process.env.HOME ?? process.cwd(), '.dsh')
  } catch {
    return '.dsh'
  }
}
