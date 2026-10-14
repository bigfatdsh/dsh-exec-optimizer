/**
 * 纯逻辑：并行纠偏的单发模式记账。
 *
 * 判定必须**窄**：只认"同一个 turn 内连续几步、每步恰好一个、且那个工具声明了并行
 * 分类器"。对 `write`/`bash` 这种本来就必须串行的工具一个字都不说。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CallPattern, KEPT_STEPS, STREAK_TRIGGER, TRACKED_SESSIONS } from '../lib/singlecall.js'

/** 只有这三个工具"本来可以并行"。 */
const batchable = (name) => ['read', 'grep', 'glob'].includes(name)

test('连着三步单发可并行工具 → 命中', () => {
  const pattern = new CallPattern()
  for (const step of [1, 2, 3]) pattern.note('s', { turn: 1, step, name: 'read' })
  const hit = pattern.streak('s', batchable)
  assert.deepEqual(hit, { steps: 3, name: 'read' })
})

test('只连着两步不命中（阈值是 3）', () => {
  const pattern = new CallPattern()
  pattern.note('s', { turn: 1, step: 1, name: 'read' })
  pattern.note('s', { turn: 1, step: 2, name: 'grep' })
  assert.equal(pattern.streak('s', batchable), undefined)
  assert.equal(STREAK_TRIGGER, 3)
})

test('本来就必须串行的工具不命中（只对"可以合并"的说）', () => {
  const pattern = new CallPattern()
  for (const step of [1, 2, 3]) pattern.note('s', { turn: 1, step, name: 'write' })
  assert.equal(pattern.streak('s', batchable), undefined)
})

test('某一步发了两个调用 → 连击断掉（那一步已经在批量了）', () => {
  const pattern = new CallPattern()
  pattern.note('s', { turn: 1, step: 1, name: 'read' })
  pattern.note('s', { turn: 1, step: 2, name: 'read' })
  pattern.note('s', { turn: 1, step: 3, name: 'read' })
  pattern.note('s', { turn: 1, step: 3, name: 'grep' }) // 第 3 步发了两个
  assert.equal(pattern.streak('s', batchable), undefined)
})

test('混着串行工具也断掉（最后一步不是单发可并行的）', () => {
  const pattern = new CallPattern()
  pattern.note('s', { turn: 1, step: 1, name: 'read' })
  pattern.note('s', { turn: 1, step: 2, name: 'read' })
  pattern.note('s', { turn: 1, step: 3, name: 'bash' })
  assert.equal(pattern.streak('s', batchable), undefined)
})

test('换了 turn 就重新数', () => {
  const pattern = new CallPattern()
  for (const step of [1, 2, 3]) pattern.note('s', { turn: 1, step, name: 'read' })
  pattern.note('s', { turn: 2, step: 1, name: 'read' })
  assert.equal(pattern.streak('s', batchable), undefined, '新的一轮只发了一次，不该算连击')
})

test('ack 之后同一个 turn 不再命中（不重复插话）', () => {
  const pattern = new CallPattern()
  for (const step of [1, 2, 3]) pattern.note('s', { turn: 1, step, name: 'read' })
  assert.ok(pattern.streak('s', batchable))
  pattern.ack('s')
  assert.equal(pattern.streak('s', batchable), undefined)
  assert.equal(pattern.snapshot().nudges, 1)
})

test('只留最近几步（内存纪律）', () => {
  const pattern = new CallPattern()
  for (let step = 1; step <= 20; step += 1) pattern.note('s', { turn: 1, step, name: 'read' })
  assert.equal(pattern.sessions.get('s').steps.length, KEPT_STEPS)
})

test('会话数有上限，超了丢最旧的', () => {
  const pattern = new CallPattern({ maxSessions: 2 })
  pattern.note('a', { turn: 1, step: 1, name: 'read' })
  pattern.note('b', { turn: 1, step: 1, name: 'read' })
  pattern.note('c', { turn: 1, step: 1, name: 'read' })
  assert.equal(pattern.snapshot().sessions, 2)
  assert.equal(pattern.streak('a', batchable), undefined)
  assert.equal(TRACKED_SESSIONS, 64)
})

test('坏输入不记账、不抛错', () => {
  const pattern = new CallPattern()
  pattern.note('', { turn: 1, step: 1, name: 'read' })
  pattern.note('s', { turn: 'x', step: 1, name: 'read' })
  pattern.note('s', { turn: 1, step: 1.5, name: 'read' })
  pattern.note('s', { turn: 1, step: 1, name: '' })
  pattern.note('s', {})
  assert.equal(pattern.snapshot().sessions, 0)
  assert.equal(pattern.streak('nope', batchable), undefined)
  assert.equal(pattern.streak('s', undefined), undefined)
})

test('clear 丢掉一个会话', () => {
  const pattern = new CallPattern()
  for (const step of [1, 2, 3]) pattern.note('s', { turn: 1, step, name: 'read' })
  pattern.clear('s')
  assert.equal(pattern.streak('s', batchable), undefined)
})
