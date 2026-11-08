/**
 * smoke-relevance-judge —— 相关性裁判的三条不变量 + 五条回退路径
 *                        + 两条**实测得出的架构约束**。
 *
 * 这个模块的全部价值在于「默认关闭且失败必回退」。所以测试主体不是
 * 「裁判判得准不准」（那要靠真实语料校准），而是：
 *
 *   1. 关掉时主链路行为逐字节不变（applied:false，不碰 hits）
 *   2. 铁律：不吞错、不返回半成品 —— 任何失败都必须 applied:false
 *   3. 只重排、不扩充 —— out.length <= hits.length
 *   4. 打分缺失排最后，且不被阈值判死
 *   5. 一条都没打上分时视同失败（否则会静默变成「纯重排但你以为在过滤」）
 *
 * 另外两条是**对着真实 Jev 端点实测出来的**，写进测试防止将来被「优化」掉：
 *
 *   6. 一次请求只放一条候选（批量会让分数塌成常数）
 *   7. 判定语句是陈述句，不是问句
 *   8. 有 VCPRAG_JUDGE_PROXY 时必须走 CONNECT 隧道（否则 451 地区永远连不通）
 *
 * 跑法：node test/smoke-relevance-judge.mjs
 */

import {
  JUDGE_DEFAULTS,
  applyVerdicts,
  createJudge,
  createFetchTransport,
  createProxyTransport,
  isValidProbability,
  probabilityOf,
} from '../lib/relevance-judge.js'

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

function hit(id, overrides = {}) {
  return { chunkId: id, title: `标题-${id}`, text: `正文-${id}`, ...overrides }
}

/** 造一个可控的假 transport。默认对每条候选返回固定分。 */
function stubTransport({ scoreFor, throws, raw, answersFor } = {}) {
  const calls = []
  const fn = async (state, questions, opts) => {
    calls.push({ state, questions, opts })
    if (throws) throw throws
    if (raw !== undefined) return raw
    if (answersFor) return { answers: answersFor(state, questions) }
    const p = typeof scoreFor === 'function' ? scoreFor(state) : 0.5
    return { answers: { verdict: { type: 'noul', noul: p } } }
  }
  fn.calls = calls
  return fn
}

console.log('=== 1. 默认关闭：未开启时不触碰任何东西 ===')
{
  const judge = createJudge()
  check('isConfigured() 默认 false', judge.isConfigured() === false)
  check('默认阈值是 0.7（实测值，见文件头）', JUDGE_DEFAULTS.threshold === 0.7,
    String(JUDGE_DEFAULTS.threshold))

  const result = await judge.judge('随便问点什么', [hit('a'), hit('b')])
  check('applied 为 false', result.applied === false)
  check('reason 写明 disabled', result.reason === 'disabled')
  check('不返回 scores', result.scores === undefined)
}

console.log('\n=== 2. 开了开关但没给 transport：仍视为未配置 ===')
{
  const judge = createJudge({ enabled: true })
  check('缺 transport 时 isConfigured() 为 false', judge.isConfigured() === false)
  const result = await judge.judge('q', [hit('a')])
  check('applied 为 false', result.applied === false)
}

console.log('\n=== 3. 正常路径：按 chunkId 对齐 ===')
{
  const transport = stubTransport({
    scoreFor: (state) => (state.记忆标题.includes('a') ? 0.9 : 0.1),
  })
  const judge = createJudge({ enabled: true, transport })
  const result = await judge.judge('现在应该正常了，加了条目级去重', [hit('a'), hit('b')])

  check('applied 为 true', result.applied === true)
  check('judged = 2', result.judged === 2, `实际 ${result.judged}`)
  check('scored = 2', result.scored === 2, `实际 ${result.scored}`)
  check('a 拿 0.9', result.scores.get('a') === 0.9, String(result.scores.get('a')))
  check('b 拿 0.1', result.scores.get('b') === 0.1, String(result.scores.get('b')))
  check('带有 latencyMs', typeof result.latencyMs === 'number')
}

console.log('\n=== 4. 【实测约束】一次请求只放一条候选 ===')
{
  const transport = stubTransport({ scoreFor: () => 0.5 })
  const judge = createJudge({ enabled: true, transport })
  await judge.judge('q', [hit('a'), hit('b'), hit('c')])

  // 这是对着真实端点测出来的：多条候选塞进同一 state 会让分数塌成常数。
  check('3 条候选发了 3 次请求', transport.calls.length === 3,
    `实际 ${transport.calls.length} 次`)
  const shapes = transport.calls.map((c) => c.state)
  check('每次 state 里只有一条记忆标题',
    shapes.every((s) => typeof s.记忆标题 === 'string'))
  check('每次 state 都带当前查询', shapes.every((s) => typeof s.当前查询 === 'string'))
  check('state 里没有候选数组（不是批量形状）',
    shapes.every((s) => s.candidates === undefined && s.候选 === undefined))

  const ids = new Set(shapes.map((s) => s.记忆标题))
  check('三次请求分别对应三条不同候选', ids.size === 3, `实际 ${ids.size} 种`)
}

console.log('\n=== 5. 【实测约束】判定语句必须是陈述句 ===')
{
  const transport = stubTransport({ scoreFor: () => 0.5 })
  const judge = createJudge({ enabled: true, transport })
  await judge.judge('q', [hit('a')])

  const instructions = transport.calls[0].questions.verdict.instructions
  check('类型是 noul', transport.calls[0].questions.verdict.type === 'noul')
  // noul 问的是「某陈述是否为真」，塞问句进去输出会漂移（实测 0.86/0.87）
  check('是陈述句（以句号结尾）', instructions.endsWith('。'), instructions)
  check('不是问句（不含问号）', !instructions.includes('？') && !instructions.includes('?'),
    instructions)
  check('陈述的是「同一主题」', instructions.includes('同一个主题'), instructions)
  // 实测加了这类元指令反而让两条分数一起抬高
  check('不含「不要因为用词相同」这类元指令', !instructions.includes('不要因为用词相同'),
    instructions)
}

console.log('\n=== 6. 失败路径：任何异常都必须 applied:false ===')
{
  const thrown = Object.assign(new Error('boom'), { code: 'JUDGE_HTTP_401' })
  const r1 = await createJudge({ enabled: true, transport: stubTransport({ throws: thrown }) })
    .judge('q', [hit('a')])
  check('全部请求抛错 → applied false', r1.applied === false)
  check('reason 为 no_valid_scores', r1.reason === 'no_valid_scores', r1.reason)
  check('报告 failed 条数便于排查', r1.failed === 1, String(r1.failed))

  const r2 = await createJudge({ enabled: true, transport: stubTransport({ raw: {} }) })
    .judge('q', [hit('a')])
  check('缺 answers → applied false', r2.applied === false)
  check('reason 为 no_valid_scores', r2.reason === 'no_valid_scores', r2.reason)

  const r3 = await createJudge({
    enabled: true,
    transport: stubTransport({ raw: { answers: 'nope' } }),
  }).judge('q', [hit('a')])
  check('answers 非对象 → applied false', r3.applied === false)

  const r4 = await createJudge({
    enabled: true,
    transport: stubTransport({ answersFor: () => ({ verdict: { type: 'noul', noul: 'high' } }) }),
  }).judge('q', [hit('a')])
  check('概率非法 → applied false', r4.applied === false)
  check('reason 为 no_valid_scores', r4.reason === 'no_valid_scores', r4.reason)

  const r5 = await createJudge({ enabled: true, transport: stubTransport({}) }).judge('q', [])
  check('空候选 → applied false', r5.applied === false)
  check('reason 为 no_candidates', r5.reason === 'no_candidates', r5.reason)
}

console.log('\n=== 7. 局部失败：单条挂了不拖垮整批 ===')
{
  let n = 0
  const transport = async (state) => {
    n += 1
    // 第一条抛错，其余成功
    if (state.记忆标题.includes('a')) throw new Error('single failure')
    return { answers: { verdict: { type: 'noul', noul: 0.8 } } }
  }
  const judge = createJudge({ enabled: true, transport, concurrency: 1 })
  const result = await judge.judge('q', [hit('a'), hit('b'), hit('c')])

  check('整批仍 applied（有有效分）', result.applied === true)
  check('scored = 2', result.scored === 2, String(result.scored))
  check('failed = 1', result.failed === 1, String(result.failed))
  check('失败的那条记 null 而不是 0', result.scores.get('a') === null,
    String(result.scores.get('a')))
  check('成功的两条正常记分', result.scores.get('b') === 0.8)
}

console.log('\n=== 8. maxCandidates 截断 + 并发不超额 ===')
{
  const transport = stubTransport({ scoreFor: () => 0.5 })
  const judge = createJudge({ enabled: true, transport, maxCandidates: 2, concurrency: 1 })
  const result = await judge.judge('q', [hit('a'), hit('b'), hit('c'), hit('d')])

  check('只判了 2 条', transport.calls.length === 2, `实际 ${transport.calls.length}`)
  check('未送的条目不在 scores 里', result.scores.has('c') === false)
  check('judged 只算送出去的', result.judged === 2, String(result.judged))
}

console.log('\n=== 9. 截断：超长 query / 正文被切到上限 ===')
{
  const transport = stubTransport({ scoreFor: () => 0.5 })
  const judge = createJudge({ enabled: true, transport, queryChars: 10, candidateChars: 5 })
  await judge.judge('一二三四五六七八九十十一十二', [hit('a', { text: '一二三四五六七八九十' })])

  check('query 被截到 10 字', transport.calls[0].state.当前查询.length === 10,
    String(transport.calls[0].state.当前查询.length))
  check('候选正文被截到 5 字', transport.calls[0].state.记忆正文.length === 5,
    String(transport.calls[0].state.记忆正文.length))
}

console.log('\n=== 10. applyVerdicts：只重排不扩充 ===')
{
  const hits = [hit('a'), hit('b'), hit('c')]
  const scores = new Map([['a', 0.2], ['b', 0.9], ['c', 0.5]])
  const { out, dropped } = applyVerdicts(hits, scores, { threshold: 0, k: 3 })

  check('条数不增加', out.length <= hits.length, `${out.length} vs ${hits.length}`)
  check('按概率降序：b(0.9) c(0.5) a(0.2)',
    out.map((h) => h.chunkId).join(',') === 'b,c,a', out.map((h) => h.chunkId).join(','))
  check('阈值 0 不剔除', dropped === 0, `dropped=${dropped}`)

  const smaller = applyVerdicts(hits, scores, { threshold: 0, k: 2 })
  check('k=2 时截到 2 条', smaller.out.length === 2, `实际 ${smaller.out.length}`)
}

console.log('\n=== 11. applyVerdicts：阈值剔除只对有分项生效 ===')
{
  const hits = [hit('a'), hit('b'), hit('unknown')]
  const scores = new Map([['a', 0.9], ['b', 0.1], ['unknown', null]])
  const { out, dropped, unknown } = applyVerdicts(hits, scores, { threshold: 0.7, k: 3 })

  check('b 被阈值剔除', !out.some((h) => h.chunkId === 'b'))
  check('a 保留', out.some((h) => h.chunkId === 'a'))
  check('dropped = 1', dropped === 1, `dropped=${dropped}`)
  check('无分项 unknown 不参与阈值判断', unknown === 1, `unknown=${unknown}`)
  check('unknown 保留在结果里', out.some((h) => h.chunkId === 'unknown'))
  check('有分项排在无分项之前',
    out.map((h) => h.chunkId).join(',') === 'a,unknown', out.map((h) => h.chunkId).join(','))
}

console.log('\n=== 12. applyVerdicts：空输入与全缺失的边界 ===')
{
  const empty = applyVerdicts([], new Map(), { threshold: 0.7 })
  check('空输入返回空', empty.out.length === 0 && empty.dropped === 0 && empty.unknown === 0)

  const hits = [hit('a'), hit('b')]
  const allUnknown = applyVerdicts(hits, new Map(), { threshold: 0.9, k: 2 })
  check('全部无分时不剔除', allUnknown.dropped === 0, `dropped=${allUnknown.dropped}`)
  check('全部无分时保持原序', allUnknown.out.map((h) => h.chunkId).join(',') === 'a,b',
    allUnknown.out.map((h) => h.chunkId).join(','))
  check('unknown 计数正确', allUnknown.unknown === 2, `unknown=${allUnknown.unknown}`)
}

console.log('\n=== 13. 概率校验的边界值 ===')
{
  check('0 合法', isValidProbability(0) === true)
  check('1 合法', isValidProbability(1) === true)
  check('0.5 合法', isValidProbability(0.5) === true)
  check('负数非法', isValidProbability(-0.01) === false)
  check('>1 非法', isValidProbability(1.01) === false)
  check('NaN 非法', isValidProbability(Number.NaN) === false)
  check('Infinity 非法', isValidProbability(Number.POSITIVE_INFINITY) === false)
  check('字符串非法', isValidProbability('0.5') === false)
  check('null 非法', isValidProbability(null) === false)

  check('probabilityOf 取到值', probabilityOf({ a: { noul: 0.7 } }, 'a') === 0.7)
  check('probabilityOf 缺失返回 null', probabilityOf({}, 'a') === null)
  check('probabilityOf answers 为 null 返回 null', probabilityOf(null, 'a') === null)
}

console.log('\n=== 14. fetchTransport：错误响应必须抛错而不是返回空 ===')
{
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate"}}'
    },
  })
  const transport = createFetchTransport({ url: 'https://example.invalid', apiKey: 'k', model: 'm' })
  let caught = null
  try {
    await transport({}, {}, { timeoutMs: 1000 })
  } catch (error) {
    caught = error
  }
  check('非 2xx 抛错', caught !== null)
  check('错误码含状态码', caught?.code === 'JUDGE_HTTP_401', caught?.code)
  check('错误信息含响应体片段', String(caught?.message).includes('authentication_error'))

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return '{"answers":{"verdict":{"type":"noul","noul":0.42}}}'
    },
  })
  const good = await transport({}, {}, { timeoutMs: 1000 })
  check('正常响应解析为对象', good.answers.verdict.noul === 0.42)

  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return '<html>' } })
  let jsonError = null
  try {
    await transport({}, {}, { timeoutMs: 1000 })
  } catch (error) {
    jsonError = error
  }
  check('非 JSON 抛错', jsonError?.code === 'JUDGE_INVALID_JSON', jsonError?.code)

  globalThis.fetch = originalFetch
}

console.log('\n=== 15. 端到端：复现用户报的真实场景 ===')
{
  // query 讲去重，召回归来两条噪声 + 一条真正相关的。
  // 分数按真实端点的实测形态给：相关 0.97，噪声 0.61 / 0.29。
  const hits = [
    hit('desktop', { title: 'DSH 桌面端迁移', text: '迁移到 Electron 33，重打签名' }),
    hit('vellum', { title: 'Vellum 备份脚本', text: '改成增量 rsync，保留 14 天' }),
    hit('dedupe', { title: '条目级去重上线', text: 'message 注入模式加了条目级去重，重复率降到 0' }),
  ]
  const transport = stubTransport({
    scoreFor: (state) => {
      if (state.记忆标题.includes('条目级去重')) return 0.97
      if (state.记忆标题.includes('Vellum')) return 0.61
      return 0.29
    },
  })
  const judge = createJudge({ enabled: true, transport })
  const judged = await judge.judge('现在应该正常了，加了条目级去重', hits)

  const { out, dropped } = applyVerdicts(hits, judged.scores, { threshold: 0.7, k: 5 })

  check('裁判生效', judged.applied === true)
  check('真正相关的那条排第一', out[0]?.chunkId === 'dedupe', out[0]?.chunkId)
  // 这条断言正是「阈值不能取中点」的理由：0.61 的噪声必须被剔掉
  check('两条噪声都被剔除（含 0.61 那条）', dropped === 2, `dropped=${dropped}`)
  check('结果只剩 1 条', out.length === 1, `实际 ${out.length}`)
  check('没有扩充', out.length <= hits.length)
}

console.log('\n=== 16. transport 选择：有 proxy 必须走隧道，不能悄悄回落直连 ===')
{
  // 官方端点对部分地区返回 451，直连永远不通、且失败是静默的
  // （applied:false）。如果产品代码「有 proxy 却还是直连」，面板上的
  // 开关就是一个按下无效的开关 —— 开了、保存了、日志没报错，只是
  // 每次召回都走回退分支。这条断言钉住这个分水岭。
  check('createProxyTransport 是导出的函数', typeof createProxyTransport === 'function')
  check('createFetchTransport 是导出的函数', typeof createFetchTransport === 'function')

  const proxyTransport = createProxyTransport({
    url: 'https://api.typesafe.ai/v1/systemone',
    apiKey: 'k',
    model: 'jev-latest',
    // 指向一个必定拒绝的端口：我们只验证「它真的去连代理了」，
    // 不验证连通性（那要真代理，属于 e2e）。
    proxyUrl: 'http://127.0.0.1:1',
  })

  let proxyError = null
  try {
    await proxyTransport({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, { timeoutMs: 300 })
  } catch (e) {
    proxyError = e
  }
  check('proxy transport 真的尝试连代理（连不上就抛错，不静默返回）', proxyError !== null,
    proxyError ? proxyError.message : '没有抛错 —— 说明它没走代理')

  // 关键区别：fetch transport 打的是目标地址；proxy transport 打的是代理。
  // 这里通过错误消息形态区分：CONNECT 失败会带 ECONNREFUSED，
  // 且不会出现「451」这种目标端点的应答。
  check('proxy transport 的错误来自代理连接而非目标端点',
    proxyError !== null && !/451/.test(proxyError.code ?? '' + (proxyError.message ?? '')),
    proxyError ? String(proxyError.code ?? proxyError.message) : '')

  // 反向断言：URL 写错时必须立刻给出可读错误，
  // 而不是在 CONNECT 之后抛一个 SyntaxError。
  const badUrl = createProxyTransport({
    url: 'not-a-url',
    apiKey: 'k',
    model: 'm',
    proxyUrl: 'http://127.0.0.1:1',
  })
  let badUrlError = null
  try {
    await badUrl({}, {}, { timeoutMs: 300 })
  } catch (e) {
    badUrlError = e
  }
  check('url 写错时抛错', badUrlError !== null)
  check('url 写错的报错可读（不是裸 SyntaxError 堆栈）',
    badUrlError !== null && typeof badUrlError.message === 'string' && badUrlError.message.length > 0,
    badUrlError ? badUrlError.message.slice(0, 60) : '')
}

console.log('\n=== 17. 超时必须是墙钟，不是 socket 空闲 ===')
{
  // 实测过的真实故障：调用方设 4000ms，实际跑了 5803ms 才返回。
  // 原因是 http.request 的 `timeout` 是 **socket 空闲** 超时 ——
  // CONNECT 成功、TLS 也有零星数据在动，空闲计时被反复重置，
  // 于是墙钟已经远超上限却仍然不返回。裁判在召回热路径上，
  // 多拖 1.8 秒就是用户多等 1.8 秒。
  //
  // 这里用一个「接受连接但永不应答」的假代理，验证到点就掐。
  const http = await import('node:http')
  // 注意：CONNECT 必须挂在 `connect` 事件上。Node 的 http.Server 对
  // CONNECT 请求**不会**走 (req, res) 回调 —— 不注册 connect 监听时
  // 它会直接销毁 socket，于是拿到的是 ECONNRESET（5ms 就返回），
  // 看起来像是「超时生效了」但其实是别的路径，测不出墙钟超时。
  const stall = http.createServer()
  // 必须自己留住 socket 引用：CONNECT 升级后的 socket 不受
  // `closeAllConnections()` 管，server.close() 会一直等它 —— 测试能过，
  // 但进程永远不退出（Exit code 13 + unsettled top-level await）。
  const stalledSockets = new Set()
  stall.on('connection', (socket) => {
    stalledSockets.add(socket)
    socket.on('close', () => stalledSockets.delete(socket))
  })
  stall.on('connect', (req, socket) => {
    // 隧道「建立成功」但上游永不应答 —— 这正是会绕过 socket 空闲超时的形态
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    // 之后故意不写任何东西，也不关闭
  })
  await new Promise((r) => stall.listen(0, '127.0.0.1', r))
  const port = stall.address().port

  const stalledTransport = createProxyTransport({
    url: 'https://api.typesafe.ai/v1/systemone',
    apiKey: 'k',
    model: 'm',
    proxyUrl: `http://127.0.0.1:${port}`,
  })

  const timeoutMs = 600
  const started = Date.now()
  let stallError = null
  try {
    await stalledTransport({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, { timeoutMs })
  } catch (e) {
    stallError = e
  }
  const elapsed = Date.now() - started

  check('卡住的请求会抛错（不无限挂起）', stallError !== null,
    stallError ? stallError.message : '没有抛错')
  check('错误码标明是超时（可与网络错误区分）',
    stallError?.code === 'JUDGE_TIMEOUT', String(stallError?.code))
  // 墙钟超时的核心断言：必须在 timeoutMs 附近返回，而不是远远超时。
  // 给 400ms 余量覆盖定时器抖动与 CI 负载；关键是 < 3 × timeoutMs。
  check(`实际耗时接近超时上限而不是远超（${elapsed}ms / 上限 ${timeoutMs}ms）`,
    elapsed >= timeoutMs - 50 && elapsed < timeoutMs * 3,
    `elapsed=${elapsed}ms`)

  // 收尾：先掐死所有挂起的 socket，再关 server。
  // stalledSockets 里那个被故意冻住的连接不销毁的话，close 回调永不触发。
  for (const socket of stalledSockets) socket.destroy()
  stalledSockets.clear()
  await new Promise((r) => stall.close(r))
}

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
