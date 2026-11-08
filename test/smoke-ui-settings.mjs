// 冒烟测试：真的把「设置」Tab 渲染出来，验证相关性裁判区块存在且可交互。
//
// 为什么必须单独有这一个文件：smoke-ui.mjs 只渲染 Panel 的首屏（记忆库 Tab），
// 而它用的 createElement 只把 children 存进对象、**从不调用子组件**，所以
// SettingsTab 这个函数一次都没被执行过。设置页里的错误恰好全是「静态检查
// 全绿、运行时才炸」的那一类，本次开发连踩三个：
//
//   1. 新增区块时多了一个 `)` → new Function 编译失败 → 整个面板白屏
//      （node --check 能抓，但那已经是最幸运的情况）
//   2. publicConfig() 没有回传 judge 段 → 面板永远显示兜底默认值，
//      用户改完保存「成功」，实际写进 overlay 的是别的东西
//   3. 老配置文件没有 judge 段时，patch('judge.enabled', ...) 在
//      target['judge'] 上赋值 → TypeError → 整页炸掉
//
// 所以这里实现了一个极小的递归渲染器：真的调用组件函数、真的保留
// useState 的值、真的执行 useEffect，然后把结果树摊平来断言。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// rpc 层的纯函数（overlay / merge 构造）。放最上面是因为 D 段要用，
// 免得再来一次「Cannot access before initialization」。
import * as overlayHarness from './_rpc-harness.mjs'

/**
 * 「开启裁判但缺 key」时的提示文案。
 *
 * 抽成常量而不是内联字符串：这条文案随功能演进而改过两次
 * （先是「只走环境变量」，后来面板也能填 key）。内联时每改一次
 * 文案就要改三处断言，其中一处漏改就会出现「功能明明是好的、
 * 测试却红了」的假警报。
 */
const JUDGE_ON_HINT = '面板和环境变量都没给 API Key'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'ui', 'client.js')
const source = await readFile(clientPath, 'utf8')

// ================= 迷你 React =================
//
// 只需要四个能力：createElement / useState（跨渲染保留值）/ useEffect
// （首次挂载跑一次）/ 以及递归调用函数组件。够用就好，不追求正确性
// 完备 —— 这里的目标是「把页面画出来」而不是复刻 React。

function createElement(type, props, ...children) {
  return {
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined),
  }
}

/** 每个组件函数一份 hook 存储：Map<fn, any[]> */
const stores = new Map()
/** 当前渲染趟里，每个组件已用掉几个 hook：Map<fn, number> */
const cursors = new Map()
/** 组件调用栈，用于 useState 知道自己属于谁 */
const stack = []
/** 这一趟是否有 setState，需要重渲染 */
let dirty = false

function currentStore() {
  const owner = stack[stack.length - 1]
  if (owner === undefined) throw new Error('hook 调用发生在组件外')
  if (!stores.has(owner)) stores.set(owner, [])
  return stores.get(owner)
}

function nextIndex() {
  const owner = stack[stack.length - 1]
  const i = cursors.get(owner) || 0
  cursors.set(owner, i + 1)
  return i
}

const useEffectQueue = []

const React = {
  createElement,
  useState(initial) {
    const store = currentStore()
    const i = nextIndex()
    if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
    const setter = (updater) => {
      const next = typeof updater === 'function' ? updater(store[i]) : updater
      if (next !== store[i]) {
        store[i] = next
        dirty = true
      }
    }
    return [store[i], setter]
  },
  useEffect(effect, deps) {
    const store = currentStore()
    const i = nextIndex()
    const prev = store[i]
    const shouldRun = prev === undefined
      || deps === undefined
      || !Array.isArray(prev.deps)
      || deps.length !== prev.deps.length
      || deps.some((d, k) => d !== prev.deps[k])
    store[i] = { deps }
    if (shouldRun) useEffectQueue.push(effect)
  },
  useCallback(fn) { return fn },
  useRef(initial) {
    const store = currentStore()
    const i = nextIndex()
    if (!(i in store)) store[i] = { current: initial }
    return store[i]
  },
  useMemo(fn) {
    const store = currentStore()
    const i = nextIndex()
    if (!(i in store)) store[i] = fn()
    return store[i]
  },
}

/** 递归渲染：函数组件真的被调用，host 元素保留 children。 */
function renderNode(node) {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(renderNode)
  if (typeof node !== 'object') return node

  if (typeof node.type === 'function') {
    const fn = node.type
    const savedCursor = cursors.get(fn)
    cursors.set(fn, 0)
    stack.push(fn)
    let output
    try {
      output = fn(node.props)
    } finally {
      stack.pop()
      if (savedCursor === undefined) cursors.delete(fn)
      else cursors.set(fn, savedCursor)
    }
    return renderNode(output)
  }

  return {
    type: node.type,
    props: node.props,
    children: renderNode(node.children),
  }
}

/** 渲染一趟 + 执行排队的 effect。 */
function renderPass(root) {
  useEffectQueue.length = 0
  // root 是组件函数，必须先包成元素节点，否则 renderNode 会把它当成
  // 一个未知对象返回空树（症状：「找不到设置 Tab 按钮」）。
  const tree = renderNode(createElement(root, {}))
  const effects = useEffectQueue.slice()
  useEffectQueue.length = 0
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') effectCleanups.push(cleanup)
  }
  return tree
}
const effectCleanups = []

/** 反复渲染直到没有 setState（fetch 的 .then 落定后都会 setState）。 */
async function settle(root, maxPasses = 60) {
  let tree = renderPass(root)
  for (let i = 0; i < maxPasses; i += 1) {
    // 让 pending 的 promise 回调先跑完
    await new Promise((r) => setImmediate(r))
    if (!dirty) break
    dirty = false
    tree = renderPass(root)
  }
  dirty = false
  return tree
}

// ================= 宿主环境替身 =================

let registered = null
globalThis.window = { __ModuleLoader__: { load(entry) { registered = entry } } }
globalThis.document = { baseURI: 'http://localhost:3000/' }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}
globalThis.console = console

let routes = {}
globalThis.fetch = async (url) => {
  const text = String(url)
  for (const [needle, payload] of Object.entries(routes)) {
    if (text.includes(needle)) return { json: async () => payload }
  }
  return { json: async () => ({ ok: false, error: '未打桩的请求：' + text }) }
}

const fn = new Function(
  'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source,
)
fn(globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval,
  globalThis.clearInterval, globalThis.setTimeout, globalThis.clearTimeout)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error('未知模块: ' + spec)
}
const exportsObj = registered.factory(requireStub)

// ---- 从 slot 注册里拿到 Panel 组件 ----
// TABS / SettingsTab 都是闭包局部变量，从外部拿不到。但 slot 注册时把
// Panel 这个组件函数交出来了 —— 渲染它并点「设置」，SettingsTab 就会被执行。
const slotsCalls = []
const slots = {
  inject(ownerKey, cb) { return cb() },
  register(options, component) { slotsCalls.push({ options, component }); return () => {} },
}
exportsObj.apply({ get: (key) => (key === 'slots' ? slots : undefined) })
const Panel = slotsCalls[0]?.component
check('从 slot 注册拿到 Panel 组件', typeof Panel === 'function')

// ---- 遍历工具 ----
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  walk(node.children, out)
  return out
}

function textOf(node) {
  const parts = []
  const visit = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(visit); return }
    if (typeof n === 'object') visit(n.children)
  }
  visit(node)
  return parts.join('')
}

/** 渲染面板并切到「设置」Tab。 */
async function renderSettingsTab() {
  let tree = await settle(Panel)
  const settingsBtn = walk(tree).find((n) => n.type === 'button' && textOf(n) === '设置')
  if (settingsBtn === undefined) throw new Error('找不到「设置」Tab 按钮')
  settingsBtn.props.onClick()
  return settle(Panel)
}

function numberValues(tree) {
  return walk(tree)
    .filter((n) => n.type === 'input' && n.props.type === 'number')
    .map((n) => Number(n.props.value))
}

function checkboxes(tree) {
  return walk(tree).filter((n) => n.type === 'input' && n.props.type === 'checkbox')
}

/** 一份老版本配置：**故意没有 judge 段**。 */
function baseConfig() {
  return {
    corpusRoot: '',
    diaryRoot: 'C:/diaries',
    chunkSize: 800,
    chunkOverlap: 120,
    diary: {
      enabled: true, format: 'txt', folder: '', templateEnabled: false, templateOrder: 130,
      templateText: '', requireTag: true, timePrefix: true, runtimeFile: '',
      semantic: {
        enabled: false, blockName: 'semantic', updateMinTarget: 60,
        allowUpdate: true, indexImmediately: true, stripFromDisplay: true,
      },
    },
    embedding: {
      enabled: true, baseUrl: 'https://x/v1', model: 'm', dimensions: 3072,
      batchSize: 16, concurrency: 4, minIntervalMs: 0, timeoutMs: 30000, apiKey: '',
    },
    recall: {
      lexicalLimit: 30, semanticLimit: 30, kBase: 5, kMin: 3, kMax: 10,
      tagWeight: 0.4, maxChars: 4000, tokenizer: 'auto',
      singleCharWeight: 0.3, semanticWeight: 0.6, lexicalWeight: 0.4,
      minSemantic: 0.3, requireSemantic: true, minTokenLen: 2, minTokenIdf: 1,
    },
    timeDecay: { enabled: true, halfLifeDays: 180, floor: 0.55 },
    freeze: { onUserMessage: true, onTodoCheck: true },
    runtime: {
      inject: true, mode: 'section', maxMessages: 0, order: 120,
      title: 't', intro: 'i', criticalTitle: 'c', normalTitle: 'n', toolGuidance: true,
    },
    inject: {
      enabled: true, mode: 'section', maxMessages: 0, order: 125,
      blockName: 'b', header: 'h', disclaimer: 'd', itemPrefix: 'p',
    },
    tools: { enabled: true, writeEnabled: true, forgetEnabled: true },
  }
}

function stubSettings(config) {
  routes = {
    '/vcprag/settings': {
      ok: true,
      config,
      defaults: {},
      manifestEmbedding: null,
      keyPresent: false,
      tokenizer: { configured: 'auto', active: 'jieba', indexed: 'jieba', loadError: null },
    },
    '/vcprag/runtime': { ok: true, memories: [] },
    '/vcprag/aliases': { ok: true, aliases: {} },
    '/vcprag/diary/folders': { ok: true, folders: [] },
    '/vcprag/diary/template': { ok: true, template: { text: '', enabled: false, order: 130 } },
  }
}

// ================= A. 老配置（无 judge 段）不能炸 =================
console.log('\n=== A. 老配置（无 judge 段）也要能渲染 ===')
stubSettings(baseConfig())

let settingsTree = null
let renderError = null
try {
  settingsTree = await renderSettingsTab()
} catch (e) {
  renderError = e
}
check('SettingsTab 渲染不抛异常（judge 段缺失时）', renderError === null,
  renderError ? renderError.message : '')

const textA = textOf(settingsTree)
check('没有卡在「加载中…」', !textA.includes('加载中…'))
check('渲染出「相关性裁判（可选）」区块', textA.includes('相关性裁判（可选）'))

const valuesA = numberValues(settingsTree)
check('阈值兜底显示 0.7', valuesA.includes(0.7), JSON.stringify(valuesA))
check('最多判几条兜底显示 12', valuesA.includes(12))
check('并发数兜底显示 8', valuesA.includes(8))
check('超时兜底显示 4000', valuesA.includes(4000))

// ================= B. 点「启用裁判」开关 =================
// 老配置的 draft 里没有 judge 段 —— patch('judge.enabled') 正是会 TypeError
// 的地方。这条断言就是防止那个回归。
console.log('\n=== B. 点开关（draft 里没有 judge 段）===')
const boxesA = checkboxes(settingsTree)
check('设置页有复选框', boxesA.length > 0, String(boxesA.length))

let enableToggle = null
let toggleError = null
for (const box of boxesA) {
  try {
    box.props.onChange({ target: { checked: true } })
  } catch (e) {
    toggleError = toggleError || e
    continue
  }
  const next = await settle(Panel)
  if (textOf(next).includes(JUDGE_ON_HINT)) {
    enableToggle = box
    settingsTree = next
    break
  }
}
check('点击复选框不抛 TypeError（中间层按需建对象）', toggleError === null,
  toggleError ? toggleError.message : '')
check('有一个复选框是「启用裁判」开关', enableToggle !== null,
  'draft 里没有 judge 段时，patch("judge.enabled") 必须在中间层补对象')
check('开启后出现 key 提示文案', textOf(settingsTree).includes(JUDGE_ON_HINT))

// ================= C. 已有 judge 段时如实回显 =================
console.log('\n=== C. 配置里有 judge 段时如实回显 ===')
const cfgC = baseConfig()
cfgC.judge = {
  enabled: true, threshold: 0.55, maxCandidates: 20, concurrency: 4,
  timeoutMs: 9000, candidateChars: 400, queryChars: 400,
}
stubSettings(cfgC)
// 必须清空 hook 存储：SettingsTab 的 load() 挂在 useEffect(fn, []) 上，
// 只在**挂载**时跑一次。真实浏览器里重开面板 = 重新挂载 = 重新 load；
// 这个 harness 没有卸载概念，不清空就会读到上一场景留下的 draft。
stores.clear()
cursors.clear()
dirty = false
for (const cleanup of effectCleanups.splice(0)) cleanup()

let treeC = null
let errC = null
try {
  treeC = await renderSettingsTab()
} catch (e) {
  errC = e
}
check('judge 段存在时渲染不抛异常', errC === null, errC ? errC.message : '')

const valuesC = numberValues(treeC)
check('回显阈值 0.55', valuesC.includes(0.55), JSON.stringify(valuesC))
check('回显最多判几条 20', valuesC.includes(20))
check('回显并发 4', valuesC.includes(4))
check('回显超时 9000', valuesC.includes(9000))

// ================= D. 连接信息：可编辑，但密钥必须是掩码 =================
// 用户要求 URL / key / 模型名 / 代理地址都能在面板里改，不该为了改个 key
// 去手改配置再重启。所以这里有 2 个密码框（embedding + judge）。
// 安全边界不是「不暴露输入框」，而是「回传的是掩码、掩码不被写盘」。
console.log('\n=== D. 连接信息可编辑，密钥走掩码 ===')
const passwordInputs = walk(treeC).filter((n) => n.type === 'input' && n.props.type === 'password')
check('有 2 个密码框（embedding + judge）', passwordInputs.length === 2, String(passwordInputs.length))

const textC = textOf(treeC)
check('有端点 URL 输入', textC.includes('端点 URL'))
check('有模型名输入', textC.includes('模型名'))
check('有代理地址输入', textC.includes('代理地址'))
check('有 API Key 输入', textC.includes('API Key'))

// 场景 C 的 cfgC 里 judge.apiKey 是空串 → 应显示「未配置」
const judgeKeyInput = passwordInputs[1]
check('judge 密钥未配置时 placeholder 显示「未配置」',
  String(judgeKeyInput.props.placeholder).includes('未配置'), judgeKeyInput.props.placeholder)

// 关键断言：已配置的 key 回显成掩码，且输入框 value 为空
// （value 为空 + placeholder 提示「已配置」，用户不动它就不会覆盖）
const cfgD = baseConfig()
cfgD.judge = { ...cfgC.judge, apiKey: 'sk-real-secret-value' }
const masked = { ...cfgD.judge, apiKey: '••••••••' }  // 模拟 publicConfig 的回包
check('掩码常量是 8 个圆点', masked.apiKey === '••••••••')

// 直接验 harness 的掩码语义：含圆点的值不得进 overlay / 不得覆盖真值
const overlayMasked = overlayHarness.buildOverlayForTest(
  { judge: { apiKey: '••••••••' } },
  { judge: { apiKey: 'sk-real-secret-value' } },
)
check('掩码值不写进 overlay（否则真 key 被八个圆点顶掉）',
  overlayMasked?.judge?.apiKey === undefined, JSON.stringify(overlayMasked?.judge))

const mergedMasked = overlayHarness.mergeForSaveForTest(
  { judge: { apiKey: 'sk-real-secret-value' } },
  { judge: { apiKey: '••••••••' } },
)
check('掩码值不覆盖已存的真 key',
  mergedMasked?.judge?.apiKey === 'sk-real-secret-value', String(mergedMasked?.judge?.apiKey))

// 反向：真 key 必须能存进去
const mergedReal = overlayHarness.mergeForSaveForTest(
  { judge: { apiKey: 'old' } },
  { judge: { apiKey: 'brand-new-key' } },
)
check('真 key 可以保存', mergedReal?.judge?.apiKey === 'brand-new-key', String(mergedReal?.judge?.apiKey))

// ================= E. 保存路径：改 judge 值后提交的 patch 能落到 overlay =================
// 渲染对了但保存路径断了，用户看到的还是「改了没生效」。
const current = { ...cfgC }
const patchFromUi = JSON.parse(JSON.stringify(cfgC))
patchFromUi.judge = { ...patchFromUi.judge, threshold: 0.9, maxCandidates: 30 }

const overlay = overlayHarness.buildOverlayForTest(patchFromUi, current)
check('阈值改动进了 overlay', overlay?.judge?.threshold === 0.9, JSON.stringify(overlay?.judge))
check('最多判几条改动进了 overlay', overlay?.judge?.maxCandidates === 30)
check('未改动的键不写进 overlay（保持 delta 语义）',
  overlay?.judge?.concurrency === undefined && overlay?.judge?.timeoutMs === undefined,
  JSON.stringify(overlay?.judge))

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 全部通过：设置页可渲染、裁判开关可交互、回显与保存路径都对、面板内无密钥')
