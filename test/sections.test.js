/**
 * 纯逻辑：交给模型的几段文字。
 *
 * 这些文字**常驻系统提示词**，所以本文件同时盯住两件事：说清了该说的，
 * 以及**足够短**（一句常驻的话，如果比它省下的还贵，就该删掉）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LAZY_SECTION,
  batchingReminder,
  PARALLEL_SECTION,
  RETRY_SECTION,
  compactedNotice,
  repeatReminder,
  resolveDiscipline,
} from '../lib/sections.js'

test('并行纪律：说清"合并进一条消息"，并给出具体例子', () => {
  assert.match(PARALLEL_SECTION, /one assistant message/)
  assert.match(PARALLEL_SECTION, /several reads/)
  assert.match(PARALLEL_SECTION, /results come back in order/)
  assert.match(PARALLEL_SECTION, /Serialize only when/, '必须说清唯一的例外，否则模型会过度合并')
})

test('三段文字都短到值回票价（常驻成本纪律）', () => {
  // 中文注释不计入这里的预算：这些是**模型看到的英文**。
  assert.ok(PARALLEL_SECTION.length < 700, `并行段落 ${PARALLEL_SECTION.length} 字符，太长了`)
  assert.ok(LAZY_SECTION.length < 700, `按需加载段落 ${LAZY_SECTION.length} 字符，太长了`)
  assert.ok(RETRY_SECTION.length < 800, `重放段落 ${RETRY_SECTION.length} 字符，太长了`)
})

test('resolveDiscipline：按开关拼装，全关时是空串', () => {
  assert.equal(resolveDiscipline({}), '')
  assert.equal(resolveDiscipline({ parallel: false, retry: false, lazy: false }), '')
  assert.equal(resolveDiscipline(undefined), '')
  assert.equal(resolveDiscipline({ parallel: true }), PARALLEL_SECTION)
  const all = resolveDiscipline({ parallel: true, retry: true, lazy: true })
  assert.ok(all.includes(PARALLEL_SECTION))
  assert.ok(all.includes(RETRY_SECTION))
  assert.ok(all.includes(LAZY_SECTION))
  // 顺序固定：开关不变时逐字节稳定，不产生额外缓存失效。
  assert.equal(all, resolveDiscipline({ parallel: true, retry: true, lazy: true }))
})

test('复读提醒：两轮与三轮以上语气不同，且都要求"别复述任务"', () => {
  const mild = repeatReminder(2)
  const hard = repeatReminder(3)
  assert.match(mild, /no tool call and no new content/)
  assert.match(mild, /Do not restate the task/)
  assert.match(hard, /3 consecutive/)
  assert.match(hard, /Stop narrating/)
  assert.notEqual(mild, hard)
  assert.ok(hard.length < 400)
})

test('压缩说明：说清"压到多少"和"从摘要继续"', () => {
  const notice = compactedNotice(312_345)
  assert.match(notice, /312345/)
  assert.match(notice, /auto-compacted early/)
  assert.ok(notice.length < 220)
})

test('并行纠偏提醒：点名工具与步数，要求"列清单再一次发"', () => {
  const text = batchingReminder(3, 'read')
  assert.match(text, /3 steps in a row/)
  assert.match(text, /`read` call/)
  assert.match(text, /ONE assistant message/)
  assert.ok(text.length < 420)
})
