/**
 * smoke-rrf-weight —— 锁住「RRF 两路不等权」。
 *
 * 背景（v0.2.1）：
 *
 * 原来的融合是纯 RRF，两路等权。隐含假设是「词法和语义排名同样可信」。
 * 这个假设在这里不成立：词法通道基于中文 1-gram，对自然语言短句几乎
 * 总是返回 30 条「恰好含几个常见字」的结果，排名接近噪声；语义通道
 * 至少真的在比对意思。等权融合 = 给噪声 50% 权重。
 *
 * 真实数据（371 chunk / 61 篇，查询「我只是调高了对话消息召回的上限」）：
 *   词法 rank1 = AI 消息撤回（无关），语义 cosine 0.5997
 *   语义上真正相关的「DSH Mnemon 热记忆容量上限」词法排第 3
 *   → 等权融合后前者第 1、后者第 3，语义没起主导作用
 *
 * 修复：给两路可配权重，默认语义:词法 = 2:1。
 *
 * 这个测试用合成通道数据验证权重机制本身，不依赖真实语料。
 *
 * 跑法：
 *   node test/smoke-rrf-weight.mjs
 */

import { recall } from '../lib/recall.js'

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

/**
 * 造一个 recall 上下文。
 *
 * chunks 用 Map（recall 内部按 chunkId 取正文）。
 * 词法 / 语义各自给出**故意冲突**的排名：
 *   - 词法把 K 系列排在前面（模拟「靠常见字凑出来」的噪声）
 *   - 语义把 S 系列排在前面（模拟「真正的语义相关」）
 */
function buildCtx({ lexicalOrder, semanticOrder, semanticScores, config }) {
  const allIds = [...new Set([...lexicalOrder, ...semanticOrder])]
  const chunks = new Map()
  for (const id of allIds) {
    chunks.set(id, {
      chunkId: id,
      docId: id,
      text: `正文 ${id}`,
      title: `标题 ${id}`,
      date: '2026-11-01',
      tags: [],
      filename: `${id}.txt`,
    })
  }

  return {
    config: {
      recall: { lexicalLimit: 30, semanticLimit: 30, kBase: 5, kMin: 3, kMax: 10, tagWeight: 0, maxChars: 4000, ...config },
      timeDecay: { enabled: false, halfLifeDays: 180, floor: 0.55 },
      aliases: null,
    },
    bm25: {
      search: () => lexicalOrder.map((id, i) => ({ chunkId: id, score: 20 - i, matched: ['噪声字'] })),
    },
    vectors: { ready: true, search: () => semanticOrder.map((id, i) => ({ chunkId: id, score: semanticScores?.[i] ?? 0.6 - i * 0.01 })) },
    embedder: { configured: true, embedOne: async () => [1, 0, 0] },
    chunks,
    aliases: null,
  }
}

// 词法噪声排在前面，语义相关排在前面 —— 两路冲突
const LEXICAL = ['noise-1', 'noise-2', 'noise-3', 'good-1', 'good-2']
const SEMANTIC = ['good-1', 'good-2', 'noise-1', 'noise-2', 'noise-3']

console.log('\n=== 1. 等权（1:1）时噪声能靠词法排到前面 ===')
{
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: { semanticWeight: 1, lexicalWeight: 1 } })
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)
  ok('noise-1 进入 top-2（等权下词法仍有很大话语权）', ids.slice(0, 2).includes('noise-1'), ids.join(' > '))
}

console.log('\n=== 2. 语义主导（2:1）时 good-1 胜出 ===')
{
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: { semanticWeight: 2, lexicalWeight: 1 } })
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)

  ok('语义 rank1 拿到第 1', ids[0] === 'good-1', ids.join(' > '))

  /*
   * 这里不能断言「good-2 是第 2」。
   *
   * RRF 的本质是**奖励被两路同时看好的文档**。构造的数据里：
   *   good-1  语义 rank1          （只拿一路的分）
   *   good-2  语义 rank2          （只拿一路的分）
   *   noise-1 词法 rank1 + 语义 rank3（拿两路的分）
   * 所以 noise-1 排在 good-2 前面是算法的正确行为，不是 bug ——
   * 它确实被两个独立信号同时选中了。
   *
   * 真正要验证的是：**语义 rank1 能赢过词法 rank1**（等权时赢不了）。
   */
  const noiseRank = ids.indexOf('noise-1')
  const good2Rank = ids.indexOf('good-2')
  ok('noise-1 已不再压住语义结果', noiseRank > 0, `noise-1 在第 ${noiseRank + 1} 位`)
  ok('good 系列占前 3 中的 2 席',
    ids.slice(0, 3).filter((id) => id.startsWith('good')).length === 2, ids.join(' > '))
}

console.log('\n=== 3. 纯语义（词法权重 0）时完全按语义排 ===')
{
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: { semanticWeight: 1, lexicalWeight: 0 } })
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)
  ok('顺序与语义通道一致', ids.slice(0, 3).join(',') === 'good-1,good-2,noise-1', ids.join(' > '))
}

console.log('\n=== 4. 纯词法（语义权重 0）时完全按词法排 ===')
{
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: { semanticWeight: 0, lexicalWeight: 1 } })
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)
  ok('顺序与词法通道一致', ids.slice(0, 3).join(',') === 'noise-1,noise-2,noise-3', ids.join(' > '))
}

console.log('\n=== 5. 权重缺省时用 2:1（不是等权） ===')
{
  // 不传 semanticWeight / lexicalWeight
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: {} })
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)
  ok('缺省即语义主导', ids[0] === 'good-1', ids.join(' > '))
}

console.log('\n=== 6. 语义通道不可用时自动退化为纯词法（不能崩） ===')
{
  const ctx = buildCtx({ lexicalOrder: LEXICAL, semanticOrder: SEMANTIC, config: { semanticWeight: 2, lexicalWeight: 1 } })
  ctx.vectors = { ready: false, search: () => [] }
  const r = await recall('测试查询', ctx)
  const ids = r.hits.map((h) => h.docId)
  ok('仍然返回词法结果', ids.length > 0 && ids[0] === 'noise-1', ids.join(' > '))
  ok('timing 里记录了跳过原因', Boolean(r.timing.semanticSkipped), r.timing.semanticSkipped)
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) process.exitCode = 1
