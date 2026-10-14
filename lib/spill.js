/**
 * 工具结果的**发送前**上限：超了就截头留尾，全文写到磁盘，并在结果里留下取回路径。
 *
 * ## 为什么必须发生在发送前
 *
 * 宿主的另一条路是"压缩时裁剪"（`tool-result-pruner`，阈值 8192 字符，改的是**已经
 * 发过**的结果）。它靠追加一条影子事件（`compaction/prune` + `surfaceOp: replace`）
 * 落到会话上，于是下一次请求的前缀从第一个被改的结果起就变了——供应商的前缀缓存从
 * 那里断掉，后面每个 token 都按未命中计价。
 *
 * 本模块把同一件事提前到 `tools/post-execute`：结果还没进会话、还没被发出去，就裁到
 * 预算内。裁过之后内置裁剪器再无事可做，已发前缀因此**永不被改写**。
 *
 * ## 裁掉的不是信息，是传输方式
 *
 * 全文一定落盘，结果里带着路径。模型要细节就自己 `read`（带 offset/limit）或 `grep`，
 * 只把它真正需要的那一段拉进上下文——比一次塞进来更省。
 *
 * @module dsh-exec-optimizer/spill
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 默认上限（字符）。与宿主内置裁剪器的 `thresholdChars` 一致，好让它无事可做。 */
export const DEFAULT_CAP_CHARS = 8192

/** 头尾切分比例：头部留得多，因为结论、报错、表头通常在前面。 */
const HEAD_RATIO = 0.67
const TAIL_RATIO = 0.22

/**
 * 取内容块里的纯文本。非文本块（图片、文件引用）不在裁剪范围内。
 *
 * @param {readonly unknown[]} content - 内容块数组。
 * @returns {string} 拼起来的文本。
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}

/**
 * 是否"纯文本块"：只有这种结果才敢整体替换，含图片的结果一律不碰。
 *
 * @param {readonly unknown[]} content - 内容块数组。
 * @returns {boolean} 全是文本块时为 true。
 */
export function isPurelyText(content) {
  if (!Array.isArray(content) || content.length === 0) return false
  return content.every(
    (block) =>
      block !== null &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string',
  )
}

/**
 * 按 UTF-16 码元安全地取下标，绝不把一个代理对劈成两半。
 *
 * @param {string} text - 原文本。
 * @param {number} index - 期望的下标。
 * @returns {number} 修正后的下标。
 */
function safeCut(text, index) {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  // 落在低位代理上说明下标正好劈开了 emoji：退一格。
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

/**
 * 规划一次裁剪。不写盘、不产生副作用，便于测试与预览。
 *
 * @param {string} text - 原始文本。
 * @param {object} [options] - `{ capChars, headRatio, tailRatio }`。
 * @returns {{head: string, tail: string, dropped: number, headChars: number, tailChars: number}|undefined}
 *   没超上限时返回 undefined。
 */
export function planCap(text, options = {}) {
  const capChars = Number.isFinite(options.capChars) && options.capChars > 0
    ? Math.floor(options.capChars)
    : DEFAULT_CAP_CHARS
  if (typeof text !== 'string' || text.length <= capChars) return undefined
  const headRatio = Number.isFinite(options.headRatio) ? options.headRatio : HEAD_RATIO
  const tailRatio = Number.isFinite(options.tailRatio) ? options.tailRatio : TAIL_RATIO
  // 头部 + 尾部不能吃掉全部分额：留 8% 给提示行本身。
  const budget = Math.floor(capChars * 0.92)
  const headWant = Math.max(1, Math.floor(budget * headRatio))
  const tailWant = Math.max(0, Math.floor(budget * tailRatio))
  const head = text.slice(0, safeCut(text, headWant))
  const tail = tailWant > 0 ? text.slice(safeCut(text, text.length - tailWant)) : ''
  const dropped = text.length - head.length - tail.length
  if (dropped <= 0) return undefined
  return { head, tail, dropped, headChars: head.length, tailChars: tail.length }
}

/**
 * 裁剪提示行：说明省了多少、全文在哪、怎么取。
 *
 * 刻意用英文并压到一行：这段文字每一轮都在上下文里，中文提示对模型的取回率并不更高。
 *
 * @param {object} input - `{ dropped, path, headChars, tailChars }`。
 * @returns {string} 提示文本（前后各留空行，避免和代码块粘在一起）。
 */
export function spillNotice(input) {
  const where = input.path === undefined || input.path === '' ? '' : ` Full text: ${input.path}`
  return `\n\n[... ${input.dropped} chars omitted by dsh-exec-optimizer (kept ${input.headChars} head + ${input.tailChars} tail).${where} — read it with offset/limit or grep it.]\n\n`
}

/**
 * 落盘文件名。会话 id 与调用 id 都可能带非法字符，一律替换掉。
 *
 * @param {string} sessionId - 会话 id。
 * @param {string} callId - 工具调用 id。
 * @param {number} [index] - 同一个调用内第几次裁剪（一次调用最多一次，留作扩展）。
 * @returns {string} 安全的文件名。
 */
export function spillFileName(sessionId, callId, index) {
  const safe = (value) => {
    const text = String(value ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      // 去掉 `..`：目录是固定的，但文件名里留着 `..` 只会让排查的人心里发毛。
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+/, '')
      .slice(0, 48)
    return text === '' ? 'x' : text
  }
  const suffix = Number.isInteger(index) && index > 0 ? `-${index}` : ''
  return `${safe(sessionId)}-${safe(callId)}${suffix}.txt`
}

/**
 * 把全文写到 `<dir>/<file>`；目录不存在就建。**任何失败都不抛**——落盘失败只意味着
 * 这条结果不裁剪（返回 undefined），绝不能让工具调用因为插件而失败。
 *
 * @param {string} dir - 目标目录。
 * @param {string} file - 文件名。
 * @param {string} text - 全文。
 * @returns {string|undefined} 成功时返回完整路径。
 */
export function writeSpill(dir, file, text) {
  try {
    mkdirSync(dir, { recursive: true })
    const full = join(dir, file)
    writeFileSync(full, text, 'utf8')
    return full
  } catch {
    return undefined
  }
}

/**
 * 一步到位：规划 + 落盘 + 拼出替换后的文本。
 *
 * @param {object} input - `{ text, dir, sessionId, callId, capChars }`。
 * @returns {{text: string, dropped: number, path: string}|undefined} 不需要裁剪（或落盘失败）时 undefined。
 */
export function capText(input) {
  const plan = planCap(input.text, { capChars: input.capChars })
  if (plan === undefined) return undefined
  const path = writeSpill(input.dir, spillFileName(input.sessionId, input.callId), input.text)
  if (path === undefined) return undefined
  return {
    text: plan.head + spillNotice({ ...plan, path }) + plan.tail,
    dropped: plan.dropped,
    path,
  }
}
