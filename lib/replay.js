/**
 * 失败重放的记账与参数合并：**只发改动的那几个字段**。
 *
 * ## 为什么值得单独做
 *
 * 工具调用因参数错失败时，宿主给模型的只有一行
 * `Error: invalid arguments: missing required property "path"`。模型要重试，只能把
 * 原来那一大坨参数**整个重新生成**一遍——参数越长，重复生成的 token 越多，而且
 * 重新生成等于把没出错的字段也赌一次。
 *
 * 本模块在 `tools/post-execute` 里把失败调用的 `(name, arguments)` 记下来（**有界**：
 * 每个 agent 最多留几条，参数超过 4KB 的不记），再提供一个 `retry_tool`：模型只发
 * `{"patch": {"path": "..."}}`，这里把补丁合并进原参数后重放。
 *
 * ## 内存纪律
 *
 * 只存字符串（工具名、参数 JSON 文本、报错文本），用固定容量的 LRU 按 agent 分组，
 * 存不下就丢最旧的。**不持有 agent、不持有会话、不持有结果对象。**
 *
 * @module dsh-exec-optimizer/replay
 */

/** 记一条失败调用时，参数序列化后的最大长度；超过就放弃记录（记录本身也会花内存）。 */
export const MAX_RECORDED_ARGS = 4096

/** 每个 agent 保留几条失败调用。 */
export const SLOTS_PER_AGENT = 3

/** 同时跟踪多少个 agent。 */
export const TRACKED_AGENTS = 64

/**
 * 普通对象判定（数组、null、类实例都不算）。
 *
 * @param {unknown} value - 待判定值。
 * @returns {boolean} 是普通对象时为 true。
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把补丁合并进原参数。
 *
 * 语义（刻意选最好猜的一种）：
 *   * 两边都是普通对象 → 逐键递归；
 *   * 补丁里的值是 `null` → **删掉**这个键（用来消掉 `additionalProperties: false` 报的那个多余字段）；
 *   * 其余（数组、标量、类型不同）→ 直接替换。
 *
 * @param {unknown} base - 原参数。
 * @param {unknown} patch - 补丁。
 * @returns {unknown} 合并结果（不改动入参）。
 */
export function mergeArgs(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch
  /** @type {Record<string, unknown>} */
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeArgs(out[key], value) : value
  }
  return out
}

/**
 * 从报错文本里抠出出错的字段名。
 *
 * 宿主的两条文案都是引号包字段路径：
 *   * `missing required property "path"`
 *   * `"offset" must be a number`
 *   * `"a.b" is not a declared property`
 *
 * @param {string} errorText - 报错文本。
 * @returns {string[]} 去重后的字段名，最多 6 个。
 */
export function failedFields(errorText) {
  if (typeof errorText !== 'string' || errorText === '') return []
  /** @type {string[]} */
  const found = []
  const pattern = /"([^"\\]{1,120})"/g
  let match = pattern.exec(errorText)
  while (match !== null) {
    const name = match[1]
    if (!found.includes(name)) found.push(name)
    if (found.length >= 6) break
    match = pattern.exec(errorText)
  }
  return found
}

/**
 * 给失败结果追加一行极短的提示：告诉模型"可以只补这几个字段"。
 *
 * 只在 retry 开关打开时追加。长度压在 160 字符以内——它挂在每一个失败结果后面，
 * 长一句就是长期成本。
 *
 * @param {string} toolName - 失败的工具名。
 * @param {string} errorText - 报错文本。
 * @returns {string} 追加文本（关掉开关时由调用方传空）。
 */
export function retryHint(toolName, errorText) {
  if (toolName === 'retry_tool') return ''
  const fields = failedFields(errorText)
  if (fields.length === 0) return ''
  const list = fields.slice(0, 4).join(', ')
  return `\n[exec-optimizer] retry_tool({"patch":{...}}) replays this call with only the changed fields; bad: ${list}`
}

/**
 * 失败调用的有界记账。键是 agent id 字符串，值是极小的记录数组。
 */
export class RetrySlots {
  /**
   * @param {object} [options] - `{ perAgent, maxAgents, maxArgs }`。
   */
  constructor(options = {}) {
    /** @type {number} */
    this.perAgent = Number.isInteger(options.perAgent) && options.perAgent > 0 ? options.perAgent : SLOTS_PER_AGENT
    /** @type {number} */
    this.maxAgents = Number.isInteger(options.maxAgents) && options.maxAgents > 0 ? options.maxAgents : TRACKED_AGENTS
    /** @type {number} */
    this.maxArgs = Number.isInteger(options.maxArgs) && options.maxArgs > 0 ? options.maxArgs : MAX_RECORDED_ARGS
    /** @type {Map<string, Array<{name: string, args: string, error: string}>>} */
    this.slots = new Map()
    /** @type {number} */
    this.dropped = 0
  }

  /**
   * 记一次失败。参数序列化超预算、或不是纯对象参数时不记（记了也补不了）。
   *
   * @param {string} agentKey - agent 标识（字符串，通常是会话 id）。
   * @param {string} name - 工具名。
   * @param {unknown} args - 已解析的参数。
   * @param {string} error - 报错文本。
   * @returns {boolean} 是否记下了。
   */
  record(agentKey, name, args, error) {
    if (typeof agentKey !== 'string' || agentKey === '') return false
    if (name === 'retry_tool') return false
    if (!isPlainObject(args)) return false
    let text
    try {
      text = JSON.stringify(args)
    } catch {
      return false
    }
    if (typeof text !== 'string' || text.length > this.maxArgs) {
      this.dropped += 1
      return false
    }
    const list = this.slots.get(agentKey) ?? []
    list.push({ name, args: text, error: typeof error === 'string' ? error.slice(0, 400) : '' })
    while (list.length > this.perAgent) list.shift()
    // 重新 set 一次：Map 的插入序就是 LRU 序，删最旧的键即可。
    this.slots.delete(agentKey)
    this.slots.set(agentKey, list)
    while (this.slots.size > this.maxAgents) {
      const oldest = this.slots.keys().next()
      if (oldest.done === true) break
      this.slots.delete(oldest.value)
    }
    return true
  }

  /**
   * 取最近一条失败记录（可选按工具名过滤）。取出来**不删除**：同一个失败可能被补
   * 好几次，删掉反而逼模型回到全量重发。
   *
   * @param {string} agentKey - agent 标识。
   * @param {string} [name] - 只要这个工具的记录。
   * @returns {{name: string, args: string, error: string}|undefined} 记录。
   */
  peek(agentKey, name) {
    const list = this.slots.get(agentKey)
    if (list === undefined || list.length === 0) return undefined
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index]
      if (name === undefined || entry.name === name) return entry
    }
    return undefined
  }

  /**
   * 丢弃某个 agent 的记录（新的一轮用户输入进来时调用）。
   *
   * @param {string} agentKey - agent 标识。
   * @returns {void}
   */
  clear(agentKey) {
    this.slots.delete(agentKey)
  }

  /** @returns {number} 正在跟踪的 agent 数。 */
  size() {
    return this.slots.size
  }
}

/**
 * 一次重放的参数决策：给定失败记录和模型给的入参，算出真正要重放的参数。
 *
 * @param {object} input - `{ record, patch, args }`。
 * @returns {{ok: true, name: string, args: unknown}|{ok: false, reason: string}} 决策结果。
 */
export function planReplay(input) {
  const record = input.record
  if (record === undefined) {
    return { ok: false, reason: 'no failed call recorded for this session yet — call the tool normally' }
  }
  let base
  try {
    base = JSON.parse(record.args)
  } catch {
    return { ok: false, reason: 'the recorded arguments are not valid JSON' }
  }
  if (input.args !== undefined) {
    if (!isPlainObject(input.args)) return { ok: false, reason: '`args` must be an object' }
    return { ok: true, name: record.name, args: input.args }
  }
  if (input.patch === undefined) return { ok: true, name: record.name, args: base }
  if (!isPlainObject(input.patch)) return { ok: false, reason: '`patch` must be an object' }
  return { ok: true, name: record.name, args: mergeArgs(base, input.patch) }
}
