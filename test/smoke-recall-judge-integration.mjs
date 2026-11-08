/**
 * smoke-recall-judge-integration —— 裁判接入 recall.js 之后的行为。
 *
 * smoke-relevance-judge.mjs 测的是模块自身。这个测试补上另一半：
 * **接入点有没有破坏原有语义**。
 *
 * 三条必须成立的等式：
 *   1. 不传 judge      ≡ v0.2.5 行为（hits 逐条相同）
 *   2. judge 关着      ≡ 不传
 *   3. judge 失败      ≡ 不传
 *
 * 加两条必须成立的不等式：
 *   4. judge 成功      → 顺序变了 / 条数只减不增
 *   5. judge 成功且不打爆 K 上限
 *
 * 注意：stub transport 的形状必须是**单条**（state 里只有一条记忆标题），
 * 因为裁判是一次请求判一条。用批量形状的 stub 会永远拿不到分数。
 *
 * 跑法：node test/smoke-recall-judge-integration.mjs
 */

import { recall } from '../lib/recall.js'
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

/**
 * 造一个极简语料。三条 chunk 的 BM25 分依次递减，
 * 这样「上游顺序」是可预期的 a → b → c。
 */
const CHUNKS = new Map()
function addChunk(chunkId, title, text, lexicalScore, semantic) {
  CHUNKS.set(chunkId, {
    chunkId,
    docId: chunkId.split('#')[0],
    title,
    text,
    date: '2026-11-01',
    tags: [],
    filename: `${chunkId}.md`,
    index: 0,
    _lexicalScore: lexicalScore,
    _semantic: semantic,
  })
}
addChunk('a#0', '条目级去重上线', 'message 注入模式加了条目级去重，重复率降到 0', 30, 0.81)
addChunk('b#0', 'DSH 桌面端迁移', '迁移到 Electron 新壳，重打签名', 20, 0.78)
addChunk('c#0', 'Vellum 备份脚本', '每日备份改成增量 rsync，保留 14 天', 10, 0.75)

/** 假 BM25：按预设分数返回，顺序即上游排名。 */
function fakeBm25() {
  return {
    idf: new Map(),
    search(_tokens, limit) {
      return [...CHUNKS.values()]
        .sort((l, r) => r._lexicalScore - l._lexicalScore)
        .slice(0, limit)
        .map((c) => ({
          chunkId: c.chunkId,
          score: c._lexicalScore,
          matched: ['条目'],
        }))
    },
  }
}

function fakeVectors() {
  return {
    ready: true,
    search(_v, limit) {
      return [...CHUNKS.values()]
        .sort((l, r) => r._semantic - l._semantic)
        .slice(0, limit)
        .map((c) => ({ chunkId: c.chunkId, score: c._semantic }))
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
      // 闸门全关：这个测试只关心裁判，不想让闸门和裁判互相干扰。
      minSemantic: 0,
      requireSemantic: false,
      minTokenLen: 0,
      minTokenIdf: 0,
      ...overrides,
    },
    timeDecay: { enabled: false, halfLifeDays: 180, floor: 0.55 },
  }
}

async function run({ judge, query = '现在应该正常了，加了条目级去重', config } = {}) {
  return recall(query, {
    bm25: fakeBm25(),
    vectors: fakeVectors(),
    embedder: {
      configured: true,
      async embedOne() {
        return new Float32Array([1, 0, 0])
      },
    },
    chunks: CHUNKS,
    aliases: null,
    config: config ?? makeConfig(),
    ...(judge === undefined ? {} : { judge }),
  })
}

const ids = (r) => r.hits.map((h) => h.chunkId)

/**
 * 单条形状的 stub：按 state.记忆标题 决定分数。
 *
 * 这是与产品行为对齐的**唯一正确形状** —— 裁判一次只送一条候选。
 */
function singleTransport(scoreForTitle) {
  const calls = []
  const fn = async (state, questions) => {
    calls.push({ state, questions })
    const p = scoreForTitle(state.记忆标题)
    return { answers: { verdict: { type: 'noul', noul: p } } }
  }
  fn.calls = calls
  return fn
}

console.log('=== 1. 不传 judge：timing.judge 为 null ===')
{
  const r = await run({})
  check('hits 有 3 条', r.hits.length === 3, `实际 ${r.hits.length}`)
  check('timing.judge 是 null（区分「没启用」）', r.timing.judge === null, String(r.timing.judge))
  console.log('  order:', ids(r).join(' → '))
}

console.log('\n=== 2. judge 关着 ≡ 不传 judge（逐条相同）===')
{
  const baseline = await run({})
  const off = await run({ judge: createJudge() })

  check('hits 序列完全一致',
    ids(baseline).join(',') === ids(off).join(','),
    `${ids(baseline).join(',')} vs ${ids(off).join(',')}`)
  check('hits 长度一致', baseline.hits.length === off.hits.length)
  check('judge trace 记录 disabled', off.timing.judge?.reason === 'disabled',
    JSON.stringify(off.timing.judge))
  check('judge trace applied 为 false', off.timing.judge?.applied === false)
}

console.log('\n=== 3. judge 失败 ≡ 不传 judge ===')
{
  const baseline = await run({})
  const boom = Object.assign(new Error('network down'), { code: 'JUDGE_HTTP_500' })
  const broken = createJudge({
    enabled: true,
    transport: async () => {
      throw boom
    },
  })
  const failed = await run({ judge: broken })

  check('hits 序列完全一致',
    ids(baseline).join(',') === ids(failed).join(','),
    `${ids(baseline).join(',')} vs ${ids(failed).join(',')}`)
  check('judge trace applied 为 false', failed.timing.judge?.applied === false)
  check('reason 为 no_valid_scores', failed.timing.judge?.reason === 'no_valid_scores',
    failed.timing.judge?.reason)
}

console.log('\n=== 4. judge 成功：重排 + 剔除 ===')
{
  const transport = singleTransport((title) => (title.includes('条目级去重') ? 0.93 : 0.04))
  const judge = createJudge({ enabled: true, threshold: 0.7, transport })
  const r = await run({ judge })

  check('judge trace applied 为 true', r.timing.judge?.applied === true,
    JSON.stringify(r.timing.judge))
  check('只剩 a 一条', r.hits.length === 1, `实际 ${r.hits.length}: ${ids(r).join(',')}`)
  check('a 是唯一的', ids(r)[0] === 'a#0', ids(r)[0])
  check('dropped = 2', r.timing.judge?.dropped === 2, `实际 ${r.timing.judge?.dropped}`)
  check('judged 记录送出去的候选数', r.timing.judge?.judged > 0, String(r.timing.judge?.judged))
  check('latencyMs 有值', typeof r.timing.judge?.latencyMs === 'number')
  check('发了 3 次请求（一条一请求）', transport.calls.length === 3,
    `实际 ${transport.calls.length} 次`)
}

console.log('\n=== 5. judge 只重排不扩充：阈值 0 时条数不变 ===')
{
  const baseline = await run({})
  const transport = singleTransport((title) => (title.includes('Vellum') ? 0.99 : 0.1))
  const judge = createJudge({ enabled: true, threshold: 0, transport })
  const r = await run({ judge })

  check('条数不变', r.hits.length === baseline.hits.length,
    `${r.hits.length} vs ${baseline.hits.length}`)
  check('顺序被改（c 上到第一）', ids(r)[0] === 'c#0', ids(r).join(','))
  check('没有新增任何 chunkId',
    ids(r).every((id) => ids(baseline).includes(id)),
    ids(r).join(','))
  check('dropped = 0（阈值 0 不剔除）', r.timing.judge?.dropped === 0,
    `实际 ${r.timing.judge?.dropped}`)
}

console.log('\n=== 6. judge 不会突破 K 上限 ===')
{
  const transport = singleTransport(() => 0.5)
  const judge = createJudge({ enabled: true, threshold: 0, transport })
  // kMax=2，喂 3 条
  const r = await run({ judge, config: makeConfig({ kBase: 2, kMin: 1, kMax: 2 }) })
  check('hits 不超过 kMax', r.hits.length <= 2, `实际 ${r.hits.length}`)
  check('k 被正确计算', r.k <= 2, `k=${r.k}`)
}

console.log('\n=== 7. judge 全部打不出分 ≡ 不传 judge ===')
{
  const baseline = await run({})
  const judge = createJudge({
    enabled: true,
    transport: async () => ({ answers: { verdict: { type: 'noul', noul: 'oops' } } }),
  })
  const r = await run({ judge })

  check('hits 序列完全一致（回退成功）',
    ids(baseline).join(',') === ids(r).join(','),
    `${ids(baseline).join(',')} vs ${ids(r).join(',')}`)
  check('judge trace applied 为 false', r.timing.judge?.applied === false)
  check('reason 为 no_valid_scores', r.timing.judge?.reason === 'no_valid_scores',
    r.timing.judge?.reason)
}

console.log('\n=== 8. 部分候选判失败：仍按有效分工作 ===')
{
  // b 那条请求抛错 → 记 null → 不参与阈值判断，排在有分项之后
  const judge = createJudge({
    enabled: true,
    threshold: 0.7,
    concurrency: 1,
    transport: async (state) => {
      if (state.记忆标题.includes('DSH')) throw new Error('one candidate failed')
      const p = state.记忆标题.includes('条目级去重') ? 0.95 : 0.05
      return { answers: { verdict: { type: 'noul', noul: p } } }
    },
  })
  const r = await run({ judge })

  check('applied 为 true（有有效分）', r.timing.judge?.applied === true,
    JSON.stringify(r.timing.judge))
  check('a 保留', ids(r).includes('a#0'), ids(r).join(','))
  // b 无分 → 不判死；c 有分 0.05 → 被剔。所以剩下 a 和 b。
  check('c 被阈值剔除', !ids(r).includes('c#0'), ids(r).join(','))
  check('b 无分但保留（不被阈值判死）', ids(r).includes('b#0'), ids(r).join(','))
  check('dropped = 1（只有 c）', r.timing.judge?.dropped === 1,
    `实际 ${r.timing.judge?.dropped}`)
  check('unknown = 1（b）', r.timing.judge?.unknown === 1,
    `实际 ${r.timing.judge?.unknown}`)
  check('a 排第一', ids(r)[0] === 'a#0', ids(r).join(','))
}

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
