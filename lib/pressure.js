/**
 * 提前自动压缩的判定：把"什么时候压"从宿主手里接过来一小段。
 *
 * ## 宿主现在的线在哪
 *
 * `dsh-compaction-basic` 自己算一条线（`resolveCompactSpec`）：
 *
 * ```text
 * messageBudget   = contextWindow - reservedCompletionTokens        // 预留 256k 输出
 * pressureBudget  = messageBudget - headroomTokens                  // 再留 64k 余量
 * thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudget))
 * ```
 *
 * 按出厂默认（窗口 1e6、预留 256k、余量 65536、thresholdRatio 0.8）算出来是
 * `min(800000, 1000000-256000-65536) = 678464` —— 用户说的"约 67.8 万"是准的，
 * 只是它不是代码里的字面量，而是这四个默认值乘出来的。
 *
 * ## 本模块做什么
 *
 * 把同一条式子复算一遍（好知道宿主的线在哪，避免两边抢着压），再和用户设的线比。
 * 只有"用户线 < 宿主线"时才自己动手；一旦越过宿主线就交给宿主，不重复压。
 *
 * @module dsh-exec-optimizer/pressure
 */

/** 宿主 `dsh-compaction-basic` 的出厂默认：窗口占比。 */
export const HOST_THRESHOLD_RATIO = 0.8

/** 宿主默认预留的余量。 */
export const HOST_HEADROOM_TOKENS = 65536

/** 两次自动压缩之间的最小间隔（毫秒），防止连环压。 */
export const COOLDOWN_MS = 120_000

/**
 * 复算宿主的自动压缩线。
 *
 * 任何一项缺失都返回 0（= 不知道），调用方应当据此放弃自己动手。
 *
 * @param {object} input - `{ contextWindow, maxTokens, headroomTokens, thresholdRatio }`。
 * @returns {number} 宿主会在多少 token 触发压缩；算不出来时 0。
 */
export function hostThreshold(input) {
  const window = Number(input?.contextWindow)
  if (!Number.isFinite(window) || window <= 0) return 0
  const reserved = Number.isFinite(input?.maxTokens) && input.maxTokens > 0 ? input.maxTokens : 0
  const headroom = Number.isFinite(input?.headroomTokens) && input.headroomTokens >= 0
    ? input.headroomTokens
    : HOST_HEADROOM_TOKENS
  const ratio = Number.isFinite(input?.thresholdRatio) && input.thresholdRatio > 0 && input.thresholdRatio <= 1
    ? input.thresholdRatio
    : HOST_THRESHOLD_RATIO
  const messageBudget = window - reserved
  const pressureBudget = messageBudget - headroom
  if (pressureBudget <= 0 || messageBudget <= 0) return 0
  return Math.floor(Math.min(window * ratio, pressureBudget))
}

/**
 * 决定这一步要不要自己发起压缩。
 *
 * 六条闸门，任何一条不满足都返回"不压"：压缩会花一次摘要调用、会改写历史（前缀缓存
 * 从改写点起失效），误触发比不触发贵得多。
 *
 * @param {object} input - `{ tokens, threshold, hostThreshold, now, lastAt, cooldownMs }`。
 * @returns {{compact: boolean, reason: string}} 判定与理由（理由进诊断日志）。
 */
export function compactPlan(input) {
  const tokens = Number(input?.tokens)
  const threshold = Number(input?.threshold)
  if (!Number.isFinite(tokens) || tokens <= 0) return { compact: false, reason: 'no-measurement' }
  if (!Number.isFinite(threshold) || threshold <= 0) return { compact: false, reason: 'no-threshold' }
  if (tokens < threshold) return { compact: false, reason: 'below-threshold' }
  const host = Number(input?.hostThreshold)
  if (Number.isFinite(host) && host > 0 && tokens >= host) return { compact: false, reason: 'host-will-handle-it' }
  const now = Number.isFinite(input?.now) ? input.now : 0
  const lastAt = Number.isFinite(input?.lastAt) ? input.lastAt : 0
  const cooldown = Number.isFinite(input?.cooldownMs) && input.cooldownMs >= 0 ? input.cooldownMs : COOLDOWN_MS
  if (lastAt > 0 && now - lastAt < cooldown) return { compact: false, reason: 'cooldown' }
  return { compact: true, reason: 'pressure' }
}

/**
 * 给面板/诊断用的一行视图。
 *
 * @param {object} input - `{ tokens, threshold, hostThreshold }`。
 * @returns {{tokens: number, threshold: number, host: number, ratio: number}} 视图数据。
 */
export function pressureView(input) {
  const tokens = Number.isFinite(input?.tokens) ? input.tokens : 0
  const threshold = Number.isFinite(input?.threshold) ? input.threshold : 0
  const host = Number.isFinite(input?.hostThreshold) ? input.hostThreshold : 0
  return {
    tokens,
    threshold,
    host,
    ratio: threshold > 0 ? Math.round((tokens / threshold) * 1000) / 1000 : 0,
  }
}
