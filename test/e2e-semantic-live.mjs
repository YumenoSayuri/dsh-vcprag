// 语义写入的真实端到端：走已部署的生产配置 + 真索引，写完立刻召回验证。
//
// 与 smoke-semantic-write 的分界：
//   smoke-semantic-write  纯逻辑层，临时目录、假 indexer，不联网
//   本文件                真实配置 + 真 indexer + 真向量化，验证「写进去能召回」
//
// 后者才能发现「文件写对了但索引没同步」这类问题 —— 那正是用户看到
// 「日记在那儿，但问它时想不起来」的原因。
//
// 跑完会把测试日记归档（移入 已整理/），不留垃圾。

import { join } from 'node:path'
import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { resolveConfig, mergeConfigOverlay } from '../lib/config.js'
import { Indexer } from '../lib/indexer.js'
import { createDiarySink } from '../lib/diary-sink.js'
import { listDiaryFiles, replaceInDiaryDoc } from '../lib/diary-write.js'
import { recall } from '../lib/recall.js'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// 手写一份与生产 profile 等价的配置。
//
// 不直接去解析 cordis.patch.yml：那需要一个 YAML 解析器，
// 而这份文件里除了 vcprag 还混着别的插件条目。这里只复刻本插件关心的
// 那几个字段 —— 它们与 profile 里的实际值逐一对应（改一边要同步另一边）。
// 密钥来自用户环境变量，但**已经开着的终端读不到它**（Windows 的进程环境
// 是启动时快照的）。所以这里显式从注册表回读一次 —— 否则测试里的 embedding
// 会一直 401，看起来像「语义写入不向量化」，实际是测试环境缺密钥。
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

const apiKey = readUserEnvKey()
console.log('=== 密钥 ===')
console.log('  VCPRAG_EMBEDDING_KEY =', apiKey === '' ? '(未取到)' : `${apiKey.length} 字符`)

const raw = {
  diaryRoot: 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-diaries',
  corpusRoot: '',
  dataDir: 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-memory',
  diary: {
    enabled: true, format: 'txt', folder: '', templateEnabled: true, templateOrder: 130,
    templateText: '', requireTag: true, timePrefix: true,
    runtimeFile: 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-mnemon-memory/runtime/memories.json',
    semantic: { enabled: true, blockName: 'DailyNote', updateMinTarget: 15 },
  },
  embedding: {
    enabled: true,
    // 显式传 key，避免依赖进程环境（见上面注释）
    apiKey,
    baseUrl: 'https://ai.huibaolinks.com/v1',
    model: 'google/gemini-embedding-2-preview',
    dimensions: 3072,
  },
}

const config = resolveConfig(mergeConfigOverlay(resolveConfig(raw).dataDir, raw))
console.log('=== 生产配置 ===')
console.log('  diaryRoot =', config.diaryRoot)
console.log('  dataDir   =', config.dataDir)
console.log('  semantic  =', JSON.stringify(config.diary.semantic))
check('语义写入已启用', config.diary.semantic.enabled === true)
check('日记目录存在', existsSync(config.diaryRoot), config.diaryRoot)

const logs = []
const log = (level, message) => {
  logs.push(`${level}: ${message}`)
  if (level !== 'info') console.log(`  [${level}] ${message}`)
}

const indexer = new Indexer({ indexDir: join(config.dataDir, 'index'), getConfig: () => config, log })
const loaded = await indexer.load()
check('索引已加载', indexer.chunks.size > 0, `${loaded.chunkCount} chunk / ${loaded.docCount} 文档`)
check('混合召回就绪', indexer.hybridReady === true, `hybridReady=${indexer.hybridReady}`)

const sink = createDiarySink({ getConfig: () => config, indexer, log })

// 唯一标记：确保只命中本次测试写的那篇
const stamp = `E2E${Date.now().toString(36).toUpperCase()}`
const title = `语义写入端到端验证 ${stamp}`
const beacon = `紫晶探针${stamp}`

const before = listDiaryFiles(config).length

const text = `先说明一下这次验证。

<<<DailyNoteStart>>>
command: create
title: ${title}
folder: 端到端测试
tags: 语义写入, 端到端, ${stamp}

[03:40] 这是一次真实的语义写入验证，特征串是 ${beacon}，用于确认「正文里的块能被系统落盘并立刻参与语义召回」。

验证要点：块在正文里，不在工具参数里；写入后不需要重启；下一次查询就能命中。
Tag: 语义写入, 端到端, ${stamp}
<<<DailyNoteEnd>>>

上面那段是系统指令，正文到此结束。`

console.log('')
console.log('=== 写入 ===')
const result = await sink.consume(text, { sessionId: 'e2e', turn: 1 })
check('written = 1', result.written === 1, JSON.stringify({ w: result.written, f: result.failed, r: result.results }))
check('failed = 0', result.failed === 0, JSON.stringify(result.results.map((r) => r.error).filter(Boolean)))

const after = listDiaryFiles(config)
check('文件数 +1', after.length === before + 1, `${before} → ${after.length}`)

const created = after.find((file) => file.relativePath.includes('端到端测试'))
check('落在了 folder 指定的子目录', created !== undefined, created?.relativePath ?? '(找不到)')

let createdPath = ''
if (created !== undefined) {
  createdPath = created.path
  const body = readFileSync(createdPath, 'utf8')
  check('文件里没有块标记', !body.includes('DailyNoteStart'))
  check('文件里没有 command 头', !body.includes('command:'))
  check('特征串在正文里', body.includes(beacon))
  check('末行是 Tag', /Tag: 语义写入, 端到端, [A-Z0-9]+\s*$/.test(body), JSON.stringify(body.slice(-50)))
}

console.log('')
console.log('=== 索引同步 ===')
const indexed = result.results[0]?.indexed === true
check('该篇已向量化', indexed, `indexed=${result.results[0]?.indexed} / ${result.results[0]?.warnings?.join('; ') ?? ''}`)
check('内存 chunk 数增加了', indexer.chunks.size > 371, `现在 ${indexer.chunks.size}`)

console.log('')
console.log('=== 语义召回（这才是"写进去有用"的证据）===')
const recalled = await recall(`紫晶探针 ${stamp}`, {
  bm25: indexer.bm25,
  vectors: indexer.vectors,
  embedder: indexer.embedder,
  chunks: indexer.chunks,
  aliases: config.aliases,
  config,
})
const hit = recalled.hits[0]
check('有召回结果', recalled.hits.length > 0, `${recalled.hits.length} 条`)
check(
  'Top1 就是刚写的那篇',
  hit !== undefined && String(hit.title).includes(stamp),
  hit === undefined ? '(无)' : `${String(hit.title).slice(0, 50)} | lex=${hit.lexical?.toFixed(2)} sem=${hit.semantic?.toFixed(4)}`,
)
check('语义通道真的参与了', hit !== undefined && typeof hit.semantic === 'number' && hit.semantic > 0,
  hit === undefined ? '' : String(hit.semantic))

console.log('')
console.log('=== update 定位替换 ===')
if (createdPath !== '') {
  const updBlock = `<<<DailyNoteStart>>>
command: update
target: 这是一次真实的语义写入验证，特征串是 ${beacon}
replace: 这是一次真实的语义写入验证（已被 update 改写），特征串是 ${beacon}
<<<DailyNoteEnd>>>`
  const upd = await sink.consume(updBlock, { sessionId: 'e2e', turn: 2 })
  check('updated = 1', upd.updated === 1, JSON.stringify({ u: upd.updated, f: upd.failed, r: upd.results }))
  const body = readFileSync(createdPath, 'utf8')
  check('文件里出现了改写后的句子', body.includes('已被 update 改写'))
  check('周边段落没被动', body.includes('验证要点：块在正文里'))
}

console.log('')
console.log('=== 幂等（同一块再投递一次）===')
const again = await sink.consume(text, { sessionId: 'e2e', turn: 1 })
check('没有重复写', again.written === 0, JSON.stringify({ w: again.written, s: again.skipped }))
check('文件数没变', listDiaryFiles(config).length === before + 1, String(listDiaryFiles(config).length))

// ---- 清理：把测试日记移到 已整理/，并从内存索引剔除 ----
if (createdPath !== '' && existsSync(createdPath)) {
  try {
    const archiveDir = join(config.diaryRoot, '已整理')
    mkdirSync(archiveDir, { recursive: true })
    renameSync(createdPath, join(archiveDir, `e2e-${stamp}.txt`))
    console.log('\n已清理测试日记 → 已整理/')
  } catch (error) {
    console.log('\n清理失败（需手动删除）：', createdPath, error?.message ?? error)
  }
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：\n  · ${failures.join('\n  · ')}`)
  process.exit(1)
}
console.log('✓ 语义写入端到端通过：正文块 → 落盘 → 向量化 → 语义召回 → 定位替换')
