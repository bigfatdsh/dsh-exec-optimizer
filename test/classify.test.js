/**
 * 判定表：一组真实请求 → 期望的轻重组。
 *
 * 这张表就是"auto"的全部语义。改任何权重都必须先改这里，测试会立刻告诉你哪类活
 * 被抬高了或压低了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUCKETS, classifyMessage, classifyText, scoreText } from '../lib/classify.js'

/**
 * 期望：客套 → 最省；提问 → 轻；要动手 → 标准；大工程 / 明确要"做到极致" → 重。
 *
 * 长度权重从 21 字起算（+2），所以除客套外几乎每条真实请求都至少 +2 —— 这是刻意的：
 * 那一档的含义是"这不是一句客套"，不是"这句话很长"。
 */
const CASES = [
  // 纯客套，且整句很短
  ['你好', 'quiet'],
  ['hi', 'quiet'],
  ['谢谢！', 'quiet'],
  ['好的', 'quiet'],
  ['嗯嗯', 'quiet'],

  // 提问、轻活
  ['什么是事件循环？', 'light'],
  ['React 和 Vue 有什么区别', 'light'],
  ['解释一下 CAP 定理', 'light'],
  ['看看这个文件', 'light'],
  ['总结一下这篇文章', 'light'],

  // 明确要动手
  ['帮我改一下这个函数的名字', 'standard'],
  ['把这个 csv 转成 json', 'standard'],
  ['帮我写一个 Python 脚本统计词频', 'standard'],
  ['修复 src/utils/date.ts 里的时区 bug', 'standard'],
  ['package.json 里的依赖版本帮我升级一下', 'standard'],
  ['帮我看看日志里有没有报错', 'standard'],
  ['应用启动就崩溃了，日志里全是异常堆栈，帮我定位一下', 'standard'],

  // 大工程
  ['帮我从零搭建一套订单系统的架构设计，要考虑分库分表和缓存策略', 'heavy'],
  ['给我一份全面的代码审查报告，逐项列出安全审计结果和性能瓶颈', 'heavy'],
  ['把整个项目从 webpack 迁移到 vite，包含所有插件的兼容性处理', 'heavy'],

  // 明确要求质量优先 / 要验收 / 有交付后果
  ['做一份极致的方案，要全面、逐项核对，最后交付给客户', 'heavy'],
  ['这份方案下周要交付给客户，请逐项核对每个数据', 'heavy'],
]

/** 只报分、不报组的用例：钉住权重本身，改权重时先看这里。 */
const SCORES = [
  // [文本, 期望分数]
  ['你好', 0],
  ['什么是事件循环？', 2],
  ['生成一个ppt', 2],
  ['做一份极致的方案', 3],
  ['我要极致的效果', 3],
]


test('判定表', () => {
  for (const [text, expected] of CASES) {
    const actual = classifyText(text)
    assert.equal(actual, expected, `"${text}" → ${actual}（期望 ${expected}）`)
  }
})

test('分数表（钉住权重本身）', () => {
  for (const [text, expected] of SCORES) {
    const actual = scoreText(text).total
    assert.equal(actual, expected, `"${text}" → ${actual} 分（期望 ${expected}）`)
  }
})

test('长度权重只取最高一档，不叠乘', () => {
  // 21 字起 +2；200 字起 +6；800 字起 +10。同内容、只改长度，分数必须只落一档。
  const short = scoreText('嗯'.repeat(10)).total
  const mid = scoreText('嗯'.repeat(60)).total
  const longer = scoreText('嗯'.repeat(300)).total
  const longest = scoreText('嗯'.repeat(900)).total
  assert.equal(short, 0, '基准：10 个"嗯"不带任何信号分')
  assert.equal(mid, 2, '21 字起只加 2（不该把 200 字的 6 分也叠上）')
  assert.equal(longer, 6, '200 字起只加 6')
  assert.equal(longest, 10, '800 字起只加 10')
})

test('极致类修饰词一票给 3 分', () => {
  for (const text of ['做一份极致的方案', '我要极致的效果', '这个要做得完美一点']) {
    assert.equal(scoreText(text).total, 3, text)
    assert.ok(scoreText(text).signals.includes('quality'), text)
  }
})

test('所有返回值都落在已知组里', () => {
  for (const [text] of CASES) assert.ok(BUCKETS.includes(classifyText(text)), text)
})

test('空消息保持上一轮，没有上一轮就用标准档', () => {
  assert.deepEqual(classifyMessage('   '), { bucket: 'standard', inherited: false })
  assert.deepEqual(classifyMessage('', { bucket: 'heavy' }), { bucket: 'heavy', inherited: true })
})

test('短追问继承上一轮，且重活不会被继承成轻活', () => {
  const follow = classifyMessage('继续', { bucket: 'heavy' })
  assert.equal(follow.inherited, true)
  assert.equal(follow.bucket, 'standard', '重活续跑不该掉到轻档')

  assert.equal(classifyMessage('那这个呢', { bucket: 'standard' }).bucket, 'standard')
  assert.equal(classifyMessage('再来一次', { bucket: 'light' }).bucket, 'light')
  assert.equal(classifyMessage('继续', { bucket: 'quiet' }).bucket, 'quiet')
})

test('带完整句子的追问不继承，按自己的内容判', () => {
  const judged = classifyMessage('帮我从零重写整个鉴权模块', { bucket: 'quiet' })
  assert.equal(judged.inherited, false)
  assert.equal(judged.bucket, 'heavy')
})

test('长文本自动加分', () => {
  const body = '嗯。'.repeat(300)
  assert.notEqual(classifyText(body), 'quiet')
  assert.equal(classifyText(`随便说说：${body}`), 'standard')
})

test('超长输入只扫前 8000 字符（有界）', () => {
  const huge = '帮我改代码。'.repeat(50_000)
  const started = Date.now()
  const bucket = classifyText(huge)
  assert.ok(Date.now() - started < 200, '判定必须是毫秒级')
  assert.ok(BUCKETS.includes(bucket))
})

test('判定是纯函数：同一输入两次结果一致', () => {
  for (const [text] of CASES) assert.equal(classifyText(text), classifyText(text))
})
