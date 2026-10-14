/**
 * 纯逻辑：提前自动压缩的判定。
 *
 * 最关键的一条是"宿主会处理就别插手"：两边同时压同一个会话，只会把历史切碎。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { COOLDOWN_MS, HOST_HEADROOM_TOKENS, HOST_THRESHOLD_RATIO, compactPlan, hostThreshold, pressureView } from '../lib/pressure.js'

test('hostThreshold：复算出用户说的那个 67.8 万', () => {
  // 出厂默认：窗口 1e6、预留输出 256k、余量 65536、ratio 0.8。
  const value = hostThreshold({ contextWindow: 1_000_000, maxTokens: 256_000 })
  assert.equal(value, 678_464)
  assert.equal(value, Math.min(800_000, 1_000_000 - 256_000 - HOST_HEADROOM_TOKENS))
})

test('hostThreshold：窗口占比分支何时占上风', () => {
  // 预留降到 144k 以下时，0.8 × 窗口 才是更小的一边。
  assert.equal(hostThreshold({ contextWindow: 1_000_000, maxTokens: 144_000 }), 790_464)
  assert.equal(hostThreshold({ contextWindow: 1_000_000, maxTokens: 100_000 }), 800_000)
})

test('hostThreshold：参数缺失或荒谬时返回 0（= 不知道，别动手）', () => {
  assert.equal(hostThreshold(undefined), 0)
  assert.equal(hostThreshold({ contextWindow: 0 }), 0)
  assert.equal(hostThreshold({ contextWindow: -5 }), 0)
  assert.equal(hostThreshold({ contextWindow: 1000, maxTokens: 2000 }), 0, '预留比窗口还大 → 算不出线')
})

test('hostThreshold：越界的阈值参数被夹回默认值而不是让整条式子失算', () => {
  // 非法 ratio → 退回 0.8；非法 headroom → 退回 65536。
  assert.equal(hostThreshold({ contextWindow: 1_000_000, maxTokens: 0, thresholdRatio: 2 }), 800_000)
  assert.equal(hostThreshold({ contextWindow: 1_000_000, maxTokens: 0, headroomTokens: -1 }), 800_000)
  assert.equal(hostThreshold({ contextWindow: 1_000_000, maxTokens: 0, headroomTokens: 0 }), 800_000)
})

test('compactPlan：六条闸门逐一验证', () => {
  const base = { tokens: 400_000, threshold: 300_000, hostThreshold: 678_464, now: 1000, lastAt: 0 }
  assert.equal(compactPlan(base).compact, true)
  assert.equal(compactPlan({ ...base, tokens: 299_999 }).reason, 'below-threshold')
  assert.equal(compactPlan({ ...base, tokens: 0 }).reason, 'no-measurement')
  assert.equal(compactPlan({ ...base, tokens: Number.NaN }).reason, 'no-measurement')
  assert.equal(compactPlan({ ...base, threshold: 0 }).reason, 'no-threshold')
  assert.equal(compactPlan({ ...base, tokens: 700_000 }).reason, 'host-will-handle-it')
  assert.equal(compactPlan({ ...base, now: 1000, lastAt: 1000 }).reason, 'cooldown')
  assert.equal(compactPlan({ ...base, now: COOLDOWN_MS + 1, lastAt: 1 }).compact, true)
})

test('compactPlan：宿主线未知（0）时不拿它当闸门', () => {
  assert.equal(compactPlan({ tokens: 400_000, threshold: 300_000, hostThreshold: 0, now: 0, lastAt: 0 }).compact, true)
})

test('compactPlan：正好压在宿主线上就让给宿主', () => {
  assert.equal(
    compactPlan({ tokens: 678_464, threshold: 300_000, hostThreshold: 678_464, now: 0 }).reason,
    'host-will-handle-it',
  )
})

test('pressureView：面板视图算得对，阈值为 0 时比值是 0 而不是 Infinity', () => {
  assert.deepEqual(pressureView({ tokens: 150, threshold: 300, hostThreshold: 600 }), { tokens: 150, threshold: 300, host: 600, ratio: 0.5 })
  assert.equal(pressureView({ tokens: 150, threshold: 0 }).ratio, 0)
  assert.equal(pressureView({}).tokens, 0)
})

test('出厂常量与宿主源码一致（改错会让"让位"判定失效）', () => {
  assert.equal(HOST_THRESHOLD_RATIO, 0.8)
  assert.equal(HOST_HEADROOM_TOKENS, 65536)
  assert.ok(COOLDOWN_MS >= 60_000)
})
