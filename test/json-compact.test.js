/**
 * 纯逻辑：JSON 紧凑化。
 *
 * 这一层不碰宿主，只回答三件事：什么时候压、压得对不对、会不会把数据改坏。
 * "对"的标准是**字节级保真**：字符串内部一个字节都不能动，数字原样保留。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactJsonContent,
  compactJsonText,
  stripJsonWhitespace,
} from '../lib/json-compact.js'

const pretty = `{
  "code": 0,
  "data": {
    "list": [
      { "id": 1, "name": "a" },
      { "id": 2, "name": "b" }
    ]
  }
}`

test('常态：缩进与换行被去掉，仍是同一份 JSON', () => {
  const result = compactJsonText(pretty, { minChars: 0 })
  assert.ok(result !== null)
  assert.equal(result.text, '{"code":0,"data":{"list":[{"id":1,"name":"a"},{"id":2,"name":"b"}]}}')
  assert.deepEqual(JSON.parse(result.text), JSON.parse(pretty))
  assert.equal(result.saved, pretty.length - result.text.length)
})

test('字符串内部的空白与转义一个字节都不动', () => {
  const text = `{
    "a": "two  spaces\\tand a tab\\tinside",
    "b": "brace } and bracket ] and quote \\" inside",
    "c": "中文 空白 也要 保留"
  }`
  const result = compactJsonText(text, { minChars: 0 })
  assert.ok(result !== null)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.a, 'two  spaces\tand a tab\tinside')
  assert.equal(parsed.b, 'brace } and bracket ] and quote " inside')
  assert.equal(parsed.c, '中文 空白 也要 保留')
})

test('数字原样保留：1.0 不变成 1，大整数不丢精度', () => {
  const text = `{
    "float": 1.0,
    "exponent": 1e21,
    "big": 12345678901234567890,
    "negative": -0.000001,
    "zero": -0
  }`
  const result = compactJsonText(text, { minChars: 0, minSaving: 0 })
  assert.ok(result !== null)
  assert.match(result.text, /"float":1\.0/)
  assert.match(result.text, /"exponent":1e21/)
  assert.match(result.text, /"big":12345678901234567890/)
  assert.match(result.text, /"negative":-0\.000001/)
  assert.match(result.text, /"zero":-0/)
})

test('紧凑化是幂等的：压过的再压，返回 null', () => {
  const once = compactJsonText(pretty, { minChars: 0 })
  assert.ok(once !== null)
  assert.equal(compactJsonText(once.text, { minChars: 0 }), null)
})

test('不适用的情况一律返回 null', () => {
  const cases = [
    'not json at all',
    '{"a":1} trailing text',
    '{"a":1,}', // 严格 JSON 不接受尾逗号
    '{"a":1}\n{"b":2}', // NDJSON
    '<path>/tmp/a.txt</path>\n{"a":1}',
    '[' .repeat(200), // 不闭合
  ]
  for (const text of cases) assert.equal(compactJsonText(text), null, JSON.stringify(text.slice(0, 40)))
})

test('纯空白填充的合法 JSON 会被压（这正是要省的情形）', () => {
  const text = '{"a":' + ' '.repeat(600) + '1}'
  const result = compactJsonText(text)
  assert.ok(result !== null)
  assert.equal(result.text, '{"a":1}')
})

test('短于门槛、或收益不足 1% 的块不动', () => {
  assert.equal(compactJsonText('{"a": 1}'), null)
  const nearlyMinified = `{"padding":"${'x'.repeat(600)}", "n": 1}`
  // 只省两个空格（< 2%），不折腾。
  assert.equal(compactJsonText(nearlyMinified), null)
})

test('BOM 与首尾空白会被处理，中间内容不受影响', () => {
  const text = `\uFEFF\n  ${pretty}\n\n`
  const result = compactJsonText(text, { minChars: 0 })
  assert.ok(result !== null)
  assert.equal(result.text[0], '{')
  assert.deepEqual(JSON.parse(result.text), JSON.parse(pretty))
})

test('顶层是数组也能压', () => {
  const text = `[
    { "a": 1 },
    { "b": 2 }
  ]`
  const result = compactJsonText(text, { minChars: 0 })
  assert.ok(result !== null)
  assert.equal(result.text, '[{"a":1},{"b":2}]')
})

test('stripJsonWhitespace：字符串里的空白不动，字符串外的四种空白全去掉', () => {
  assert.equal(stripJsonWhitespace('{"a": "x  y"}'), '{"a":"x  y"}')
  assert.equal(stripJsonWhitespace('{"a":\t"x"}\r\n'), '{"a":"x"}')
})

test('compactJsonContent：只动文本块，富内容与顺序原样保留', () => {
  const image = { type: 'image', source: { data: 'AAAA' } }
  const blocks = [
    { type: 'text', text: pretty },
    image,
    { type: 'text', text: 'not json' },
  ]
  const result = compactJsonContent(blocks, { minChars: 0 })
  assert.equal(result.changed, true)
  assert.equal(result.saved, pretty.length - compactJsonText(pretty, { minChars: 0 }).text.length)
  assert.equal(result.content[0].type, 'text')
  assert.equal(result.content[1], image)
  assert.equal(result.content[2].text, 'not json')
  assert.equal(result.content.length, 3)
})

test('compactJsonContent：没有可压的块时原数组返回，changed=false', () => {
  const blocks = [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]
  const result = compactJsonContent(blocks)
  assert.equal(result.changed, false)
  assert.equal(result.saved, 0)
  assert.equal(result.content, blocks)
})

test('内容块不是数组时不抛错', () => {
  for (const value of [null, undefined, 'text', 42, {}]) {
    assert.deepEqual(compactJsonContent(value), { content: value, changed: false, saved: 0 })
  }
})

test('深度嵌套与大量元素：结果永远不大于原文，且可解析', () => {
  let deep = '1'
  for (let index = 0; index < 400; index += 1) deep = `[ ${deep} ]`
  const wide = JSON.stringify(Array.from({ length: 400 }, (_, index) => ({ index })), null, 2)
  for (const text of [deep, wide]) {
    const result = compactJsonText(text)
    if (result !== null) {
      assert.ok(result.text.length <= text.length)
      assert.doesNotThrow(() => JSON.parse(result.text))
    }
  }
})
