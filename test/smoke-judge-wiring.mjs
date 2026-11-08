/**
 * 「裁判到底有没有接进召回链路」—— 端到端接线测试。
 *
 * ## 为什么必须有这个文件
 *
 * 之前三组测试都绿着，但裁判在真实环境里完全没参与打分：
 *
 *   - `smoke-relevance-judge`        测的是模块自身（createJudge 能不能判）
 *   - `smoke-recall-judge-integration` 测的是 recall.js 的接入点（传了 judge 会怎样）
 *   - `smoke-ui-settings`            测的是面板能不能读写配置
 *
 * 三者都假设「有人会把 judge 传进 recall」。**没人测这件事本身。**
 * 实际结果是 `/recall` 端点（召回调试 Tab）自己拼参数时漏了 judge ——
 * 于是调试面板的 `timing.judge` 恒为 null，看起来像「裁判没接进链路」，
 * 而注入路径（index.js 的 runRecall）是好的。两条路各自拼参数，长期分叉。
 *
 * 所以这里的断言全部是「端到端形状」的：
 *   1. `/recall` 端点真的把 judge 传给了 recall（timing.judge 非 null）
 *   2. `/state` 报告的是 buildJudge 的真实结果，不是 config 的声明值
 *   3. 两条召回路径对同一个配置得出同一个结论
 *
 * 跑法：node test/smoke-judge-wiring.mjs
 */

import { registerRpc } from '../lib/rpc.js'
import { resolveConfig } from '../lib/config.js'
import { createJudge } from '../lib/relevance-judge.js'

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

// ---------------- 打桩：最小 indexer + webServer ----------------

/** 3 篇文档：1 篇相关（去重）+ 2 篇无关，用来验证裁判真的在筛。 */
const CHUNKS = new Map([
  ['dedupe#0', {
    chunkId: 'dedupe#0', docId: 'dedupe', title: '条目级去重上线', index: 0,
    text: '给 message 注入模式加了条目级去重，重复率从 52% 降到 0。',
    date: '2026-11-01', tags: [], filename: 'dedupe.md',
  }],
  ['desktop#0', {
    chunkId: 'desktop#0', docId: 'desktop', title: 'DSH 桌面端迁移', index: 0,
    text: '把桌面端从旧壳迁到 Electron 33，重打了签名。',
    date: '2026-10-20', tags: [], filename: 'desktop.md',
  }],
  ['cat#0', {
    chunkId: 'cat#0', docId: 'cat', title: '给猫换了猫砂', index: 0,
    text: '周末把猫砂盆洗了换了新猫砂。',
    date: '2026-10-10', tags: [], filename: 'cat.md',
  }],
])

function makeIndexer() {
  return {
    bm25: {
      // 让三篇都进候选，把「谁该被裁判剔掉」留给裁判决定。
      //
      // `matched` 必须给，而且必须给成**能过规则 3** 的形态。
      //
      // 这里踩过两个坑，都记下来免得再犯：
      //   1. 三条都不写 `matched` → recall.js 的 `entry.matched.length`
      //      抛 TypeError → `/recall` 整个 500（错误信息完全看不出是这里）。
      //   2. 写了 `matched: ['去重']` 也过不去 —— jieba 把「去重」切成
      //      「重」，而「重」是单字，进不了 distinctiveTokens（默认
      //      minTokenLen=2）。于是规则 3 在裁判之前就把三条全剔了，
      //      裁判只看到 0 条候选（`reason: "no_candidates"`）。
      //
      // 所以必须写一个「查询 jieba 分词后真实存在、且长度 ≥2」的词。
      // QUERY 分词实测为 ["正常","加","条目","级","重"] → 用「条目」。
      search: () => [
        { chunkId: 'dedupe#0', score: 30, matched: ['条目'] },
        { chunkId: 'desktop#0', score: 25, matched: ['条目'] },
        { chunkId: 'cat#0', score: 20, matched: ['条目'] },
      ],
      stats: () => ({ docs: 3, terms: 10, avgLen: 20 }),
    },
    vectors: {
      ready: false,
      search: () => [],
    },
    embedder: { configured: false, embedOne: async () => new Float32Array([0, 0, 0]) },
    chunks: CHUNKS,
    summary: () => ({ chunks: 3, documents: 3, embedding: false }),
    manifest: null,
    tokenizerActive: 'gram',
    tokenizerError: null,
  }
}

/** 记录注册了哪些路由，供测试手动调用 handler。 */
function makeCtx() {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'webServer' ? {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => {}
      },
    } : undefined),
    effect(fn) { fn() },
    logger() {
      const noop = () => {}
      return { info: noop, warn: noop, error: noop, debug: noop }
    },
  }
  return { ctx, routes }
}

/** 假的 res：收集 writeJson 写进去的内容。 */
function makeRes() {
  const res = {
    statusCode: 0,
    payload: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers ?? {}) },
    end(text) { this.payload = JSON.parse(text) },
    write(text) { this.payload = JSON.parse(text) },
  }
  return res
}

/** 假 transport：按标题给固定分，模拟真实裁判的分离度。 */
function stubTransport(calls) {
  return async (state) => {
    calls.push(state)
    const title = String(state?.记忆标题 ?? '')
    // 相关 0.97，噪声 0.09 / 0.05 —— 与真实端点实测形态一致
    const noul = title.includes('去重') ? 0.97 : (title.includes('桌面') ? 0.09 : 0.05)
    return { answers: { verdict: { type: 'noul', noul } } }
  }
}

function baseRaw(overrides = {}) {
  return {
    corpusRoot: '',
    diaryRoot: 'C:/diaries',
    dataDir: 'C:/tmp/.vcprag-test',
    recall: { kBase: 5, kMin: 3, kMax: 10, lexicalLimit: 30, semanticLimit: 30, maxChars: 4000 },
    ...overrides,
  }
}

/**
 * 本文件统一用的查询。
 *
 * 选它是因为 jieba 切成 ["正常","加","条目","级","重"] —— 含两个 ≥2 字
 * 的实词（正常 / 条目），既能过闸门规则 3，又和「条目级去重」那篇
 * 有真实词面重叠。换成效更短的查询（如「去重」）会被切成单字「重」，
 * 闸门直接全剔，测试会因为跟裁判完全无关的原因失败。
 */
const QUERY = '现在应该正常了，加了条目级去重'

/** 跑一次完整装配：config → registerRpc → 拿路由。 */
function wire(rawConfig, { judgeFactory } = {}) {
  const config = resolveConfig(rawConfig)
  const { ctx, routes } = makeCtx()
  const indexer = makeIndexer()
  const buildJudgeCalls = []
  registerRpc(ctx, {
    getConfig: () => config,
    setConfig: (next) => { Object.assign(config, next) },
    indexer,
    fridgeFor: Object.assign(() => ({ snapshot: () => ({}) }), { snapshots: () => [] }),
    log: () => {},
    corpusRootOf: () => config.corpusRoot,
    buildJudge: judgeFactory ?? ((current) => {
      buildJudgeCalls.push(current.judge)
      if (current.judge.enabled !== true) return null
      if (current.judge.apiKey === '') return null
      return createJudge({ ...current.judge, enabled: true, transport: stubTransport([]) })
    }),
  })
  return { config, routes, buildJudgeCalls, indexer }
}

// ================= 1. /recall 必须把 judge 传进 recall =================
console.log('\n=== 1. /recall（召回调试 Tab）真的用上了裁判 ===')
{
  const { routes } = wire(baseRaw({
    judge: {
      enabled: true,
      threshold: 0.7,
      apiKey: 'sk-test',
      baseUrl: 'https://jev.example.com/v1/systemone',
      model: 'jev-latest',
    },
  }))

  const handler = routes.get('/api/vcprag/recall')
  check('/recall 已注册', typeof handler === 'function')

  const res = makeRes()
  await handler({ url: '/api/vcprag/recall?q=' + encodeURIComponent(QUERY) }, res)

  check('返回 200', res.statusCode === 200, String(res.statusCode))
  // 这条是核心断言。修之前这里是 null，就是用户报的现象。
  check('timing.judge 不为 null（裁判真的参与了）',
    res.payload?.timing?.judge !== null && res.payload?.timing?.judge !== undefined,
    JSON.stringify(res.payload?.timing?.judge))
  check('timing.judge.applied === true',
    res.payload?.timing?.judge?.applied === true,
    JSON.stringify(res.payload?.timing?.judge))
  check('裁判确实剔掉了条目（dropped > 0）',
    (res.payload?.timing?.judge?.dropped ?? 0) > 0,
    String(res.payload?.timing?.judge?.dropped))

  // 相关性真的生效：剩下的大概率只有「去重」那条
  const titles = (res.payload?.hits ?? []).map((h) => h.title)
  check('无关的「给猫换了猫砂」被剔除', !titles.includes('给猫换了猫砂'), JSON.stringify(titles))
  check('相关的那条还在', titles.includes('条目级去重上线'), JSON.stringify(titles))
}

// ================= 2. 关着的时候不受影响 =================
console.log('\n=== 2. judge.enabled=false 时 /recall 行为不变 ===')
{
  const { routes } = wire(baseRaw({ judge: { enabled: false } }))
  const res = makeRes()
  // 这里不能用「去重」当查询：jieba 切成单字「重」，没有 ≥2 字的实词，
  // 闸门会把候选全部剔掉 —— 那是闸门的正确行为，但会让本组断言
  // （「裁判缺席不影响召回」）因为无关原因失败。用 QUERY 才有意义。
  await routes.get('/api/vcprag/recall')({ url: '/api/vcprag/recall?q=' + encodeURIComponent(QUERY) }, res)
  check('timing.judge 为 null（没启用就不该有痕）',
    res.payload?.timing?.judge === null, JSON.stringify(res.payload?.timing?.judge))
  check('仍然返回结果（裁判缺席不影响召回）', (res.payload?.hits ?? []).length > 0,
    String(res.payload?.hits?.length))
}

// ================= 3. /state 报的是运行时真实状态 =================
console.log('\n=== 3. /state 的 judgeRuntime 反映 buildJudge 的真实结果 ===')
{
  // 3a. 开关开着、key 也在 → ok
  {
    const { routes } = wire(baseRaw({
      judge: { enabled: true, apiKey: 'sk-test', baseUrl: 'https://jev.example.com/v1/systemone' },
    }))
    const res = makeRes()
    await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, res)
    const rt = res.payload?.judgeRuntime
    check('judgeRuntime.ok === true', rt?.ok === true, JSON.stringify(rt))
    check('transport 报 direct（没配代理）', rt?.transport === 'direct', String(rt?.transport))
    check('effective.url 是配置里的地址',
      rt?.effective?.url === 'https://jev.example.com/v1/systemone', String(rt?.effective?.url))
    check('effective.apiKeyFrom 报 config', rt?.effective?.apiKeyFrom === 'config',
      String(rt?.effective?.apiKeyFrom))
  }

  // 3b. 开关开着但没 key → 明确说清为什么没生效
  {
    const { routes } = wire(baseRaw({ judge: { enabled: true, apiKey: '' } }))
    const res = makeRes()
    await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, res)
    const rt = res.payload?.judgeRuntime
    check('judgeRuntime.ok === false', rt?.ok === false, JSON.stringify(rt))
    check('reason 指出是缺 apiKey', String(rt?.reason).includes('apiKey'), String(rt?.reason))
  }

  // 3c. 开关关着 → reason 指向 enabled
  {
    const { routes } = wire(baseRaw({ judge: { enabled: false, apiKey: 'sk-test' } }))
    const res = makeRes()
    await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, res)
    check('reason 指出 enabled 不是 true',
      String(res.payload?.judgeRuntime?.reason).includes('enabled'),
      String(res.payload?.judgeRuntime?.reason))
  }

  // 3d. 配了代理 → transport 报 connect-tunnel
  {
    const { routes } = wire(baseRaw({
      judge: { enabled: true, apiKey: 'sk-test', proxyUrl: 'http://127.0.0.1:7897' },
    }))
    const res = makeRes()
    await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, res)
    check('transport 报 connect-tunnel',
      res.payload?.judgeRuntime?.transport === 'connect-tunnel',
      String(res.payload?.judgeRuntime?.transport))
  }

  // 3e. 没注入 buildJudge → 明确报出来，而不是静默 ok
  {
    const config = resolveConfig(baseRaw({ judge: { enabled: true, apiKey: 'k' } }))
    const { ctx, routes } = makeCtx()
    registerRpc(ctx, {
      getConfig: () => config,
      setConfig: () => {},
      indexer: makeIndexer(),
      fridgeFor: Object.assign(() => ({ snapshot: () => ({}) }), { snapshots: () => [] }),
      log: () => {},
      corpusRootOf: () => '',
      // 故意不传 buildJudge
    })
    const res = makeRes()
    await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, res)
    check('缺 buildJudge 时 judgeRuntime.ok=false',
      res.payload?.judgeRuntime?.ok === false, JSON.stringify(res.payload?.judgeRuntime))
    check('reason 指出没注入',
      String(res.payload?.judgeRuntime?.reason).includes('buildJudge'),
      String(res.payload?.judgeRuntime?.reason))
  }
}

// ================= 4. 两条召回路径结论一致 =================
console.log('\n=== 4. /recall 与注入路径用同一套 buildJudge ===')
{
  const raw = baseRaw({
    judge: { enabled: true, apiKey: 'sk-test', threshold: 0.7 },
  })
  const { routes, buildJudgeCalls } = wire(raw)

  const resRecall = makeRes()
  await routes.get('/api/vcprag/recall')({ url: '/api/vcprag/recall?q=' + encodeURIComponent(QUERY) }, resRecall)

  const resState = makeRes()
  await routes.get('/api/vcprag/state')({ url: '/api/vcprag/state' }, resState)

  check('两条路径都调用了 buildJudge', buildJudgeCalls.length >= 2, String(buildJudgeCalls.length))
  check('/recall 认为裁判生效', resRecall.payload?.timing?.judge?.applied === true)
  check('/state 也认为裁判生效', resState.payload?.judgeRuntime?.ok === true)
  // 同一个 buildJudge 源 → 不会出现「调试面板说有、真实注入说没有」
  check('两边对 enabled 的判断一致',
    resRecall.payload?.timing?.judge?.applied === resState.payload?.judgeRuntime?.ok)
}

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言 —— 裁判已接进两条召回路径`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
