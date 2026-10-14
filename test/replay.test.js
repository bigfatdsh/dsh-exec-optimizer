/**
 * 纯逻辑：失败记账与"只发改动字段"的参数合并。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_RECORDED_ARGS,
  RetrySlots,
  failedFields,
  isPlainObject,
  mergeArgs,
  planReplay,
  retryHint,
} from '../lib/replay.js'

test('isPlainObject：数组、null、类实例都不算普通对象', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Date()), true, 'Date 也是 typeof object 且非数组——由调用方按 JSON 语义处理')
})

test('mergeArgs：对象深合并，数组与标量直接替换', () => {
  const base = { path: '/a', opts: { limit: 10, deep: { x: 1 } }, tags: ['a'] }
  const merged = mergeArgs(base, { path: '/b', opts: { deep: { y: 2 } }, tags: ['b', 'c'] })
  assert.deepEqual(merged, { path: '/b', opts: { limit: 10, deep: { x: 1, y: 2 } }, tags: ['b', 'c'] })
  assert.deepEqual(base, { path: '/a', opts: { limit: 10, deep: { x: 1 } }, tags: ['a'] }, '不许改原参数')
})

test('mergeArgs：null 用来删字段（消掉 additionalProperties 报的那个多余键）', () => {
  const merged = mergeArgs({ a: 1, b: 2 }, { b: null })
  assert.deepEqual(merged, { a: 1 })
})

test('failedFields：从两条宿主报错文案里抠出字段名', () => {
  assert.deepEqual(failedFields('invalid arguments: missing required property "path"'), ['path'])
  assert.deepEqual(
    failedFields('invalid arguments: "offset" must be a number; "a.b" is not a declared property (additionalProperties: false)'),
    ['offset', 'a.b'],
  )
  assert.deepEqual(failedFields(''), [])
  assert.deepEqual(failedFields('no quotes here'), [])
})

test('failedFields：最多 6 个，不重复', () => {
  const text = '"a" "b" "a" "c" "d" "e" "f" "g"'
  const fields = failedFields(text)
  assert.equal(fields.length, 6)
  assert.deepEqual(fields, ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('retryHint：点名出错的字段，且足够短', () => {
  const hint = retryHint('edit', 'invalid arguments: "path" must be a string')
  assert.match(hint, /retry_tool/)
  assert.match(hint, /path/)
  assert.ok(hint.length < 200)
})

test('retryHint：retry_tool 自己失败时不提示重放自己；抠不到字段也不提示', () => {
  assert.equal(retryHint('retry_tool', '"x" bad'), '')
  assert.equal(retryHint('edit', 'network down'), '')
})

test('RetrySlots：记住失败，按 agent 分组，取最近一条', () => {
  const slots = new RetrySlots()
  slots.record('a', 'edit', { path: '/x' }, 'err1')
  slots.record('a', 'read', { path: '/y' }, 'err2')
  assert.equal(slots.peek('a').name, 'read')
  assert.equal(slots.peek('a', 'edit').name, 'edit')
  assert.equal(slots.peek('b'), undefined)
})

test('RetrySlots：每个 agent 只留最近 N 条（超出丢最旧的）', () => {
  const slots = new RetrySlots({ perAgent: 2 })
  slots.record('a', 't1', { i: 1 }, 'e')
  slots.record('a', 't2', { i: 2 }, 'e')
  slots.record('a', 't3', { i: 3 }, 'e')
  assert.equal(slots.peek('a', 't1'), undefined, '最旧的必须被丢掉')
  assert.equal(slots.peek('a', 't2').name, 't2')
  assert.equal(slots.peek('a').name, 't3')
})

test('RetrySlots：agent 数量有上限，超了丢最旧的', () => {
  const slots = new RetrySlots({ maxAgents: 2 })
  slots.record('a', 't', {}, 'e')
  slots.record('b', 't', {}, 'e')
  slots.record('c', 't', {}, 'e')
  assert.equal(slots.size(), 2)
  assert.equal(slots.peek('a'), undefined)
  assert.equal(slots.peek('c').name, 't')
})

test('RetrySlots：超大参数不记（记了也是白占内存）', () => {
  const slots = new RetrySlots({ maxArgs: 50 })
  assert.equal(slots.record('a', 't', { blob: 'x'.repeat(100) }, 'e'), false)
  assert.equal(slots.peek('a'), undefined)
  assert.equal(slots.dropped, 1)
})

test('RetrySlots：非对象参数、空 agent 键、retry_tool 自身都不记', () => {
  const slots = new RetrySlots()
  assert.equal(slots.record('a', 't', 'raw string', 'e'), false)
  assert.equal(slots.record('', 't', {}, 'e'), false)
  assert.equal(slots.record('a', 'retry_tool', {}, 'e'), false)
  assert.equal(slots.size(), 0)
})

test('RetrySlots：clear 丢掉一个会话', () => {
  const slots = new RetrySlots()
  slots.record('a', 't', {}, 'e')
  slots.clear('a')
  assert.equal(slots.peek('a'), undefined)
})

test('planReplay：patch 合并、args 整体替换、都没有就原样重放', () => {
  const record = { name: 'edit', args: JSON.stringify({ path: '/a', old: 'x', new: 'y' }), error: '' }
  assert.deepEqual(planReplay({ record, patch: { new: 'z' } }).args, { path: '/a', old: 'x', new: 'z' })
  assert.deepEqual(planReplay({ record, args: { only: 1 } }).args, { only: 1 })
  assert.deepEqual(planReplay({ record }).args, { path: '/a', old: 'x', new: 'y' })
  assert.equal(planReplay({ record, args: { only: 1 } }).name, 'edit')
})

test('planReplay：没有记录、参数坏了、补丁不是对象，都给出可读的理由', () => {
  assert.match(planReplay({ record: undefined, patch: {} }).reason, /no failed call recorded/)
  assert.match(planReplay({ record: { name: 't', args: '{oops', error: '' }, patch: {} }).reason, /not valid JSON/)
  assert.match(planReplay({ record: { name: 't', args: '{}', error: '' }, patch: [] }).reason, /`patch` must be an object/)
  assert.match(planReplay({ record: { name: 't', args: '{}', error: '' }, args: 5 }).reason, /`args` must be an object/)
})

test('MAX_RECORDED_ARGS 是个有界的值（内存纪律）', () => {
  assert.ok(Number.isInteger(MAX_RECORDED_ARGS) && MAX_RECORDED_ARGS > 0 && MAX_RECORDED_ARGS <= 8192)
})
