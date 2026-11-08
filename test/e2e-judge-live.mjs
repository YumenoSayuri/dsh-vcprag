/**
 * e2e-judge-live —— 用**真实 Jev 端点**跑一遍完整召回链路。
 *
 * 与 smoke 的区别：smoke 用 stub，验证的是逻辑；这个用真 API，验证的是
 * 「真模型 + 真网络 + 我们的 prompt + 阈值」这套组合是否成立。
 *
 * 需要两个环境变量，缺任一个就跳过（不算失败）：
 *   VCPRAG_JUDGE_KEY
 *   VCPRAG_JUDGE_URL      可选，默认官方端点
 *   VCPRAG_JUDGE_PROXY    可选，形如 http://127.0.0.1:7897
 *
 * 跑法：
 *   set VCPRAG_JUDGE_KEY=xxx && set VCPRAG_JUDGE_PROXY=http://127.0.0.1:7897
 *   node test/e2e-judge-live.mjs
 */

import { recall } from '../lib/recall.js'
import { createJudge, createFetchTransport, createProxyTransport } from '../lib/relevance-judge.js'

const key = process.env.VCPRAG_JUDGE_KEY ?? ''
if (key === '') {
  console.log('缺少 VCPRAG_JUDGE_KEY，跳过（这不是失败）')
  process.exit(0)
}

const endpoint = process.env.VCPRAG_JUDGE_URL ?? 'https://api.typesafe.ai/v1/systemone'
const proxyUrl = process.env.VCPRAG_JUDGE_PROXY ?? ''
const model = process.env.VCPRAG_JUDGE_MODEL ?? 'jev-latest'

// 直接复用产品代码里的两个 transport。
//
// 这个 e2e 存在的意义是「跑真实链路」，所以**不能**自带一份实现 ——
// 那样测的是脚本里的副本，产品代码改坏了这里照样绿。以前这里有一份
// 手抄的 CONNECT 实现，正是因为如此才没发现产品代码只有直连、
// 而直连在 451 地区根本不通（开关等于按下无效）。
const transport = proxyUrl === ''
  ? createFetchTransport({ url: endpoint, apiKey: key, model })
  : createProxyTransport({ url: endpoint, apiKey: key, model, proxyUrl })

// ---- 语料：一篇真正相关 + 三篇无关 ----
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
addChunk('dedupe#0', '条目级去重上线', '这次给 message 注入模式加了条目级去重，历史召回的 50 条里有 19 条重复，现在按 日期+标题 作为 key 记忆已投递条目，重复率降到 0。', 30, 0.81)
addChunk('desktop#0', 'DSH 桌面端迁移', '把桌面端从旧壳迁到 Electron 33，重打了签名，修了 tray 图标在高分屏下模糊的问题。', 25, 0.80)
addChunk('vellum#0', 'Vellum 备份脚本调整', 'Vellum 的每日备份改成增量 rsync，保留 14 天。', 20, 0.78)
addChunk('cat#0', '给猫换了猫砂', '今天给猫换了新的豆腐猫砂，它不太适应，在门口转了两圈。', 15, 0.76)

function fakeBm25() {
  return {
    idf: new Map(),
    search(_tokens, limit) {
      return [...CHUNKS.values()]
        .sort((l, r) => r._lexicalScore - l._lexicalScore)
        .slice(0, limit)
        .map((c) => ({ chunkId: c.chunkId, score: c._lexicalScore, matched: ['条目'] }))
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

function makeConfig() {
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
      minSemantic: 0,
      requireSemantic: false,
      minTokenLen: 0,
      minTokenIdf: 0,
    },
    timeDecay: { enabled: false, halfLifeDays: 180, floor: 0.55 },
  }
}

async function runOnce(query, { judge }) {
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
    config: makeConfig(),
    judge,
  })
}

let pass = 0
let fail = 0
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('=== 真实端点端到端 ===')
console.log('endpoint =', endpoint)
console.log('proxy    =', proxyUrl || '(直连)')
console.log('model    =', model)
console.log('')

const QUERY = '现在应该正常了，加了条目级去重'

// 基线：不开裁判
const baseline = await runOnce(QUERY, { judge: null })
console.log('基线（无裁判）顺序:', baseline.hits.map((h) => h.title).join(' → '))
check('基线至少 3 条（裁判前是满的）', baseline.hits.length >= 3, String(baseline.hits.length))
check('基线 timing.judge 为 null', baseline.timing.judge === null)

// 开裁判
const judge = createJudge({
  enabled: true,
  threshold: 0.7,
  maxCandidates: 12,
  concurrency: 8,
  timeoutMs: 15000,
  transport,
})

const judged = await runOnce(QUERY, { judge })
console.log('')
console.log('裁判后顺序:', judged.hits.map((h) => h.title).join(' → ') || '(空)')
console.log('timing.judge:', JSON.stringify(judged.timing.judge))
console.log('')

check('裁判真的生效了（applied=true）', judged.timing.judge?.applied === true,
  JSON.stringify(judged.timing.judge))
check('没有扩充', judged.hits.length <= baseline.hits.length,
  `${judged.hits.length} vs ${baseline.hits.length}`)
check('相关的那条排第一', judged.hits[0]?.title === '条目级去重上线',
  judged.hits[0]?.title)
check('无关的猫砂那条被剔除', !judged.hits.some((h) => h.title === '给猫换了猫砂'))
check('有 latencyMs', typeof judged.timing.judge?.latencyMs === 'number')

console.log('')
if (judged.timing.judge?.applied === true) {
  const kept = judged.hits.map((h) => h.title)
  console.log(`保留 ${kept.length} 条：${kept.join(', ')}`)
  console.log(`剔除 ${judged.timing.judge.dropped} 条，耗时 ${judged.timing.judge.latencyMs}ms`)
}

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  process.exitCode = 1
}
