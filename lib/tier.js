/**
 * 按任务轻重选档：把一个 turn 的"活儿有多重"落成 provider/模型/推理档位。
 *
 * ## 只走官方瀑布，不包模型调用
 *
 * 落地位置是 `agent/request` —— 宿主文档里写明它是**唯一**能在派发前替换
 * `LlmCallConfig`（provider / model / reasoningEffort）的钩子。本插件不碰模型目录、
 * 不碰选择器、不包 `llm.stream`：那些是历史上把宿主内存拖爆的路子。
 *
 * ## 为什么映射要用户自己写
 *
 * 自动挑"更便宜的模型"需要价目表，而这一版运行时的目录里**没有任何价格字段**
 * （只有 `contextWindow` / `maxTokens` / 描述）。凭 id 猜"flash 比 pro 便宜"是不
 * 可靠的，所以这里只在配置里明确写了映射时才换；没写就原样透传，一分钱不多花也不
 * 少花。手选优先：用户在选择器里点过的模型不会被这里覆盖。
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
  /** @type {{provider?: string, model?: string, reasoningEffort?: string}} */
  const out = {}
  const route = parseRoute(input?.routes?.[bucket])
  if (route !== undefined) {
    const current = input?.current
    // 不知道当前路由就**不换**：换模型会写一条新的 request/header，等于主动制造一次
    // 前缀缓存重建；没有明确收益时不做这件事。
    const known = current !== undefined && typeof current.provider === 'string' && typeof current.model === 'string'
    const same = known && current.provider === route.provider && current.model === route.model
    if (known && !same) {
      out.provider = route.provider
      out.model = route.model
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
