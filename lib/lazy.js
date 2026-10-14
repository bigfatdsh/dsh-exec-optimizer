/**
 * 工具说明的按需加载：默认只把"核心工具"的 schema 发出去，其余留索引。
 *
 * ## 为什么在 `system-prompt/assemble` 上做，而不是 `tools.restrict`
 *
 * 每一轮的 `tools` 数组都是现算的：`systemPrompt.assemble()` 每次重新跑 provider 并
 * `structuredClone`，返回值就是权威。所以在瀑布里改写 `assembly.tools` 是宿主公开
 * 契约内的做法，**不动工具注册表**——藏起来的工具照样可调用，只是模型看不见它的
 * schema 而已。`tools.restrict` 是给"这个 agent 不许用某工具"的，语义不同，而且要先
 * 拿到 agent 作用域，多一层耦合。
 *
 * ## 代价必须说清楚
 *
 * 工具集变化会让宿主写一条 `tool-addition`，供应商前缀缓存在**变化点**之后失效。
 * 所以这个开关默认关闭：省下的是固定的 schema 常驻成本，付出的是偶尔一次缓存重建。
 *
 * @module dsh-exec-optimizer/lazy
 */

/**
 * 默认核心集：没有它们连"去看看有什么工具"都做不到。
 *
 * 内嵌本插件自己的两个工具：`load_tools` 自我隐藏会让模型再也取不回任何工具；
 * `retry_tool` 被藏起来则和系统提示词里那段"用 retry_tool 重放"自相矛盾。
 * （装配层还有一道"自己的工具永远可见"的兜底，防止有人改了核心集名单。）
 */
export const DEFAULT_CORE = [
  'load_tools',
  'retry_tool',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'todo_write',
  'ask_user_question',
]

/** 索引里最多列几个工具。 */
const INDEX_LIMIT = 80

/** 索引里每条描述最多几个字符。 */
const INDEX_DESC_CHARS = 96

/**
 * 解析逗号/空白分隔的名字列表。
 *
 * @param {string} text - 原始配置文本。
 * @returns {string[]} 去空、去重的名字。
 */
export function parseNameList(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  /** @type {string[]} */
  const out = []
  for (const piece of text.split(/[\s,]+/)) {
    const name = piece.trim()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 按核心集与已解锁集合，把这一轮的 schema 切成"给模型看的"和"藏起来的"。
 *
 * 顺序保持不变：宿主已经排好序，重排会额外制造缓存差异。
 *
 * @param {readonly {name: string}[]} schemas - 这一轮装配出的 schema。
 * @param {object} options - `{ core, unlocked }`。
 * @returns {{visible: object[], hidden: object[]}} 切分结果。
 */
export function splitSchemas(schemas, options = {}) {
  const core = new Set(Array.isArray(options.core) && options.core.length > 0 ? options.core : DEFAULT_CORE)
  const unlocked = options.unlocked instanceof Set ? options.unlocked : new Set()
  /** @type {object[]} */
  const visible = []
  /** @type {object[]} */
  const hidden = []
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') continue
    if (core.has(schema.name) || unlocked.has(schema.name)) visible.push(schema)
    else hidden.push(schema)
  }
  return { visible, hidden }
}

/**
 * 生成"还有什么工具"的一行索引。**这是本功能唯一的发现入口**，所以必须便宜且完整。
 *
 * @param {readonly {name: string, description?: string}[]} hidden - 藏起来的 schema。
 * @returns {string} 索引文本。
 */
export function toolIndex(hidden) {
  const list = Array.isArray(hidden) ? hidden.slice(0, INDEX_LIMIT) : []
  if (list.length === 0) return 'Every tool is already loaded.'
  const lines = list.map((schema) => {
    const description = typeof schema.description === 'string' ? schema.description : ''
    const oneLine = description.replace(/\s+/g, ' ').trim()
    const short = oneLine.length > INDEX_DESC_CHARS ? `${oneLine.slice(0, INDEX_DESC_CHARS - 1)}…` : oneLine
    return `- ${schema.name}: ${short}`
  })
  const extra = Array.isArray(hidden) && hidden.length > list.length
    ? `\n(${hidden.length - list.length} more not listed.)`
    : ''
  return `Available but not loaded:\n${lines.join('\n')}${extra}\nLoad with load_tools({"names": [...]}).`
}

/**
 * 解析一次 `load_tools` 调用。
 *
 * @param {unknown} args - 模型给的入参。
 * @param {readonly string[]} available - 当前藏起来的工具名。
 * @returns {{action: 'list'}|{action: 'unlock', names: string[]}|{action: 'error', message: string}} 动作。
 */
export function planLoad(args, available) {
  const input = args === null || typeof args !== 'object' ? {} : args
  const names = Array.isArray(input.names) ? input.names.filter((name) => typeof name === 'string') : undefined
  if (names !== undefined && names.length > 0) {
    const known = new Set(Array.isArray(available) ? available : [])
    /** @type {string[]} */
    const ok = []
    /** @type {string[]} */
    const unknown = []
    for (const name of names) {
      if (known.has(name)) {
        if (!ok.includes(name)) ok.push(name)
      } else if (!unknown.includes(name)) unknown.push(name)
    }
    if (ok.length === 0) {
      return {
        action: 'error',
        message: `none of ${unknown.map((name) => JSON.stringify(name)).join(', ')} exist. Call load_tools({"list": true}) to see what does.`,
      }
    }
    return { action: 'unlock', names: ok }
  }
  if (input.list === true || names === undefined || names.length === 0) return { action: 'list' }
  return { action: 'error', message: 'pass `names` (non-empty array of strings) or `list: true`' }
}

/**
 * 每个 agent 已解锁的工具名。
 *
 * 键是 agent **对象**，用 `WeakMap`：agent 被回收时记录跟着走，插件不会把 agent 留住。
 */
export class UnlockState {
  constructor() {
    /** @type {WeakMap<object, Set<string>>} */
    this.unlocked = new WeakMap()
    /** @type {number} */
    this.unlocks = 0
  }

  /**
   * @param {object|undefined} agent - agent 对象（`assemble` 的 `context.scope`）。
   * @returns {Set<string>} 已解锁集合（只读用途）。
   */
  of(agent) {
    if (agent === null || typeof agent !== 'object') return new Set()
    return this.unlocked.get(agent) ?? new Set()
  }

  /**
   * 解锁若干工具。
   *
   * @param {object|undefined} agent - agent 对象。
   * @param {readonly string[]} names - 工具名。
   * @returns {string[]} 这次**新**解锁的名字（已经解锁的不算）。
   */
  unlock(agent, names) {
    if (agent === null || typeof agent !== 'object') return []
    const current = this.unlocked.get(agent) ?? new Set()
    /** @type {string[]} */
    const fresh = []
    for (const name of names) {
      if (current.has(name)) continue
      current.add(name)
      fresh.push(name)
    }
    if (fresh.length > 0) {
      this.unlocked.set(agent, current)
      this.unlocks += fresh.length
    }
    return fresh
  }
}
