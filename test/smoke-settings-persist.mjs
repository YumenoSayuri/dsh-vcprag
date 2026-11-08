/**
 * 设置**必须能跨重启累积保存** —— 而不是「每次保存都把上一次的擦掉」。
 *
 * ## 用户报的现象
 *
 * 「我每次重启，那些设置都没保存，裁判开关又关掉了，我填的 jev url 和 key
 *   也没了，注入位置又变成系统提示词了。」
 *
 * ## 根因
 *
 * 覆盖层（`dataDir/config.json`）是**整份覆盖写**，而 `buildOverlay()` 只
 * 算「相对基准真正变了的项」。
 *
 * 如果基准取的是 **current**（= patch.yml + 旧覆盖层），就会出现：
 *
 *   第 1 次保存：judge 还没生效 → delta 含 judge → 写进 overlay  ✅
 *   重启：judge 生效了
 *   第 2 次保存（只改了 maxMessages）：judge 与 current 相同 →
 *            delta 里没有 judge → **整份 overlay 被覆盖成只有
 *            maxMessages** → judge 的 URL/key/开关全丢        ❌
 *
 * 所以准确的说法不是「重启丢设置」，而是「**每次保存都擦掉上一次保存的
 * 东西，只是重启才暴露**」。注入位置从 message 变回 section 也是同一条：
 * `inject.mode` 同样被擦掉后回落到默认值。
 *
 * ## 修法
 *
 * 基准改成 **baseConfig**（只解析 patch.yml，不含覆盖层）。这样凡是与部署
 * 配置不同的项，**每次**保存都会被重新算进 delta，覆盖层天然幂等、可累积。
 *
 * 跑法：node test/smoke-settings-persist.mjs
 */

import { join } from 'node:path'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { registerRpc } from '../lib/rpc.js'
import { resolveConfig, mergeConfigOverlay, readConfigOverlay } from '../lib/config.js'

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? ` — ${detail}` : ''))
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------------- 临时 dataDir：不碰真实配置 ----------------

const ROOT = join(tmpdir(), `vcprag-persist-${process.pid}-${Date.now()}`)
const dataDir = join(ROOT, 'data')
mkdirSync(join(dataDir, 'index'), { recursive: true })

/** patch.yml 里的「部署配置」——每次重启都只有这一份。 */
const DEPLOYED = {
  corpusRoot: '',
  diaryRoot: 'C:/diaries',
  dataDir,
  inject: { enabled: true, mode: 'section', maxMessages: 5, blockName: 'vcprag-recall' },
  recall: { kBase: 5, kMin: 3, kMax: 10, lexicalLimit: 30, semanticLimit: 30, maxChars: 4000 },
}

function makeIndexer() {
  return {
    bm25: { search: () => [], stats: () => ({ docs: 0, terms: 0, avgLen: 0 }) },
    vectors: { ready: false, search: () => [] },
    embedder: { configured: false, embedOne: async () => new Float32Array([0]) },
    chunks: new Map(),
    summary: () => ({ chunks: 0, documents: 0, embedding: false, hybridReady: false, docCount: 0 }),
    manifest: null,
    tokenizerActive: 'gram',
    tokenizerError: null,
    async addDocument() { return { ok: true, vectorized: false } },
  }
}

/**
 * 模拟「启动一次宿主进程」。
 *
 * 完全复刻 index.js 的装配顺序（这也是这类 bug 只在重启后暴露的原因）：
 *   baseConfig = resolveConfig(patch.yml)
 *   config     = resolveConfig(patch.yml + 覆盖层)
 */
function boot() {
  const baseConfig = resolveConfig(JSON.parse(JSON.stringify(DEPLOYED)))
  const config = resolveConfig(mergeConfigOverlay(baseConfig.dataDir, JSON.parse(JSON.stringify(DEPLOYED))))

  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'webServer' ? {
      register({ path, handler }) { routes.set(path, handler); return () => {} },
    } : undefined),
    effect(fn) { fn() },
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  }

  let live = config
  registerRpc(ctx, {
    getConfig: () => live,
    setConfig: (next) => { live = next },
    getBaseConfig: () => baseConfig,
    indexer: makeIndexer(),
    log: () => {},
    corpusRootOf: () => live.corpusRoot,
    fridgeFor: Object.assign(() => ({ snapshot: () => ({}) }), { snapshots: () => [] }),
  })

  return { routes, config: () => live, baseConfig }
}

function makeRes() {
  const res = {
    statusCode: 0, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v },
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h ?? {}) },
    end(t) { this.payload = JSON.parse(t) },
    write(t) { this.payload = JSON.parse(t) },
  }
  return res
}

const save = async (routes, config) => {
  const res = makeRes()
  await routes.get('/api/vcprag/settings/save')({ url: '/api/vcprag/settings/save', method: 'POST' }, res)
  return res
}

// settings/save 走 readBody(req)，需要伪造一个可读的请求体流
function makeReq(body) {
  const text = JSON.stringify(body)
  const handlers = {}
  return {
    url: '/api/vcprag/settings/save',
    method: 'POST',
    on(event, fn) { handlers[event] = fn; return this },
    destroy() {},
    // 异步触发，模拟真实流
    [Symbol.for('kickoff')]: null,
    _kick() {
      Promise.resolve().then(() => {
        handlers.data?.(Buffer.from(text, 'utf8'))
        handlers.end?.()
      })
    },
  }
}

// ---------------- 1. 第一轮：打开裁判 + 填 URL/key + 改注入模式 ----------------

console.log('\n=== 1. 第一次保存：打开裁判、填 URL/key、注入切到 message ===')

{
  const { routes, config } = boot()
  const draft = JSON.parse(JSON.stringify(config()))

  draft.judge = {
    ...(draft.judge ?? {}),
    enabled: true,
    threshold: 0.7,
    maxCandidates: 12,
    timeoutMs: 4000,
    candidateChars: 400,
    queryChars: 400,
    baseUrl: 'https://jev.huibaolinks.com/v1/systemone',
    model: 'jev-latest',
    proxyUrl: '',
    apiKey: 'sk-real-key-12345',
  }
  // 注入位置改成 message（用户明确选了「对话消息」）
  draft.inject.mode = 'message'

  const req = makeReq({ config: draft })
  const res = makeRes()
  const p = routes.get('/api/vcprag/settings/save')(req, res)
  req._kick()
  await p

  check('保存返回 200', res.statusCode === 200, String(res.statusCode))

  const overlay = readConfigOverlay(dataDir)
  check('overlay 里有 judge.enabled', overlay.judge?.enabled === true, JSON.stringify(overlay.judge))
  check('overlay 里有 judge.apiKey', overlay.judge?.apiKey === 'sk-real-key-12345', String(overlay.judge?.apiKey))
  check('overlay 里有 judge.baseUrl',
    overlay.judge?.baseUrl === 'https://jev.huibaolinks.com/v1/systemone', String(overlay.judge?.baseUrl))
  check('overlay 里有 inject.mode = message', overlay.inject?.mode === 'message', String(overlay.inject?.mode))
}

// ---------------- 2. 重启，确认第一轮的东西都在 ----------------

console.log('\n=== 2. 重启一次：第一轮的设置必须还在 ===')

{
  const { config } = boot()
  const c = config()
  check('judge.enabled 仍为 true', c.judge.enabled === true, String(c.judge.enabled))
  check('judge.apiKey 仍在', c.judge.apiKey === 'sk-real-key-12345', String(c.judge.apiKey))
  check('judge.baseUrl 仍在',
    c.judge.baseUrl === 'https://jev.huibaolinks.com/v1/systemone', String(c.judge.baseUrl))
  check('inject.mode 仍为 message', c.inject.mode === 'message', String(c.inject.mode))
}

// ---------------- 3. 关键场景：再保存一个**别**的设置 ----------------

console.log('\n=== 3. 重启后再保存一个无关项（maxMessages）—— 这是 bug 的触发点 ===')

{
  const { routes, config } = boot()
  const draft = JSON.parse(JSON.stringify(config()))
  draft.inject.maxMessages = 0   // 只改这一项，judge 一个字段都不碰

  const req = makeReq({ config: draft })
  const res = makeRes()
  const p = routes.get('/api/vcprag/settings/save')(req, res)
  req._kick()
  await p

  check('保存返回 200', res.statusCode === 200, String(res.statusCode))

  const overlay = readConfigOverlay(dataDir)
  check('overlay 里 inject.maxMessages 已更新', overlay.inject?.maxMessages === 0, JSON.stringify(overlay.inject))
  // 这两条是核心：第二次保存不能把第一次的东西擦掉
  check('overlay 里 judge 仍然完整（没被擦掉）',
    overlay.judge?.enabled === true && overlay.judge?.apiKey === 'sk-real-key-12345',
    JSON.stringify(overlay.judge))
  check('overlay 里 inject.mode 仍然在（没被擦掉）',
    overlay.inject?.mode === 'message', String(overlay.inject?.mode))
}

// ---------------- 4. 再重启，前两轮的设置都要在 ----------------

console.log('\n=== 4. 再重启：两轮的设置必须同时生效 ===')

{
  const { config } = boot()
  const c = config()
  check('judge.enabled 仍为 true', c.judge.enabled === true, String(c.judge.enabled))
  check('judge.apiKey 仍在', c.judge.apiKey === 'sk-real-key-12345', String(c.judge.apiKey))
  check('judge.baseUrl 仍在',
    c.judge.baseUrl === 'https://jev.huibaolinks.com/v1/systemone', String(c.judge.baseUrl))
  check('inject.mode 仍为 message（没被默认值顶掉）', c.inject.mode === 'message', String(c.inject.mode))
  check('inject.maxMessages 已生效为 0', c.inject.maxMessages === 0, String(c.inject.maxMessages))
}

// ---------------- 5. 连存三次空改动，不能把任何东西吃掉 ----------------

console.log('\n=== 5. 连点三次保存（无改动）：不能吃掉任何设置 ===')

{
  for (let i = 0; i < 3; i += 1) {
    const { routes, config } = boot()
    const draft = JSON.parse(JSON.stringify(config()))
    const req = makeReq({ config: draft })
    const res = makeRes()
    const p = routes.get('/api/vcprag/settings/save')(req, res)
    req._kick()
    await p
  }

  const overlay = readConfigOverlay(dataDir)
  check('judge.apiKey 仍在', overlay.judge?.apiKey === 'sk-real-key-12345', JSON.stringify(overlay.judge))
  check('inject.mode 仍在', overlay.inject?.mode === 'message', JSON.stringify(overlay.inject))

  const { config } = boot()
  check('三次空保存后 judge 仍然启用', config().judge.enabled === true)
  check('三次空保存后注入模式仍是 message', config().inject.mode === 'message')
}

// ---------------- 6. 覆盖层是累积的，不是全量快照 ----------------

console.log('\n=== 6. 覆盖层必须只存 delta（否则 patch.yml 永远改不动）===')

{
  const overlay = readConfigOverlay(dataDir)
  // diaryRoot / dataDir 这些 patch.yml 里就有的值，不该被抄进 overlay
  check('overlay 不含 diaryRoot（与部署配置相同）', overlay.diaryRoot === undefined, String(overlay.diaryRoot))
  check('overlay 不含 dataDir', overlay.dataDir === undefined, String(overlay.dataDir))
  check('overlay 不含 corpusRoot', overlay.corpusRoot === undefined, String(overlay.corpusRoot))
}

rmSync(ROOT, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言 —— 设置能跨重启累积保存`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
