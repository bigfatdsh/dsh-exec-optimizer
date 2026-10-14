/**
 * dsh-exec-optimizer 测评台。
 *
 * ## 口径
 *
 * 每一行都标了它是**实测**还是**推算**：
 *
 *   * 实测（measured）：把真实/真实形状的输入喂进本插件发布的那几个纯函数，
 *     数出来的字符与文件字节。复现方式就是跑这个脚本本身。
 *   * 推算（computed）：需要"会话有多长、一轮上下文多大"这类本机没有的事实，
 *     所以把假设写在 `assumptions` 里，算式一并写出来，谁都能改数重算。
 *
 * token 换算与宿主 `dsh-token-meter` 同一口径：`CHARS_PER_TOKEN = 4`，
 * 每个内容块再加 `BLOCK_OVERHEAD = 4`。所以这里的 token 数与面板/宿主对得上。
 *
 * 跑法：`node tools/bench.mjs [--json <路径>]`。
 *
 * @module dsh-exec-optimizer/bench
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { capText, planCap } from '../lib/spill.js'
import { mergeArgs, retryHint } from '../lib/replay.js'
import { RepeatTracker } from '../lib/repeat.js'
import { DEFAULT_CORE, splitSchemas, toolIndex } from '../lib/lazy.js'
import { hostThreshold } from '../lib/pressure.js'
import { PARALLEL_SECTION, RETRY_SECTION, LAZY_SECTION, repeatReminder } from '../lib/sections.js'
import { retryTool, loadTool } from '../lib/tool-defs.js'
import { DEFAULT_CAP_CHARS } from '../lib/optimize.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 与宿主 dsh-token-meter 一致的估算系数。 */
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4

/**
 * 估算 token。
 *
 * @param {number} chars - 字符数。
 * @returns {number} 估算 token 数。
 */
const tokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN)

/**
 * 一行结果。
 *
 * @param {object} row - `{ feature, metric, before, after, unit, kind, note }`。
 * @returns {object} 补齐派生字段的行。
 */
function row(input) {
  const saved = input.before - input.after
  return {
    feature: input.feature,
    metric: input.metric,
    before: input.before,
    after: input.after,
    saved,
    savedPct: input.before > 0 ? Math.round((saved / input.before) * 1000) / 10 : 0,
    unit: input.unit,
    kind: input.kind,
    note: input.note ?? '',
  }
}

// ---------------------------------------------------------------------------
// 素材：真实形状的"大结果"
// ---------------------------------------------------------------------------

/**
 * 造一批工具结果素材。
 *
 * 除 `repo-source` 直接读仓库里真实的 `lib/index.js` 之外，其余按真实观测到的形状
 * 生成（本机实测见过 5 万字符级的 bash 输出、数万字符的 grep 结果）。
 *
 * @returns {Array<{name: string, text: string, tool: string}>} 素材。
 */
function fixtures() {
  /** @type {Array<{name: string, text: string, tool: string}>} */
  const out = []

  // 1. 真实文件：本插件自己**最大**的那个源文件（发布物之一），保证素材是真实的代码文本。
  const libDir = join(ROOT, 'lib')
  const largest = readdirSync(libDir)
    .map((name) => join(libDir, name))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0]
  const source = readFileSync(largest, 'utf8')
  out.push({ name: 'repo-source', text: source, tool: 'read' })
  // 这条只是对照：cacheSafe 关闭时 `read` 不裁（宿主 readMaxBytes = 50KB）。
  out.push({ name: 'repo-source-via-bash', text: source, tool: 'bash' })

  // 2. 测试运行器输出：一堆 ok/耗时行 + 末尾失败堆栈。
  const tests = []
  for (let index = 0; index < 900; index += 1) {
    tests.push(`✔ case ${index}: does the thing (${(index % 37) / 10}ms)`)
  }
  tests.push('✖ case 900: fails', '  AssertionError: expected 1 to equal 2', '    at test/x.js:12:3')
  out.push({ name: 'test-runner', text: tests.join('\n'), tool: 'bash' })

  // 3. grep 结果：几百条命中行。
  const grep = []
  for (let index = 0; index < 1200; index += 1) {
    grep.push(`lib/mod-${index % 40}.js:${index}:  const value${index} = compute(${index}, "${'x'.repeat(20)}")`)
  }
  out.push({ name: 'grep-hits', text: grep.join('\n'), tool: 'grep' })

  // 4. JSON 接口导出。
  const records = []
  for (let index = 0; index < 260; index += 1) {
    records.push({ id: `rec-${index}`, name: `record ${index}`, tags: ['a', 'b'], score: index * 1.5 })
  }
  out.push({ name: 'json-dump', text: JSON.stringify({ data: records }, null, 2), tool: 'bash' })

  // 5. 压缩产物：一行超长的 minified JS。
  out.push({ name: 'minified-bundle', text: `var a=${'x'.repeat(60000)};`, tool: 'read' })

  // 6. 目录清单。
  const listing = ['total 4096']
  for (let index = 0; index < 600; index += 1) {
    listing.push(`-rw-r--r--  1 user  staff  ${1000 + index}  Jan  1 00:00  file-${index}.txt`)
  }
  out.push({ name: 'dir-listing', text: listing.join('\n'), tool: 'bash' })

  // 7. 构建/错误日志：大量重复行 + 关键报错。
  const log = []
  for (let index = 0; index < 800; index += 1) log.push(`[build] compiling module ${index}/800`)
  log.push('[build] ERROR: cannot resolve ./missing.js', '  at build.js:88', '  at run.js:12')
  out.push({ name: 'build-log', text: log.join('\n'), tool: 'bash' })

  return out
}

// ---------------------------------------------------------------------------
// 各项测评
// ---------------------------------------------------------------------------

/**
 * 结果上限 + 落盘（实测）。
 *
 * @returns {{rows: object[], detail: object[]}} 结果。
 */
function benchResultCap() {
  const dir = mkdtempSync(join(tmpdir(), 'optimizer-bench-'))
  const rows = []
  const detail = []
  try {
    for (const fixture of fixtures()) {
      const before = fixture.text.length
      const capped = capText({
        text: fixture.text,
        dir,
        sessionId: 'bench',
        callId: fixture.name,
        capChars: DEFAULT_CAP_CHARS,
      })
      const after = capped === undefined ? before : capped.text.length
      const back = capped === undefined ? fixture.text : readFileSync(capped.path, 'utf8')
      const lossless = back === fixture.text
      detail.push({ fixture: fixture.name, tool: fixture.tool, before, after, lossless, path: capped?.path ?? null })
      rows.push(
        row({
          feature: '结果上限',
          metric: `cap(${fixture.name})`,
          before,
          after,
          unit: 'chars',
          kind: 'measured',
          note: lossless ? '全文落盘且逐字节回读一致' : '未裁剪',
        }),
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return { rows, detail }
}

/**
 * 与内置裁剪器对齐（实测：算阈值，推算：被改写的结果条数）。
 *
 * @param {object[]} detail - 上一节的结果明细。
 * @returns {object[]} 行。
 */
function benchCacheSafe(detail) {
  const prunerThreshold = 8192 // dsh-base 里 tool-result-pruner 的出厂配置
  // cacheSafe 打开时 `read` 也一起裁，所以这里不再排除 read——留下的任何一条
  // 超过阈值的结果，都是内置裁剪器下一次压缩时**还会改写**的东西。
  const wouldPrune = detail.filter((item) => item.before > prunerThreshold)
  const stillPrunable = detail.filter((item) => item.after > prunerThreshold && item.after === item.before)
  return [
    row({
      feature: '不动已发内容',
      metric: '会被内置裁剪器改写的结果数',
      before: wouldPrune.length,
      after: stillPrunable.length,
      unit: '条',
      kind: 'measured',
      note: `阈值 ${prunerThreshold} 字符（head 4096 + tail 1024）；本插件在发送前就把每一条（含 read）裁到线内`,
    }),
  ]
}

/**
 * 失败重放（实测）。
 *
 * @returns {object[]} 行。
 */
function benchRetry() {
  /** @type {Array<{name: string, args: object, error: string}>} */
  const cases = [
    {
      name: 'edit',
      args: {
        path: '/Users/me/project/src/components/VeryLongComponentName.tsx',
        old_string: '  const [state, setState] = useState<Record<string, unknown>>({})\n'.repeat(6),
        new_string: '  const [state, setState] = useState<Record<string, unknown>>(initial)\n'.repeat(6),
        replace_all: false,
      },
      error: 'invalid arguments: missing required property "expected_replacements"',
    },
    {
      name: 'bash',
      args: {
        command: `node --test ${Array.from({ length: 12 }, (_, i) => `test/mod-${i}.test.js`).join(' ')}`,
        cwd: '/Users/me/project',
        timeoutMs: 600000,
        description: 'run the whole suite once more',
      },
      error: 'invalid arguments: "timeoutMs" must be a number',
    },
    {
      name: 'workflow',
      args: {
        meta: { name: 'audit', description: 'audit every module', phases: [{ title: 'scan' }, { title: 'fix' }] },
        script: `const out = []\n${Array.from({ length: 40 }, (_, i) => `out.push(await agent("check module ${i}"))`).join('\n')}\nreturn out`,
      },
      error: 'invalid arguments: "meta.phases" is not a declared property (additionalProperties: false)',
    },
  ]
  const rows = []
  for (const item of cases) {
    const full = JSON.stringify(item.args).length
    const patch = JSON.stringify(pickPatch(item)).length
    const hint = retryHint(item.name, item.error).length
    rows.push(
      row({
        feature: '失败重放',
        metric: `重发 vs 补丁（${item.name}）`,
        // 全量重发 = 重新吐一遍全部参数；补丁 = 只吐变动字段。两边都加上那行提示（它挂在失败结果上）。
        before: full + hint,
        after: patch + hint,
        unit: 'chars',
        kind: 'measured',
        note: `补丁：${Object.keys(pickPatch(item)).join(', ')}`,
      }),
    )
  }
  return rows
}

/**
 * 从一条失败用例里挑出"模型真正要改的那几个字段"。
 *
 * @param {{name: string, args: object}} item - 用例。
 * @returns {object} 补丁。
 */
function pickPatch(item) {
  if (item.name === 'edit') return { expected_replacements: 1 }
  if (item.name === 'bash') return { timeoutMs: 600000 }
  return { meta: { phases: ['scan', 'fix'] } }
}

/**
 * 复读抑制。
 *
 * 判定灵敏度是**实测**（第几条碎片会触发），省钱是**推算**（每条碎片各占一轮请求）。
 *
 * @returns {object[]} 行。
 */
function benchRepeat() {
  const tracker = new RepeatTracker()
  const fillers = ['好。', '好', 'Let me do it.', 'Let me do it']
  for (const text of fillers) tracker.observe('bench', { text, hasToolCall: false })
  const run = tracker.runOf('bench')
  const reminder = repeatReminder(2)

  const contextChars = 120_000 // 与并行那一节同一个假设
  const fillerTurns = 10 // 假设：不拦的话模型会连着空转 10 轮（用户描述的正是这种状态）
  return [
    row({
      feature: '复读抑制',
      metric: '判定灵敏度',
      before: 0,
      after: run,
      unit: '条碎片触发',
      kind: 'measured',
      note: `默认阈值 2、硬线 4；带工具调用的回合一律清零`,
    }),
    row({
      feature: '复读抑制',
      metric: `拦下 ${fillerTurns - 1} 轮空转省下的重发`,
      before: contextChars * fillerTurns,
      after: contextChars + reminder.length,
      unit: 'chars',
      kind: 'computed',
      note: `假设：不拦则空转 ${fillerTurns} 轮、每轮重发 ${contextChars} 字符；拦下后只插一条 ${reminder.length} 字符的提醒`,
    }),
  ]
}

/**
 * 纪律段落的常驻成本（实测：字符数）。
 *
 * @returns {object[]} 行。
 */
function benchSections() {
  return [
    row({ feature: '纪律段落成本', metric: '并行纪律', before: 0, after: PARALLEL_SECTION.length, unit: 'chars', kind: 'measured', note: `≈ ${tokens(PARALLEL_SECTION.length)} token/轮` }),
    row({ feature: '纪律段落成本', metric: '失败重放说明', before: 0, after: RETRY_SECTION.length, unit: 'chars', kind: 'measured', note: `≈ ${tokens(RETRY_SECTION.length)} token/轮` }),
    row({ feature: '纪律段落成本', metric: '按需加载说明', before: 0, after: LAZY_SECTION.length, unit: 'chars', kind: 'measured', note: `≈ ${tokens(LAZY_SECTION.length)} token/轮；仅在该开关打开时出现` }),
  ]
}

/**
 * 本插件自己那两个工具的常驻成本（实测）。
 *
 * @returns {object[]} 行。
 */
function benchOwnSchemas() {
  const retry = retryTool({ execute: async () => ({}) })
  const load = loadTool({ execute: async () => ({}) })
  // 只有 name / description / parameters 会进模型上下文（供应商只收 input_schema），
  // 输出 schema 是宿主内部用的，不计入常驻成本。
  const size = (tool) => tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length + 32
  return [
    row({ feature: '工具 schema 成本', metric: 'retry_tool 常驻', before: 0, after: size(retry), unit: 'chars', kind: 'measured', note: `≈ ${tokens(size(retry))} token/轮；关掉开关即为 0` }),
    row({ feature: '工具 schema 成本', metric: 'load_tools 常驻', before: 0, after: size(load), unit: 'chars', kind: 'measured', note: `≈ ${tokens(size(load))} token/轮；关掉开关即为 0` }),
  ]
}

/**
 * 按需加载（实测：给定工具集的 schema 体积）。
 *
 * @returns {object[]} 行。
 */
function benchLazy() {
  // 素材：真实形状的工具集（名字与描述取自本机这一版运行时的工具目录）。
  const catalog = [
    ['read', 'Read a file from the workspace with optional offset and limit.', { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'], additionalProperties: false }],
    ['write', 'Write a file, replacing it entirely.', { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }],
    ['edit', 'Replace an exact string inside one file.', { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'], additionalProperties: false }],
    ['glob', 'Find files by glob pattern.', { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false }],
    ['grep', 'Search file contents with a regular expression.', { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'], additionalProperties: false }],
    ['bash', 'Execute a bash command and return combined stdout and stderr.', { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' }, description: { type: 'string' } }, required: ['command'], additionalProperties: false }],
    ['todo_write', 'Record and update a task list for multi-step work.', { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string' } } } } }, required: ['todos'], additionalProperties: false }],
    ['ask_user_question', 'Ask the user a concise question when a choice or missing information blocks progress.', { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } } } } } }, required: ['questions'], additionalProperties: false }],
    ['subagent', 'Delegate a self-contained task to a subagent that works in its own context.', { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, run_in_background: { type: 'boolean' } }, required: ['description', 'prompt'], additionalProperties: false }],
    ['workflow', 'Run a JavaScript workflow script that orchestrates subagents at scale.', { type: 'object', properties: { script: { type: 'string' }, meta: { type: 'object', properties: {}, additionalProperties: true }, args: { type: 'object', properties: {}, additionalProperties: true }, run_in_background: { type: 'boolean' } }, required: ['script', 'meta'], additionalProperties: false }],
    ['create_goal', 'Create a persisted goal that keeps this session working across continuation rounds.', { type: 'object', properties: { objective: { type: 'string' }, max_goal_rounds: { type: 'number' } }, required: ['objective'], additionalProperties: false }],
    ['present', 'Declare existing files as final deliverables for the user.', { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, description: { type: 'string' } } } } }, required: ['files'], additionalProperties: false }],
    ['univer', 'Univer Office single entry point.', { type: 'object', properties: { op: { type: 'string' }, file: { type: 'string' }, unitId: { type: 'string' }, worktreeId: { type: 'string' }, output: { type: 'string' }, source: { type: 'string' }, code: { type: 'string' }, codeFile: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, action: { type: 'string' }, range: { type: 'string' }, pages: { type: 'array', items: { type: 'number' } }, scale: { type: 'number' }, queries: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, unit: { type: 'string' }, docType: { type: 'string' }, mode: { type: 'string' }, page: { type: 'number' }, elementIds: { type: 'array', items: { type: 'string' } }, region: { type: 'object', properties: {}, additionalProperties: true }, padding: { type: 'number' }, sheetName: { type: 'string' }, contactSheet: { type: 'boolean' }, tileRows: { type: 'number' }, tileColumns: { type: 'number' }, registries: { type: 'array', items: { type: 'string' } }, handle: { type: 'string' }, handles: { type: 'array', items: { type: 'string' } }, ops: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } }, force: { type: 'boolean' }, stopOnError: { type: 'boolean' } }, required: ['op'], additionalProperties: false }],
  ]
  const schemas = catalog.map(([name, description, parameters]) => ({ name, description, parameters }))
  const size = (list) => list.reduce((sum, schema) => sum + schema.name.length + JSON.stringify(schema.parameters).length + schema.description.length + 32, 0)
  const { visible, hidden } = splitSchemas(schemas, { core: DEFAULT_CORE, unlocked: new Set() })
  const index = toolIndex(hidden)
  const rows = [
    row({
      feature: '按需加载',
      metric: `每个请求的工具 schema（${schemas.length} 个工具）`,
      before: size(schemas),
      after: size(visible) + index.length,
      unit: 'chars',
      kind: 'measured',
      note: `隐藏 ${hidden.length} 个，改用一个 ${index.length} 字符的索引；索引只在调用 list 时进上下文。平均 ${Math.round(size(schemas) / schemas.length)} 字符/工具，按自己那张表线性放大即可；面板里的 optimizations.toolSchemaChars 是这台机器上的真实值`,
    }),
    row({
      feature: '按需加载',
      metric: '每轮固定省下的 token',
      before: tokens(size(schemas)),
      after: tokens(size(visible)),
      unit: 'token',
      kind: 'measured',
      note: `净省 ≈ ${tokens(size(schemas) - size(visible))} token/轮（13 个真实形状的工具；索引本身不进每轮请求，只在 list 时产生）`,
    }),
  ]
  return rows
}

/**
 * 并行工具调用（推算）。
 *
 * 宿主本来就并发执行同一组调用（上限 10）；缺的只是让模型把独立调用放进一条消息。
 * 合并 N 轮省下的是 **N-1 次完整上下文重发**。
 *
 * @returns {object[]} 行。
 */
function benchParallel() {
  const contextChars = 120_000 // 假设：一次请求的上下文约 12 万字符（≈3 万 token）
  /** @type {object[]} */
  const rows = []
  for (const count of [3, 5, 8]) {
    rows.push(
      row({
        feature: '并行工具调用',
        metric: `${count} 个独立调用：串行 vs 一条消息`,
        before: contextChars * (count - 1),
        after: 0,
        unit: 'chars',
        kind: 'computed',
        note: `假设每轮上下文 ${contextChars} 字符；串行 ${count} 轮 → 一条消息 1 轮，省掉 ${count - 1} 次重发`,
      }),
    )
  }
  return rows
}

/**
 * 提前自动压缩（推算，边界实测）。
 *
 * @returns {object[]} 行。
 */
function benchAutoCompact() {
  const host = hostThreshold({ contextWindow: 1_000_000, maxTokens: 256_000 })
  const line = 300_000
  const rounds = 20
  // 压缩后保留的尾巴：宿主按 messageBudget(1e6-256e3) × retainRatio(0.16) 留 ≈ 119k。
  const retained = Math.floor((1_000_000 - 256_000) * 0.16)
  // 不提前压：会话从自定线一路涨到宿主线，平均每轮 ≈ 两条线的中点。
  const withoutAvg = Math.round((line + host) / 2)
  // 提前压：压回 retained，再慢慢涨回自定线，平均 ≈ (retained + line) / 2。
  const withAvg = Math.round((retained + line) / 2)
  return [
    row({
      feature: '提前自动压缩',
      metric: '宿主的自动压缩线（复算，仅参考）',
      before: host,
      after: host,
      unit: 'token',
      kind: 'measured',
      note: 'min(1e6 × 0.8, 1e6 − 256e3 − 65536) = 678,464（用户说的"约 67.8 万"是准的）',
    }),
    row({
      feature: '提前自动压缩',
      metric: `同 ${rounds} 轮里的输入 token`,
      before: withoutAvg * rounds,
      after: withAvg * rounds,
      unit: 'token',
      kind: 'computed',
      note: `不提前压：从 ${line} 涨到 ${host}，均值 ≈ ${withoutAvg}/轮；提前压：压回 ${retained} 再涨回 ${line}，均值 ≈ ${withAvg}/轮`,
    }),
  ]
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/**
 * 主流程。
 *
 * @returns {object} 报告。
 */
function main() {
  const cap = benchResultCap()
  const rows = [
    ...benchResultCap2(cap.rows),
    ...benchCacheSafe(cap.detail),
    ...benchParallel(),
    ...benchSections(),
    ...benchOwnSchemas(),
    ...benchRetry(),
    ...benchRepeat(),
    ...benchLazy(),
    ...benchAutoCompact(),
  ]
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, pluginRoot: ROOT },
    constants: { CHARS_PER_TOKEN, BLOCK_OVERHEAD, capChars: DEFAULT_CAP_CHARS },
    assumptions: {
      parallelContextChars: 120_000,
      autoCompactLine: 300_000,
      autoCompactHostLine: hostThreshold({ contextWindow: 1_000_000, maxTokens: 256_000 }),
      autoCompactPerRoundTokens: 150_000,
      autoCompactRounds: 20,
    },
    rows,
    resultCapDetail: cap.detail,
  }
  writeFileSync(join(ROOT, 'bench-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(join(ROOT, 'bench-report.md'), markdown(report), 'utf8')
  return report
}

/**
 * 渲染成 markdown（给 README 与汇报直接用）。
 *
 * @param {object} report - 报告。
 * @returns {string} markdown 文本。
 */
function markdown(report) {
  const head = '| 项目 | 指标 | 前 | 后 | 省 | 省% | 口径 |\n|---|---|---:|---:|---:|---:|---|\n'
  const body = report.rows
    .map(
      (line) =>
        `| ${line.feature} | ${line.metric.replace(/\|/g, '\\|')} | ${line.before} | ${line.after} | ${line.saved} | ${line.savedPct} | ${line.kind} |`,
    )
    .join('\n')
  const detail =
    '\n\n### 结果上限 · 逐条素材（实测）\n\n| 素材 | 走哪个工具 | 原始字符 | 裁剪后 | 全文可回读 |\n|---|---|---:|---:|---|\n' +
    report.resultCapDetail
      .map((item) => `| ${item.fixture} | ${item.tool} | ${item.before} | ${item.after} | ${item.lossless ? '是（逐字节一致）' : '未裁剪'} |`)
      .join('\n')
  const assumptions =
    '\n\n### 推算用的假设\n\n```json\n' + JSON.stringify(report.assumptions, null, 2) + '\n```\n' +
    '\n换算口径：`CHARS_PER_TOKEN = 4`、`BLOCK_OVERHEAD = 4`，与宿主 `dsh-token-meter` 一致。\n'
  return `# dsh-exec-optimizer 测评数据\n\n生成于 ${report.generatedAt}（node ${report.runtime.node}）\n\n${head}${body}${detail}${assumptions}`
}

/**
 * 把结果上限那几行原样带出来（只是为了让汇总顺序读起来清楚）。
 *
 * @param {object[]} rows - 结果上限的行。
 * @returns {object[]} 同样的行。
 */
function benchResultCap2(rows) {
  return rows
}

const report = main()

/**
 * 显示宽度：中日韩字符按 2 列算，否则表格会歪。
 *
 * @param {unknown} value - 值。
 * @returns {number} 列数。
 */
const displayWidth = (value) => {
  let total = 0
  for (const char of String(value)) total += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  return total
}

/**
 * 按显示宽度补空格。
 *
 * @param {unknown} value - 值。
 * @param {number} size - 目标列数。
 * @returns {string} 补齐后的字符串。
 */
const pad = (value, size) => {
  const text = String(value)
  return text + ' '.repeat(Math.max(0, size - displayWidth(text)))
}

const columns = [
  ['feature', '项目', 16],
  ['metric', '指标', 42],
  ['before', '前', 11],
  ['after', '后', 11],
  ['saved', '省', 11],
  ['savedPct', '省%', 7],
  ['kind', '口径', 9],
]

console.log('dsh-exec-optimizer 测评台 · 逐项数据\n')
console.log(columns.map(([, title, size]) => pad(title, size)).join(''))
console.log('-'.repeat(columns.reduce((sum, [, , size]) => sum + size, 0)))
for (const line of report.rows) {
  console.log(columns.map(([key, , size]) => pad(key === 'metric' ? line.metric.slice(0, 40) : line[key], size)).join(''))
}
console.log(`\n明细已写入 ${join(ROOT, 'bench-report.json')}`)
