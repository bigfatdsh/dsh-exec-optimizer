/**
 * dsh-exec-optimizer —— 浏览器半边：输入栏右侧一个「执行优化」图标 + 开关面板。
 *
 * ## 约束（踩过的坑，别改）
 *
 * 只 `require('react')` 这一个启动期种子模块；不能 `import`、不能 require 自己包的
 * 子路径——客户端组合会整体失败，应用直接打不开。所以面板、图标、样式全部手写。
 *
 * ## 开关是登记出来的，不是写死的
 *
 * 面板从宿主读一张登记表（`GET <本插件端点>`），表里每项描述一个开关：
 * `{ id, label, hint, endpoint, field }`。宿主那边新增一个开关只要往那张表里加一行，
 * 这个文件一行都不用动——**面板与开关的对应关系只有宿主一处定义**。
 *
 *   * `GET  <endpoint>` → `{ "<field>": boolean, switches: [...] }`
 *   * `POST <endpoint>` body `{ "<field>": boolean }` → `{ "<field>": boolean }`
 *
 * @module dsh-exec-optimizer/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-exec-optimizer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 本插件在宿主侧的端点。 */
    const ENDPOINT = '/dsh-exec-optimizer'

    /** 样式节点的 id：重复挂载时只注入一次。 */
    const STYLE_ID = 'dsh-exec-optimizer-style'

    /** 问宿主的超时。面板点一下要立刻有反应，等超过这个数就不如报错。 */
    const TIMEOUT_MS = 8000

    const zh = {
      title: '执行优化',
      count: '%s/%d 开',
      loading: '读取中…',
      failed: '读不到状态，请稍后重试',
      empty: '当前没有可用的开关',
      writeFailed: '没存上（%s），再点一次试试。',
      open: '执行优化',
    }

    const en = {
      title: 'Execution',
      count: '%s/%d on',
      loading: 'Loading…',
      failed: 'Could not read the state. Try again.',
      empty: 'No switch available',
      writeFailed: 'Not saved (%s). Try again.',
      open: 'Execution optimizations',
    }

    const style = `
[data-dsh-exo-root]{position:relative;display:inline-flex}
[data-dsh-exo-trigger]{display:inline-flex;align-items:center;justify-content:center;
  width:32px;height:32px;padding:0;margin:0;border:0;box-sizing:border-box;appearance:none;
  border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);
  corner-shape:round;cursor:pointer}
[data-dsh-exo-trigger]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
[data-dsh-exo-trigger]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
[data-dsh-exo-trigger][data-open="1"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
[data-dsh-exo-panel]{position:absolute;bottom:calc(100% + 8px);right:0;z-index:60;box-sizing:border-box;
  display:flex;flex-direction:column;
  width:368px;max-width:calc(100vw - 32px);padding:6px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-module-platform);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-primary)}
[data-dsh-exo-head]{display:flex;align-items:center;gap:6px;justify-content:space-between;
  padding:4px 8px 8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px}
[data-dsh-exo-count]{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
[data-dsh-exo-list]{display:flex;flex-direction:column;min-height:0;
  max-height:min(52vh,420px);overflow-y:auto;overscroll-behavior:contain}
[data-dsh-exo-row]{display:flex;align-items:center;justify-content:space-between;gap:10px;
  min-height:44px;padding:6px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer}
[data-dsh-exo-row]:hover{background:var(--dsw-alias-interactive-bg-hover)}
[data-dsh-exo-row]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
[data-dsh-exo-text]{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;overflow:hidden}
[data-dsh-exo-label]{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-exo-hint]{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-dsh-exo-switch]{position:relative;flex:0 0 auto;width:34px;height:20px;border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover);transition:background .15s ease;corner-shape:round}
[data-dsh-exo-switch][data-on="1"]{background:var(--dsw-alias-state-business-primary)}
[data-dsh-exo-knob]{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-bg-module-platform);transition:transform .15s ease}
[data-dsh-exo-switch][data-on="1"] [data-dsh-exo-knob]{transform:translateX(14px)}
[data-dsh-exo-fail]{padding:0 8px 6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}
[data-dsh-exo-hintline]{padding:0 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
`

    /**
     * 带超时的 fetch。
     *
     * @param {string} url - 地址。
     * @param {object} [init] - fetch 参数。
     * @returns {Promise<unknown>} 解析后的 JSON。
     */
    async function fetchJson(url, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        if (response.ok !== true) throw new Error(`http-${response.status}`)
        return await response.json()
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 读登记表与当前值。
     *
     * @returns {Promise<{items: object[], values: Record<string, boolean>}>} 登记表与值。
     */
    async function readRegistry() {
      const payload = await fetchJson(ENDPOINT, { headers: { accept: 'application/json' } })
      const items = Array.isArray(payload?.switches) ? payload.switches : []
      /** @type {Record<string, boolean>} */
      const values = {}
      for (const item of items) values[item.field] = payload[item.field] === true
      return { items, values }
    }

    /**
     * 写一个开关。
     *
     * @param {string} field - 字段名。
     * @param {boolean} value - 目标值。
     * @returns {Promise<boolean>} 写入后的值。
     */
    async function writeSwitch(field, value) {
      const payload = await fetchJson(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      return payload?.[field] === true
    }

    /**
     * 注入样式（只注一次）。
     *
     * @returns {void}
     */
    function injectStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const node = document.createElement('style')
      node.id = STYLE_ID
      node.textContent = style
      document.head.append(node)
    }

    /**
     * 一个开关行：左标题 + 说明，右开关本体。
     *
     * @param {object} props - `{ item, on, label, onToggle }`。
     * @returns {object} React 元素。
     */
    function SwitchRow(props) {
      const { item, on, label, onToggle } = props
      const english = label === en
      const text = item.label?.[english ? 'en' : 'zh'] ?? item.id ?? item.field
      const hint = item.hint?.[english ? 'en' : 'zh'] ?? ''
      // 详细解释只进原生 tooltip（`title`）：它零布局成本，鼠标停一下才出现，
      // 绝不会把面板撑成一堵字墙。
      const detail = item.detail?.[english ? 'en' : 'zh'] ?? ''
      return React.createElement(
        'div',
        {
          'data-dsh-exo-row': '',
          title: detail === '' ? undefined : detail,
          role: 'switch',
          tabIndex: 0,
          'aria-checked': on === true,
          onClick: onToggle,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onToggle()
          },
        },
        React.createElement(
          'div',
          { 'data-dsh-exo-text': '' },
          React.createElement('span', { 'data-dsh-exo-label': '' }, text),
          hint === '' ? null : React.createElement('span', { 'data-dsh-exo-hint': '' }, hint),
        ),
        React.createElement(
          'span',
          { 'data-dsh-exo-switch': '', 'data-on': on === true ? '1' : '0', 'aria-hidden': 'true' },
          React.createElement('span', { 'data-dsh-exo-knob': '' }),
        ),
      )
    }

    /**
     * 输入栏右侧那个图标 + 面板。
     *
     * @returns {object} React 元素。
     */
    function ExecOptimizerButton() {
      const [open, setOpen] = React.useState(false)
      const [locale, setLocale] = React.useState('zh')
      const [items, setItems] = React.useState([])
      const [values, setValues] = React.useState({})
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState('')
      const rootRef = React.useRef(null)

      const label = locale === 'en' ? en : zh

      const refresh = React.useCallback(async () => {
        setStatus('loading')
        try {
          const read = await readRegistry()
          setItems(read.items)
          setValues(read.values)
          setStatus(read.items.length === 0 ? 'empty' : 'ready')
          setError('')
        } catch (failure) {
          setStatus('failed')
          setError(String(failure?.message ?? failure))
        }
      }, [])

      // 打开时才去问宿主：面板是偶尔用的东西，不该在每次渲染时打请求。
      React.useEffect(() => {
        if (!open) return
        void refresh()
      }, [open, refresh])

      React.useEffect(() => {
        if (!open) return () => {}
        const onDown = (event) => {
          if (rootRef.current?.contains?.(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // 跟随界面语言：面板挂在同一个 DOM 上，读的是文档语言，不需要额外的注入。
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        const read = () => setLocale((document.documentElement?.lang ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh')
        read()
        const observer = new MutationObserver(read)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => observer.disconnect()
      }, [])

      /**
       * 点一个开关：**先在本地翻过去**，再按宿主的回答校正。
       *
       * 这样点下去立刻有反馈；写失败就翻回来并说一句，不会出现"看着开着其实没开"。
       *
       * @param {object} item - 登记项。
       * @param {boolean} next - 目标值。
       * @returns {Promise<void>} 完成。
       */
      const toggle = async (item, next) => {
        setValues((current) => ({ ...current, [item.field]: next }))
        setError('')
        try {
          const written = await writeSwitch(item.field, next)
          setValues((current) => ({ ...current, [item.field]: written }))
        } catch (failure) {
          setValues((current) => ({ ...current, [item.field]: next !== true }))
          setError(label.writeFailed.replace('%s', String(failure?.message ?? failure)))
        }
      }

      return React.createElement(
        'div',
        { 'data-dsh-exo-root': '', ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            'data-dsh-exo-trigger': '',
            'data-open': open ? '1' : '0',
            'aria-label': label.open,
            'aria-expanded': open,
            title: label.open,
            onClick: () => setOpen((current) => !current),
          },
          React.createElement(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
            React.createElement('path', {
              fill: 'currentColor',
              d: 'M9.2 1.2 3.4 8.6c-.3.4 0 .9.4.9h2.9l-.9 5.3c-.1.5.6.8.9.4l5.8-7.4c.3-.4 0-.9-.4-.9h-2.9l.9-5.3c.1-.5-.6-.8-.9-.4z',
            }),
          ),
        ),
        open
          ? React.createElement(
            'div',
            { 'data-dsh-exo-panel': '', role: 'dialog', 'aria-label': label.title },
            React.createElement(
              'div',
              { 'data-dsh-exo-head': '' },
              React.createElement('span', null, label.title),
              // 一行说清"开了几个"，省得用户一个个数。
              React.createElement(
                'span',
                { 'data-dsh-exo-count': '' },
                label.count.replace('%s', String(items.filter((item) => values[item.field] === true).length)).replace('%d', String(items.length)),
              ),
            ),
            error === '' ? null : React.createElement('div', { 'data-dsh-exo-fail': '' }, error),
            status === 'loading'
              ? React.createElement('div', { 'data-dsh-exo-hintline': '' }, label.loading)
              : status === 'failed'
                ? React.createElement('div', { 'data-dsh-exo-hintline': '' }, label.failed)
                : status === 'empty'
                  ? React.createElement('div', { 'data-dsh-exo-hintline': '' }, label.empty)
                  : React.createElement(
                    'div',
                    { 'data-dsh-exo-list': '' },
                    items.map((item) =>
                      SwitchRow({
                        key: item.field ?? item.id,
                        item,
                        on: values[item.field] === true,
                        label,
                        onToggle: () => void toggle(item, values[item.field] !== true),
                      }),
                    ),
                  ),
          )
          : null,
      )
    }

    /**
     * 客户端插件主体：注入样式，把图标挂到输入栏那一排。
     *
     * @param {object} ctx - 客户端根上下文。
     * @returns {void}
     */
    function apply(ctx) {
      injectStyle()
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'exec-optimizer', order: 22 },
          ExecOptimizerButton,
        ),
      )
    }

    exports.inject = ['slots']
    exports.apply = apply
    exports.ExecOptimizerButton = ExecOptimizerButton
    exports.SwitchRow = SwitchRow
    exports.readRegistry = readRegistry
    exports.writeSwitch = writeSwitch
    exports.ENDPOINT = ENDPOINT
    exports.TIMEOUT_MS = TIMEOUT_MS
    return module.exports
  },
})
