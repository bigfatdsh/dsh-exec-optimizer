/**
 * 纯逻辑：结果上限与落盘。
 *
 * 这一层不碰宿主，只验证"什么时候裁、裁成什么样、落盘失败怎么办"三件事。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CAP_CHARS,
  capText,
  isPurelyText,
  planCap,
  spillFileName,
  spillNotice,
  textOfContent,
  writeSpill,
} from '../lib/spill.js'

test('textOfContent：只拼文本块，忽略图片等非文本块', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOfContent([{ type: 'image', data: 'x' }]), '')
  assert.equal(textOfContent(undefined), '')
  assert.equal(textOfContent([null, { type: 'text', text: 'z' }]), 'z')
})

test('isPurelyText：含非文本块一律返回 false（不敢整体替换）', () => {
  assert.equal(isPurelyText([{ type: 'text', text: 'a' }]), true)
  assert.equal(isPurelyText([{ type: 'text', text: 'a' }, { type: 'image' }]), false)
  assert.equal(isPurelyText([]), false)
  assert.equal(isPurelyText(undefined), false)
})

test('planCap：没超上限不动', () => {
  assert.equal(planCap('short', { capChars: 100 }), undefined)
  assert.equal(planCap('x'.repeat(100), { capChars: 100 }), undefined, '正好等于上限也不动')
})

test('planCap：超了就截头留尾，且省下来的量算得对', () => {
  const text = `${'H'.repeat(5000)}${'M'.repeat(10000)}${'T'.repeat(2000)}`
  const plan = planCap(text, { capChars: 1000 })
  assert.ok(plan)
  assert.ok(plan.head.startsWith('HHHH'))
  assert.ok(plan.tail.endsWith('TTTT'))
  assert.equal(plan.dropped, text.length - plan.head.length - plan.tail.length)
  assert.ok(plan.dropped > 0)
  assert.ok(plan.head.length + plan.tail.length < 1000, '必须给提示行留位置')
  assert.ok(plan.head.length > plan.tail.length, '头部要留得比尾部多')
})

test('planCap：不劈开代理对（emoji 不会被切成半个）', () => {
  const text = '😀'.repeat(2000)
  const plan = planCap(text, { capChars: 100 })
  assert.ok(plan)
  assert.ok(!/[\uD800-\uDBFF]$/.test(plan.head), '头部不能以高位代理结尾')
  assert.ok(!/^[\uDC00-\uDFFF]/.test(plan.tail), '尾部不能以低位代理开头')
})

test('spillNotice：一行内说清省了多少、全文在哪、怎么取', () => {
  const notice = spillNotice({ dropped: 12345, path: '/tmp/x.txt', headChars: 10, tailChars: 5 })
  assert.match(notice, /12345 chars omitted/)
  assert.match(notice, /\/tmp\/x\.txt/)
  assert.match(notice, /offset\/limit or grep/)
  assert.ok(notice.length < 200, '这条提示挂在每一条被裁的结果上，必须短')
})

test('spillFileName：非法字符被换掉，长度有上限', () => {
  const name = spillFileName('sess/../../etc', 'call id:1', 0)
  assert.equal(name.includes('/'), false)
  assert.equal(name.includes('..'), false)
  assert.ok(name.length <= 110)
  assert.match(spillFileName('a', 'b', 2), /-2\.txt$/)
})

test('capText：全文落盘，替换文本里带路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'optimizer-spill-'))
  try {
    const text = 'A'.repeat(20000)
    const capped = capText({ text, dir, sessionId: 's1', callId: 'c1', capChars: 1000 })
    assert.ok(capped)
    assert.ok(capped.text.length < 1200)
    assert.ok(capped.text.includes(capped.path))
    assert.equal(await readFile(capped.path, 'utf8'), text, '盘上必须是**完整**全文')
    const plan = planCap(text, { capChars: 1000 })
    assert.equal(capped.dropped, plan.dropped, 'dropped 必须等于 planCap 算出来的正文字符数')
    assert.equal(capped.text, plan.head + spillNotice({ ...plan, path: capped.path }) + plan.tail)
    assert.ok(capped.dropped > 18000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeSpill：目录不存在会建；写不进去返回 undefined 而不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'optimizer-spill-'))
  try {
    const path = writeSpill(join(dir, 'deep', 'deeper'), 'a.txt', 'hello')
    assert.equal(typeof path, 'string')
    assert.equal(await readFile(path, 'utf8'), 'hello')
    assert.deepEqual(await readdir(join(dir, 'deep')), ['deeper'])
    // 目标是一个已存在的**文件**：mkdir 必然失败 → 必须优雅返回。
    const blocked = writeSpill(join(path, 'nope'), 'b.txt', 'x')
    assert.equal(blocked, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('capText：落盘失败时返回 undefined（不裁剪，也绝不抛）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'optimizer-spill-'))
  try {
    const file = join(dir, 'blocker')
    await writeSpill(dir, 'blocker', 'x')
    const capped = capText({ text: 'y'.repeat(5000), dir: file, sessionId: 's', callId: 'c', capChars: 100 })
    assert.equal(capped, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DEFAULT_CAP_CHARS 与内置裁剪器默认阈值一致（这是 cacheSafe 的算术前提）', () => {
  assert.equal(DEFAULT_CAP_CHARS, 8192)
})
