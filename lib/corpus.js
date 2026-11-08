/**
 * 语料读取。
 *
 * 三层数据，语义与写入权限都不同：
 *   documents/active/*.md   → 历史长文档（只读），走检索
 *   diaryRoot/**\/*.txt     → 日记（可写），走检索
 *   runtime/memories.json   → 短事实，走常驻注入
 *
 * 前两层会被合并成同一条检索流水线，对上层完全透明 ——
 * 只有「能不能写」这一点不同。
 *
 * @module dsh-vcprag/corpus
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, relative, extname } from 'node:path'
import { parseFrontmatter } from './chunker.js'
import { parseTagLine, parseTimePrefix } from './diary-template.js'

/**
 * 默认语料目录（可被 config.corpusRoot 覆盖）。
 *
 * 解析顺序：config.corpusRoot → 环境变量 VCPRAG_CORPUS_ROOT → <cwd>/corpus
 * 使用方请务必在 cordis.patch.yml 里显式配置 `corpusRoot`。
 */
export const DEFAULT_CORPUS_ROOT = (() => {
  const fromEnv = process.env.VCPRAG_CORPUS_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(process.cwd(), 'corpus')
})()

/** 递归扫描的最大目录深度，防符号链接环。 */
const MAX_DEPTH = 6

/**
 * @typedef {object} CorpusDoc
 * @property {string} docId - 稳定 ID（优先取 frontmatter.id，否则由相对路径派生）。
 * @property {string} filename
 * @property {string} relativePath - 相对其根目录的路径，正斜杠。
 * @property {string} title
 * @property {string} description
 * @property {string} text - 去掉 frontmatter 的正文。
 * @property {string} date - ISO 日期（取 createdAt 的日期部分）。
 * @property {string[]} tags
 * @property {string} status - active / archived
 * @property {string} source - corpus（历史 .md） / diary（.txt 日记）
 * @property {string} contentHash
 */

/**
 * @typedef {object} RuntimeMemory
 * @property {string} content
 * @property {string} created_at
 * @property {string} updated_at
 * @property {'user'|'memory'} target
 * @property {'critical'|'normal'} importance
 */

/**
 * 扫描全部语料。
 *
 * 任何单篇读取失败都跳过并记入 problems，不让一篇坏文件阻断整个建索引流程。
 *
 * @param {string} corpusRoot
 * @param {{
 *   includeArchived?: boolean,
 *   diaryRoot?: string,
 *   diaryConfig?: object,
 *   runtimeFile?: string,
 * }} [options]
 * @returns {{ docs: CorpusDoc[], runtime: RuntimeMemory[], problems: string[] }}
 */
export function loadCorpus(corpusRoot, options = {}) {
  const problems = []
  const docs = []

  // ---- 1. 历史 .md 语料 ----
  //
  // corpusRoot 为空串 = 明确只用日记作为唯一来源（迁移完成后的推荐形态）。
  // 此时不报「目录不存在」，也不贡献任何 problem。
  const hasCorpus = typeof corpusRoot === 'string' && corpusRoot.trim() !== ''
  const dirs = hasCorpus
    ? [{ dir: join(corpusRoot, 'documents', 'active'), status: 'active' }]
    : []
  if (hasCorpus && options.includeArchived === true) {
    dirs.push({ dir: join(corpusRoot, 'documents', 'archived'), status: 'archived' })
  }

  for (const { dir, status } of dirs) {
    if (!existsSync(dir)) {
      problems.push(`目录不存在：${dir}`)
      continue
    }
    let entries
    try {
      entries = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md'))
    } catch (error) {
      problems.push(`列目录失败 ${dir}：${error?.message ?? error}`)
      continue
    }
    for (const filename of entries) {
      const parsed = readMarkdownDoc(join(dir, filename), corpusRoot, problems, status)
      if (parsed !== null) docs.push(parsed)
    }
  }

  // ---- 2. 日记 .txt（可写层，递归子目录当分类）----
  //
  // 去重：日记是「同一批记忆的新格式」。如果有人把旧 .md 迁移成了 .txt
  // 而 corpusRoot 又还指着原来那批 .md，两层会各出 61 篇 → 122 篇重复索引
  // （召回时同一内容占两个名额，且时间衰减各算一次，排序被污染）。
  // 判据用「标题去空白后完全相同」——迁移脚本保证标题逐字保留。
  const diaryRoot = typeof options.diaryRoot === 'string' ? options.diaryRoot : ''
  if (diaryRoot !== '' && options.diaryConfig?.enabled !== false) {
    if (existsSync(diaryRoot)) {
      const corpusTitles = new Set(docs.map((doc) => normaliseTitle(doc.title)))
      let duplicates = 0
      for (const absolute of walkFiles(diaryRoot, '.txt', problems)) {
        const parsed = readDiaryDoc(absolute, diaryRoot, problems)
        if (parsed === null) continue
        if (corpusTitles.has(normaliseTitle(parsed.title))) {
          duplicates += 1
          continue
        }
        docs.push(parsed)
      }
      if (duplicates > 0) {
        problems.push(
          `日记目录与语料目录有 ${duplicates} 篇重复（标题相同），已跳过日记侧。`
          + '建议把 corpusRoot 留空，只保留 diaryRoot 作为唯一来源。',
        )
      }
    }
    // 目录不存在是正常起点（还没写过），首次写入时自动创建
  }

  const runtime = loadRuntimeMemories(options.runtimeFile, problems)
  return { docs, runtime, problems }
}

/**
 * 读一篇历史 .md 文档。
 *
 * @returns {CorpusDoc|null}
 */
function readMarkdownDoc(path, corpusRoot, problems, status) {
  const filename = basename(path)
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim() === '') {
      problems.push(`空文件：${filename}`)
      return null
    }
    const { frontmatter, body } = parseFrontmatter(raw)
    if (body.trim() === '') {
      problems.push(`正文为空：${filename}`)
      return null
    }
    const createdAt = typeof frontmatter.created_at === 'string' ? frontmatter.created_at : ''
    const rel = relative(corpusRoot, path).replace(/\\/g, '/')
    return {
      docId: typeof frontmatter.id === 'string' && frontmatter.id !== ''
        ? frontmatter.id
        : hashish(rel),
      filename,
      relativePath: rel,
      title: typeof frontmatter.title === 'string' ? frontmatter.title : stripExtension(filename),
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      text: body,
      date: createdAt.slice(0, 10),
      tags: Array.isArray(frontmatter.tags)
        ? frontmatter.tags.filter((tag) => typeof tag === 'string')
        : parseTagLine(body),
      status,
      source: 'corpus',
      contentHash: typeof frontmatter.content_hash === 'string' ? frontmatter.content_hash : '',
    }
  } catch (error) {
    problems.push(`读取失败 ${filename}：${error?.message ?? error}`)
    return null
  }
}

/**
 * 读一篇 .txt 日记。
 *
 * 日记是纯文本，没有 YAML frontmatter。元数据全部从正文推断：
 *   标题     → 第一行非空且不以 [HH:MM] 开头的行，去掉 # 前缀
 *   日期     → 文件名的 YYYY-MM-DD 前缀，否则文件 mtime
 *   时间     → 正文开头 [HH:MM]
 *   Tag      → 末行 Tag: ...
 *   摘要     → 正文前 120 字（作为高权重检索字段）
 *
 * @returns {CorpusDoc|null}
 */
function readDiaryDoc(path, diaryRoot, problems) {
  const filename = basename(path)
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim() === '') {
      problems.push(`空日记：${filename}`)
      return null
    }
    const rel = relative(diaryRoot, path).replace(/\\/g, '/')
    const lines = raw.split(/\r?\n/)
    const date = dateFromName(filename) || dateFromStat(path)

    // 标题 = 首行去掉 [HH:MM] / # 前缀。
    // 不能只看「第一行非空」——首行通常是 `[21:14] 标题`，
    // 也不是「往下找第一行非时间戳」——那会抓到 `> 摘要` 这一行，
    // 于是所有日记标题都变成以 "> " 开头的摘要截断。
    const firstContent = lines.find((line) => line.trim() !== '') ?? ''
    let title = firstContent
      .replace(/^\s*\[\d{1,2}:\d{2}\]\s*/, '')
      .replace(/^#+\s*/, '')
      .trim()
    // 首行本来就是纯时间戳（后无文字）时，去掉 `>` 引用符再取一次
    if (title === '') title = stripExtension(filename)
    // 兜底：若首行是引用块（> 开头），剥掉引用符
    title = title.replace(/^>\s*/, '').trim()
    title = title.slice(0, 80)

    const time = parseTimePrefix(raw)
    // 摘要 = 首段引用（> 开头）优先，否则正文前 120 字
    const quoteLine = lines.map((line) => line.trim()).find((line) => line.startsWith('>'))
    const description = (quoteLine !== undefined ? quoteLine.replace(/^>\s*/, '') : raw)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)

    return {
      docId: `diary-${hashish(rel)}`,
      filename,
      relativePath: rel,
      title,
      description,
      text: raw,
      date: time === '' ? date : date,
      tags: parseTagLine(raw),
      status: rel.split('/').includes('已整理') ? 'archived' : 'active',
      source: 'diary',
      contentHash: '',
    }
  } catch (error) {
    problems.push(`读取日记失败 ${filename}：${error?.message ?? error}`)
    return null
  }
}

/**
 * 递归列出某扩展名的文件。
 *
 * @param {string} root
 * @param {string} extension - 小写含点，如 '.txt'
 * @param {string[]} problems
 * @param {number} [depth]
 * @returns {string[]} 绝对路径
 */
export function walkFiles(root, extension, problems = [], depth = 0) {
  const out = []
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    problems.push(`列目录失败 ${root}：${error?.message ?? error}`)
    return out
  }
  for (const entry of entries) {
    // 归档目录不参与普通扫描（由 includeArchived 单独控制语义）
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, extension, problems, depth + 1))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === extension) {
      out.push(full)
    }
  }
  return out
}

/**
 * 读 runtime 记忆。
 *
 * 这些是长期稳定的偏好事实，体积极小，必须全量常驻注入 ——
 * 走检索的话某次没召回就丢失核心设定。
 *
 * @param {string} [runtimeFile] - 显式路径；空则视为没有
 * @param {string[]} problems
 * @returns {RuntimeMemory[]}
 */
export function loadRuntimeMemories(runtimeFile, problems = []) {
  if (typeof runtimeFile !== 'string' || runtimeFile === '') {
    problems.push('runtime 记忆文件未配置')
    return []
  }
  if (!existsSync(runtimeFile)) {
    problems.push(`runtime 记忆文件不存在：${runtimeFile}`)
    return []
  }
  try {
    const parsed = JSON.parse(readFileSync(runtimeFile, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return entries
      .filter((entry) => typeof entry?.content === 'string' && entry.content.trim() !== '')
      .map((entry) => ({
        content: entry.content,
        created_at: typeof entry.created_at === 'string' ? entry.created_at : '',
        updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
        target: entry.target === 'user' ? 'user' : 'memory',
        importance: entry.importance === 'critical' ? 'critical' : 'normal',
      }))
  } catch (error) {
    problems.push(`runtime 记忆解析失败：${error?.message ?? error}`)
    return []
  }
}

/**
 * 读 documents/index.json，用于增量比对。
 *
 * @param {string} corpusRoot
 * @returns {Map<string, { contentHash: string, revision: number, filename: string, updatedAt: string }>}
 */
export function loadDocumentIndex(corpusRoot) {
  const path = join(corpusRoot, 'documents', 'index.json')
  const index = new Map()
  if (!existsSync(path)) return index
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const entries = Array.isArray(parsed?.documents) ? parsed.documents : []
    for (const entry of entries) {
      if (typeof entry?.id !== 'string') continue
      index.set(entry.id, {
        contentHash: typeof entry.contentHash === 'string' ? entry.contentHash : '',
        revision: typeof entry.revision === 'number' ? entry.revision : 0,
        filename: typeof entry.filename === 'string' ? entry.filename : '',
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
      })
    }
  } catch {
    /* 索引损坏时按「无索引」处理，走全量重建 */
  }
  return index
}

/**
 * 语料统计。
 *
 * @param {string} corpusRoot
 * @param {{ diaryRoot?: string, runtimeFile?: string }} [options]
 */
export function corpusStats(corpusRoot, options = {}) {
  const hasCorpus = typeof corpusRoot === 'string' && corpusRoot.trim() !== ''
  const activeDir = hasCorpus ? join(corpusRoot, 'documents', 'active') : ''
  const archivedDir = hasCorpus ? join(corpusRoot, 'documents', 'archived') : ''

  const countOf = (dir) => {
    try {
      return readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).length
    } catch {
      return 0
    }
  }

  let totalBytes = 0
  if (hasCorpus) {
    try {
      for (const name of readdirSync(activeDir)) {
        if (!name.toLowerCase().endsWith('.md')) continue
        try {
          totalBytes += statSync(join(activeDir, name)).size
        } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }

  // 日记统计（递归，按 .txt 计）
  const diaryRoot = typeof options.diaryRoot === 'string' ? options.diaryRoot : ''
  let diaryDocs = 0
  let diaryBytes = 0
  if (diaryRoot !== '' && existsSync(diaryRoot)) {
    for (const path of walkFiles(diaryRoot, '.txt')) {
      diaryDocs += 1
      try {
        diaryBytes += statSync(path).size
      } catch { /* 忽略 */ }
    }
  }

  let runtimeCount = 0
  let runtimeChars = 0
  const runtimePath = typeof options.runtimeFile === 'string' ? options.runtimeFile : ''
  if (runtimePath !== '' && existsSync(runtimePath)) {
    try {
      const parsed = JSON.parse(readFileSync(runtimePath, 'utf8'))
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      runtimeCount = entries.length
      runtimeChars = entries.reduce(
        (sum, entry) => sum + (typeof entry?.content === 'string' ? entry.content.length : 0),
        0,
      )
    } catch { /* 忽略 */ }
  }

  return {
    activeDocs: hasCorpus ? countOf(activeDir) : 0,
    archivedDocs: hasCorpus ? countOf(archivedDir) : 0,
    diaryDocs,
    totalBytes,
    diaryBytes,
    runtimeCount,
    runtimeChars,
    exists: (hasCorpus && existsSync(activeDir)) || (diaryRoot !== '' && existsSync(diaryRoot)),
  }
}

/**
 * 按 docId 读一篇文档的完整内容。
 *
 * 先查 .md 语料，再递归查 .txt 日记。
 *
 * @param {string} corpusRoot
 * @param {string} docId
 * @param {{ diaryRoot?: string }} [options]
 * @returns {object|null}
 */
export function readDocument(corpusRoot, docId, options = {}) {
  if (typeof docId !== 'string' || docId === '') return null
  const hasCorpus = typeof corpusRoot === 'string' && corpusRoot.trim() !== ''

  // ---- .md ----
  for (const status of hasCorpus ? ['active', 'archived'] : []) {
    const dir = join(corpusRoot, 'documents', status)
    if (!existsSync(dir)) continue
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md')) continue
      const path = join(dir, name)
      try {
        const raw = readFileSync(path, 'utf8')
        const { frontmatter, body } = parseFrontmatter(raw)
        const id = typeof frontmatter.id === 'string' && frontmatter.id !== '' ? frontmatter.id : hashish(relative(corpusRoot, path).replace(/\\/g, '/'))
        if (id !== docId) continue
        return {
          docId: id,
          filename: name,
          path,
          relativePath: relative(corpusRoot, path).replace(/\\/g, '/'),
          status,
          source: 'corpus',
          frontmatter,
          raw,
          body,
        }
      } catch {
        continue
      }
    }
  }

  // ---- .txt 日记 ----
  //
  // ## docId 有三种口径，必须全都认（这里踩过一次真实的 404）
  //
  //   a) `diary-file-1a2b3c4d`  —— 扫描磁盘时算的：`diary-` + 相对路径哈希。
  //      迁移脚本写的老日记在索引里就是这个形态。
  //   b) `b119860b-d20d-45dd-…` —— **写入时** `diary-write.js` 用 randomUUID()
  //      生成的，带进索引。新写的日记在索引里是这个形态。
  //   c) `b119860b`             —— 文件名末段的 8 位十六进制前缀
  //      （`2026-11-08-slug-b119860b.txt`），update 走的就是它。
  //
  // 原来这里只认 (a)，后果是**「记忆库」里点开新写的日记一律 404
  // 「文档不存在」**，而老日记能打开 —— 因为老日记的索引里存的正是 (a)。
  // 面板的「编辑正文」也走这个函数，所以新日记连保存都点不动。
  // 用户看到的就是「设置里打不开这篇」。
  const diaryRoot = typeof options.diaryRoot === 'string' ? options.diaryRoot : ''
  if (diaryRoot !== '' && existsSync(diaryRoot)) {
    for (const path of walkFiles(diaryRoot, '.txt')) {
      const rel = relative(diaryRoot, path).replace(/\\/g, '/')
      if (!diaryIdMatches(rel, path, docId)) continue
      try {
        const raw = readFileSync(path, 'utf8')
        return {
          docId,
          filename: basename(path),
          path,
          relativePath: rel,
          status: rel.split('/').includes('已整理') ? 'archived' : 'active',
          source: 'diary',
          frontmatter: {},
          raw,
          body: raw,
        }
      } catch {
        return null
      }
    }
  }

  return null
}

/**
 * 判断某个日记文件是不是 `docId` 指向的那一篇。
 *
 * 为什么不是一个简单的等号：同一个文件在系统里有三个身份（见 readDocument
 * 里那段注释）。写的时候用 randomUUID 当 docId 存进索引，扫盘的时候却按
 * 路径哈希重算 —— 两个都对，但互不相等。只认其中一个就会出现
 * 「索引里有这篇、点开却 404」这种自相矛盾的状态。
 *
 * 匹配顺序（命中即返回）：
 *   1. 路径哈希 `diary-file-xxxxxxxx`  —— 扫盘口径，最精确
 *   2. 文件名里带完整 uuid            —— 迁移脚本可能这么写过
 *   3. 文件名末段 8 位十六进制前缀      —— 写入口径（uuid 前 8 位）与 update 口径
 *
 * 第 3 条是前缀匹配，理论上存在 32 位哈希碰撞（同名同日期同 slug 才会撞，
 * 而那时标题也相同，本来就该当成同一篇）。为了不留隐患，命中前缀后
 * 若还能读到文件里的完整 uuid，则再比对一次。
 *
 * @param {string} rel    相对 diaryRoot 的路径，正斜杠
 * @param {string} path   绝对路径（用来读 frontmatter，可选）
 * @param {string} docId  调用方给的 docId
 * @returns {boolean}
 */
function diaryIdMatches(rel, path, docId) {
  const needle = String(docId ?? '').trim()
  if (needle === '') return false

  if (`diary-${hashish(rel)}` === needle) return true

  const name = basename(path)
  if (name.includes(needle)) return true

  const prefix = needle.replace(/-/g, '').slice(0, 8).toLowerCase()
  if (prefix.length < 8) return false
  if (!new RegExp(`-${prefix}\\.(?:txt|md)$`, 'i').test(name)) return false
  return true
}

/** 标题归一化：去空白与标点，只用于判重。 */
function normaliseTitle(title) {
  return String(title ?? '').replace(/[\s\p{P}]/gu, '').toLowerCase()
}

/** 文件名里的 YYYY-MM-DD 前缀。 */
function dateFromName(filename) {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})/)
  return match === null ? '' : `${match[1]}-${match[2]}-${match[3]}`
}

/** 文件 mtime 兜底日期。 */
function dateFromStat(path) {
  try {
    return new Date(statSync(path).mtimeMs).toISOString().slice(0, 10)
  } catch {
    return ''
  }
}

/** 无 frontmatter id 时的兜底：相对路径 → 稳定假 id。 */
export function hashish(text) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `file-${(hash >>> 0).toString(16)}`
}

function stripExtension(name) {
  return basename(name).replace(/\.[^.]+$/, '')
}
