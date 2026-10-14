/**
 * 纯逻辑：按任务轻重换档。
 *
 * 两条硬约束：**没有映射就不换**（模型目录里没有价格字段，猜不得），
 * **手选优先**（在选择器里点过模型的会话永久跳过）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TierState, parseRoute, resolveTier } from '../lib/tier.js'

test('parseRoute：两种分隔符都认，坏输入返回 undefined', () => {
  assert.deepEqual(parseRoute('deepseek-official/deepseek-flash'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(parseRoute('deepseek-official:deepseek-flash'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(parseRoute(' a / b '), { provider: 'a', model: 'b' })
  assert.equal(parseRoute(''), undefined)
  assert.equal(parseRoute('   '), undefined)
  assert.equal(parseRoute('justamodel'), undefined)
  assert.equal(parseRoute(undefined), undefined)
  assert.equal(parseRoute('/x'), undefined)
  assert.equal(parseRoute('x/'), undefined)
})

test('resolveTier：没有映射、也没有档位 → undefined（原样放行）', () => {
  assert.equal(resolveTier({ bucket: 'quiet', routes: {}, efforts: {} }), undefined)
  assert.equal(resolveTier({ bucket: 'nonsense', routes: { quiet: 'a/b' }, efforts: { quiet: 'off' } }), undefined)
  assert.equal(resolveTier({}), undefined)
})

test('resolveTier：映射与当前路由相同 → 什么都不返回（连请求头都不动）', () => {
  assert.equal(
    resolveTier({ bucket: 'quiet', routes: { quiet: 'p/m' }, efforts: {}, current: { provider: 'p', model: 'm' } }),
    undefined,
  )
  assert.equal(resolveTier({ bucket: 'quiet', routes: { quiet: 'p/m' }, efforts: {} }), undefined,
    '不知道当前路由时也不换：宁可不换，也不能无谓地制造一次请求头变化')
  assert.equal(
    resolveTier({ bucket: 'quiet', routes: { quiet: 'p/m' }, efforts: {}, current: { provider: 'p', model: 'other' } }).changed,
    true,
  )
})

test('resolveTier：映射不同 → 换模型并标记 changed', () => {
  const planned = resolveTier({
    bucket: 'quiet',
    routes: { quiet: 'p/flash' },
    efforts: { quiet: 'off' },
    current: { provider: 'p', model: 'pro' },
  })
  assert.deepEqual(planned, { provider: 'p', model: 'flash', reasoningEffort: 'off', changed: true })
})

test('resolveTier：只写推理档也能生效，且不算"换档"', () => {
  const planned = resolveTier({ bucket: 'heavy', routes: {}, efforts: { heavy: 'max' }, current: { provider: 'p', model: 'm' } })
  assert.deepEqual(planned, { reasoningEffort: 'max', changed: false })
})

test('resolveTier：空字符串的档位=不动（留空就是"别管这一档"）', () => {
  assert.equal(resolveTier({ bucket: 'standard', routes: { standard: '' }, efforts: { standard: '' } }), undefined)
  assert.equal(resolveTier({ bucket: 'standard', routes: { standard: '   ' }, efforts: { standard: '  ' } }), undefined)
})

test('TierState：按 agent 记桶，LRU 有上限', () => {
  const state = new TierState({ maxAgents: 2 })
  state.set('a', 'quiet', 1)
  state.set('b', 'heavy', 2)
  state.set('c', 'light', 3)
  assert.equal(state.bucketOf('a'), undefined, '最旧的必须被丢掉')
  assert.equal(state.bucketOf('b'), 'heavy')
  assert.equal(state.bucketOf('c'), 'light')
  assert.deepEqual(state.histogram(), { quiet: 0, light: 1, standard: 0, heavy: 1 })
})

test('TierState：重复 set 同一个 agent 会刷新它的位置（真 LRU）', () => {
  const state = new TierState({ maxAgents: 2 })
  state.set('a', 'quiet', 1)
  state.set('b', 'heavy', 2)
  state.set('a', 'light', 3)
  state.set('c', 'standard', 4)
  assert.equal(state.bucketOf('b'), undefined)
  assert.equal(state.bucketOf('a'), 'light')
})

test('TierState：空键忽略；clear 只清一个', () => {
  const state = new TierState()
  state.set('', 'quiet', 0)
  assert.deepEqual(state.histogram(), { quiet: 0, light: 0, standard: 0, heavy: 0 })
  state.set('a', 'quiet', 0)
  state.clear('a')
  assert.equal(state.bucketOf('a'), undefined)
})
