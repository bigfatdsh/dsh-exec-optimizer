/**
 * dsh-exec-optimizer —— 执行优化（宿主半边）。
 *
 * ## 它做什么
 *
 * 八个开关，全部挂在宿主**公开契约**的钩子上，没有一处包住模型调用：
 *
 * | 开关 | 挂的钩子 | 省什么 |
 * |---|---|---|
 * | 并行工具调用 | `systemPrompt.section` | 每合并一次省掉一整轮请求 |
 * | 失败重放 | `tools/post-execute` + `tools.register` | 参数重发 → 只发改动字段 |
 * | 工具结果上限 | `tools/post-execute` | 大结果截头留尾，全文落盘 |
 * | 不动已发内容 | 同上（上限算法） | 让内置裁剪器无事可做，前缀缓存不断 |
 * | 复读抑制 | `session/event` + `agent/pre-step` | 拦住空转轮次 |
 * | 按需加载工具说明 | `system-prompt/assemble` + `tools.register` | 每轮固定的 schema 常驻成本 |
 * | 提前自动压缩 | `agent/pre-step` + `compaction.compactNow` | 每轮重发的输入 token |
 * | 按任务换档 | `agent/pre-step` + `agent/request` | 轻活走便宜的模型/档位 |
 *
 * 具体实现在 `optimize.js`；这里只做三件事：**读配置、管开关、开端点**。
 *
 * ## 与 dsh-optimizer 的关系
 *
 * 完全独立：自己的包名、自己的状态文件、自己的端点、自己的面板图标。两个插件都装也
 * 互不干扰（各自 `inject` 自己的服务，各自记自己的开关，各写各的状态文件）。
 *
 * @module dsh-exec-optimizer
 */

import { randomUUID } from 'node:crypto'

import { DISCIPLINE_SECTION, installOptimizations } from './optimize.js'
import { Config, resolveConfig } from './schema.js'
import { ToggleState, resolveDshHome, statePath } from './state.js'

/** 插件名（cordis 运行时身份，也是 bundle 补丁里的名字）。 */
export const name = 'exec-optimizer'

export { Config }

/** 需要的服务：提示词面 + 浏览器开关的通路。其余服务一律 `ctx.get()` 现取，缺了就降级。 */
export const inject = ['systemPrompt', 'webServer']

/** 浏览器开关的端点路径。 */
export const ROUTE_PATH = '/dsh-exec-optimizer'

/**
 * 面板登记表：八个开关的字段名与说明。
 *
 * **一处定义，两处使用**：端点把它发给面板，POST 处理器按它认领字段。加一个开关只需要
 * 在这里加一行、在 `installOptimizations` 里挂上对应逻辑——不会出现"面板点得动但不生效"。
 */
export const SWITCHES = [
  {
    field: 'parallel',
    label: { zh: '并行工具调用', en: 'Batch tool calls' },
    hint: {
      zh: '在系统提示词末尾加一段纪律：互不依赖的工具调用必须放进同一条消息。宿主本来就会并发执行同一组调用，缺的只是让模型这么做——每合并一次就省掉一整轮请求（也就是重发一遍全部上下文）。只加文字、不加工具，关掉时一个字都不占。',
      en: 'Adds one discipline paragraph: independent tool calls must share one message. The runtime already runs a batch concurrently; this only makes the model emit batches, and each batch saves one full round trip.',
    },
  },
  {
    field: 'retry',
    label: { zh: '失败重放', en: 'Cheap retry' },
    hint: {
      zh: '注册 `retry_tool`：工具调用因参数错失败后，只发 `{"patch":{"出错的字段":新值}}` 就能重放，不必把原来那一大坨参数整个重新生成。失败结果后面还会挂一行提示，点名是哪几个字段出错。每个会话只记最近 3 次失败、参数超过 4KB 不记。',
      en: 'Registers `retry_tool`: after an argument error, replay the call with only the changed fields instead of re-emitting all of it. Each session keeps the last 3 failures, arguments over 4 KB are not recorded.',
    },
  },
  {
    field: 'resultCap',
    label: { zh: '工具结果上限', en: 'Cap tool results' },
    hint: {
      zh: '超过 8192 字符的工具结果，在**写进会话之前**截头留尾，全文落到 `<DSH_HOME>/exec-optimizer-spill/`，结果里带路径，模型要细节自己 read/grep。宿主自己的上限是 12500 token（约 5 万字符），这里更紧一档。',
      en: 'Trims results over 8192 chars BEFORE they enter the session, keeps the full text under `<DSH_HOME>/exec-optimizer-spill/` and leaves the path in the result.',
    },
  },
  {
    field: 'cacheSafe',
    label: { zh: '不动已发内容', en: 'Never rewrite sent text' },
    hint: {
      zh: '把上面那个上限压到内置裁剪器（`tool-result-pruner`）的阈值以下，并**连 `read` 一起裁**（`read` 自己封顶 50KB，比裁剪器阈值大得多）——这样它下一次压缩时找不到任何可裁的结果。已发出去的上下文因此永不被改写，供应商的前缀缓存不会从中间断掉。自检数字见 `?diag=1` 里的 `prunerThreshold` 与 `effectiveCap`。',
      en: 'Clamps the cap to the built-in pruner threshold and applies it to `read` too (read tops out at 50 KB), so the pruner never finds anything to rewrite: sent context stays byte-identical and the provider prefix cache survives.',
    },
  },
  {
    field: 'repeatGuard',
    label: { zh: '复读抑制', en: 'Stop filler loops' },
    hint: {
      zh: '连着两轮"没有工具调用、也没有新内容"的助手输出（例如反复"Let me do it""好。"）就插一条提醒；连到 4 轮直接停住这一步，不再白烧 token。带工具调用的消息一律清零，所以正常的简短收尾不会被误伤。',
      en: 'Interjects a reminder after two consecutive content-free assistant turns, and stops the step at four. Any turn with a tool call resets the count.',
    },
  },
  {
    field: 'lazyTools',
    label: { zh: '工具说明按需加载', en: 'Load tool schemas on demand' },
    hint: {
      zh: '默认只把核心工具（read/write/edit/glob/grep/bash/todo_write/ask_user_question 与本插件自己的两个工具）的 schema 发给模型，其余留一个 `load_tools` 索引，用到再取。省下每轮固定的常驻成本，代价是工具表变化处会重建一次前缀缓存，所以默认关闭。隐藏的工具按名字仍然可调用。',
      en: 'Sends only core tool schemas; the rest are reachable through `load_tools`. Saves a fixed per-request cost but rebuilds the prefix cache where the tool set changes, so it is off by default.',
    },
  },
  {
    field: 'autoCompact',
    label: { zh: '提前自动压缩', en: 'Compact early' },
    hint: {
      zh: '宿主的自动压缩线是 678,464 token（1e6 窗口 × 0.8，再被 256k 预留与 64k 余量夹住）。打开后越过 300,000 token 就主动调一次压缩，不必等历史涨到 67.8 万——每一轮都要重发的输入 token 从这里省。默认关闭：压缩会花一次摘要调用并改写历史。越线之后交给宿主，不重复压。',
      en: 'The host compacts at 678,464 tokens. This triggers compaction at 300,000 instead, cutting the input tokens every later round re-sends. Off by default: compaction costs one summarization call and rewrites history.',
    },
  },
  {
    field: 'modelTier',
    label: { zh: '按任务换档', en: 'Model tier by task' },
    hint: {
      zh: 'IM 闲聊这类轻活按 `agent/request` 切到更便宜的模型/更低的推理档，重活再切回来。只走官方瀑布，不碰模型目录与选择器。映射默认留空（= 不换模型，因为模型目录里没有价格字段，猜不得）；在 `cordis.patch.yml` 里填 `tierModelQuiet: 供应方/模型` 才生效。**手选优先**：在选择器里点过模型的会话永久跳过换档。',
      en: 'Switches cheap tasks to a cheaper model/effort through the official `agent/request` waterfall. Empty mapping means no switch. A session where you picked a model by hand is never switched.',
    },
  },
]

/**
 * 装配插件。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - 插件配置（已由 `Config` 校验并补默认值）。
 * @returns {object} 控制句柄（测试用；宿主忽略）。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  /**
   * 解析一个宿主服务。
   *
   * **必须在每次使用时重新解析**：`inject` 只保证依赖在图里，不保证 `apply` 执行时
   * 提供者已经就位。兜底那一句必须包在 try 里——cordis 的属性访问在"这个键不在 inject
   * 里"时是**抛错**而不是返回 undefined，少装一个插件就会把整个插件打掉。
   *
   * @param {string} key - 服务名。
   * @returns {object|undefined} 服务对象。
   */
  const service = (key) => {
    const fromGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
    if (fromGet !== undefined) return fromGet
    try {
      return ctx[key]
    } catch {
      return undefined
    }
  }

  const warn = (message) => ctx?.logger?.warn?.(`exec-optimizer: ${message}`)

  /**
   * 跑一段可能失败的装配：失败只降级，不牵连整个插件。
   *
   * 实测教训：宿主对"同名提示词段落"是**抛错**而不是忽略，而这个抛错发生在装配期。
   *
   * @param {string} what - 出错时点名哪一段。
   * @param {() => unknown} run - 要跑的装配。
   * @returns {unknown} `run()` 的返回值；抛错时 undefined。
   */
  const guard = (what, run) => {
    try {
      return run()
    } catch (error) {
      warn(`${what} unavailable: ${error?.message ?? error}`)
      return undefined
    }
  }

  const file = config.persist === true
    ? (typeof config.file === 'string' && config.file !== '' ? config.file : statePath(resolveDshHome()))
    : undefined

  /**
   * 建一个开关。字段名就是面板登记表里的 `field`——"面板上点了什么"与"文件里存了什么"
   * 永远同名，排查时不用猜。
   *
   * @param {string} field - 状态文件字段名。
   * @param {boolean} initial - 首次装配的默认值。
   * @returns {ToggleState} 开关。
   */
  const makeToggle = (field, initial) =>
    new ToggleState({
      field,
      initial: initial === true,
      file,
      onError: (error) => warn(`${field} state write failed: ${error?.message ?? error}`),
    })

  /** 八个开关。字段名与 `SWITCHES` 一一对应（有测试钉住这件事）。 */
  const toggles = {
    parallel: makeToggle('parallel', config.parallelDefault),
    retry: makeToggle('retry', config.retryDefault),
    resultCap: makeToggle('resultCap', config.resultCapDefault),
    cacheSafe: makeToggle('cacheSafe', config.cacheSafeDefault),
    repeatGuard: makeToggle('repeatGuard', config.repeatGuardDefault),
    lazyTools: makeToggle('lazyTools', config.lazyToolsDefault),
    autoCompact: makeToggle('autoCompact', config.autoCompactDefault),
    modelTier: makeToggle('modelTier', config.modelTierDefault),
  }

  /**
   * 开关快照，摊平成 `{ [field]: boolean }`。
   *
   * 从 `toggles` 现算而不是写死八个键：加一个开关只需要加一行。
   *
   * @returns {Record<string, boolean>} 快照。
   */
  const toggleValues = () => {
    /** @type {Record<string, boolean>} */
    const out = {}
    for (const [field, toggle] of Object.entries(toggles)) out[field] = toggle.get() === true
    return out
  }

  if (config.log === true) {
    warn(`loaded with ${Object.entries(toggleValues()).map(([key, on]) => `${key}=${on}`).join(' ')}`)
  }

  /**
   * 八项优化的运行时部分。挂的全是公开契约的钩子，**没有一处包住模型调用**。
   *
   * 装配失败只降级：内部每个钩子都过 `guard`，单个钩子挂不上不影响其它钩子。
   */
  const optimize = guard('optimizations', () =>
    installOptimizations({
      ctx,
      config,
      service,
      guard,
      warn,
      toggles,
      home: resolveDshHome(),
      makeId: () => randomUUID(),
    }),
  )

  const webServer = service('webServer')
  if (webServer?.register !== undefined) {
    ctx.effect(
      () =>
        guard('endpoint', () =>
          webServer.register({
            kind: 'exact',
            path: ROUTE_PATH,
            /**
             * 开关协议（与面板的约定，刻意做得跟 dsh-optimizer 一样，好让面板代码可复用）：
             *   * `GET  <path>` → `{ "<field>": boolean, switches: [...], optimizations: {...} }`
             *   * `POST <path>` body `{ "<field>": boolean }` → 同样的快照
             *
             * @param {import('node:http').IncomingMessage} req - 请求。
             * @param {import('node:http').ServerResponse} res - 响应。
             * @returns {Promise<void>} 完成。
             */
            handler: async (req, res) => {
              if (req.method === 'GET' || req.method === 'HEAD') {
                sendJson(res, 200, {
                  ...toggleValues(),
                  switches: SWITCHES.map((item) => ({ ...item, endpoint: ROUTE_PATH })),
                  optimizations: optimize?.view?.() ?? null,
                })
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { error: 'method-not-allowed' })
                return
              }
              const body = await readJsonBody(req)
              if (body === undefined) {
                sendJson(res, 400, { error: 'invalid-body' })
                return
              }
              let changed = false
              for (const [field, toggle] of Object.entries(toggles)) {
                if (typeof body[field] !== 'boolean') continue
                toggle.set(body[field])
                changed = true
              }
              if (changed === false) {
                sendJson(res, 400, { error: 'invalid-body' })
                return
              }
              sendJson(res, 200, toggleValues())
            },
          }),
        ),
      'exec-optimizer: endpoint',
    )
  } else {
    warn('webServer unavailable, running without the UI panel')
  }

  return { toggles, optimize, config, toggleValues }
}

/**
 * 发一段 JSON。响应头固定 `no-store`：开关状态是易变的，缓存住只会让面板显示旧值。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - 载荷。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 读一个 JSON 请求体。**有大小上限**：开关只有几个布尔值，超过 16KB 一律当坏请求，
 * 免得插件成为别人往里灌数据的入口。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown>|undefined>} 解析结果；非法时 undefined。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16384) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}
