// 用假 ctx 直接跑 registerRpc，验证 16 个端点真的注册上、并且能返回数据。
//
// 为什么需要这个测试：UI 能打开但一直"读取状态…"、0 篇文档，
// 根因是 index.js 的 inject 里漏了 'webServer'，导致 ctx.get('webServer')
// 返回 undefined，registerRpc 静默 return —— 端点一个都没注册。
// 静态检查完全看不出来，必须行为级验证。

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { registerRpc } from '../lib/rpc.js'
import { Indexer } from '../lib/indexer.js'
import { resolveConfig } from '../lib/config.js'
import { RecallFridge } from '../lib/freeze.js'

// corpusRoot 留空 = 只用日记作为唯一来源（迁移完成后的推荐形态）
const corpusRoot = ''
const diaryRoot = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-diaries'
const runtimeFile = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-mnemon-memory/runtime/memories.json'
const dataDir = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-memory'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// ---- 假 ctx：记录 webServer.register 的调用 ----
const registered = []
const webServer = {
  register(route) {
    registered.push(route)
    return () => {}
  },
}

const ctx = {
  get(name) {
    // 这正是真实行为：只有声明过的服务才拿得到。
    // 这个测试模拟「inject 正确声明了 webServer」的情况。
    if (name === 'webServer') return webServer
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

// embedding 的 baseUrl / model / dimensions 必须与**建索引时用的完全一致**，
// 否则维度保护会判定不兼容并 fatal 降级（这是设计正确的行为，不是缺陷）。
// 所以这里从 manifest 里读真实值，而不是写死。
const manifestPath = path.join(dataDir, 'index', 'manifest.json')
let indexed = {}
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  indexed = manifest?.embedding ?? {}
} catch {
  /* 没有索引时留空，后续会因缺配置自动降级，不影响其他断言 */
}

const config = resolveConfig({
  corpusRoot,
  diaryRoot,
  dataDir,
  diary: { enabled: true, format: 'txt', runtimeFile },
  embedding: {
    enabled: true,
    baseUrl: indexed.baseUrl ?? 'https://example.invalid/v1',
    model: indexed.model ?? '',
    dimensions: indexed.dimensions ?? 3072,
  },
})
const logger = []
const log = (level, message) => logger.push(`${level}: ${message}`)

// ---- 构造真实 Indexer ----
// 注意：indexDir 指向 dataDir 下的 index 子目录（生产索引就在那儿）
const indexer = new Indexer({
  indexDir: path.join(dataDir, 'index'),
  getConfig: () => config,
  log,
})
await indexer.load()

const fridges = new Map()
const fridgeFor = (sessionId) => {
  const key = sessionId ?? 'default'
  if (!fridges.has(key)) fridges.set(key, new RecallFridge())
  return fridges.get(key)
}

console.log('=== 注册 RPC ===')
registerRpc(ctx, {
  getConfig: () => config,
  setConfig: () => {},
  indexer,
  fridgeFor,
  log,
  corpusRootOf: () => config.corpusRoot,
})

console.log('logger:', logger.join(' | ') || '(空)')
console.log('')

// ---- 断言 ----
check('webServer.register 被调用', registered.length > 0, String(registered.length) + ' 条')
// 端点数量随功能增长（19 → 20 加了 /diary/semantic/preview）。
// 断言精确数字是刻意的：少一个说明注册路径断了，
// 多一个说明有人加了端点却没更新测试，两边都该被看见。
check('注册了 20 个端点', registered.length === 20, String(registered.length))

const paths = registered.map((r) => r.path).sort()
console.log('端点清单:', paths.join(', '))
check('全部走 /api/vcprag 前缀', paths.every((p) => p.startsWith('/api/vcprag/')), paths[0])
check('全部是 exact 路由', registered.every((r) => r.kind === 'exact'))
check('每条都有 handler', registered.every((r) => typeof r.handler === 'function'))

// ---- 真的调用 handler 拿数据 ----
function fakeRes() {
  const out = { headers: {}, body: '' }
  // res.statusCode 是直接赋值的属性，必须让 out 与 res 共享
  const res = {
    statusCode: 0,
    setHeader(k, v) { out.headers[k] = v },
    end(chunk) { out.body = String(chunk ?? '') },
  }
  res.out = out
  return res
}
function fakeReq(url) {
  const handlers = {}
  return {
    url,
    method: 'GET',
    on(event, fn) { handlers[event] = fn },
    destroy() {},
    _handlers: handlers,
  }
}

async function callRoute(suffix, query = '') {
  const route = registered.find((r) => r.path === '/api/vcprag' + suffix)
  if (!route) throw new Error('找不到路由 ' + suffix)
  const req = fakeReq('/api/vcprag' + suffix + query)
  const res = fakeRes()
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.out.body) }
}

console.log('')
console.log('=== 实际调用 /state ===')
const state = await callRoute('/state')
check('/state 返回 200', state.status === 200, String(state.status))
check('/state ok=true', state.json.ok === true)
check('/state 有 corpus', typeof state.json.corpus === 'object')
check('/state 有 index', typeof state.json.index === 'object')
console.log('  corpus.activeDocs =', state.json.corpus?.activeDocs)
console.log('  corpus.runtimeCount =', state.json.corpus?.runtimeCount)
console.log('  index.docCount =', state.json.index?.docCount)
console.log('  index.chunkCount =', state.json.index?.chunkCount)
console.log('  index.vectorized =', state.json.index?.vectorized)
console.log('  index.hybridReady =', state.json.index?.hybridReady)

// 这里**不能写死篇数**。
//
// 曾经断言 `=== 61`，于是用户随手写一篇新日记、语料从 61 变 62 时，
// 这条测试就红了 —— 但插件完全正常，红的是测试表达的东西不对：
// 「语料里恰好有 61 篇」不是我们要保证的性质。
//
// 真正要保证的是**自洽**：
//   · 日记数与索引 docCount 相等 → 说明没有漏索引、也没有重复索引
//     （重复是真实踩过的坑：old .md 与 .txt 两层同时开会翻倍）
//   · 篇数 > 0                        → 说明语料确实被读到了
//   · library 行数 === docCount        → 列表与索引同一份数据
const diaryDocs = state.json.corpus?.diaryDocs
const docCount = state.json.index?.docCount

check('/state 读到日记（篇数 > 0）', typeof diaryDocs === 'number' && diaryDocs > 0, String(diaryDocs))
check(
  '/state 的 docCount 与日记数一致（无重复索引）',
  docCount === diaryDocs,
  `docCount=${docCount} diaryDocs=${diaryDocs}`,
)
// chunk 数随分块参数与日记内容变化，这里只断言「非零且与 manifest 一致」
const manifestChunks = state.json.index?.chunkCount
check('/state chunk 数 > 0', typeof manifestChunks === 'number' && manifestChunks > 0, String(manifestChunks))
check(
  '/state 已向量化的 chunk 与总数一致',
  state.json.index?.vectorized === manifestChunks,
  `${state.json.index?.vectorized} / ${manifestChunks}`,
)
check('/state 混合召回就绪', state.json.index?.hybridReady === true, String(state.json.index?.hybridReady))

console.log('')
console.log('=== 实际调用 /library ===')
const lib = await callRoute('/library')
check('/library 返回 200', lib.status === 200, String(lib.status))
check('/library ok=true', lib.json.ok === true)
check('/library 有 rows', Array.isArray(lib.json.rows))
// 同样不写死篇数：library 的口径必须和 /state 的 docCount 一致，
// 这才是「列表与索引是同一份数据」的证据。
check(
  '/library 行数与 docCount 一致',
  lib.json.rows?.length === docCount,
  `rows=${lib.json.rows?.length} docCount=${docCount}`,
)
if (lib.json.rows?.length > 0) {
  const first = lib.json.rows[0]
  console.log('  首行:', JSON.stringify({ docId: first.docId, title: first.title, chunks: first.chunks }).slice(0, 160))
  check('首行有标题', typeof first.title === 'string' && first.title.length > 0, first.title)
  check('首行 chunk 数 > 0', first.chunks > 0, String(first.chunks))
}

console.log('')
console.log('=== 实际调用 /settings 与 /runtime 与 /aliases ===')
for (const p of ['/settings', '/runtime', '/aliases', '/index/progress']) {
  const r = await callRoute(p)
  check(`${p} 返回 200 且 ok=true`, r.status === 200 && r.json.ok === true, `status=${r.status} ok=${r.json.ok}`)
}

const rt = await callRoute('/runtime')
console.log('  runtime memories =', Array.isArray(rt.json.memories) ? rt.json.memories.length : '?')
check('/runtime 有 18 条', rt.json.memories?.length === 18, String(rt.json.memories?.length))

console.log('')
console.log('=== 实际调用 /recall（词法通道）===')
const rec = await callRoute('/recall', '?q=记忆&limit=5&only=lexical')
check('/recall 返回 200', rec.status === 200, String(rec.status))
check('/recall ok=true', rec.json.ok === true)
console.log('  hits =', rec.json.hits?.length)
if (rec.json.hits?.length > 0) {
  console.log('  top1 =', JSON.stringify({ title: rec.json.hits[0].title, final: rec.json.hits[0].final }).slice(0, 160))
  check('recall 有命中', rec.json.hits.length > 0)
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 全部通过：RPC 端点真实可用，数据能读出来')
