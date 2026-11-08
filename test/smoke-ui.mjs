// 冒烟测试：模拟 DSH client 运行时，验证 ui/client.js 真的把面板挂到了 slots 上。
//
// 这个测试存在的理由：旧版 client.js 只写了 exports.Panel，从没调 slots.register，
// 结果设置页里什么都看不到，而语法检查完全通过 —— 静态检查抓不到这类缺陷。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'ui', 'client.js')

const source = await readFile(clientPath, 'utf8')

// ---- 最小 React 替身：只要能让组件函数被调用而不炸 ----
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) }
}
const React = {
  createElement,
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useCallback(fn) { return fn },
  useRef(initial) { return { current: initial } },
  useMemo(fn) { return fn() },
}

// ---- 捕获 __ModuleLoader__.load 注册的 factory ----
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { registered = entry },
  },
}

// ---- 浏览器 API 替身 ----
globalThis.document = { baseURI: 'http://localhost:3000/' }
globalThis.fetch = async () => ({
  json: async () => ({ ok: false, error: '测试环境不发起真实请求' }),
})
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}
globalThis.console = console

// ---- 执行 bundle ----
const fn = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source)
fn(globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval,
  globalThis.clearInterval, globalThis.setTimeout, globalThis.clearTimeout)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

check('__ModuleLoader__.load 被调用', registered !== null)
check('bundle id 等于包名', registered?.id === '@local/dsh-vcprag', registered?.id)

const require = (spec) => {
  if (spec === 'react') return React
  throw new Error('未知模块: ' + spec)
}
const exportsObj = registered.factory(require)

// ---- 插件契约 ----
check('exports.name === "vcprag"', exportsObj.name === 'vcprag', String(exportsObj.name))
check('exports.inject 含 slots', Array.isArray(exportsObj.inject) && exportsObj.inject.includes('slots'),
  JSON.stringify(exportsObj.inject))
check('exports.apply 是函数', typeof exportsObj.apply === 'function')

// ---- slots 注册 ----
const calls = { inject: [], register: [] }
const slots = {
  inject(ownerKey, callback) {
    calls.inject.push(ownerKey)
    return callback()
  },
  register(options, component) {
    calls.register.push({ options, component })
    return () => {}
  },
}
const ctx = { get: (key) => (key === 'slots' ? slots : undefined) }

exportsObj.apply(ctx)

check('slots.inject 收到 settings.section', calls.inject.length === 1 && calls.inject[0] === 'settings.section',
  JSON.stringify(calls.inject))
check('slots.register 被调用一次', calls.register.length === 1, String(calls.register.length))

const reg = calls.register[0]
check('register options.name 正确', reg?.options?.name === 'settings.section', reg?.options?.name)
check('register options.id 存在', typeof reg?.options?.id === 'string' && reg.options.id.length > 0, reg?.options?.id)
check('register options.label 是「记忆召回」', reg?.options?.label === '记忆召回', String(reg?.options?.label))
check('register 传了组件', typeof reg?.component === 'function')

// ---- 组件能被渲染函数调用（不抛异常）----
let renderError = null
let tree = null
try {
  tree = reg.component({})
} catch (e) {
  renderError = e
}
check('Panel 首次渲染不抛异常', renderError === null, renderError ? renderError.message : '')
check('Panel 返回元素树', tree !== null && typeof tree === 'object', tree ? String(tree.type) : '')

// ---- 四个 Tab 组件都在（通过 TABS 渲染出来间接验证）----
let textNodes = []
const collect = (node) => {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { textNodes.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (typeof node === 'object') {
    // 本文件的 createElement 把 children 放在 node.children
    collect(node.children)
    collect(node.props?.children)
    if (node.props?.label) textNodes.push(String(node.props.label))
  }
}
collect(tree)

const expectedTabs = ['记忆库', '召回调试', '索引', '设置']
for (const tab of expectedTabs) {
  check(`Tab「${tab}」已渲染`, textNodes.includes(tab))
}

// ---- 反向验证：必须没有任何会被误当成 ESM 默认导出的键 ----
// DSH 的 loader 遇到 `default` 会优先把它当默认导出，于是一个 React 组件
// 会被当作 plugin 调用 → 返回 React element → 激活失败
// （真实症状：web boot: "@local/dsh-vcprag: failed"）
check('exports 里没有 `default` 键',
  !('default' in exportsObj),
  '有 default 会让 loader 把组件当插件，导致激活失败')
check('exports 里没有多余组件键（Panel）',
  !('Panel' in exportsObj),
  '只应导出 name / inject / apply')

const allowedKeys = ['name', 'inject', 'apply']
const extraKeys = Object.keys(exportsObj).filter((k) => !allowedKeys.includes(k))
check('exports 只含 name/inject/apply',
  extraKeys.length === 0,
  extraKeys.length > 0 ? '多余键: ' + extraKeys.join(', ') : '')

check('exports 里没有残留的 window.__vcprag* 依赖',
  !source.includes('__vcpragShared') && !source.includes('__vcpragLibrary'),
  '旧版靠全局变量跨文件，bundle 里加载不到')

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 全部通过：面板已正确挂载到 settings.section')
