/**
 * 重建生产索引（会真调 embedding 网关，耗时长）。
 *
 * 用法：node rebuild-index.mjs <dataDir>
 *
 * 环境变量：
 *   VCPRAG_DATA_DIR          dataDir（也可由命令行覆盖）
 *   VCPRAG_DIARY_DIR         日记目录
 *   VCPRAG_EMBEDDING_KEY     embedding 密钥
 *   VCPRAG_BASE_URL / VCPRAG_MODEL / VCPRAG_DIMENSIONS  覆盖 manifest 里的值
 */

import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

import { Indexer } from './lib/indexer.js'
import { resolveConfig, runtimeFilePath } from './lib/config.js'

const dataDir = process.argv[2] ?? process.env.VCPRAG_DATA_DIR
if (typeof dataDir !== 'string' || dataDir.trim() === '') {
  console.error('用法：node rebuild-index.mjs <dataDir>')
  process.exit(1)
}

const diaryRoot = process.env.VCPRAG_DIARY_DIR ?? ''
const corpusRoot = process.env.VCPRAG_CORPUS_ROOT ?? ''

// 优先沿用现有 manifest 的 embedding 三要素，保证维度保护判定为兼容
const manifestPath = join(dataDir, 'index', 'manifest.json')
let previous = {}
if (existsSync(manifestPath)) {
  try {
    previous = JSON.parse(readFileSync(manifestPath, 'utf8'))?.embedding ?? {}
  } catch { /* 忽略 */ }
}

const config = resolveConfig({
  corpusRoot,
  diaryRoot,
  dataDir,
  embedding: {
    enabled: true,
    baseUrl: process.env.VCPRAG_BASE_URL ?? previous.baseUrl ?? '',
    model: process.env.VCPRAG_MODEL ?? previous.model ?? '',
    dimensions: Number(process.env.VCPRAG_DIMENSIONS ?? previous.dimensions ?? 3072),
    batchSize: 16,
    concurrency: 2,
    minIntervalMs: 700,
  },
  diary: {
    enabled: true,
    format: 'txt',
    runtimeFile: process.env.VCPRAG_RUNTIME_FILE ?? '',
  },
})

const log = (level, message) => console.log(`[${level}] ${message}`)

console.log('corpusRoot =', config.corpusRoot || '(空，只用日记)')
console.log('diaryRoot  =', config.diaryRoot)
console.log('dataDir    =', config.dataDir)
console.log('runtime    =', runtimeFilePath(config))
console.log('embedding  =', config.embedding.baseUrl, config.embedding.model, config.embedding.dimensions)
console.log('keyPresent =', (process.env.VCPRAG_EMBEDDING_KEY ?? config.embedding.apiKey ?? '') !== '')
console.log('')

const indexer = new Indexer({
  indexDir: join(dataDir, 'index'),
  getConfig: () => config,
  log,
})

let lastMessage = ''
const ticker = setInterval(() => {
  const status = indexer.status
  if (status.message !== lastMessage) {
    lastMessage = status.message
    console.log(`  ${status.progress}%  ${status.message}`)
  }
}, 1000)

const started = Date.now()
const report = await indexer.rebuild()
clearInterval(ticker)

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log('')
console.log('报告：', JSON.stringify({
  ok: report.ok,
  error: report.error,
  docCount: report.docCount,
  chunkCount: report.chunkCount,
  vectorized: report.vectorized,
  vectorError: report.vectorError,
  problems: report.problems,
}, null, 2))
console.log(`耗时 ${seconds}s`)

if (report.ok !== true) process.exit(1)
