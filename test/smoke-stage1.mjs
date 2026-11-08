/**
 * 阶段 1 冒烟测试：corpus + chunker + tokenize + bm25。
 *
 * 不依赖 DSH 运行时，直接 node 跑。
 *   node test/smoke-stage1.mjs
 */

import { loadCorpus, corpusStats, DEFAULT_CORPUS_ROOT } from '../lib/corpus.js'
import { DEFAULT_DIARY_DIR } from '../lib/config.js'
import { chunkDocument, scoringText } from '../lib/chunker.js'
import { tokenize } from '../lib/tokenize.js'
import { BM25 } from '../lib/bm25.js'

// 两层的路径都可以用环境变量指定：
//   VCPRAG_CORPUS     旧 .md 语料（可留空，只用日记）
//   VCPRAG_DIARY_DIR  .txt 日记目录
//   VCPRAG_RUNTIME_FILE  runtime 记忆文件
const CORPUS = process.env.VCPRAG_CORPUS ?? DEFAULT_CORPUS_ROOT
const DIARY = process.env.VCPRAG_DIARY_DIR ?? DEFAULT_DIARY_DIR
const RUNTIME_FILE = process.env.VCPRAG_RUNTIME_FILE ?? `${CORPUS}/runtime/memories.json`
const STATS_OPTS = { diaryRoot: DIARY, runtimeFile: RUNTIME_FILE }

console.log('=== 目录 ===')
console.log('corpus =', CORPUS || '(空，只用日记)')
console.log('diary  =', DIARY)
console.log(JSON.stringify(corpusStats(CORPUS, STATS_OPTS), null, 2))

const t0 = performance.now()
const { docs, runtime, problems } = loadCorpus(CORPUS, {
  diaryRoot: DIARY,
  diaryConfig: { enabled: true },
  runtimeFile: RUNTIME_FILE,
})
const tLoad = performance.now() - t0

console.log('\n=== 读取 ===')
console.log('docs:', docs.length, ' runtime:', runtime.length, ' problems:', problems.length)
console.log('耗时:', tLoad.toFixed(1) + 'ms')
if (problems.length > 0) problems.slice(0, 10).forEach((p) => console.log('  !', p))

console.log('\n=== 切分 ===')
const t1 = performance.now()
const chunks = docs.flatMap((doc) =>
  chunkDocument(doc, { size: 800, overlap: 120 }).map((chunk) => ({
    ...chunk,
    // 打分文本：标题 + tags 重复计入
    text: scoringText(chunk),
    // 但给模型看的正文必须是原始 chunk text
  })),
)
const tChunk = performance.now() - t1
console.log('chunks:', chunks.length, ' 耗时:', tChunk.toFixed(1) + 'ms')

const sizes = chunks.map((c) => c.text.length)
console.log(
  'chunk 长度 min/avg/max:',
  Math.min(...sizes),
  Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
  Math.max(...sizes),
)

console.log('\n=== BM25 建索引 ===')
const t2 = performance.now()
const bm25 = new BM25(1.5, 0.75).build(
  chunks.map((chunk) => ({ chunkId: chunk.chunkId, text: chunk.text, tags: chunk.tags, date: chunk.date })),
  (text) => tokenize(text, null),
)
const tBuild = performance.now() - t2
console.log(JSON.stringify(bm25.stats(), null, 2))
console.log('耗时:', tBuild.toFixed(1) + 'ms')

console.log('\n=== 查询测试 ===')
const queries = [
  '木马扫描 Defender',
  'comfyui',
  'vellum cloudflare tunnel',
  '时间编织者 rewind',
  'mnemon 记忆',
  'Clash Verge 命名管道',
  'gemini 模型路由',
]

for (const query of queries) {
  const tokens = tokenize(query, null)
  const t = performance.now()
  const hits = bm25.search(tokens, 3)
  const elapsed = performance.now() - t
  console.log(`\n「${query}」 tokens=${tokens.length} 命中=${hits.length}  ${elapsed.toFixed(1)}ms`)
  for (const hit of hits) {
    const doc = docs.find((d) => hit.chunkId.startsWith(d.docId))
    console.log(
      `  ${hit.score.toFixed(3)}  ${(doc?.title ?? '').slice(0, 46)}  [${hit.matched.slice(0, 5).join(',')}]`,
    )
  }
}

console.log('\n=== runtime 记忆 ===')
console.log('条数:', runtime.length, '总字符:', runtime.reduce((a, m) => a + m.content.length, 0))
const byTarget = {}
for (const m of runtime) byTarget[m.target] = (byTarget[m.target] ?? 0) + 1
console.log('分布:', JSON.stringify(byTarget))

console.log('\n=== 文档解析抽查 ===')
const sample = docs[0]
if (sample === undefined) {
  console.log('（没有文档，跳过）')
} else {
  console.log(JSON.stringify({
    docId: sample.docId,
    source: sample.source,
    title: sample.title.slice(0, 40),
    description: sample.description.slice(0, 60),
    date: sample.date,
    tags: sample.tags,
    bodyChars: sample.text.length,
  }, null, 2))
}

// 摘要：stage1 不依赖具体语料内容，只断言「读得进来 + 切得开 + 搜得到」
const diaryCount = docs.filter((d) => d.source === 'diary').length
const corpusCount = docs.filter((d) => d.source === 'corpus').length
console.log('\n=== 汇总 ===')
console.log(`文档 ${docs.length}（日记 ${diaryCount} / 语料 ${corpusCount}）  切分 ${chunks.length} chunk`)
console.log(`runtime ${runtime.length} 条  problem ${problems.length} 条`)
if (docs.length === 0) {
  console.error('✗ 没有任何文档 —— 检查 VCPRAG_DIARY_DIR 是否指向真实目录')
  process.exit(1)
}
console.log('✓ stage1 通过')
