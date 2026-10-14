/**
 * 交给模型的几段纪律文字（都进系统提示词，所以每一句都要挣回自己）。
 *
 * ## 为什么并行纪律不需要"批量工具"
 *
 * 宿主的循环本来就支持一条助手消息里的多个工具调用：`executeToolCalls` 会把同一
 * 组里声明了 `isConcurrencySafe` 的调用并发跑（上限 10），结果按模型顺序落库。
 * 缺的不是机制，是**让模型这么做**。所以这里只加文字，不加工具——加一个工具等于
 * 每一轮请求都多背一份 schema，反而更贵。
 *
 * ## 为什么"按需加载"那段必须和插件一起开
 *
 * 只藏 schema、不告诉模型怎么取回来，模型只会瞎猜工具名。两段文字必须成对出现，
 * 而且只在开关打开时出现：开关不变时逐字节稳定，不产生额外缓存失效。
 *
 * @module dsh-exec-optimizer/sections
 */

/**
 * 并行纪律：独立调用合并成一条消息。
 *
 * 措辞刻意用"必须"和具体例子：模型对抽象原则的执行率远低于对例子的执行率。
 */
export const PARALLEL_SECTION = [
  '## Tool batching (mandatory)',
  '',
  'Independent tool calls MUST share one assistant message. Before calling, list what you need;',
  'whenever two or more calls do not depend on each other, emit them together in the same message.',
  'Typical batches: several reads, a read plus a grep plus a glob for one question, several',
  'independent greps, several unrelated shell probes.',
  'Calls in one message run concurrently and their results come back in order, so batching costs',
  'nothing and saves a full round trip each time.',
  'Serialize only when a later argument is literally derived from an earlier result.',
].join('\n')

/**
 * 按需加载的用法说明。**只有 lazyTools 打开时才注入**。
 */
export const LAZY_SECTION = [
  '## Tool disclosure',
  '',
  'Only the core tools are listed. The rest still exist and are still callable, but their schemas',
  'are not sent to save tokens. Use `load_tools` to reach them:',
  '`load_tools({"list": true})` prints a one-line index of every other tool;',
  '`load_tools({"names": ["a", "b"]})` adds those schemas to your tool list from the next step on.',
  'Load the ones you need as soon as you know you need them, then call them normally.',
].join('\n')

/**
 * 失败重放的用法说明。**只有 retry 打开时才注入**。
 *
 * 放在系统提示词里而不是每条报错后面，是因为报错后面每加一个字都要在每个失败上重复付钱；
 * 提示词里只说一次，长期更便宜。
 */
export const RETRY_SECTION = [
  '## Cheap retry',
  '',
  'When a tool call fails on its arguments, do not re-emit the whole call. Replay it with only the',
  'changed fields: `retry_tool({"patch": {"the_bad_field": <fixed value>}})`. The patch is merged',
  'into the failed call\'s arguments (objects merge deeply, `null` deletes a field). Pass `args`',
  'instead of `patch` to replace the arguments outright, and `name` to pick an earlier failed call.',
].join('\n')

/**
 * 复读抑制时插给模型的话。
 *
 * @param {number} run - 连续"空转"的助手回合数。
 * @returns {string} 要插进对话的提醒正文。
 */
export function repeatReminder(run) {
  if (run >= 3) {
    return [
      `[exec-optimizer] ${run} consecutive assistant turns added no new content and called no tool.`,
      'Stop narrating. Either make the tool call you keep describing right now, or state the final',
      'answer from what you already have. Do not restate the task and do not repeat this notice.',
    ].join(' ')
  }
  return [
    `[exec-optimizer] ${run} consecutive assistant turns produced no tool call and no new content.`,
    'Do not restate the task or announce what you are about to do — do it, or answer now.',
  ].join(' ')
}

/**
 * 并行纠偏：模型连着几步都只发一个**本来可以并行**的调用时，插一条提醒。
 *
 * 这段文字只在真的检测到模式之后才出现，不进常驻系统提示词——所以它不花常驻成本。
 *
 * @param {number} steps - 连着几步都是一个调用。
 * @param {string} toolName - 那个工具的名字。
 * @returns {string} 提醒正文。
 */
export function batchingReminder(steps, toolName) {
  return [
    `[exec-optimizer] ${steps} steps in a row each made exactly one \`${toolName}\` call.`,
    'Independent calls like these belong in ONE assistant message — they run concurrently and the',
    'results come back in order, so batching them saves a full round trip each time.',
    'List everything you still need, then emit those calls together.',
  ].join(' ')
}

/**
 * 提前压缩生效时，给这一轮加一句说明（只在真的压缩过之后插一次）。
 *
 * @param {number} tokens - 压缩前的估算 token 数。
 * @returns {string} 提醒正文。
 */
export function compactedNotice(tokens) {
  return `[exec-optimizer] Context was auto-compacted early at ~${tokens} estimated tokens. Older turns were replaced by a summary; continue from the summary.`
}

/**
 * 把若干段落按开关拼起来；关掉的段落返回空串，**不占任何 token**。
 *
 * @param {object} flags - `{ parallel, retry, lazy }`。
 * @returns {string} 要追加到系统提示词末尾的文本。
 */
export function resolveDiscipline(flags) {
  const parts = []
  if (flags?.parallel === true) parts.push(PARALLEL_SECTION)
  if (flags?.retry === true) parts.push(RETRY_SECTION)
  if (flags?.lazy === true) parts.push(LAZY_SECTION)
  if (parts.length === 0) return ''
  return parts.join('\n\n')
}
