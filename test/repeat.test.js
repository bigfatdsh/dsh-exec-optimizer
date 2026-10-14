/**
 * 纯逻辑：复读探测。
 *
 * 判定必须**窄**：带工具调用的消息一律清零，正常长度的回答一律清零，
 * 只有连续的碎片才算空转。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MIN_CHARS, RepeatTracker, TRACKED_SESSIONS, isFiller, normalizeForCompare } from '../lib/repeat.js'

test('normalizeForCompare：空白与标点不影响"是不是同一句"', () => {
  assert.equal(normalizeForCompare('好。'), normalizeForCompare('好'))
  assert.equal(normalizeForCompare('Let me do it.'), normalizeForCompare('  let   me DO it! '))
  assert.notEqual(normalizeForCompare('Let me do it'), normalizeForCompare('Let me read it'))
})

test('normalizeForCompare：超长文本截断到 200 字符（内存纪律）', () => {
  assert.equal(normalizeForCompare('x'.repeat(500)).length, 200)
})

test('isFiller：只按长度判，边界就是门槛本身', () => {
  assert.equal(isFiller('a'.repeat(MIN_CHARS - 1), MIN_CHARS), true)
  assert.equal(isFiller('a'.repeat(MIN_CHARS), MIN_CHARS), false)
  assert.equal(isFiller('   ', MIN_CHARS), true)
  assert.equal(isFiller(undefined, MIN_CHARS), true)
})

test('带工具调用的消息清零连击（哪怕正文只有一句 let me）', () => {
  const tracker = new RepeatTracker()
  tracker.observe('s', { text: '好。', hasToolCall: false })
  assert.equal(tracker.runOf('s'), 1)
  tracker.observe('s', { text: 'Let me do it', hasToolCall: true })
  assert.equal(tracker.runOf('s'), 0)
})

test('正常长度的回答清零连击（简短收尾不会被误伤）', () => {
  const tracker = new RepeatTracker()
  tracker.observe('s', { text: '好。', hasToolCall: false })
  tracker.observe('s', { text: 'x'.repeat(200), hasToolCall: false })
  assert.equal(tracker.runOf('s'), 0)
})

test('连续碎片累加，同一句重复也累加', () => {
  const tracker = new RepeatTracker()
  tracker.observe('s', { text: '好。', hasToolCall: false })
  assert.equal(tracker.observe('s', { text: '好', hasToolCall: false }).repeated, true)
  assert.equal(tracker.runOf('s'), 2)
  const third = tracker.observe('s', { text: 'Let me do it', hasToolCall: false })
  assert.equal(third.filler, true)
  assert.equal(third.run, 3)
})

test('ack 把连击压回 1：同一条连击不会每个 step 都提醒一次', () => {
  const tracker = new RepeatTracker()
  tracker.observe('s', { text: 'a', hasToolCall: false })
  tracker.observe('s', { text: 'b', hasToolCall: false })
  assert.equal(tracker.runOf('s'), 2)
  tracker.ack('s')
  assert.equal(tracker.runOf('s'), 1)
})

test('会话之间互不干扰；clear 只清一个', () => {
  const tracker = new RepeatTracker()
  tracker.observe('a', { text: 'x', hasToolCall: false })
  tracker.observe('b', { text: 'y', hasToolCall: false })
  tracker.clear('a')
  assert.equal(tracker.runOf('a'), 0)
  assert.equal(tracker.runOf('b'), 1)
})

test('会话数有上限，超了丢最旧的（内存纪律）', () => {
  const tracker = new RepeatTracker({ maxSessions: 2 })
  tracker.observe('a', { text: 'x', hasToolCall: false })
  tracker.observe('b', { text: 'x', hasToolCall: false })
  tracker.observe('c', { text: 'x', hasToolCall: false })
  assert.equal(tracker.snapshot().sessions, 2)
  assert.equal(tracker.runOf('a'), 0, '最旧的会话状态必须被丢掉')
})

test('环形窗口只留最近 N 条', () => {
  const tracker = new RepeatTracker({ window: 2 })
  for (let index = 0; index < 6; index += 1) tracker.observe('s', { text: 'x', hasToolCall: false })
  assert.equal(tracker.sessions.get('s').seen.length, 2)
})

test('空会话键直接返回零状态，不记账', () => {
  const tracker = new RepeatTracker()
  assert.deepEqual(tracker.observe('', { text: 'x' }), { run: 0, filler: false, repeated: false })
  assert.equal(tracker.snapshot().sessions, 0)
})

test('TRACKED_SESSIONS 是有界的（内存纪律）', () => {
  assert.ok(Number.isInteger(TRACKED_SESSIONS) && TRACKED_SESSIONS > 0 && TRACKED_SESSIONS <= 256)
})
