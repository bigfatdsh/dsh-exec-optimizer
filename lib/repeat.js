/**
 * 复读探测：识别"连着几轮没干活也没新内容"的助手输出。
 *
 * ## 判定口径（窄到不会误伤）
 *
 * 只把**同一轮里连续的、没有工具调用的**助手消息算进连击：
 *
 *   1. 带工具调用的消息 → 连击清零（它在干活，哪怕正文只有一句"Let me read it"）；
 *   2. 纯文字但很短（默认 < 30 字符）→ 记一次空转；
 *   3. 纯文字且归一化后和上一条完全相同 → 记一次复读。
 *
 * 其余情况（正常长度的回答）→ 连击清零。所以"最后一句简短总结"不会被判成复读，
 * 只有**连续的**碎片才算。
 *
 * ## 内存纪律
 *
 * 每个会话只留一个定长环形缓冲（默认 6 条、每条最多 200 字符），会话数有上限，
 * 超了丢最旧的。只存字符串。
 *
 * @module dsh-exec-optimizer/repeat
 */

/** 默认窗口：记住最近几条助手正文。 */
export const WINDOW = 6

/** 默认"太短"门槛（字符）。 */
export const MIN_CHARS = 30

/** 同时跟踪多少个会话。 */
export const TRACKED_SESSIONS = 64

/**
 * 归一化：去空白、去标点、转小写。只用于"是不是同一句"的比较。
 *
 * @param {string} text - 原文本。
 * @returns {string} 归一化结果。
 */
export function normalizeForCompare(text) {
  if (typeof text !== 'string') return ''
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?，。；：！？、"'`~…—－-]+/g, '')
    .slice(0, 200)
}

/**
 * 判断一段助手正文算不算"空转"。
 *
 * @param {string} text - 正文。
 * @param {number} minChars - 长度门槛。
 * @returns {boolean} 空转时为 true。
 */
export function isFiller(text, minChars = MIN_CHARS) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return trimmed.length < minChars
}

/**
 * 助手回合的连击记账。
 */
export class RepeatTracker {
  /**
   * @param {object} [options] - `{ window, minChars, maxSessions }`。
   */
  constructor(options = {}) {
    /** @type {number} */
    this.minChars = Number.isInteger(options.minChars) && options.minChars > 0 ? options.minChars : MIN_CHARS
    /** @type {number} */
    this.maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : TRACKED_SESSIONS
    /** @type {number} */
    this.window = Number.isInteger(options.window) && options.window > 0 ? options.window : WINDOW
    /** @type {Map<string, {run: number, last: string, seen: string[]}>} */
    this.sessions = new Map()
    /** @type {number} */
    this.trips = 0
  }

  /**
   * @param {string} sessionKey - 会话 id。
   * @returns {{run: number, last: string, seen: string[]}} 该会话的状态（不存在就建）。
   */
  #state(sessionKey) {
    const found = this.sessions.get(sessionKey)
    if (found !== undefined) {
      // 触碰一下：Map 的插入序当 LRU 用。
      this.sessions.delete(sessionKey)
      this.sessions.set(sessionKey, found)
      return found
    }
    const fresh = { run: 0, last: '', seen: [] }
    this.sessions.set(sessionKey, fresh)
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    return fresh
  }

  /**
   * 观察一条助手消息。
   *
   * @param {string} sessionKey - 会话 id。
   * @param {object} input - `{ text, hasToolCall }`。
   * @returns {{run: number, filler: boolean, repeated: boolean}} 观察结果；`run` 是连击长度。
   */
  observe(sessionKey, input) {
    if (typeof sessionKey !== 'string' || sessionKey === '') return { run: 0, filler: false, repeated: false }
    const state = this.#state(sessionKey)
    if (input?.hasToolCall === true) {
      state.run = 0
      state.last = ''
      return { run: 0, filler: false, repeated: false }
    }
    const normalized = normalizeForCompare(input?.text)
    const filler = isFiller(input?.text, this.minChars)
    // 归一化后完全一样就算复读。**不设长度下限**：用户举的例子正是"好。"这种一个字的
    // 碎片——加了 `length >= 4` 会让它绕过"复读"判定，只剩"太短"这一条，反而更容易漏。
    const repeated = normalized !== '' && normalized === state.last
    if (!filler && !repeated) {
      state.run = 0
      state.last = normalized
      return { run: 0, filler, repeated }
    }
    state.run += 1
    state.last = normalized
    state.seen.push(normalized.slice(0, 200))
    while (state.seen.length > this.window) state.seen.shift()
    if (state.run >= 2) this.trips += 1
    return { run: state.run, filler, repeated }
  }

  /**
   * 读当前连击长度，不改变状态。
   *
   * @param {string} sessionKey - 会话 id。
   * @returns {number} 连击长度。
   */
  runOf(sessionKey) {
    return this.sessions.get(sessionKey)?.run ?? 0
  }

  /**
   * 已提醒过之后，把连击压回 1：避免同一条连击在每个 step 都提醒一次。
   *
   * @param {string} sessionKey - 会话 id。
   * @returns {void}
   */
  ack(sessionKey) {
    const state = this.sessions.get(sessionKey)
    if (state !== undefined) state.run = 1
  }

  /**
   * 丢掉一个会话的状态（新用户输入进来、或会话结束）。
   *
   * @param {string} sessionKey - 会话 id。
   * @returns {void}
   */
  clear(sessionKey) {
    this.sessions.delete(sessionKey)
  }

  /** @returns {{sessions: number, trips: number}} 诊断快照。 */
  snapshot() {
    return { sessions: this.sessions.size, trips: this.trips }
  }
}
