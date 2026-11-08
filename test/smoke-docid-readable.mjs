/**
 * 「记忆库里点开一篇日记」——docId 必须能被 readDocument 认出来。
 *
 * ## 为什么需要这个文件
 *
 * 用户报：「模型写了个记忆，但我在设置里点不开」。查下来是个**纯粹的
 * 标识符口径不一致**，不涉及任何业务逻辑：
 *
 *   diary-write.js 写盘时用 randomUUID() 当 docId，存进索引
 *        → 2026-11-08-xxx-b119860b.txt
 *        → 索引里 docId = "b119860b-d20d-45dd-a74e-72dcf0fa16a3"
 *
 *   corpus.js 扫盘时用「相对路径的 32 位哈希」当 docId
 *        → docId = "diary-file-481edb1d"
 *
 *   readDocument 只比对了后者 → 用索引里的 uuid 去查，永远 null。
 *
 * 表现是「记忆库列表里看得见这条（列表用的是 indexer.chunks，里面是
 * uuid），点开却 404『文档不存在』（读取用的是路径哈希）」。老日记能
 * 打开，因为迁移脚本写进去的恰好就是路径哈希形态。
 *
 * 面板的「编辑正文 / 保存并重建索引」也走 readDocument，所以新日记
 * 连保存都点不动 —— 同一处 bug 的两个症状。
 *
 * ## 这个文件钉住什么
 *
 * 三种口径都必须能打开同一篇，且**不能**把无关的 docId 也放进来
 * （前缀匹配写松了会把所有日记都匹配上）。
 *
 * 跑法：node test/smoke-docid-readable.mjs
 */

import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { readDocument, hashish } from '../lib/corpus.js'
import { writeDiaryDoc } from '../lib/diary-write.js'
import { resolveConfig } from '../lib/config.js'

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

// ---------------- 临时目录：不碰生产语料 ----------------

const ROOT = join(tmpdir(), `vcprag-docid-${process.pid}-${Date.now()}`)
const diaryRoot = join(ROOT, 'diaries')
const dataDir = join(ROOT, 'data')
mkdirSync(diaryRoot, { recursive: true })
mkdirSync(join(dataDir, 'index'), { recursive: true })

/** 最小 indexer：writeDiaryDoc / addDocument 只需要它别抛错。 */
function makeIndexer() {
  return {
    bm25: { search: () => [], stats: () => ({ docs: 0, terms: 0, avgLen: 0 }) },
    vectors: { ready: false, search: () => [] },
    embedder: { configured: false, embedOne: async () => new Float32Array([0]) },
    chunks: new Map(),
    summary: () => ({ chunks: 0, documents: 0, embedding: false }),
    manifest: null,
    tokenizerActive: 'gram',
    tokenizerError: null,
    async addDocument(doc) {
      this.chunks.set(`${doc.docId}#0`, {
        chunkId: `${doc.docId}#0`,
        docId: doc.docId,
        title: doc.title,
        text: doc.text,
        date: doc.date,
        tags: doc.tags ?? [],
        filename: doc.filename,
        index: 0,
      })
      return { ok: true, vectorized: false }
    },
  }
}

const config = resolveConfig({
  corpusRoot: '',
  diaryRoot,
  dataDir,
  diary: { enabled: true, format: 'txt', folder: '', requireTag: true },
})

const indexer = makeIndexer()

// ---------------- 1. 真写一篇，拿到写入口径的 docId ----------------

console.log('\n=== 1. 写入时用 randomUUID 当 docId ===')

const written = await writeDiaryDoc({
  config,
  indexer,
  title: '文档 id 口径不一致排查',
  content: '[10:00] 三种 docId 口径必须全都认，否则记忆库点开就是 404。\n\nTag: 调试',
})
check('写入成功', written.ok === true, JSON.stringify(written.error ?? ''))
const uuid = written.docId
check('docId 是 uuid 形态（不是 diary-file-xxx）',
  /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(uuid)), String(uuid))
check('文件名末段是 uuid 前 8 位',
  String(written.filename).endsWith(`-${String(uuid).slice(0, 8)}.txt`), String(written.filename))

// ---------------- 2. 三种口径都能打开 ----------------

console.log('\n=== 2. 三种 docId 口径都能读到同一篇 ===')

const byUuid = readDocument('', uuid, { diaryRoot })
check('① 索引里的 uuid 能打开', byUuid !== null, 'null')
check('  读到的正是这篇', String(byUuid?.filename ?? '').includes(String(uuid).slice(0, 8)),
  String(byUuid?.filename ?? ''))

const relPath = String(written.relativePath).replace(/\\/g, '/')
const pathHash = `diary-${hashish(relPath)}`
const byHash = readDocument('', pathHash, { diaryRoot })
check('② 路径哈希（扫盘口径）能打开', byHash !== null, pathHash)
check('  和 uuid 读到同一篇', byHash?.filename === byUuid?.filename,
  `${byHash?.filename} vs ${byUuid?.filename}`)

const shortId = String(uuid).slice(0, 8)
const byShort = readDocument('', shortId, { diaryRoot })
check('③ 8 位前缀（update 口径）能打开', byShort !== null, shortId)
check('  和 uuid 读到同一篇', byShort?.filename === byUuid?.filename,
  `${byShort?.filename} vs ${byUuid?.filename}`)

// ---------------- 3. 反向：不能乱匹配 ----------------

console.log('\n=== 3. 不相关的 docId 必须仍然 404 ===')

check('不存在的 uuid → null',
  readDocument('', 'deadbeef-0000-4000-8000-000000000000', { diaryRoot }) === null)
check('不存在的 8 位前缀 → null',
  readDocument('', 'deadbeef', { diaryRoot }) === null)
check('空串 → null', readDocument('', '', { diaryRoot }) === null)

// 另一篇日记：8 位前缀不同，不能被上一轮的短 id 抢走
const other = await writeDiaryDoc({
  config,
  indexer,
  title: '另一篇完全不同的日记',
  content: '[11:00] 这篇的存在意义是证明短 id 不会串台。\n\nTag: 调试',
})
check('第二篇写入成功', other.ok === true)
const otherDoc = readDocument('', String(other.docId).slice(0, 8), { diaryRoot })
check('用自己的短 id 读到自己',
  otherDoc?.filename === other.filename, `${otherDoc?.filename} vs ${other.filename}`)
check('第一篇的短 id 读不到第二篇',
  readDocument('', shortId, { diaryRoot })?.filename !== other.filename)

// ---------------- 4. 手写的旧形态文件（迁移脚本产物） ----------------

console.log('\n=== 4. 老日记（迁移产物）不受影响 ===')

mkdirSync(join(diaryRoot, '归档'), { recursive: true })
const legacyRel = '归档/2026-01-01-legacy-note.txt'
writeFileSync(join(diaryRoot, legacyRel), '[09:00] 迁移脚本写的老日记。\n\nTag: 老\n', 'utf8')
const legacyHash = `diary-${hashish(legacyRel)}`
check('老日记仍能用路径哈希打开',
  readDocument('', legacyHash, { diaryRoot }) !== null, legacyHash)

rmSync(ROOT, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言 —— 记忆库里点开任何一篇都能读到`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  for (const f of failures) console.log('  - ' + f)
  process.exitCode = 1
}
