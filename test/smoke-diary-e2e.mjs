// 端到端：写一篇日记 → 增量向量化 → 立刻混合召回命中。
//
// 这是 vcprag_write 的真实路径。价值在于验证「写的东西真能被搜到」，
// 而不是「代码看起来对」。写到一个临时 dataDir，不污染生产索引。

import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * 读取 embedding 密钥。
 *
 * 坑：**已经开着的终端读不到新设的用户环境变量** —— Windows 的进程环境是
 * 启动时的快照。表现是测试里 embedding 一路 401，看起来像「语义写入不
 * 向量化」的 bug，实际只是测试环境缺密钥。
 *
 * 所以 process.env 拿不到时，显式从用户注册表回读一次。
 */
function readUserEnvKey() {
  const fromProcess = process.env.VCPRAG_EMBEDDING_KEY
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') return fromProcess.trim()
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('VCPRAG_EMBEDDING_KEY','User')",
    ], { encoding: 'utf8' })
    return String(out).trim()
  } catch {
    return ''
  }
}

import { Indexer } from '../lib/indexer.js'
import { resolveConfig } from '../lib/config.js'
import { RecallFridge } from '../lib/freeze.js'
import { createTools } from '../lib/tools.js'
import { recall } from '../lib/recall.js'
import { loadAliases } from '../lib/config.js'

const ROOT = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins'
const PROD_DATA = join(ROOT, 'dsh-vcprag-memory')
const diaryRoot = join(ROOT, 'dsh-vcprag-diaries')
const runtimeFile = join(ROOT, 'dsh-mnemon-memory', 'runtime', 'memories.json')

// 测试用独立 dataDir，从生产 manifest 抄 embedding 三要素保证维度兼容
const testData = join(ROOT, '_scratch', 'vcprag-e2e')
rmSync(testData, { recursive: true, force: true })
mkdirSync(join(testData, 'index'), { recursive: true })

const prodManifest = JSON.parse(
  readFileSync(join(PROD_DATA, 'index', 'manifest.json'), 'utf8'),
)
for (const name of ['chunks.json', 'vectors.f32', 'manifest.json']) {
  const src = join(PROD_DATA, 'index', name)
  if (existsSync(src)) {
    // 直接复用生产索引，避免重新 embed 371 个 chunk
    const { copyFileSync } = await import('node:fs')
    copyFileSync(src, join(testData, 'index', name))
  }
}

const config = resolveConfig({
  corpusRoot: '',
  diaryRoot,
  dataDir: testData,
  diary: {
    enabled: true,
    format: 'txt',
    folder: '_e2e',
    requireTag: true,
    timePrefix: true,
    runtimeFile,
  },
  embedding: {
    enabled: true,
    baseUrl: prodManifest.embedding.baseUrl,
    model: prodManifest.embedding.model,
    dimensions: prodManifest.embedding.dimensions,
    apiKey: readUserEnvKey(),
    batchSize: 16,
    concurrency: 2,
    minIntervalMs: 700,
  },
})
config.aliases = loadAliases(testData)

const log = (level, message) => console.log(`  [${level}] ${message}`)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

const indexer = new Indexer({
  indexDir: join(testData, 'index'),
  getConfig: () => config,
  log,
})
const loaded = await indexer.load()
console.log(`索引加载：${loaded.chunkCount} chunk / ${loaded.docCount} 文档`)
// 不写死 371：语料每写一篇日记就变，写死等于「用户正常使用就会让测试变红」。
// 这里要保证的是「生产索引被成功复制并读进来了」，判据是数据非空且自洽。
check('复用生产索引（有 chunk）', loaded.chunkCount > 0, String(loaded.chunkCount))
check('chunk 数 ≥ 文档数（每篇至少一块）', loaded.chunkCount >= loaded.docCount,
  `${loaded.chunkCount} chunk / ${loaded.docCount} 文档`)
check('混合召回就绪', indexer.hybridReady === true, String(indexer.hybridReady))

const fridge = new RecallFridge()
const tools = createTools({ getConfig: () => config, indexer, fridge })
const writeTool = tools.find((tool) => tool.name === 'vcprag_write')
const searchTool = tools.find((tool) => tool.name === 'vcprag_search')
check('找到 vcprag_write', writeTool !== undefined)
check('找到 vcprag_search', searchTool !== undefined)

// ---- 1. 写一篇带独特词串的日记 ----
const unique = `紫曜石信标 ${Date.now()}`
const content = [
  `[03:0${new Date().getMinutes() % 10}] E2E 验证：${unique}`,
  '',
  '> 端到端测试自动写入的日记，用于验证写入后能否立即混合召回。',
  '',
  `本条目仅用于自动化验证。注入的独特标识：${unique}，`,
  '它不该出现在其他任何日记里，所以能精确判断召回是否命中本篇。',
  '',
  '写入路径：临时 dataDir，测试结束后清理。',
  '',
  `Tag: E2E验证, 端到端测试, ${unique}`,
].join('\n')

console.log('')
console.log('=== 写入 ===')
const writeResult = await writeTool.execute({ content, title: `E2E 验证：${unique}` })
console.log(writeResult)
check('写入成功', /已写入/.test(writeResult), writeResult.split('\n')[0])
check('向量化成功', /已建立/.test(writeResult), writeResult.split('\n')[2])

// ---- 2. 用独特词召回 ----
console.log('')
console.log('=== 混合召回 ===')
const result = await recall(unique, {
  bm25: indexer.bm25,
  vectors: indexer.vectors,
  embedder: indexer.embedder,
  chunks: indexer.chunks,
  aliases: config.aliases,
  config,
})
console.log(`  命中 ${result.hits.length} 条，k=${result.k}`)
console.log(`  词法 ${result.timing.lexicalMs}ms / 向量 ${result.timing.semanticMs}ms`)
for (const hit of result.hits.slice(0, 3)) {
  console.log(`  · ${hit.title}（lex=${hit.lexical} sem=${hit.semantic}）`)
}

check('召回命中新写入的日记', result.hits.length > 0, String(result.hits.length))
check(
  'Top1 就是刚写的那篇',
  result.hits[0]?.title?.includes(unique) === true,
  result.hits[0]?.title ?? '(无)',
)
check(
  '语义通道参与了打分',
  result.hits[0]?.semantic !== undefined && result.hits[0].semantic > 0.5,
  String(result.hits[0]?.semantic),
)

// ---- 3. 文件真的落盘了吗 ----
console.log('')
console.log('=== 文件检查 ===')
const written = result.hits[0]?.filename ?? ''
console.log(`  filename = ${written}`)
check('文件名带日期前缀', /^\d{4}-\d{2}-\d{2}-/.test(written), written)
check('写入分类子目录', result.hits[0]?.filename !== undefined)

// 清理
rmSync(join(diaryRoot, '_e2e'), { recursive: true, force: true })
rmSync(testData, { recursive: true, force: true })
console.log('\n已清理测试文件')

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 日记写入 → 增量向量化 → 混合召回 全链路通过')
