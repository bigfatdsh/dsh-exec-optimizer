/**
 * 客户端 bundle 纯度闸门。
 *
 * 浏览器半边不会让宿主启动失败：语法错、require 错、注册错都只在页面里炸，宿主看起来
 * 一切正常。所以这里在真正加载它之前，把几条**一旦违反就让应用打不开**的硬规则钉住。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const clientExport = pkg.exports['./client']
assert.ok(typeof clientExport === 'string', 'package.json 必须导出 ./client')
const file = `${root}${clientExport.replace(/^\.\//, '')}`
const source = readFileSync(file, 'utf8')

// 1) 单文件 bundle：**文件名**必须匹配 `client.<name>.js`（目录不限，实测 lib/ 也能被服务）。
const basename = clientExport.split('/').pop()
// 实测可用的两种形态：`client.js` 与 `client.<name>.js`（后者是带名字的分块）。
assert.match(basename, /^client(\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/, `客户端入口文件名必须是 client.js 或 client.*.js，实际 ${clientExport}`)

// 2) 注册 id 必须等于包名（组合系统按它做依赖注入）。
assert.match(source, new RegExp(`id: '${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), 'bundle 注册 id 必须等于包名')
assert.match(source, /__ModuleLoader__\.load\(\{/)

// 3) 只允许 require 启动期种子模块（react）。require 别的一律让整个客户端组合失败。
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n')
const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
assert.deepEqual([...new Set(requires)], ['react'], `bundle 只能 require react，实际：${requires.join(', ')}`)

// 4) 禁止 import / 相对导入：客户端只服务这一个文件，`./other.js` 会 404。
assert.doesNotMatch(code, /^\s*import\s/m, 'bundle 不能有 import 语句')
assert.doesNotMatch(code, /from\s+'\.\//, 'bundle 不能相对导入兄弟文件')

// 5) 契约：注册到输入栏右侧插槽，样式里带图标与面板，端点正确。
assert.match(code, /'conversation\.input\.right'/, 'bundle 必须注册到输入栏右侧插槽')
assert.match(code, /\[data-dsh-exo-trigger\]/, 'bundle 样式里要有图标按钮')
assert.match(code, /data-dsh-exo-panel/, 'bundle 样式里要有开关面板')
assert.match(code, /data-dsh-exo-list/, 'bundle 样式里要有可滚动的行列表（开关多了会撑破面板）')
assert.match(code, /'\/dsh-exec-optimizer'/, 'bundle 必须打本插件的端点')

console.log('client bundle OK:', pkg.name, '→', clientExport)
