/**
 * smoke-recall-gate —— 相关性闸门。
 *
 * 闸门要防的回归只有一条：
 *   **无关查询不该再返回 k 条「最不无关」的噪声。**
 *
 * 但它同时有一个更危险的反向风险：
 *   **语义通道不可用时（没配 embedding / 索引没向量），闸门必须整体不参与**
 *   —— 否则余弦恒为 0，会把所有结果杀光，比噪声更糟。
 *
 * 所以这里用纯内存假件直接驱动 recall()，不依赖真实 embedding 服务、
 * 不依赖真实索引。这样两个方向都能确定性验证。
 *
 * 跑法：node test/smoke-recall-gate.mjs
 */

import { recall } from '../lib/recall.js'
import { tokenize } from '../lib/tokenize.js'

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

// ---- 假语料 ----
// 5 个 chunk。a/b 是「相关」的（会被语义通道返回，余弦高），
// c/d 只在词法通道里（语义没返回 → semantic === undefined），
// e 语义返回了但余弦很低。
const CHUNKS = new Map(
  [
    { chunkId: 'a#0', docId: 'a', title: 'A 相关文档', text: '相关甲 相关乙', lexicalTop: true, sem: 0.72 },
    { chunkId: 'b#0', docId: 'b', title: 'B 相关文档', text: '相关丙', lexicalTop: false, sem: 0.61 },
    { chunkId: 'c#0', docId: 'c', title: 'C 纯词法噪声', text: '噪声甲', lexicalTop: true, sem: null },
    { chunkId: 'd#0', docId: 'd', title: 'D 纯词法噪声', text: '噪声乙', lexicalTop: false, sem: null },
    { chunkId: 'e#0', docId: 'e', title: 'E 低余弦', text: '噪声丙', lexicalTop: false, sem: 0.31 },
  ].map((row) => [
    row.chunkId,
    {
      chunkId: row.chunkId,
      docId: row.docId,
      title: row.title,
      text: row.text,
      date: '',
      tags: [],
      filename: 'x.txt',
      index: 0,
      _lexicalTop: row.lexicalTop,
      _sem: row.sem,
    },
  ]),
)

/** 假 BM25：按 _lexicalTop 决定排名，分数只是占位。 */
function fakeBm25() {
  return {
    built: true,
    search(_tokens, limit) {
      const rows = [...CHUNKS.values()].filter((c) => c._lexicalTop)
      return rows.slice(0, limit).map((c, i) => ({
        chunkId: c.chunkId,
        score: 20 - i * 5,
        matched: ['相关'],
      }))
    },
  }
}

/**
 * 假 BM25，但**带 idf 表** —— 用于测「区分词」相关规则。
 *
 * 默认的 fakeBm25 没有 idf 属性，`idfOf()` 全部返回 0，于是
 * distinctiveTokens 恒为空 → 永远走 starved 分支。测「纯语义放行」
 * 这类用例必须给 idf，否则测的就不是目标分支。
 *
 * ⚠️ 注意：区分词取自**查询**（queryTokens ∩ idf≥阈值），
 * 不是取自命中（matched）。所以查询里必须真的含有 idf 表里的词，
 * 否则照样 starved。
 *
 * @param {{
 *   matched?: string[],
 *   idf?: Record<string, number>,
 * }} [options]
 */
function fakeBm25WithIdf(options = {}) {
  const matched = options.matched ?? ['相关']
  const idfEntries = options.idf ?? { 测试: 2.5, 查询: 2.5, 试查: 1.8 }
  return {
    built: true,
    idf: new Map(Object.entries(idfEntries)),
    search(_tokens, limit) {
      const rows = [...CHUNKS.values()].filter((c) => c._lexicalTop)
      return rows.slice(0, limit).map((c, i) => ({
        chunkId: c.chunkId,
        score: 20 - i * 5,
        matched,
      }))
    },
  }
}

/** 假向量库 + 假 embedder：sem 非 null 的才「被返回」。 */
function fakeVectors(semAvailable = true) {
  return {
    ready: semAvailable,
    search(_v, limit) {
      if (!semAvailable) return []
      return [...CHUNKS.values()]
        .filter((c) => c._sem !== null)
        .sort((l, r) => r._sem - l._sem)
        .slice(0, limit)
        .map((c) => ({ chunkId: c.chunkId, score: c._sem }))
    },
  }
}

function fakeEmbedder(configured = true) {
  return {
    configured,
    async embedOne() {
      return new Float32Array([1, 0, 0])
    },
  }
}

function makeConfig(overrides = {}) {
  return {
    recall: {
      lexicalLimit: 30,
      semanticLimit: 30,
      kBase: 5,
      kMin: 3,
      kMax: 10,
      tagWeight: 0,
      maxChars: 4000,
      tokenizer: 'gram',
      singleCharWeight: 0.15,
      semanticWeight: 2,
      lexicalWeight: 1,
      minSemantic: 0.55,
      requireSemantic: true,
      // ⚠️ 这里默认**关闭实词规则**（minTokenLen=0），不是因为它不重要，
      // 而是为了让测试职责分离：
      //
      //   第 1-8 组   只测 requireSemantic / minSemantic 两条闸门的正交性。
      //               开着实词规则会引入第三个变量，把「谁剔的」搅乱。
      //   第 9-14 组  专门测实词规则，各自显式打开。
      //
      // 生产默认值见 config.js 的 DEFAULTS.recall（minTokenLen=2, minTokenIdf=2）。
      minTokenLen: 0,
      minTokenIdf: 0,
      ...overrides,
    },
    timeDecay: { enabled: false, halfLifeDays: 180, floor: 0.55 },
  }
}

async function run(ctx, query = '测试查询') {
  return recall(query, {
    bm25: ctx.bm25 ?? fakeBm25(),
    vectors: ctx.vectors ?? fakeVectors(),
    embedder: ctx.embedder ?? fakeEmbedder(),
    chunks: CHUNKS,
    aliases: null,
    config: ctx.config ?? makeConfig(),
  })
}

console.log('=== 1. 闸门开启：噪声被剔除 ===')
{
  const r = await run({})
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  console.log('  timing:', JSON.stringify({
    gatedOut: r.timing.gatedOut,
    gatedBy: r.timing.gatedBy,
    tokenizer: r.timing.tokenizer,
  }))
  check('只保留语义命中且余弦达标的两条', ids.length === 2, `实际 ${ids.length} 条`)
  check('相关文档 a 在结果里', ids.includes('a#0'))
  check('相关文档 b 在结果里', ids.includes('b#0'))
  check('纯词法噪声 c 被剔除', !ids.includes('c#0'))
  check('低余弦 e 被剔除', !ids.includes('e#0'))
  // 假 BM25 只返回 _lexicalTop 的 a 和 c，所以 d 根本进不了融合表 ——
  // 被闸门剔除的是 c（纯词法）和 e（低余弦），共 2 条。
  check('gatedOut 计数为 2', r.timing.gatedOut === 2, `实际 ${r.timing.gatedOut}`)
  check('gatedBy 文案包含阈值', String(r.timing.gatedBy).includes('0.55'))
}

console.log('')
console.log('=== 2. 两个开关全关 → 退回 v0.2.1 行为 ===')
{
  const r = await run({ config: makeConfig({ minSemantic: 0, requireSemantic: false }) })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  // 融合表里只有 a / b / c / e（d 不在假 BM25 结果里），4 条全回来。
  check('噪声全部回来（4 条）', ids.length === 4, `实际 ${ids.length} 条`)
  check('纯词法 c 在结果里', ids.includes('c#0'))
  check('低余弦 e 在结果里', ids.includes('e#0'))
  check('gatedOut 为 0', r.timing.gatedOut === 0)
}

console.log('')
console.log('=== 3. 只关 requireSemantic：纯词法放行，低余弦仍被剔除 ===')
{
  const r = await run({ config: makeConfig({ requireSemantic: false }) })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  check('纯词法噪声 c 回来了', ids.includes('c#0'), '两个开关必须正交')
  check('低余弦 e 仍被剔除（minSemantic 仍生效）', !ids.includes('e#0'))
}

console.log('')
console.log('=== 4. 只关 minSemantic：纯词法仍被剔除，低余弦放行 ===')
{
  const r = await run({ config: makeConfig({ minSemantic: 0 }) })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  check('纯词法噪声 c 仍被剔除（requireSemantic 仍生效）', !ids.includes('c#0'))
  check('低余弦 e 放行', ids.includes('e#0'))
}

console.log('')
console.log('=== 5. 语义通道不可用 → 闸门必须整体跳过 ===')
// 这是最关键的一条：没配 embedding 时余弦恒为 0，若照常过滤会全杀光。
{
  const r = await run({ vectors: fakeVectors(false), embedder: fakeEmbedder(false) })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  console.log('  gatedBy:', r.timing.gatedBy)
  check('纯词法降级时仍有结果（没有全杀光）', ids.length > 0, `实际 ${ids.length} 条`)
  check('gatedOut 为 0', r.timing.gatedOut === 0)
  check('gatedBy 说明闸门被跳过', String(r.timing.gatedBy).includes('跳过'))
}

console.log('')
console.log('=== 6. 语义通道抛错 → 同样跳过闸门 ===')
{
  const brokenVectors = {
    ready: true,
    search() {
      return []
    },
  }
  const brokenEmbedder = {
    configured: true,
    async embedOne() {
      throw new Error('网关 502')
    },
  }
  const r = await run({ vectors: brokenVectors, embedder: brokenEmbedder })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  console.log('  semanticSkipped:', r.timing.semanticSkipped)
  check('语义失败时仍有词法结果', ids.length > 0)
  check('semanticSkipped 记录了原因', String(r.timing.semanticSkipped).includes('502'))
}

console.log('')
console.log('=== 7. timing 字段完整性（可观测性）===')
{
  const r = await run({})
  const t = r.timing
  for (const key of ['lexicalCount', 'semanticCount', 'fusedCount', 'gatedOut', 'gatedBy', 'dedupedCount', 'tokenizer']) {
    check(`timing.${key} 存在`, key in t, `缺 ${key}`)
  }
}

console.log('')
console.log('=== 8. 高阈值能把全部候选剔光（此时 hits 为空，不是报错）===')
{
  const r = await run({ config: makeConfig({ minSemantic: 0.99 }) })
  console.log('  hits:', r.hits.length, ' gatedOut:', r.timing.gatedOut)
  check('返回空数组而不是抛错', Array.isArray(r.hits) && r.hits.length === 0)
  check('gatedOut 记录了被剔条数', r.timing.gatedOut > 0)
}

// ================================================================
// 规则 3：实词要求（minTokenLen）
//
// 这组锁的是 v0.2.2 的真实缺陷：`minSemantic` 在本语料上完全失效
// —— 无关查询和强相关查询的余弦顶分几乎一样（0.6322 vs 0.6320），
// 于是「无关查询也硬返 5 条」永远修不掉。真正的判据是命中里有没有实词。
//
// 所以这里要同时钉住两件事：
//   1. 只命中单字的条目被剔除（否则噪声照旧进来）
//   2. 纯语义条目（matched 为空）**不受影响** —— 它没有词法信息，
//      拿实词规则去卡它等于误杀「换种说法讲同一件事」，那恰恰是
//      向量通道唯一能覆盖的场景。
// ================================================================

/** 造一个「命中的全是单字」的假 BM25。 */
function singleCharBm25() {
  return {
    built: true,
    search(_tokens, limit) {
      const rows = [...CHUNKS.values()]
      return rows.slice(0, limit).map((c, i) => ({
        chunkId: c.chunkId,
        score: 20 - i * 3,
        // 关键：命中的 token 全是 1 个字 —— 这就是「靠常见字凑分」
        matched: ['的', '了', '上'],
      }))
    },
  }
}

/** 造一个「命中里既有单字也有实词」的假 BM25。 */
function mixedBm25() {
  return {
    built: true,
    search(_tokens, limit) {
      const rows = [...CHUNKS.values()]
      return rows.slice(0, limit).map((c, i) => ({
        chunkId: c.chunkId,
        score: 20 - i * 3,
        matched: ['的', '上限', '了'],
      }))
    },
  }
}

console.log('')
console.log('=== 9. minTokenLen 生效：只命中单字的条目被剔除 ===')
{
  const r = await run({
    bm25: singleCharBm25(),
    config: makeConfig({ minTokenLen: 2 }),
  })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  console.log('  timing:', JSON.stringify({
    gatedOut: r.timing.gatedOut,
    gatedByToken: r.timing.gatedByToken,
    gatedBySemantic: r.timing.gatedBySemantic,
    gatedBy: r.timing.gatedBy,
  }))
  check('只命中单字的条目全被实词规则剔除', ids.length === 0, `实际 ${ids.length} 条`)
  check('gatedByToken 记录被实词剔的条数', r.timing.gatedByToken > 0, `实际 ${r.timing.gatedByToken}`)
  check('gatedBy 文案说明实词规则生效', String(r.timing.gatedBy).includes('实词≥2'))
}

console.log('')
console.log('=== 10. 命中里带区分词 → 放行 ===')
{
  // mixedBm25 的 matched 是 ['的','上限','了']。要让「上限」算数，
  // 它必须既是 len≥2、又在 idf 表里且 idf 达标 —— 所以这里同样得
  // 用带 idf 的假件，并且 idf 表里要有「上限」。
  const r = await run({
    bm25: fakeBm25WithIdf({ matched: ['的', '上限', '了'], idf: { 上限: 2.8 } }),
    config: makeConfig({ minTokenLen: 2 }),
  })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  // b 是纯语义（没有 matched），不受实词规则约束，所以留下。
  // a/c 的 matched=['的','上限','了'] ——「上限」是区分词，本该都放行；
  // 但 a 同时被 requireSemantic 之外的条件挡掉的路径取决于语义分，
  // 这里只锁「至少有一个条目靠区分词活了下来」+「实词规则没把全部杀光」。
  check('命中了「上限」这种区分词的条目被放行', ids.length > 0, `实际 ${ids.length} 条`)
  check('没有条目因「不含区分词」被剔', r.timing.gatedByToken === 0 || r.timing.gatedByToken < r.timing.gatedOut, `byToken=${r.timing.gatedByToken} out=${r.timing.gatedOut}`)
}

console.log('')
console.log('=== 11. 纯语义条目不受实词规则影响（不能误杀）===')
{
  // 「纯语义条目」的定义是 **BM25 没返回它**（matched 为空）。
  // 所以这里必须用默认 fakeBm25（只返回 a / c）。
  //
  // 假向量返回 a / b / e：
  //   a → 有词法命中（matched=['相关']）+ 有语义分
  //   b → **纯语义**（matched 为空）+ 语义 0.61
  //   e → **纯语义**（matched 为空）+ 语义 0.31
  //   c → 纯词法（matched 有实词，无语义分）
  //
  // 关键：查询必须**有区分词**，规则 3 才会正常参与。否则会走
  // 「starved → 全不注入」那条路，测的就不是「纯语义放行」了。
  // 这里把 bm25.idf 造好，让「测试查询」里的「测试」「查询」是高 IDF 词。
  const r = await run({
    bm25: fakeBm25WithIdf(),
    vectors: fakeVectors(),
    config: makeConfig({ minTokenLen: 2, requireSemantic: false, minSemantic: 0 }),
  })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids)
  for (const h of r.hits) console.log(`    ${h.chunkId} matched=${JSON.stringify(h.matched)}`)
  check('纯语义条目 b 仍在（实词规则管不到它）', ids.includes('b#0'), `实际 ${JSON.stringify(ids)}`)
  check('低余弦的纯语义条目 e 也在（minSemantic 已关）', ids.includes('e#0'), `实际 ${JSON.stringify(ids)}`)
  // a 由两路同时命中（词法 + 语义 0.72），但它的 matched 是 ['相关']，
  // 「相关」不在本用例造的 idf 词表里 → 不含区分词 → 被实词规则剔掉。
  // 这看起来可惜（它语义分最高），但规则就是这么定义的：
  // 「字面碰巧重合但那个词不是查询的区分词」→ 不算有效命中。
  // 真实语料里这条会不会误杀，取决于 idf 表是否覆盖了常用词。
  check('纯词法条目 c 被实词规则剔除', !ids.includes('c#0'), `实际 ${JSON.stringify(ids)}`)
  check('a 命中的「相关」不是区分词，同样被剔', !ids.includes('a#0'), `实际 ${JSON.stringify(ids)}`)
  check('gatedByToken 记了 a / c 两条', r.timing.gatedByToken === 2, `实际 ${r.timing.gatedByToken}`)
  check('没有走 starved 分支', !String(r.timing.gatedBy).includes('全不注入'), `实际 ${r.timing.gatedBy}`)
}

console.log('')
console.log('=== 12. 查询没有任何区分词 → 全不注入（宁可空着）===')
{
  // 这是用户明确要求的语义（原话「甚至宁愿全舍弃」）。
  //
  // 用单个汉字「猫」：只产生 1-gram，切不出 len≥2 的 token，
  // 于是 distinctiveTokens 为空 → 规则 0 把所有候选判死。
  //
  // **必须断言 hits 为 0，而不是「规则跳过、照旧返回」** ——
  // v0.2.4 初版就是后者，导致「修了，再简单测一下」照样返回 5 条。
  console.log('  「猫」的 gram token:', JSON.stringify(tokenize('猫', null, { mode: 'gram' })))
  const r = await run(
    { bm25: singleCharBm25(), config: makeConfig({ minTokenLen: 2 }) },
    '猫',
  )
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids.length, ' gatedBy:', r.timing.gatedBy)
  check('无区分词时一条都不注入', ids.length === 0, `实际 ${ids.length} 条`)
  check('gatedBy 明确说明是「无区分词」导致', String(r.timing.gatedBy).includes('查询无区分词'), `实际 ${r.timing.gatedBy}`)
  check('这些候选记在 gatedByToken 名下', r.timing.gatedByToken > 0, `实际 ${r.timing.gatedByToken}`)
}

console.log('')
console.log('=== 13. minTokenLen=0 关闭实词规则（退回 v0.2.3 行为）===')
{
  const r = await run({
    bm25: singleCharBm25(),
    config: makeConfig({ minTokenLen: 0 }),
  })
  const ids = r.hits.map((h) => h.chunkId)
  console.log('  hits:', ids.length, ' gatedByToken:', r.timing.gatedByToken)
  check('关掉后单字命中不再被剔（有结果的回来了）', ids.length > 0, `实际 ${ids.length} 条`)
  check('gatedByToken 为 0', r.timing.gatedByToken === 0)
}

console.log('')
console.log('=== 14. timing 分项计数存在（可观测性）===')
{
  const r = await run({})
  for (const key of ['gatedByToken', 'gatedBySemantic']) {
    check(`timing.${key} 存在`, key in r.timing, `缺 ${key}`)
  }
}

// ================================================================ 15
console.log('')
console.log('=== 15. ★ minTokenIdf=2 才够：通用词不该当区分信号 ===')
console.log('    真实反例：「这条应该能看见了 不要用工具先」')
console.log('    「工具」df=59/371 → idf=1.83，在 1.0 的线下、2.0 的线上')
{
  // 命中一条只含「工具」这个通用词的噪声 chunk。
  // 查询 token 由 run() 的默认 '测试查询' 换成含「工具」的句子。
  const commonIdf = new Map([['工具', 1.83], ['测试', 3.0]])
  const ctx = {
    bm25: {
      built: true,
      idf: commonIdf,
      search(_tokens, limit) {
        return [...CHUNKS.values()]
          .filter((c) => c._lexicalTop)
          .slice(0, limit)
          .map((c, i) => ({ chunkId: c.chunkId, score: 20 - i * 5, matched: ['工具'] }))
      },
    },
    vectors: fakeVectors(true),
    embedder: fakeEmbedder(true),
    chunks: CHUNKS,
    aliases: [],
  }

  // idf 门槛 1.0：1.83 过线 → 被当成「真的在谈工具」→ 放行噪声
  const loose = await run({ ...ctx, config: makeConfig({ minTokenLen: 2, minTokenIdf: 1.0 }) }, '用工具看看')
  check(
    '阈值 1.0 时「工具」过线，噪声被放行（这是要修的问题）',
    loose.hits.length > 0,
    `实际 ${loose.hits.length} 条`,
  )

  // idf 门槛 2.0：1.83 不过线 → 查询无区分词 → 全不注入
  const strict = await run({ ...ctx, config: makeConfig({ minTokenLen: 2, minTokenIdf: 2.0 }) }, '用工具看看')
  check(
    '阈值 2.0 时「工具」不过线 → 全不注入',
    strict.hits.length === 0,
    `实际 ${strict.hits.length} 条`,
  )
  check(
    '此时被判为「查询无区分词」',
    strict.timing.gatedBy.includes('无区分词'),
    strict.timing.gatedBy,
  )

  // 真区分词（idf 3.0）在两个阈值下都必须放行 —— 提高门槛不能误杀真查询
  for (const idf of [1.0, 2.0]) {
    const real = await run({ ...ctx, config: makeConfig({ minTokenLen: 2, minTokenIdf: idf }) }, '测试一下')
    check(
      `阈值 ${idf} 时真区分词(idf=3.0)仍然放行`,
      real.hits.length > 0,
      `实际 ${real.hits.length} 条`,
    )
  }
}

console.log('')
console.log(`通过了 ${pass} 项断言`)
if (fail > 0) {
  console.log(`❌ ${fail} 项失败：`)
  for (const f of failures) console.log('   - ' + f)
  process.exitCode = 1
} else {
  console.log('✅ 通过')
}
