/**
 * 并行纠偏：认出"连着几步都只发一个本来可以并行的调用"，好在下一步插一句提醒。
 *
 * ## 为什么需要这个
 *
 * 系统提示词里已经写了"独立调用要合并"，但那是**常驻的抽象原则**，模型在长会话里
 * 会漂。真正有用的是**它刚刚这么干了**的时候当面说一句——那一条只在检测到模式时才
 * 出现，不花常驻成本。
 *
 * ## 判定口径（窄到不会误伤）
 *
 *   1. 只看**同一个 turn** 内相邻的 step；
 *   2. 每个 step 恰好**一个**工具调用；
 *   3. 那个工具**声明了** `isConcurrencySafe`（宿主自己的并行分类器）——只对这类工具
 *      说"你可以合并"，对 `write`/`bash` 这种本来就必须串行的一个字都不说；
 *   4. 连着 3 步才触发；一个 turn 最多提醒一次。
 *
 * ## 内存纪律
 *
 * 每个会话只留最近 4 个 step，每个 step 最多 4 个工具名；会话数有上限，超了丢最旧的。
 * 只存字符串与数字。
 *
 * @module dsh-exec-optimizer/singlecall
 */

/** 连着几步单发就提醒。 */
export const STREAK_TRIGGER = 3

/** 每个会话留几个 step 的记录。 */
export const KEPT_STEPS = 4

/** 每个 step 最多记几个工具名（只用来判断"是不是恰好一个"）。 */
export const KEPT_NAMES = 4

/** 同时跟踪多少个会话。 */
export const TRACKED_SESSIONS = 64

/**
 * 单发模式记账。
 */
export class CallPattern {
  /**
   * @param {object} [options] - `{ maxSessions, trigger }`。
   */
  constructor(options = {}) {
    /** @type {number} */
    this.maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : TRACKED_SESSIONS
    /** @type {number} */
    this.trigger = Number.isInteger(options.trigger) && options.trigger > 0 ? options.trigger : STREAK_TRIGGER
    /** @type {Map<string, {turn: number, steps: Array<{step: number, names: string[]}>, nudgedTurn: number}>} */
    this.sessions = new Map()
    /** @type {number} */
    this.nudges = 0
  }

  /**
   * @param {string} sessionKey - 会话 id。
   * @returns {object} 该会话的状态（不存在就建）。
   */
  #state(sessionKey) {
    const found = this.sessions.get(sessionKey)
    if (found !== undefined) {
      this.sessions.delete(sessionKey)
      this.sessions.set(sessionKey, found)
      return found
    }
    const fresh = { turn: -1, steps: [], nudgedTurn: -1 }
    this.sessions.set(sessionKey, fresh)
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      this.sessions.delete(oldest.value)
    }
    return fresh
  }

  /**
   * 记一次工具调用。
   *
   * @param {string} sessionKey - 会话 id。
   * @param {object} input - `{ turn, step, name }`。
   * @returns {void}
   */
  note(sessionKey, input) {
    const turn = Number(input?.turn)
    const step = Number(input?.step)
    const name = typeof input?.name === 'string' ? input.name : ''
    if (typeof sessionKey !== 'string' || sessionKey === '') return
    if (!Number.isInteger(turn) || !Number.isInteger(step) || name === '') return
    const state = this.#state(sessionKey)
    if (state.turn !== turn) {
      state.turn = turn
      state.steps = []
    }
    let entry = state.steps.find((item) => item.step === step)
    if (entry === undefined) {
      entry = { step, names: [] }
      state.steps.push(entry)
      while (state.steps.length > KEPT_STEPS) state.steps.shift()
    }
    if (entry.names.length < KEPT_NAMES) entry.names.push(name)
  }

  /**
   * 看现在是不是"连着几步单发"。
   *
   * @param {string} sessionKey - 会话 id。
   * @param {(name: string) => boolean} isBatchable - 这个工具是不是声明了并行分类器。
   * @returns {{steps: number, name: string}|undefined} 命中时给出连了几步、是哪个工具。
   */
  streak(sessionKey, isBatchable) {
    const state = this.sessions.get(sessionKey)
    if (state === undefined || typeof isBatchable !== 'function') return undefined
    if (state.nudgedTurn === state.turn) return undefined
    let count = 0
    let name = ''
    for (let index = state.steps.length - 1; index >= 0; index -= 1) {
      const entry = state.steps[index]
      if (entry.names.length !== 1) break
      if (isBatchable(entry.names[0]) !== true) break
      count += 1
      name = entry.names[0]
    }
    if (count < this.trigger) return undefined
    return { steps: count, name }
  }

  /**
   * 记下"这一轮已经提醒过"，同一条连击不再重复插话。
   *
   * @param {string} sessionKey - 会话 id。
   * @returns {void}
   */
  ack(sessionKey) {
    const state = this.sessions.get(sessionKey)
    if (state === undefined) return
    state.nudgedTurn = state.turn
    state.steps = []
    this.nudges += 1
  }

  /**
   * 丢掉一个会话（新用户输入或会话结束）。
   *
   * @param {string} sessionKey - 会话 id。
   * @returns {void}
   */
  clear(sessionKey) {
    this.sessions.delete(sessionKey)
  }

  /** @returns {{sessions: number, nudges: number}} 诊断快照。 */
  snapshot() {
    return { sessions: this.sessions.size, nudges: this.nudges }
  }
}
