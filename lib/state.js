/**
 * 开关状态：`<DSH_HOME>/exec-optimizer.json`，一个开关一个字段。
 *
 * **写盘先读回再合并**：直接整文件覆盖会把别的开关的选择抹掉。读不出、写不进都退回
 * 默认值——**装配永不因为状态问题失败**。
 *
 * @module dsh-exec-optimizer/state
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 状态文件名。 */
export const STORE_FILENAME = 'exec-optimizer.json'

/**
 * 解析 DSH 主目录。
 *
 * @returns {string} 绝对路径。
 */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * 状态文件路径。
 *
 * @param {string} [home] - 覆盖 DSH 主目录（测试用）。
 * @returns {string} 绝对路径。
 */
export function statePath(home) {
  const base = typeof home === 'string' && home !== '' ? home : resolveDshHome()
  return join(base, STORE_FILENAME)
}

/**
 * 读一个状态文件。文件不存在返回空对象；解析失败上报并返回空对象。
 *
 * 导出给诊断用：能读到"盘上到底写了什么"，才说得清"为什么没拦"。
 *
 * @param {string|undefined} file - 文件路径；undefined 表示不落盘。
 * @param {(error: unknown) => void} onError - 失败上报。
 * @returns {Record<string, unknown>} 文件内容。
 */
export function readStore(file, onError) {
  if (file === undefined) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') onError(error)
    return {}
  }
}

/**
 * 写一个字段进状态文件；**先读回再合并**，所以同一个文件上的多个键互不覆盖。
 *
 * @param {string|undefined} file - 文件路径；undefined 表示不落盘。
 * @param {string} field - 字段名。
 * @param {unknown} value - 字段值。
 * @param {(error: unknown) => void} onError - 失败上报。
 */
function writeStore(file, field, value, onError) {
  if (file === undefined) return
  const temp = `${file}.${process.pid}.tmp`
  const merged = { ...readStore(file, onError), [field]: value }
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    onError(error)
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败无所谓：临时文件带 pid，不会污染下次读取。
    }
  }
}

/**
 * 一个布尔开关。
 *
 * 同一个文件上可以挂多个实例；写盘时互相保留对方字段，也保留不认识的键。
 */
export class ToggleState {
  /** @type {string} */
  #field
  /** @type {boolean} */
  #on
  /** @type {string|undefined} */
  #file
  /** @type {(error: unknown) => void} */
  #onError
  /** @type {Set<(value: boolean) => void>} */
  #listeners = new Set()

  /**
   * @param {object} options - `{ field, initial, file, onError }`。
   * @param {string} options.field - 状态文件里的字段名。
   * @param {boolean} [options.initial] - 读盘前的初值。
   * @param {string} [options.file] - 状态文件；空串表示不落盘。
   * @param {(error: unknown) => void} [options.onError] - 写盘失败上报。
   */
  constructor(options) {
    this.#field = options.field
    this.#on = options.initial === true
    this.#file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
    // **同步**读一次盘。实测踩过：原来是异步 load()，而插件的第一个请求可能早于
    // 它完成——那一轮读到的还是内存默认值，表现为"明明开着 auto，第一轮却不动作"。
    this.load()
  }

  /** @returns {boolean} 当前是否开启。 */
  get() {
    return this.#on
  }

  /**
   * 写入开关。
   *
   * @param {unknown} next - 目标值，按真值解释。
   * @returns {boolean} 写入后的值。
   */
  set(next) {
    this.#on = next === true
    this.#write()
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#on)
      } catch {
        // 监听器失败不能影响开关本身：开关的值才是事实。
      }
    }
    return this.#on
  }

  /**
   * 订阅开关变化。返回退订函数。
   *
   * 用途是"开关一改就得重做某件事"（比如工具注册表：关掉开关等于把工具摘下来，
   * 下一轮请求就少一份 schema）。**回调同步执行**，所以别在里面做重活。
   *
   * @param {(value: boolean) => void} listener - 变化回调。
   * @returns {() => void} 退订。
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 从盘上读回上次的选择。读不到、读坏都保持当前值。
   *
   * 同步实现：调用方（构造）需要在下一个请求之前就拿到真实值。
   *
   * @returns {boolean} 是否读到了一个有效值。
   */
  load() {
    const value = this.#read()[this.#field]
    if (typeof value !== 'boolean') return false
    this.#on = value
    return true
  }

  /**
   * 读整个文件。文件不存在返回空对象；解析失败上报并返回空对象。
   *
   * @returns {Record<string, unknown>} 文件内容。
   */
  #read() {
    return readStore(this.#file, this.#onError)
  }

  /** 写盘；先读回再合并，任何失败只上报，不影响内存值。 */
  #write() {
    writeStore(this.#file, this.#field, this.#on, this.#onError)
  }
}
