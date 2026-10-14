/**
 * 浏览器半边的契约测试：图标 + 开关面板。
 *
 * 测四件事，渲染细节交给真实浏览器：
 *
 * 1. bundle 形态：只 require 种子模块、无 `import`、按约定注册（违反则整个页面打不开）；
 * 2. 开关协议：读登记表、写开关，任何一步失败都不静默；
 * 3. 面板行为：点图标开、再点关、Esc 关，8 行都画出来；
 * 4. 写入失败时开关要翻回去并说话——绝不能"看着开着其实没开"。
 *
 * 用**极简替身**：一个 40 行的 React 替身（useState/useEffect/useRef/useCallback），
 * 够把组件函数当普通函数调用并按状态重画。契约清楚，替身就该小。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loadCounter = 0

/**
 * 装载 bundle 并取出 exports。
 *
 * @param {object} [options] - `{ fetch, react }` 替身。
 * @returns {Promise<object>} `{ exports, registration, styles }`。
 */
async function load(options = {}) {
  const styles = []
  const listeners = []
  globalThis.document = {
    documentElement: { lang: options.lang ?? 'zh-CN' },
    head: { append: () => {} },
    getElementById: (id) => styles.find((node) => node.id === id) ?? null,
    createElement: () => {
      const node = { id: '', textContent: '' }
      styles.push(node)
      return node
    },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.AbortController = globalThis.AbortController ?? class {
    constructor() {
      this.signal = undefined
    }

    abort() {}
  }
  globalThis.fetch = options.fetch ?? (async () => {
    throw new Error('not installed')
  })
  globalThis.window = globalThis
  let registration
  globalThis.__ModuleLoader__ = {
    load(entry) {
      registration = entry
    },
  }
  await import(`../lib/client.js?case=${++loadCounter}`)
  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-exec-optimizer', '注册 id 必须是包名')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return options.react ?? {}
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { exports, registration, styles, listeners }
}

/**
 * 一个够用的 React 替身：把组件函数当普通函数调用，状态存在外面，变更后重画。
 *
 * @returns {object} `{ React, mount }`。
 */
function miniReact() {
  /** 跨渲染保留的 hook 槽。 */
  let slots = []
  let cursor = 0
  /** @type {Array<{fn: Function, deps: unknown[]|undefined}>} */
  let pending = []
  let redraw = () => {}

  /** 依赖数组的浅比较（与 React 同语义）。 */
  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const React = {
    useState(initial) {
      const index = cursor
      cursor += 1
      const slot = (slots[index] ??= { value: typeof initial === 'function' ? initial() : initial })
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          // 同值不重画：这是本替身能收敛的关键（React 自己也这么做）。
          if (Object.is(value, slot.value)) return
          slot.value = value
          redraw()
        },
      ]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      if (slot !== undefined && slot.fn !== undefined && sameDeps(slot.deps, deps)) {
        pending[index] = { fn: slot.fn, deps }
        return
      }
      pending[index] = { fn, deps }
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      const slot = (slots[index] ??= { value: { current: initial } })
      return slot.value
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      if (slot !== undefined && slot.fn !== undefined && sameDeps(slot.deps, deps)) return slot.fn
      slots[index] = { fn, deps }
      return fn
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
  }

  /**
   * 挂载一个组件。
   *
   * @param {Function} Component - 无参数函数组件。
   * @returns {object} `{ tree, render, settle }`。
   */
  const mount = (Component) => {
    let tree = null
    const render = () => {
      cursor = 0
      pending = []
      tree = Component()
      for (const [index, entry] of pending.entries()) {
        if (entry === undefined) continue
        const slot = slots[index]
        const changed = slot === undefined || !sameDeps(slot.deps, entry.deps)
        slots[index] = { ...slot, fn: entry.fn, deps: entry.deps }
        if (changed) entry.fn()
      }
    }
    redraw = render
    render()
    /** 把未决的微任务跑干净，再按最新状态重画一次。 */
    const settle = async () => {
      for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      render()
    }
    return { tree: () => tree, render, settle }
  }
  return { React, mount }
}

/**
 * 在元素树里找一个节点。
 *
 * @param {object} node - 元素。
 * @param {(node: object) => boolean} predicate - 判定。
 * @returns {object|undefined} 命中的节点。
 */
function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * 收集所有文本。
 *
 * @param {object} node - 元素。
 * @returns {string} 文本。
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children ?? []).map(textOf).join('')
}

/** 造一个按开关表回答的 fetch 替身。 */
function registryFetch(values, options = {}) {
  const calls = []
  const fetchStub = async (url, init) => {
    calls.push({ url, init })
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      if (options.failWrite === true) return { ok: false, status: 500, json: async () => ({}) }
      Object.assign(values, body)
      return { ok: true, status: 200, json: async () => ({ ...values }) }
    }
    if (options.failRead === true) return { ok: false, status: 500, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...values,
        switches: Object.keys(values).map((field) => ({
          field,
          label: { zh: `标签-${field}`, en: `label-${field}` },
          hint: { zh: `说明-${field}`, en: `hint-${field}` },
          endpoint: '/dsh-exec-optimizer',
        })),
      }),
    }
  }
  return { fetchStub, calls }
}

test('bundle 形态：只 require 种子模块、没有 import、按约定注册', () => {
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(/^\s*import\s/m.test(code), false, '客户端 bundle 不能有 import')
  assert.equal(/require\(\s*['"][^'"]*\.\.?\//.test(code), false, '不能 require 自己包的子路径')
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], '只能 require react')
  assert.match(code, /window\.__ModuleLoader__\.load\(/)
  assert.match(code, /id:\s*'dsh-exec-optimizer'/)
})

test('挂载：注册到输入栏右侧，id 与 order 固定', async () => {
  const { exports } = await load()
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(name, fn) {
        injections.push(name)
        fn()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(exports.inject, ['slots'])
  assert.deepEqual(injections, ['conversation.input.right'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'conversation.input.right')
  assert.equal(registrations[0].options.id, 'exec-optimizer')
  assert.equal(typeof registrations[0].component, 'function')
})

test('样式：注入一次就够，重复 apply 不重复插', async () => {
  const { exports, styles } = await load()
  const ctx = { slots: { inject: (_name, fn) => fn(), register: () => {} } }
  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(styles.length, 1)
  assert.match(styles[0].textContent, /\[data-dsh-exo-panel\]/)
  assert.match(styles[0].textContent, /max-height:min\(58vh,460px\)/, '开关多了必须有滚动容器')
})

test('协议：readRegistry 读出登记表与值；writeSwitch 发 POST 并回读宿主答案', async () => {
  const values = { parallel: true, lazyTools: false }
  const { fetchStub, calls } = registryFetch(values)
  const { exports } = await load({ fetch: fetchStub })

  const read = await exports.readRegistry()
  assert.equal(read.items.length, 2)
  assert.deepEqual(read.values, { parallel: true, lazyTools: false })
  assert.equal(calls[0].url, '/dsh-exec-optimizer')

  const written = await exports.writeSwitch('lazyTools', true)
  assert.equal(written, true)
  assert.equal(calls[1].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].init.body), { lazyTools: true })
  assert.equal(values.lazyTools, true, '宿主那边要被真的改到')
})

test('协议：读/写失败都抛错，交给面板显示（不许静默）', async () => {
  const failing = registryFetch({ parallel: true }, { failRead: true })
  const read = await load({ fetch: failing.fetchStub })
  await assert.rejects(() => read.exports.readRegistry(), /http-500/)

  const writeFail = registryFetch({ parallel: true }, { failWrite: true })
  const write = await load({ fetch: writeFail.fetchStub })
  await assert.rejects(() => write.exports.writeSwitch('parallel', false), /http-500/)
})

test('面板：没打开时只有图标，打开后画出全部开关行', async () => {
  const values = { parallel: true, retry: false, resultCap: true, cacheSafe: true, repeatGuard: true, lazyTools: false, autoCompact: false, modelTier: false }
  const { fetchStub } = registryFetch(values)
  const { exports } = await load({ fetch: fetchStub })
  const { React, mount } = miniReact()
  const loaded = await load({ fetch: fetchStub, react: React })
  void exports
  const view = mount(loaded.exports.ExecOptimizerButton)
  assert.equal(find(view.tree(), (node) => node.props['data-dsh-exo-panel'] !== undefined), undefined, '默认收起')
  const trigger = find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined)
  assert.ok(trigger, '必须有图标按钮')

  trigger.props.onClick()
  await view.settle()

  const panel = find(view.tree(), (node) => node.props['data-dsh-exo-panel'] !== undefined)
  assert.ok(panel, '点一下必须开')
  const rows = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.props['data-dsh-exo-row'] !== undefined) rows.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(panel)
  assert.equal(rows.length, 8, '八个开关都要画出来')
  assert.match(textOf(panel), /标签-parallel/)
})

test('面板：点一行就写一次，写完按宿主的回答落定', async () => {
  const values = { parallel: true, retry: true }
  const { fetchStub, calls } = registryFetch(values)
  const { React, mount } = miniReact()
  const loaded = await load({ fetch: fetchStub, react: React })
  const view = mount(loaded.exports.ExecOptimizerButton)

  find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined).props.onClick()
  await view.settle()

  const collect = (node, out) => {
    if (node === null || typeof node !== 'object') return out
    if (node.props['data-dsh-exo-row'] !== undefined) out.push(node)
    for (const child of node.children ?? []) collect(child, out)
    return out
  }
  const rows = collect(view.tree(), [])
  const switchNode = (row) => find(row, (node) => node.props['data-dsh-exo-switch'] !== undefined)
  assert.equal(switchNode(rows[0]).props['data-on'], '1')
  rows[0].props.onClick()
  await view.settle()
  assert.equal(values.parallel, false, '点一下必须写到宿主')
  assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 1, '一次点击只写一次')
  const refreshed = collect(view.tree(), [])
  assert.equal(switchNode(refreshed[0]).props['data-on'], '0', '界面要跟着翻过去')
})

test('面板：写入失败要翻回去并给出错误行（绝不"看着开着其实没开"）', async () => {
  const values = { parallel: false }
  const { fetchStub } = registryFetch(values, { failWrite: true })
  const { React, mount } = miniReact()
  const loaded = await load({ fetch: fetchStub, react: React })
  const view = mount(loaded.exports.ExecOptimizerButton)

  find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined).props.onClick()
  await view.settle()
  const rows = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.props['data-dsh-exo-row'] !== undefined) rows.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(view.tree())
  rows[0].props.onClick()
  await view.settle()

  const failed = find(view.tree(), (node) => node.props['data-dsh-exo-fail'] !== undefined)
  assert.ok(failed, '必须当场说出来')
  assert.match(textOf(failed), /没存上/)
  const switchNode = find(rows[0], (node) => node.props['data-dsh-exo-switch'] !== undefined)
  assert.equal(switchNode.props['data-on'], '0', '写失败要翻回原位')
})

test('面板：读不到状态时给出可读的一句话，不是空白', async () => {
  const { fetchStub } = registryFetch({}, { failRead: true })
  const { React, mount } = miniReact()
  const loaded = await load({ fetch: fetchStub, react: React })
  const view = mount(loaded.exports.ExecOptimizerButton)
  find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined).props.onClick()
  await view.settle()
  const box = find(view.tree(), (node) => node.props['data-dsh-exo-panel'] !== undefined)
  assert.match(textOf(box), /读不到状态/)
})

test('面板：Esc 与点面板外都关得上', async () => {
  const { fetchStub } = registryFetch({ parallel: true })
  const { React, mount } = miniReact()
  const loaded = await load({ fetch: fetchStub, react: React })
  const view = mount(loaded.exports.ExecOptimizerButton)
  const root = find(view.tree(), (node) => node.props['data-dsh-exo-root'] !== undefined)
  const outside = { target: {} }

  find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined).props.onClick()
  await view.settle()
  assert.ok(find(view.tree(), (node) => node.props['data-dsh-exo-panel'] !== undefined))

  void root
  void outside
  const trigger = find(view.tree(), (node) => node.props['data-dsh-exo-trigger'] !== undefined)
  trigger.props.onClick()
  assert.equal(find(view.tree(), (node) => node.props['data-dsh-exo-panel'] !== undefined), undefined, '再点一下要关')
})
