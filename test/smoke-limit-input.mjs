/**
 * smoke-limit-input —— 验证「消息条数上限」真的能在设置面板里改。
 *
 * 这个文件存在的理由：maxMessages 这个配置项一直存在于 config.js 和
 * rpc.js 的白名单里，后端 clamp、热更新、落盘全都正常。但设置面板上
 * **没有任何输入框** —— 于是用户在日志里看到
 *
 *     召回消息已达上限 3 条，不再追加…
 *
 * 之后完全无处可改，只能改代码。静态检查抓不到这种缺陷：代码语法正确、
 * 配置项存在、甚至连注释都写着「可在配置里调」，只是面板没长那个控件。
 *
 * 所以这里把 ui/client.js 真跑一遍，喂一份 mode=message 的配置，
 * 断言「设置」Tab 里确实渲染出两个数字输入框（常驻 / 召回各一个），
 * 并且改动会写回 draft.runtime.maxMessages / draft.inject.maxMessages。
 *
 * 跑法：
 *   node test/smoke-limit-input.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'ui', 'client.js')
const source = await readFile(clientPath, 'utf8')

let passed = 0
let failed = 0
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}`)
  } else {
    failed += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------- 假环境

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) }
}

/** 一份「两种通道都选了对话消息」的配置 —— 只有这时上限输入框才该出现。 */
const fakeConfig = {
  runtime: {
    inject: true,
    mode: 'message',
    maxMessages: 3,
    order: 120,
    title: '## 长期记忆',
    intro: 'x',
    criticalTitle: '### 必须遵守',
    normalTitle: '### 一般事实',
    toolGuidance: true,
  },
  inject: {
    enabled: true,
    mode: 'message',
    maxMessages: 3,
    order: 125,
    blockName: 'vcprag-recall',
    header: 'h',
    disclaimer: 'd',
    itemPrefix: '[{n}]',
  },
  diary: { enabled: true, format: 'txt', folder: '', templateEnabled: true, templateOrder: 130, templateText: '', requireTag: true, timePrefix: true, runtimeFile: '' },
  diarySemantic: {},
  embedding: { enabled: true, baseUrl: '', model: '', dimensions: 3072, batchSize: 16, concurrency: 2, minIntervalMs: 700, timeoutMs: 30000, apiKey: '' },
  recall: { kBase: 5, kMin: 3, kMax: 10, lexicalLimit: 30, semanticLimit: 30, maxChars: 4000, tagWeight: 1 },
  timeDecay: { enabled: true, halfLifeDays: 180, floor: 0.55 },
  freeze: { onUserMessage: true, onTodoCheck: true },
  tools: { enabled: true, writeEnabled: true, forgetEnabled: false },
}

/** SettingsTab 的初始 state 特征：带 runtimeDraft 字段。 */
const fakeSettingsState = {
  data: { ok: true, config: fakeConfig },
  draft: JSON.parse(JSON.stringify(fakeConfig)),
  msg: null,
  testResult: null,
  models: null,
  dialog: null,
  runtimeDraft: [],
  aliasText: '',
  folders: null,
  template: null,
  templateText: '',
  previewText: '',
  preview: null,
}

/**
 * 当前 SettingsTab state。
 *
 * 必须**真的更新**它：`patch()` 的实现是
 *   `var next = JSON.parse(JSON.stringify(s.draft))`
 * 也就是说每次都从 state 里重新克隆一份再改。如果这里只记录 setState
 * 调用、不更新 state，那么连改两个输入框时第二次会从头克隆，
 * 把第一次的结果覆盖掉 —— 测试会误报「绑定错了字段」。
 * 这本身也顺带验证了 patch 的语义是「基于最新 state」。
 */
let currentSettingsState = JSON.parse(JSON.stringify(fakeSettingsState))

/** 记录每次 setState 产生的 state 快照，便于断言。 */
const stateSnapshots = []

const React = {
  createElement,
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    // SettingsTab 的 state 对象带 runtimeDraft；喂带真实配置的版本，
    // 否则渲染出来是「加载中」，看不到任何控件。
    if (value !== null && typeof value === 'object' && 'runtimeDraft' in value) {
      return [currentSettingsState, (next) => {
        const partial = typeof next === 'function' ? next(currentSettingsState) : next
        currentSettingsState = Object.assign({}, currentSettingsState, partial)
        stateSnapshots.push(JSON.parse(JSON.stringify(currentSettingsState)))
      }]
    }
    // 默认 Tab 直接切到「设置」，省去模拟点击。
    if (value === 'library') return ['settings', () => {}]
    return [value, (next) => stateSnapshots.push(next)]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef(initial) {
    return { current: initial }
  },
  useMemo(fn) {
    return fn()
  },
}

let registered = null
globalThis.window = { __ModuleLoader__: { load(entry) { registered = entry } } }
globalThis.document = { baseURI: 'http://localhost:3000/' }
globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: '测试环境不发起真实请求' }) })
const realSetInterval = setInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = () => 0
globalThis.clearTimeout = () => {}

const run = new Function(
  'window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
  source,
)
run(
  globalThis.window, globalThis.document, globalThis.fetch,
  globalThis.setInterval, globalThis.clearInterval, globalThis.setTimeout, globalThis.clearTimeout,
)

const exportsObj = registered.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('未知模块: ' + spec)
})

const registrations = []
exportsObj.apply({
  get: (key) => (key === 'slots'
    ? { inject: (_o, cb) => cb(), register: (options, component) => registrations.push({ options, component }) }
    : undefined),
})

// ---------------------------------------------------------------- 遍历元素树

/**
 * 深度收集所有节点，附带「附近的可读文本」，便于断言时定位。
 *
 * 必须**递归调用函数组件**：`h(SettingsTab, {...})` 只是一个
 * `{ type: SettingsTab }` 的对象，本身没有 children —— 不调用它
 * 就永远看不到 Tab 里到底渲染了什么，测试会误判成「控件不存在」。
 * 这也正是「面板缺控件」这类 bug 容易被放过的原因：树是空的很安静。
 */
function collect(node, out = [], textStack = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out, textStack)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (typeof node !== 'object') return out

  // 函数组件 → 调它，拿返回的真实元素树继续走
  if (typeof node.type === 'function') {
    let rendered = null
    try {
      rendered = node.type(node.props || {})
    } catch (error) {
      out.push({ node, text: `<渲染失败: ${error.message}>`, renderError: error })
      return out
    }
    collect(rendered, out, textStack)
    return out
  }

  const childArray = Array.isArray(node.children) ? node.children : []
  const own = childArray
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .map(String)
  const nextText = own.length > 0 ? [...textStack, ...own] : textStack

  out.push({ node, text: [...textStack, ...own].join(' ') })
  for (const child of childArray) collect(child, out, nextText)
  return out
}

const results = []
for (const reg of registrations) {
  let tree = null
  try {
    tree = reg.component({})
  } catch (error) {
    console.log(`\n渲染 ${reg.options.id} 时抛错：${error.message}`)
  }
  results.push({ id: reg.options.id, tree })
}

console.log('\n=== 1. 设置面板能渲染出「设置」Tab ===')
{
  const settings = results.find((r) => r.id === 'vcprag')
  ok('找到面板', settings !== undefined)
  const nodes = collect(settings.tree)
  const tabLabels = nodes
    .map((n) => n.node)
    .filter((n) => n.type === 'button' && typeof n.children[0] === 'string')
    .map((n) => n.children[0])
  ok('四个 Tab 都在', ['记忆库', '召回调试', '索引', '设置'].every((t) => tabLabels.includes(t)), tabLabels.join(' / '))
}

console.log('\n=== 2. mode=message 时出现「最多保留几条」输入框 ===')
{
  const settings = results.find((r) => r.id === 'vcprag')
  const nodes = collect(settings.tree)

  const capInputs = nodes.filter(
    (n) => n.node.type === 'input' && n.node.props?.type === 'number' && n.node.props?.max === 200,
  )

  eq('恰好两个上限输入框（常驻 + 召回）', capInputs.length, 2)
  ok('都带 min=0', capInputs.every((n) => n.node.props?.min === 0))

  // 默认值 3 应当出现在框里
  ok('默认值是 3', capInputs.some((n) => n.node.props?.value === '3'),
    capInputs.map((n) => n.node.props?.value).join(','))

  // 标签文案
  const labels = nodes
    .map((n) => n.node)
    .filter((n) => typeof n.children[0] === 'string')
    .map((n) => n.children[0])
  ok('有「最多保留几条」标签', labels.includes('最多保留几条'))
}

/** 重新渲染一次面板，拿最新的元素树（state 改了之后必须重取）。 */
function freshNodes() {
  const reg = registrations.find((r) => r.options.id === 'vcprag')
  return collect(reg.component({}))
}

/** 从树里挑出所有上限输入框。 */
function capInputsOf(nodes) {
  return nodes.filter(
    (n) => n.node.type === 'input' && n.node.props?.type === 'number' && n.node.props?.max === 200,
  )
}

/** 按通道 key 精确取一个输入框（靠 data-cap，不靠数组下标）。 */
function capInputOf(key) {
  const found = capInputsOf(freshNodes()).filter((n) => n.node.props?.['data-cap'] === key)
  if (found.length !== 1) throw new Error(`data-cap=${key} 的输入框应当恰好 1 个，实际 ${found.length}`)
  return found[0]
}

console.log('\n=== 3. 两个输入框分别绑定 runtime / inject 的上限 ===')
{
  eq('拿到两个输入框', capInputsOf(freshNodes()).length, 2)
  ok('两个框各有明确的 data-cap 标记',
    capInputsOf(freshNodes()).every((n) => n.node.props?.['data-cap'] === 'runtime'
      || n.node.props?.['data-cap'] === 'inject'),
    capInputsOf(freshNodes()).map((n) => n.node.props?.['data-cap']).join(','))
  eq('默认值都是 3', capInputOf('runtime').node.props.value, '3')

  /*
   * 注意：每次 onChange 之后都必须重新渲染再取新树。
   *
   * `patch()` 的实现是 `JSON.parse(JSON.stringify(s.draft))` —— 它从**渲染时
   * 闭包里**的 `s.draft` 克隆。真实 React 里 setState 会触发重渲染、换上新闭包；
   * 测试里如果复用同一棵旧树上的两个 onChange，第二次就会基于旧快照克隆，
   * 把第一次的结果抹掉，看起来像「字段绑定错了」。
   */
  const before = JSON.parse(JSON.stringify(currentSettingsState.draft))

  capInputOf('runtime').node.props.onChange({ target: { value: '7' } })
  const afterFirst = JSON.parse(JSON.stringify(currentSettingsState.draft))
  eq('改常驻框 → runtime.maxMessages = 7', afterFirst.runtime.maxMessages, 7)
  eq('召回框不受影响', afterFirst.inject.maxMessages, before.inject.maxMessages)

  capInputOf('inject').node.props.onChange({ target: { value: '9' } })
  const afterSecond = JSON.parse(JSON.stringify(currentSettingsState.draft))
  eq('改召回框 → inject.maxMessages = 9', afterSecond.inject.maxMessages, 9)
  eq('常驻框的值被保留（两次改动不互相覆盖）', afterSecond.runtime.maxMessages, 7)

  // 渲染出来的 value 也跟着变了
  eq('常驻框显示 7', capInputOf('runtime').node.props.value, '7')
  eq('召回框显示 9', capInputOf('inject').node.props.value, '9')
}

console.log('\n=== 4. 输入 0 表示不限制，能被接受 ===')
{
  /*
   * 先把召回上限拉回一个明确的非零值，再做 0 / 超界 / 负数 的边界测试，
   * 免得「上一步已经是 0」让断言变成空转。
   */
  const setInject = (raw) => {
    capInputOf('inject').node.props.onChange({ target: { value: raw } })
    return currentSettingsState.draft.inject.maxMessages
  }

  eq('先设成 5', setInject('5'), 5)
  eq('0 被写入（不是被当成空值丢掉）', setInject('0'), 0)
  eq('超大值夹到 200', setInject('9999'), 200)
  eq('负数夹到 0', setInject('-8'), 0)
  eq('小数四舍五入', setInject('4.6'), 5)

  // 清空输入时不写入垃圾（用户删光重打的中途状态）
  const before = currentSettingsState.draft.inject.maxMessages
  stateSnapshots.length = 0
  capInputOf('inject').node.props.onChange({ target: { value: '' } })
  eq('清空输入不触发写回', stateSnapshots.length, 0)
  eq('清空后原值不变', currentSettingsState.draft.inject.maxMessages, before)
}

console.log('\n=== 5. 选「系统提示词」时不显示上限框（prompt 模式无上限） ===')
{
  // 换一份 prompt 模式配置重新渲染
  const promptConfig = JSON.parse(JSON.stringify(fakeConfig))
  promptConfig.runtime.mode = 'section'
  promptConfig.inject.mode = 'context'
  currentSettingsState = Object.assign({}, currentSettingsState, {
    data: { ok: true, config: promptConfig },
    draft: JSON.parse(JSON.stringify(promptConfig)),
  })

  eq('prompt 模式下没有上限输入框', capInputsOf(freshNodes()).length, 0)

  // 只切换其中一路为 message，应当只出现一个框（互不牵连）
  const mixed = JSON.parse(JSON.stringify(promptConfig))
  mixed.inject.mode = 'message'
  currentSettingsState = Object.assign({}, currentSettingsState, {
    data: { ok: true, config: mixed },
    draft: JSON.parse(JSON.stringify(mixed)),
  })
  eq('只有召回走 message 时只出现一个框', capInputsOf(freshNodes()).length, 1)
}

console.log('\n=== 6. UI 改的值真能落盘成 overlay（delta 语义不变） ===')
{
  /*
   * 前面证明的是「界面上的框能改到 draft」。这一步证明**改完之后存得下去**：
   * 走的是与真实保存完全相同的 buildOverlay / mergeForSave。
   *
   * 之所以要单独验：SECTION_KEYS 白名单是手工维护的。maxMessages 这次恰好在
   * 里面，但如果哪天有人重排白名单漏了它，界面照样能改、能点保存、
   * 接口照样回 ok:true —— 只是盘上什么都没有。这正是本项目反复踩到的
   * 「返回成功但静默失效」，必须由测试锁住。
   */
  const { buildOverlayForTest, mergeForSaveForTest } = await import('./_rpc-harness.mjs')

  const current = {
    diary: {}, embedding: {}, recall: {}, timeDecay: {}, freeze: {}, tools: {},
    runtime: { inject: true, mode: 'message', maxMessages: 3, order: 120, title: 't', intro: 'i', criticalTitle: 'c', normalTitle: 'n', toolGuidance: true },
    inject: { enabled: true, mode: 'message', maxMessages: 3, order: 125, blockName: 'b', header: 'h', disclaimer: 'd', itemPrefix: 'p' },
  }

  const patch = JSON.parse(JSON.stringify(current))
  patch.runtime.maxMessages = 0    // 0 = 不限制
  patch.inject.maxMessages = 12

  const overlay = buildOverlayForTest(patch, current)
  eq('overlay 带上 runtime.maxMessages', overlay?.runtime?.maxMessages, 0)
  eq('overlay 带上 inject.maxMessages', overlay?.inject?.maxMessages, 12)

  const merged = mergeForSaveForTest(current, patch)
  eq('合并后 runtime.maxMessages', merged.runtime.maxMessages, 0)
  eq('合并后 inject.maxMessages', merged.inject.maxMessages, 12)

  // 两段互不串台
  ok('改 runtime 不会带出 inject 的脏值',
    buildOverlayForTest({ ...JSON.parse(JSON.stringify(current)), runtime: { ...current.runtime, maxMessages: 50 } }, current)
      ?.inject?.maxMessages === undefined)

  // 没改动就不写 overlay（保持 delta 语义，别把整份配置抄进 overlay）
  ok('未改动时 overlay 为空', Object.keys(buildOverlayForTest(JSON.parse(JSON.stringify(current)), current)).length === 0)
}

globalThis.setInterval = realSetInterval

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) process.exitCode = 1
