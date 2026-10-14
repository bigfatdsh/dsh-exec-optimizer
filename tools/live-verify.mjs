/**
 * 真宿主装配验证：把插件按**真实的 cordis 加载路径**挂到真实的 dsh-system-prompt +
 * dsh-tools 上跑一遍。
 *
 * 单元测试用的是假宿主，能验证"逻辑对不对"；这个脚本验证的是"契约对不对"——
 * 真 `ctx.plugin()` 的 fiber 语义、真的 schema 校验、真的瀑布派发、真的 `register()`
 * 前置条件。这是在不重启 GUI 的前提下能做到的最强验证。
 *
 * 跑法：node tools/live-verify.mjs [--runtime <node_modules 路径>]
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeArg = process.argv.indexOf('--runtime')
const RUNTIME = runtimeArg > 0 ? process.argv[runtimeArg + 1] : '/tmp/dsh-fix/dsh/node_modules'

/**
 * 按绝对路径加载宿主包（插件在真实运行时不 import 它们，这里只是为了拉起真宿主）。
 *
 * @param {string} name - 包名。
 * @returns {Promise<any>} 模块。
 */
const load = (name) => import(pathToFileURL(join(RUNTIME, name, 'lib/index.js')).href)

const checks = []
/**
 * 记一条结果。
 *
 * @param {string} name - 检查项。
 * @param {Function} fn - 断言体。
 * @returns {Promise<void>} 完成。
 */
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: error?.stack ?? String(error) })
  }
}

/** 每次工具调用都要一个真的 AbortSignal：宿主会读 `signal.aborted`。 */
const liveSignal = new AbortController().signal

const home = mkdtempSync(join(tmpdir(), 'optimizer-live-'))
process.env.DSH_HOME = home

const { Context, Service } = await load('@deepseek-ai/cordis')
const systemPromptModule = await load('@deepseek-ai/dsh-system-prompt')
const toolsModule = await load('@deepseek-ai/dsh-tools')
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

console.log(`真宿主：${RUNTIME}（配置：${process.argv.includes('--defaults') ? '全默认' : '额外打开 lazyTools'}）`)
console.log(`临时 DSH_HOME：${home}\n`)

/** 一个最小的 webServer 替身：插件的 `inject` 里有它，缺了 fiber 会一直等。 */
class FakeWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
  }

  /**
   * @returns {() => void} 退订。
   */
  register() {
    return () => {}
  }
}

const ctx = new Context()
ctx.plugin(systemPromptModule.default ?? systemPromptModule)
ctx.plugin(toolsModule.default ?? toolsModule)
ctx.plugin(FakeWebServer)
await new Promise((resolve) => setTimeout(resolve, 80))

// `--defaults` 跑**一个键都不传**的那一档（全默认：五个开、三个关）。
// 默认那一档额外把 lazyTools 打开，好把"按需加载"整条链路也验一遍。
const useDefaults = process.argv.includes('--defaults')
const pluginConfig = useDefaults ? {} : { log: false, lazyToolsDefault: true }

// **真实的加载路径**：cordis 的 fiber，而不是裸调 apply()。
const fiber = ctx.plugin(plugin, pluginConfig)
await new Promise((resolve) => setTimeout(resolve, 120))

console.log(`插件 fiber 状态：${fiber?.state?.name ?? 'unknown'}\n`)

/** 探针工具：**不在**核心集里，用来验证"隐藏 → 列表 → 解锁"这一整条路。 */
const PROBE_TEXT = 'P'.repeat(30000)
// 从服务取（而不是 `ctx.tools` 属性访问）：属性访问在根上下文上会走 cordis 的 shadow
// 代理，脚本层直接调用会踩到它的内部断言。服务本体是同一个。
ctx.get('tools').register({
  name: 'live_probe',
  description: 'probe',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  async execute() {
    return PROBE_TEXT
  },
  isConcurrencySafe: () => true,
})
await new Promise((resolve) => setTimeout(resolve, 50))

await check('真 fiber 下纪律段落注册了，且能装配出来', async () => {
  const assembly = await ctx.systemPrompt.assemble({})
  const names = assembly.sections.map((section) => section.name)
  assert.ok(names.includes('exec-optimizer:discipline'), `段落名：${names.join(', ')}`)
})

await check('纪律段落的英文正文出现在真实装配结果里', async () => {
  const assembly = await ctx.systemPrompt.assemble({})
  const text = assembly.sections.map((section) => section.text).join('\n')
  assert.match(text, /Tool batching/)
  assert.match(text, /retry_tool/)
  // 按需加载说明只在那个开关打开时出现——`--defaults` 那一档它**必须缺席**。
  assert.equal(/Tool disclosure/.test(text), !useDefaults)
})

await check('真实 tools 服务接受了本插件注册的工具（schema 校验通过）', () => {
  const names = ctx.tools.schemas().map((schema) => schema.name)
  assert.ok(names.includes('retry_tool'), `工具：${names.join(', ')}`)
  assert.equal(names.includes('load_tools'), useDefaults === false, `工具：${names.join(', ')}`)
})

await check('工具定义形状完整（register 的前置条件）', () => {
  for (const name of useDefaults ? ['retry_tool'] : ['retry_tool', 'load_tools']) {
    const tool = ctx.tools.get(name)
    assert.equal(typeof tool?.output?.render, 'function', `${name}.output.render`)
    assert.equal(typeof tool?.execute, 'function', `${name}.execute`)
    assert.equal(tool.parameters.type, 'object', `${name}.parameters.type`)
  }
})

await check('load_tools 的取回路径在真宿主上真的能用（列出 → 解锁）', async () => {
  if (useDefaults) return
  const agent = { id: 'live-agent', session: { id: 'live-agent', requestHeader: () => ({ config: {} }) } }
  const toolsSvc = ctx.get('tools')
  const listed = await toolsSvc.get('load_tools').execute({ list: true }, { agent, signal: liveSignal })
  assert.match(listed.text, /Available but not loaded/, `索引正文：${listed.text}`)
  assert.match(listed.text, /live_probe/, `非核心工具必须出现在索引里：${listed.text}`)
  const loaded = await toolsSvc.get('load_tools').execute({ names: ['live_probe'] }, { agent, signal: liveSignal })
  assert.match(loaded.text, /Loaded: live_probe/)
  // 解锁之后必须真的进入这一轮的装配结果。
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  assert.ok(assembly.tools.some((schema) => schema.name === 'live_probe'), '解锁后必须出现')
})

await check('真 ToolRuntime 上跑一次 execute：长结果被裁、全文可回读', async () => {
  const agent = { id: 'live-agent', session: { id: 'live-agent', requestHeader: () => ({ config: {} }) } }
  const result = await ctx.get('tools').execute({ callId: 'live-1', name: 'live_probe', arguments: {}, agent, signal: liveSignal })
  assert.equal(result.isError, false, JSON.stringify(result).slice(0, 300))
  const out = result.content.map((block) => block.text ?? '').join('')
  assert.ok(out.length < 9500, `裁剪后长度 ${out.length}，没裁到位`)
  assert.match(out, /chars omitted by dsh-exec-optimizer/)
  assert.match(out, /Full text:/)
})

await check('按需加载的过滤在真装配里生效：核心工具留下，其余被挡', async () => {
  if (useDefaults) return
  const probeAgent = { id: 'other-agent', session: { id: 'other-agent', requestHeader: () => ({ config: {} }) } }
  const assembly = await ctx.systemPrompt.assemble({ scope: probeAgent })
  const names = assembly.tools.map((schema) => schema.name)
  const all = ctx.tools.schemas().map((schema) => schema.name)
  console.log(`  装配工具表：${names.join(', ') || '(空)'}`)
  console.log(`  注册表全量：${all.join(', ') || '(空)'}`)
  assert.ok(names.includes('load_tools'), `核心工具必须留下：${names.join(', ')}`)
  assert.ok(names.includes('retry_tool'), `核心工具必须留下：${names.join(', ')}`)
  assert.ok(names.length < ctx.tools.schemas().length, '应当有工具被藏起来')
})

await check('插件没有把宿主搞崩：两个服务都还在、fiber 是 active', () => {
  assert.ok(ctx.get('systemPrompt'))
  assert.ok(ctx.get('tools'))
  assert.notEqual(fiber?.state?.name, 'failed', `fiber：${fiber?.state?.name}`)
})

// ---------------------------------------------------------------------------

let failed = 0
for (const item of checks) {
  if (item.ok) {
    console.log(`✔ ${item.name}`)
  } else {
    failed += 1
    console.log(`✖ ${item.name}\n${item.error}\n`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
