/**
 * 按任务轻重选档：把一个 turn 的"活儿有多重"落成 provider/模型/推理档位。
 *
 * ## 只走官方瀑布，不包模型调用
 *
 * 落地位置是 `agent/request` —— 宿主文档里写明它是**唯一**能在派发前替换
 * `LlmCallConfig`（provider / model / reasoningEffort）的钩子。本插件不碰模型目录、
 * 不碰选择器、不包 `llm.stream`：那些是历史上把宿主内存拖爆的路子。
 *
 * ## 怎么在没有价目表的情况下挑模型
 *
 * 这一版运行时的模型目录**没有价格字段**，但有可用的档位信号：id、名字、描述。
 * 出厂目录就是明证——`deepseek-v4-pro` 的描述写着 "Stronger … at higher cost"，
 * 而 `deepseek-flash` 一个字都没写。所以这里做**标记打分**：
 *
 *   * 弱档标记：flash / mini / lite / small / nano / air / fast / instant / turbo / haiku
 *   * 强档标记：pro / max / ultra / opus / strong(er) / quality / higher cost /
 *     complex / reasoning / thinking / premium
 *
 * 分数 = 强档命中数 − 弱档命中数（扫 id + 名字 + 描述，全部小写）。分数越低越便宜。
 * 于是 `deepseek-flash` = −1，`deepseek-v4-pro` = +5。
 *
 * 三条安全阀：**同供应方内**才换；**分数全都一样就不换**（认不出来就别猜）；
 * 显式映射永远优先。手选优先：用户在选择器里点过的会话永久跳过换档。
 *
 * 方向是双向的，两边都省钱：闲聊/轻活挑目录里最便宜的那个；重活挑最强的那个；
 * `standard` 保持用户当前的选择不动。
 *
 * @module dsh-exec-optimizer/tier
 */

import { BUCKETS } from './classify.js'

/** 路由文本里允许的分隔符：`provider/model` 与 `provider:model` 都认。 */
const ROUTE_SPLIT = /^([^/:]+)[/:](.+)$/

/**
 * 解析 `provider/model` 文本。
 *
 * @param {unknown} text - 配置文本。
 * @returns {{provider: string, model: string}|undefined} 解析结果；空或格式不对时 undefined。
 */
export function parseRoute(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = ROUTE_SPLIT.exec(trimmed)
  if (match === null) return undefined
  const provider = match[1].trim()
  const model = match[2].trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/** 弱档标记：命中说明这个模型是便宜那一档。 */
const CHEAP_MARKERS = ['flash', 'mini', 'lite', 'small', 'nano', 'air', 'fast', 'instant', 'turbo', 'haiku']

/** 强档标记：命中说明这个模型是强/贵那一档。 */
const STRONG_MARKERS = [
  'pro',
  'max',
  'ultra',
  'opus',
  'strong',
  'quality',
  'higher cost',
  'expensive',
  'premium',
  'complex',
  'reasoning',
  'thinking',
]

/** 一次扫描里用于打分的字段长度上限：描述可能很长，扫前 400 字符足够。 */
const SCAN_CHARS = 400

/**
 * 数一个模型命中了几个标记。
 *
 * @param {string} haystack - 已经小写化的文本。
 * @param {readonly string[]} markers - 标记表。
 * @returns {number} 命中数（同一个标记只算一次）。
 */
function countMarkers(haystack, markers) {
  let hits = 0
  for (const marker of markers) {
    if (haystack.includes(marker)) hits += 1
  }
  return hits
}

/**
 * 给目录里的每个模型打一个"档位分"：越低越便宜。
 *
 * @param {readonly {id?: string, name?: string, description?: string}[]} models - 目录。
 * @returns {Array<{id: string, score: number}>} 打分结果（保持目录顺序）。
 */
export function rankModels(models) {
  const out = []
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.id === 'string' ? model.id : undefined
    if (id === undefined || id === '') continue
    const haystack = `${id} ${model?.name ?? ''} ${String(model?.description ?? '').slice(0, SCAN_CHARS)}`.toLowerCase()
    out.push({ id, score: countMarkers(haystack, STRONG_MARKERS) - countMarkers(haystack, CHEAP_MARKERS) })
  }
  return out
}

/**
 * 按轻重从目录里自动挑一个模型。
 *
 * @param {object} input - `{ bucket, models, current }`。
 * @returns {{id: string, why: string}|undefined} 挑中的模型；不换时 undefined。
 */
export function autoPick(input) {
  const bucket = input?.bucket
  const ranked = rankModels(input?.models)
  const current = typeof input?.current === 'string' ? input.current : undefined
  if (ranked.length < 2 || current === undefined) return undefined
  const scores = new Set(ranked.map((entry) => entry.score))
  // 分数全都一样 = 目录里没有可用的档位信号，认不出来就不猜。
  if (scores.size < 2) return undefined
  const cheapest = ranked.reduce((best, entry) => (entry.score < best.score ? entry : best), ranked[0])
  const strongest = ranked.reduce((best, entry) => (entry.score > best.score ? entry : best), ranked[0])
  if (bucket === 'quiet' || bucket === 'light') {
    if (cheapest.id === current) return undefined
    return { id: cheapest.id, why: `cheapest in catalog (score ${cheapest.score})` }
  }
  if (bucket === 'heavy') {
    if (strongest.id === current) return undefined
    return { id: strongest.id, why: `strongest in catalog (score ${strongest.score})` }
  }
  // standard：保持用户/会话当前的选择，不制造无谓的请求头变化。
  return undefined
}

/**
 * 这一轮要用的路由与档位。
 *
 * @param {object} input - `{ bucket, routes, efforts, current }`。
 *   `routes`/`efforts` 都是 `{quiet, light, standard, heavy}`；
 *   `current` 是当前生效的 `{provider, model}`（用于判断有没有真的换）。
 * @returns {{provider?: string, model?: string, reasoningEffort?: string, changed: boolean}|undefined}
 *   没有任何改动时 undefined（调用方据此原样放行，避免无谓的请求头变化）。
 */
export function resolveTier(input) {
  const bucket = BUCKETS.includes(input?.bucket) ? input.bucket : undefined
  if (bucket === undefined) return undefined
  /** @type {{provider?: string, model?: string, reasoningEffort?: string, why?: string}} */
  const out = {}
  // 不知道当前路由就**不换**：换模型会写一条新的 request/header，等于主动制造一次
  // 前缀缓存重建；没有明确收益时不做这件事。
  const current = input?.current
  const known = current !== undefined && typeof current.provider === 'string' && typeof current.model === 'string'
  const route = parseRoute(input?.routes?.[bucket])
  if (route !== undefined) {
    const same = known && current.provider === route.provider && current.model === route.model
    if (known && !same) {
      out.provider = route.provider
      out.model = route.model
      out.why = 'explicit mapping'
    }
  } else if (known && input?.auto === true) {
    // 没写映射时按目录打分自动挑（同供应方内）。换成"同供应方的另一个模型"不需要改
    // provider，所以 provider 不动。
    const picked = autoPick({ bucket, models: input?.models, current: current.model })
    if (picked !== undefined) {
      out.model = picked.id
      out.why = picked.why
    }
  }
  const effort = input?.efforts?.[bucket]
  if (typeof effort === 'string' && effort.trim() !== '') out.reasoningEffort = effort.trim()
  if (out.provider === undefined && out.model === undefined && out.reasoningEffort === undefined) return undefined
  return { ...out, changed: out.provider !== undefined || out.model !== undefined }
}

/**
 * 每个 agent 当前这一轮的轻重判定。
 *
 * 只存一个桶名和一个时间戳，按 agent id 字符串分组，容量有上限。
 */
export class TierState {
  /**
   * @param {object} [options] - `{ maxAgents }`。
   */
  constructor(options = {}) {
    /** @type {number} */
    this.maxAgents = Number.isInteger(options.maxAgents) && options.maxAgents > 0 ? options.maxAgents : 64
    /** @type {Map<string, {bucket: string, at: number}>} */
    this.agents = new Map()
  }

  /**
   * 落一次判定。
   *
   * @param {string} agentKey - agent 标识。
   * @param {string} bucket - 轻重桶。
   * @param {number} at - 时间戳。
   * @returns {void}
   */
  set(agentKey, bucket, at) {
    if (typeof agentKey !== 'string' || agentKey === '') return
    this.agents.delete(agentKey)
    this.agents.set(agentKey, { bucket, at })
    while (this.agents.size > this.maxAgents) {
      const oldest = this.agents.keys().next()
      if (oldest.done === true) break
      this.agents.delete(oldest.value)
    }
  }

  /**
   * 读当前桶。
   *
   * @param {string} agentKey - agent 标识。
   * @returns {string|undefined} 桶名。
   */
  bucketOf(agentKey) {
    return this.agents.get(agentKey)?.bucket
  }

  /**
   * 丢弃。
   *
   * @param {string} agentKey - agent 标识。
   * @returns {void}
   */
  clear(agentKey) {
    this.agents.delete(agentKey)
  }

  /** @returns {Record<string, number>} 各桶计数，供诊断展示。 */
  histogram() {
    /** @type {Record<string, number>} */
    const out = { quiet: 0, light: 0, standard: 0, heavy: 0 }
    for (const entry of this.agents.values()) {
      if (out[entry.bucket] !== undefined) out[entry.bucket] += 1
    }
    return out
  }
}
