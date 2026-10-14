/**
 * 纯逻辑：工具 schema 的按需加载。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CORE, UnlockState, parseNameList, planLoad, splitSchemas, toolIndex } from '../lib/lazy.js'

const schemas = [
  { name: 'read', description: 'Read a file.' },
  { name: 'bash', description: 'Run a command.' },
  { name: 'univer', description: '  Office\n operations.  ' },
  { name: 'browser_use', description: 'x'.repeat(300) },
]

test('parseNameList：逗号与空白都认，去重去空', () => {
  assert.deepEqual(parseNameList('read, bash  grep'), ['read', 'bash', 'grep'])
  assert.deepEqual(parseNameList(''), [])
  assert.deepEqual(parseNameList('a,a,b'), ['a', 'b'])
  assert.deepEqual(parseNameList(undefined), [])
})

test('splitSchemas：核心集与已解锁保留，其余藏起来；顺序不变', () => {
  const { visible, hidden } = splitSchemas(schemas, { core: ['read', 'bash'], unlocked: new Set(['univer']) })
  assert.deepEqual(visible.map((s) => s.name), ['read', 'bash', 'univer'])
  assert.deepEqual(hidden.map((s) => s.name), ['browser_use'])
})

test('splitSchemas：默认核心集里必须有 load_tools 自己（否则模型再也取不回任何工具）', () => {
  assert.ok(DEFAULT_CORE.includes('load_tools'))
  const withLoad = [...schemas, { name: 'load_tools', description: 'x' }]
  const { visible } = splitSchemas(withLoad, {})
  assert.ok(visible.some((s) => s.name === 'load_tools'))
})

test('splitSchemas：坏数据被跳过而不是抛错', () => {
  const { visible, hidden } = splitSchemas([null, {}, { name: 5 }, { name: 'read' }], { core: ['read'] })
  assert.equal(visible.length, 1)
  assert.equal(hidden.length, 0)
  assert.deepEqual(splitSchemas(undefined, {}).visible, [])
})

test('toolIndex：一行一个工具，描述被压成单行并截断', () => {
  const text = toolIndex([schemas[2], schemas[3]])
  assert.match(text, /- univer: Office operations\./)
  const long = text.split('\n').find((line) => line.startsWith('- browser_use'))
  assert.ok(long.length < 130, '索引行必须短，它是"发现入口"不是文档')
  assert.match(text, /load_tools/)
})

test('toolIndex：没有隐藏工具时说清楚', () => {
  assert.match(toolIndex([]), /Every tool is already loaded/)
})

test('planLoad：names → 解锁；list → 列索引；都没有 → 列索引', () => {
  assert.deepEqual(planLoad({ names: ['a'] }, ['a', 'b']), { action: 'unlock', names: ['a'] })
  assert.deepEqual(planLoad({ list: true }, ['a']), { action: 'list' })
  assert.deepEqual(planLoad({}, ['a']), { action: 'list' })
})

test('planLoad：全部不认识时给出可操作的错误（并指向 list）', () => {
  const planned = planLoad({ names: ['nope'] }, ['a'])
  assert.equal(planned.action, 'error')
  assert.match(planned.message, /nope/)
  assert.match(planned.message, /"list": true/)
})

test('planLoad：认识一部分就解锁那一部分，去重', () => {
  const planned = planLoad({ names: ['a', 'a', 'nope'] }, ['a', 'b'])
  assert.deepEqual(planned, { action: 'unlock', names: ['a'] })
})

test('planLoad：names 是空的/非数组时退化成 list，不报错', () => {
  assert.equal(planLoad({ names: [] }, ['a']).action, 'list')
  assert.equal(planLoad({ names: 'a' }, ['a']).action, 'list')
  assert.equal(planLoad(null, ['a']).action, 'list')
})

test('UnlockState：按 agent 对象记账，解锁幂等，返回的只是新解锁的', () => {
  const state = new UnlockState()
  const agent = {}
  assert.deepEqual(state.unlock(agent, ['a', 'b']), ['a', 'b'])
  assert.deepEqual(state.unlock(agent, ['b', 'c']), ['c'])
  assert.deepEqual([...state.of(agent)].sort(), ['a', 'b', 'c'])
  assert.equal(state.unlocks, 3)
})

test('UnlockState：两个 agent 互不影响；拿不到 agent 时不炸', () => {
  const state = new UnlockState()
  const a = {}
  const b = {}
  state.unlock(a, ['x'])
  assert.deepEqual([...state.of(b)], [])
  assert.deepEqual(state.unlock(undefined, ['x']), [])
  assert.deepEqual([...state.of(null)], [])
})
