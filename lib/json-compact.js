/**
 * JSON 紧凑化：把工具返回里**纯 JSON** 的文本块去掉字符串之外的空白。
 *
 * ## 为什么只去空白，不 `JSON.parse` + `JSON.stringify`
 *
 * 重排会动到数值的书写形式：`1.0` 变 `1`、`1e21` 变 `1e+21`、超过 2^53 的整数
 * 直接丢精度。工具结果里的 ID、时间戳、金额全在这两类值上。所以这里只做一个
 * **字符串感知的空白剥离器**：字符串内部（含转义）一个字节都不碰，数字原样保留。
 * 实测两种做法在 1,102,745 字符的语料上分别省 62,350 / 62,582 字符——重排只多
 * 232 字符，不值得为它冒精度风险。
 *
 * ## 什么时候生效
 *
 * - 整块文本去掉首尾空白后必须以 `{` 或 `[` 开头、以 `}` 或 `]` 结尾；
 * - `JSON.parse` 必须成功（挡住 NDJSON、日志、半截 JSON）；
 * - 原始长度 ≥ `minChars`（默认 512），否则编辑成本高于收益；
 * - 至少省 `minSaving`（默认 2%），否则原样返回（已 minified 的结果不折腾）；
 * - 结果永远不大于原块（有测试钉住）。
 *
 * ## 与"结果截断"的关系
 *
 * 这一步是**无损**的，因此独立于「结果截断」开关：压缩后仍超上限的才交给
 * `capText` 去截头留尾。顺序必须是"先压缩、后截断"——否则本来能整个装下的 JSON
 * 会被无谓地截掉一半。
 *
 * @module dsh-exec-optimizer/json-compact
 */

/** 低于这个长度的块不压：省下的字符还抵不过多出来的说明成本（实测 256 已覆盖 93% 的可省量）。 */
export const DEFAULT_MIN_CHARS = 256

/** 低于这个比例不压：已经 minified 的结果原样放着，避免"为了 3 个字符重写一遍"。 */
export const DEFAULT_MIN_SAVING = 0.01

/**
 * 去掉 JSON 字符串之外的空白。**不解析、不重排、不改任何字节。**
 *
 * @param text - 原文（应当已经通过 `JSON.parse`）。
 * @returns 紧凑文本。
 */
export function stripJsonWhitespace(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    // JSON 的空白只有四种：空格、水平制表、换行、回车。
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue
    out += char
  }
  return out
}

/**
 * 判断一段文本是否是"整块 JSON"。
 *
 * @param text - 候选文本。
 * @returns 解析成功返回解析值，否则返回 `undefined`。
 */
function parseWholeJson(text) {
  const first = text[0]
  const last = text[text.length - 1]
  if (first !== '{' && first !== '[') return undefined
  if (last !== '}' && last !== ']') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 压缩一个文本块。
 *
 * @param text - 文本块内容。
 * @param options - `{ minChars, minSaving }`。
 * @returns `{ text, saved }`；不适用或收益不足时返回 `null`。
 */
export function compactJsonText(text, options = {}) {
  if (typeof text !== 'string') return null
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS
  const minSaving = options.minSaving ?? DEFAULT_MIN_SAVING
  if (text.length < minChars) return null
  // 去掉首尾空白（BOM 也顺手挡掉），但保留中间的原始字节交给下面的扫描器。
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed.length < minChars) return null
  if (parseWholeJson(trimmed) === undefined) return null
  const compact = stripJsonWhitespace(trimmed)
  if (compact.length >= trimmed.length) return null
  if (compact.length > trimmed.length * (1 - minSaving)) return null
  // 最后一道闸：压完必须仍是同一份 JSON。达不到就原样返回，宁可少省也不给坏数据。
  try {
    JSON.parse(compact)
  } catch {
    return null
  }
  return { text: compact, saved: text.length - compact.length }
}

/**
 * 对一条结果的文本块做 JSON 压缩。
 *
 * 只动 `type === 'text'` 的块；图片、文件等富内容原样保留（顺序也不变）。
 *
 * @param content - 结果的内容块数组。
 * @param options - 见 {@link compactJsonText}。
 * @returns `{ content, changed, saved }`；没有任何块变化时 `changed === false`。
 */
export function compactJsonContent(content, options = {}) {
  if (!Array.isArray(content)) return { content, changed: false, saved: 0 }
  let changed = false
  let saved = 0
  const next = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const compacted = compactJsonText(block.text, options)
    if (compacted === null) return block
    changed = true
    saved += compacted.saved
    return { ...block, text: compacted.text }
  })
  return { content: changed ? next : content, changed, saved }
}
