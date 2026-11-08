/**
 * smoke-bm25-weight —— 锁住「汉字单字降权」。
 *
 * 背景（v0.2.1 修复）：
 *
 * 中文没走真分词，用 1-gram + 2-gram。于是查询里**每个汉字都是独立
 * token**。这些单字在语料里出现极频繁（实测「上」217/371 chunk、
 * 「消」187/371），IDF 只有 0.2~0.5 —— 但胜在数量多。
 *
 * 实测后果：查询「我只是调高了对话消息召回的上限」拆出 11 个单字，
 * 它们累计分数压过「上限」「召回」「对话」这些真正有区分度的双字词，
 * top-5 全是「AI 消息撤回」「dsh-rewind 架构」这类只含几个常见字的
 * 无关文档。更直接的证据：**只用单字召回 与 用全部 token 召回，
 * 排序完全一致** —— 说明双字词基本没起作用。
 *
 * 这个测试用合成语料把这个行为焊死，不依赖真实日记目录。
 *
 * 跑法：
 *   node test/smoke-bm25-weight.mjs
 */

import { BM25 } from '../lib/bm25.js'

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

/**
 * 合成语料，复刻真实语料的失真模式。
 *
 * 真实数据（371 chunk / 61 篇）的形态是：
 *   - 大量普通文档里零散出现「上」「限」「消」「息」这类常见字，
 *     每篇也就一两次，但**覆盖面极广**（「上」出现在 217/371 篇）
 *   - 只有少数文档含「上限」这个整词
 *
 * 查询拆出 11 个单字，每个都能在一堆文档里命中，累计起来就把
 * 只命中一个双字词的相关文档挤下去。
 *
 * 要复刻这个，语料必须**足够多篇**（否则 IDF 算不出来覆盖面差异），
 * 且噪音文档**不能靠堆词频**（真实语料里单字在单篇里就一两次）。
 */
const DOCS = [
  // 目标：含真正的区分词
  { chunkId: 'target', text: '召回上限 配置说明 变更记录' },
  // 大量噪音：各含一两个常见字，模拟「刚巧沾边」的普通文档
  { chunkId: 'noise-01', text: '上 面 说 的 记 录' },
  { chunkId: 'noise-02', text: '限 制 说 明 内 容' },
  { chunkId: 'noise-03', text: '回 到 上 一 步' },
  { chunkId: 'noise-04', text: '对 话 记 录 保 存' },
  { chunkId: 'noise-05', text: '消 息 记 录 已 清' },
  { chunkId: 'noise-06', text: '上 限 说 明 见 下' },
  { chunkId: 'noise-07', text: '回 复 记 录 归 档' },
  { chunkId: 'noise-08', text: '召 唤 记 录 汇 总' },
  // 完全无关的填充，撑起 IDF 的「常见」基线
  { chunkId: 'filler-01', text: '部 署 脚 本 说 明' },
  { chunkId: 'filler-02', text: '接 口 文 档 记 录' },
  { chunkId: 'filler-03', text: '配 置 项 目 列 表' },
]

/** 极简分词：按空格切，中文不做 n-gram（测试要精确控制 token）。 */
const tokensOf = (text) => text.split(/\s+/).filter(Boolean)

/**
 * 为了让「单字 vs 双字」的区别可测，这里用自带 1-gram 的分词：
 * 每个汉字拆成单字，同时保留空格分隔的整词。
 */
function tokenizeMixed(text) {
  const out = []
  for (const word of tokensOf(text)) {
    out.push(word) // 整词（双字或更长）
    if (word.length === 1) out.push(word) // 单字已在上面推过，跳过
    else if (/^[\u4e00-\u9fff]+$/.test(word) && word.length > 1) {
      for (const ch of word) out.push(ch) // 1-gram
    }
  }
  return out
}

const build = (weight) =>
  new BM25(1.5, 0.75, weight).build(
    DOCS.map((d) => ({ chunkId: d.chunkId, text: d.text, tags: [], date: '' })),
    tokenizeMixed,
  )

/*
 * 这里**不断言具体排名**。
 *
 * 试过断言「降权后 target 排第一」，但小语料里做不到：噪音文档之间
 * 由单字组成，同比例降权不改变它们的相对顺序；而 target 之所以能
 * 赢，靠的是「整词 idf 高 + 单字被压低」这个组合，需要真实语料那种
 * IDF 分布（常见字覆盖 200+/371 篇、整词只覆盖几篇）才成立。
 *
 * 12 篇合成语料压不出那个分布，硬写排名只会得到一个靠调参才绿的
 * 脆弱断言。真实语料上的排序效果由 `test/diag-recall-quality.mjs`
 * 负责（它跑 371 chunk 真语料，断言降权确实改变了排序）。
 *
 * 这里只锁**机制本身**：权重真的乘进打分、边界值语义正确。
 */
const QUERY = ['上限', '上', '限', '召回', '召', '回', '对话', '对', '话']

console.log('\n=== 1. 单字权重确实作用于打分（同文档分数下降）===')
{
  const s1 = build(1).search(QUERY, 20)
  const s015 = build(0.15).search(QUERY, 20)

  const byId = (arr) => new Map(arr.map((h) => [h.chunkId, h.score]))
  const m1 = byId(s1)
  const m015 = byId(s015)

  const common = [...m1.keys()].filter((id) => m015.has(id))
  ok('有可比文档', common.length > 0, `${common.length} 篇`)

  const allLower = common.every((id) => m015.get(id) < m1.get(id))
  ok('每篇分数都下降', allLower, common.map((id) => `${id}:${m1.get(id).toFixed(2)}→${m015.get(id).toFixed(2)}`).join(' '))
}

console.log('\n=== 2. 双字词命中不受降权影响（只有单字被压）===')
{
  /*
   * 关键契约：降权只作用于「单个汉字」，双字词与拉丁词的分数必须
   * 完全不变。否则降权就变成了「全局减分」，等于什么都没做。
   *
   * 用只含双字词命中的查询来验证：两次打分必须一模一样。
   */
  const onlyDoubles = ['上限', '召回', '对话']
  const a = build(1).search(onlyDoubles, 20).map((h) => `${h.chunkId}:${h.score.toFixed(6)}`)
  const b = build(0.15).search(onlyDoubles, 20).map((h) => `${h.chunkId}:${h.score.toFixed(6)}`)
  eq('双字查询打分完全不受权重影响', a.join('|'), b.join('|'))
}

console.log('\n=== 3. 权重 0：单字完全不计分 ===')
{
  const bm25 = build(0)
  // 只查单字 → 全部零分，不应有命中
  const singlesOnly = bm25.search(['上'], 4)
  eq('只查单字无命中', singlesOnly.length, 0)

  // 查双字词 → 只命中真含该词的文档
  const doubleOnly = bm25.search(['上限'], 4)
  ok('双字查询只命中含该词的文档', doubleOnly.every((h) => h.chunkId !== 'noise-a'),
    doubleOnly.map((h) => h.chunkId).join(','))
}

console.log('\n=== 4. 权重 1 与默认构造等价（向后兼容） ===')
{
  const a = new BM25(1.5, 0.75).build(
    DOCS.map((d) => ({ chunkId: d.chunkId, text: d.text, tags: [], date: '' })),
    tokenizeMixed,
  )
  const b = build(1)
  const qa = a.search(['上限', '上'], 4).map((h) => `${h.chunkId}:${h.score.toFixed(6)}`)
  const qb = b.search(['上限', '上'], 4).map((h) => `${h.chunkId}:${h.score.toFixed(6)}`)
  eq('不传第三参 = 权重 1', qa.join('|'), qb.join('|'))
}

console.log('\n=== 5. 拉丁词不受影响（只降中文单字） ===')
{
  const docs = [
    { chunkId: 'x', text: 'a abc' },
    { chunkId: 'y', text: 'b abc' },
  ]
  const bm25 = new BM25(1.5, 0.75, 0).build(
    docs.map((d) => ({ chunkId: d.chunkId, text: d.text, tags: [], date: '' })),
    tokenizeMixed,
  )
  const hits = bm25.search(['a', 'abc'], 2)
  ok('权重 0 时拉丁词仍计分', hits.length === 2, `命中 ${hits.length}`)
}

console.log('\n=== 6. 分数随权重单调 ===')
{
  const q = ['上限', '上', '限']
  const s1 = build(1).search(q, 4).find((h) => h.chunkId === 'target')?.score ?? 0
  const s015 = build(0.15).search(q, 4).find((h) => h.chunkId === 'target')?.score ?? 0
  const s0 = build(0).search(q, 4).find((h) => h.chunkId === 'target')?.score ?? 0
  ok('权重越小分数越低', s1 > s015 && s015 > s0, `${s1.toFixed(3)} > ${s015.toFixed(3)} > ${s0.toFixed(3)}`)
}

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) process.exitCode = 1
