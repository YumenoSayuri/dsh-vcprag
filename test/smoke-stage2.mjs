/**
 * 阶段 2 冒烟测试：完整索引构建 + 混合召回 + 维度保护。
 *
 *   set VCPRAG_EMBEDDING_KEY=sk-xxx
 *   node test/smoke-stage2.mjs
 *
 * 不带 key 时只测 BM25 降级路径。
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveConfig, loadAliases } from '../lib/config.js'
import { Indexer, assertIndexCompatible, resolveApiKey } from '../lib/indexer.js'
import { recall, renderRecallBlock, dynamicK } from '../lib/recall.js'
import { RecallFridge } from '../lib/freeze.js'

const DATA_DIR =
  'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/dev-plugins/dsh-vcprag/test/.tmp-index'

const KEY = process.env.VCPRAG_EMBEDDING_KEY ?? ''
const HAS_KEY = KEY.trim() !== ''

if (process.argv.includes('--clean') && existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true })
  console.log('已清空测试索引目录')
}
mkdirSync(join(DATA_DIR, 'index'), { recursive: true })

let config = resolveConfig({
  embedding: { enabled: HAS_KEY },
})
if (HAS_KEY) config.embedding.apiKey = KEY
config.aliases = loadAliases(DATA_DIR)

console.log('=== 配置 ===')
console.log(JSON.stringify({
  corpusRoot: config.corpusRoot,
  embeddingEnabled: config.embedding.enabled,
  hasApiKey: resolveApiKey(config.embedding) !== '',
  dimensions: config.embedding.dimensions,
  batchSize: config.embedding.batchSize,
  chunkSize: config.chunkSize,
  kBase: config.recall.kBase,
}, null, 2))

const indexer = new Indexer({
  indexDir: join(DATA_DIR, 'index'),
  getConfig: () => config,
  log: (level, message) => console.log(`  [${level}] ${message}`),
})

console.log('\n=== 构建索引 ===')
const t0 = performance.now()
const report = await indexer.rebuild()
const elapsed = performance.now() - t0
console.log(JSON.stringify(report, null, 2))
console.log('总耗时:', elapsed.toFixed(0) + 'ms')

if (report.ok !== true) {
  console.error('构建失败，终止')
  process.exit(1)
}

console.log('\n=== 加载与状态 ===')
await indexer.load()
const summary = indexer.summary()
console.log(JSON.stringify({
  hybridReady: summary.hybridReady,
  compatible: summary.compatible,
  docCount: summary.docCount,
  chunkCount: summary.chunkCount,
  vectorized: summary.vectorized,
  runtimeCount: summary.runtimeCount,
  bm25: summary.bm25,
  statusState: summary.status.state,
}, null, 2))

console.log('\n=== 混合召回 ===')
const queries = [
  '木马扫描 Defender 那 19 项',
  'comfyui 工作流',
  'vellum cloudflare tunnel',
  '时间编织者 rewind',
  'mnemon 三级记忆',
  'Clash Verge 命名管道 secret',
  'gemini 模型路由 404',
  'spectre 漏洞',
]

const recallCtx = {
  bm25: indexer.bm25,
  vectors: indexer.vectors,
  embedder: indexer.embedder,
  chunks: indexer.chunks,
  aliases: config.aliases,
  config,
}

for (const query of queries) {
  const result = await recall(query, recallCtx)
  console.log(`\n「${query}」  K=${result.k}  总=${result.timing.totalMs}ms`)
  console.log(
    `  词法 ${result.timing.lexicalCount}条/${result.timing.lexicalMs}ms  ` +
    `向量 ${result.timing.semanticCount}条/${result.timing.semanticMs}ms  ` +
    `融合 ${result.timing.fusedCount}→去重 ${result.timing.dedupedCount}` +
    (result.timing.semanticSkipped ? `  [跳过:${result.timing.semanticSkipped}]` : ''),
  )
  for (const hit of result.hits.slice(0, 4)) {
    const parts = [
      hit.final.toFixed(4),
      'L=' + hit.lexical.toFixed(2),
      hit.semantic !== undefined ? 'V=' + hit.semantic.toFixed(3) : 'V=-',
      hit.title.slice(0, 38),
    ]
    console.log('   ' + parts.join('  '))
  }
}

console.log('\n=== 注入文本样例 ===')
const sample = await recall('木马扫描 Defender', recallCtx)
const block = renderRecallBlock(sample.hits, { reason: 'first-turn', maxChars: 1500 })
console.log(block)

console.log('\n=== 冻结状态机 ===')
const fridge = new RecallFridge()
const steps = [
  { kind: 'user/message', payload: { id: 'm1' } },
  { kind: 'tool/call', payload: { name: 'read_file' } },
  { kind: 'user/message', payload: { id: 'm1' } },              // 重复，不应刷新
  { kind: 'tool/call', payload: { name: 'todo_write', args: { todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'pending' },
  ] } } },
  { kind: 'tool/call', payload: { name: 'todo_write', args: { todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'pending' },
  ] } } },                                                       // 无新勾选，不刷新
  { kind: 'tool/call', payload: { name: 'todo_write', args: { todos: [
    { content: 'a', status: 'completed' }, { content: 'b', status: 'completed' },
  ] } } },                                                       // 新勾选，刷新
  { kind: 'user/message', payload: { id: 'm2' } },
]
for (const step of steps) {
  const decision = fridge.shouldRefresh(step, config.freeze)
  const label =
    step.kind === 'tool/call'
      ? `tool/call ${step.payload.name}${step.payload.args ? ' 勾选' + (step.payload.args.todos.filter((t) => t.status === 'completed').length) : ''}`
      : `user/message ${step.payload.id}`
  console.log(`  ${decision.refresh ? '✓刷新' : ' 跳过'}  ${decision.reason.padEnd(24)} ← ${label}`)
  if (decision.refresh) fridge.freeze({ text: 'x', reason: decision.reason, hits: [] })
}
console.log('  snapshot:', JSON.stringify(fridge.snapshot()))

console.log('\n=== 维度保护 ===')
const manifest = indexer.manifest
console.log('真实配置:', JSON.stringify(assertIndexCompatible(manifest, config)))

const wrongDim = structuredClone(config)
wrongDim.embedding.dimensions = 1536
console.log('改维度 1536:', JSON.stringify(assertIndexCompatible(manifest, wrongDim), null, 2))

const wrongModel = structuredClone(config)
wrongModel.embedding.model = 'BAAI/bge-m3'
console.log('改模型:', JSON.stringify(assertIndexCompatible(manifest, wrongModel), null, 2))

const wrongChunk = structuredClone(config)
wrongChunk.chunkSize = 1200
console.log('改分块:', JSON.stringify(assertIndexCompatible(manifest, wrongChunk), null, 2))

console.log('\n=== 动态 K ===')
for (const query of ['comfyui', '为什么上次那个木马扫描跑了 2 小时还没扫完？我怀疑排除项没删干净', 'a、b、c、d、e、f、g、h 都失败了怎么办？']) {
  console.log(`  len=${String(query.length).padStart(3)}  K=${dynamicK(query, config.recall)}  ${query.slice(0, 40)}`)
}

if (HAS_KEY) {
  console.log('\n=== 完整性校验 ===')
  const verify = await indexer.verify(3)
  console.log(JSON.stringify(verify, null, 2))
} else {
  console.log('\n（无 API key，跳过完整性校验）')
}
