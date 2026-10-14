/**
 * 纯逻辑：按任务轻重换档。
 *
 * 两条硬约束：**没有映射就不换**（模型目录里没有价格字段，猜不得），
 * **手选优先**（在选择器里点过模型的会话永久跳过）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TierState, autoPick, parseRoute, rankModels, resolveTier } from '../lib/tier.js'

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
  assert.deepEqual(planned, { provider: 'p', model: 'flash', reasoningEffort: 'off', why: 'explicit mapping', changed: true })
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

// ---------------------------------------------------------------------------
// 没有价目表时怎么挑模型：按目录里的档位标记打分
// ---------------------------------------------------------------------------

/** 出厂目录（本机真实的那两条）。 */
const CATALOG = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
  },
]

test('rankModels：识别出厂目录里的强弱两档', () => {
  const ranked = rankModels(CATALOG)
  assert.deepEqual(ranked.map((entry) => entry.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.ok(ranked[0].score < ranked[1].score, 'flash 必须比 pro 便宜')
  assert.equal(ranked[0].score, -1, 'flash 命中一个弱档标记')
  assert.ok(ranked[1].score >= 4, 'pro 命中多个强档标记')
})

test('rankModels：认不出来的 id 不会瞎给分；坏数据被跳过', () => {
  assert.deepEqual(rankModels([{ id: 'model-a' }, { id: 'model-b', name: 'Model B' }]), [
    { id: 'model-a', score: 0 },
    { id: 'model-b', score: 0 },
  ])
  assert.deepEqual(rankModels([{ id: '' }, {}, null, 'x']), [])
  assert.deepEqual(rankModels(undefined), [])
})

test('rankModels：扫得到 id、名字与描述三处标记', () => {
  assert.equal(rankModels([{ id: 'x', name: 'X Mini' }])[0].score, -1)
  assert.equal(rankModels([{ id: 'x', description: 'premium tier' }])[0].score, 1)
})

test('autoPick：轻活挑最便宜、重活挑最强', () => {
  assert.equal(autoPick({ bucket: 'heavy', models: CATALOG, current: 'deepseek-flash' }).id, 'deepseek-v4-pro')
  assert.equal(autoPick({ bucket: 'quiet', models: CATALOG, current: 'deepseek-v4-pro' }).id, 'deepseek-flash')
  assert.equal(autoPick({ bucket: 'light', models: CATALOG, current: 'deepseek-v4-pro' }).id, 'deepseek-flash')
})

test('autoPick：已经在最便宜/最贵的那个上就不动（不制造无谓的请求头变化）', () => {
  assert.equal(autoPick({ bucket: 'quiet', models: CATALOG, current: 'deepseek-flash' }), undefined)
  assert.equal(autoPick({ bucket: 'heavy', models: CATALOG, current: 'deepseek-v4-pro' }), undefined)
})

test('autoPick：standard 保持用户当前的选择', () => {
  assert.equal(autoPick({ bucket: 'standard', models: CATALOG, current: 'deepseek-flash' }), undefined)
  assert.equal(autoPick({ bucket: 'standard', models: CATALOG, current: 'deepseek-v4-pro' }), undefined)
})

test('autoPick：只有一个模型、或全都一个分数 → 认不出来就不猜', () => {
  assert.equal(autoPick({ bucket: 'heavy', models: [CATALOG[0]], current: 'deepseek-flash' }), undefined)
  assert.equal(autoPick({ bucket: 'heavy', models: [{ id: 'a' }, { id: 'b' }], current: 'a' }), undefined)
  assert.equal(autoPick({ bucket: 'heavy', models: CATALOG }), undefined, '不知道当前模型就不换')
  assert.equal(autoPick({ bucket: 'heavy', models: undefined, current: 'a' }), undefined)
})

test('resolveTier：没写映射时自动挑（同一供应方内，provider 不动）', () => {
  const planned = resolveTier({
    bucket: 'heavy',
    routes: {},
    efforts: {},
    auto: true,
    models: CATALOG,
    current: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  assert.equal(planned.model, 'deepseek-v4-pro')
  assert.equal(planned.provider, undefined, '同供应方内换模型不该改 provider')
  assert.match(planned.why, /strongest/)
})

test('resolveTier：显式映射优先于自动挑；auto 关掉就不自动挑', () => {
  const explicit = resolveTier({
    bucket: 'heavy',
    routes: { heavy: 'other/model-x' },
    efforts: {},
    auto: true,
    models: CATALOG,
    current: { provider: 'p', model: 'deepseek-flash' },
  })
  assert.equal(explicit.model, 'model-x')
  assert.equal(explicit.why, 'explicit mapping')

  const off = resolveTier({
    bucket: 'heavy',
    routes: {},
    efforts: {},
    auto: false,
    models: CATALOG,
    current: { provider: 'p', model: 'deepseek-flash' },
  })
  assert.equal(off, undefined)
})

test('resolveTier：只换推理档、不换模型时 changed 为 false', () => {
  const planned = resolveTier({
    bucket: 'quiet',
    routes: {},
    efforts: { quiet: 'off' },
    auto: true,
    models: CATALOG,
    current: { provider: 'p', model: 'deepseek-flash' },
  })
  assert.deepEqual(planned, { reasoningEffort: 'off', changed: false })
})
