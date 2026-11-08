/**
 * 日记落盘 + 索引的**唯一实现**。tool 通道与语义块通道都调这里。
 *
 * 为什么必须共用：两条写入通道只要各写一份，就必然漂移 ——
 * 一条加了 Tag 校验、另一条没加；一条用了原子写、另一条直接 writeFile；
 * 一条把 contentHash 传给索引、另一条忘了传。用户看到的是「有时能召回，
 * 有时不能」，而日志里两个通道都显示成功。
 *
 * 所以所有写入语义（文件名规则、frontmatter、原子写、增量向量化）
 * 都收拢在本模块，上层只负责「拿到参数」。
 *
 * @module dsh-vcprag/diary-write
 */

import {
  writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, renameSync, statSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

import { diaryWriteDir, buildDiaryRelativePath } from './config.js'
import { parseTagLine, parseTimePrefix } from './diary-template.js'

/**
 * @typedef {object} WriteResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {string} [docId]
 * @property {string} [filename]
 * @property {string} [relativePath]
 * @property {string[]} [warnings]
 * @property {object} [index]  增量索引结果
 * @property {boolean} [duplicate] 命中同标题旧篇时置 true
 */

/**
 * 写一篇新日记。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {import('./indexer.js').Indexer} params.indexer
 * @param {string} params.content
 * @param {string} [params.title]
 * @param {string} [params.description]
 * @param {string[]} [params.tags]
 * @param {string} [params.folder]
 * @param {string} [params.dateOverride]  形如 2026-11-06
 * @param {boolean} [params.skipDuplicate] 跳过同标题查重
 * @returns {Promise<WriteResult>}
 */
export async function writeDiaryDoc(params) {
  const { config, indexer, content } = params
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, error: '正文不能为空。' }
  }

  const text = content.replace(/\s+$/, '')
  const warnings = collectWarnings(config, text)
  const bodyTags = parseTagLine(text)

  const tags = Array.isArray(params.tags) && params.tags.length > 0
    ? params.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
    : bodyTags

  const title = resolveTitle(params.title, text)
  const description = typeof params.description === 'string' && params.description.trim() !== ''
    ? params.description.trim()
    : text.replace(/\s+/g, ' ').slice(0, 120)

  // 同标题查重：模型经常把同一件事写两遍（尤其语义块 + 工具各来一次）。
  // 命中时不覆盖旧篇，而是明确告知，让上层决定怎么办 —— 静默覆盖会丢历史。
  if (params.skipDuplicate !== true) {
    const existing = findSameTitle(config, title)
    if (existing !== null) {
      return {
        ok: false,
        duplicate: true,
        docId: existing.docId,
        filename: existing.filename,
        relativePath: existing.relativePath,
        error: `已存在同标题日记「${title}」（${existing.relativePath}）。`
          + '若要补充内容，请用 command: update 定位替换；确实是新事件请换个标题。',
      }
    }
  }

  const now = new Date()
  const iso = normaliseIso(params.dateOverride, now)
  const docId = randomUUID()

  const written = writeFile({
    config,
    docId,
    title,
    description,
    content: text,
    tags,
    folder: params.folder,
    iso,
  })
  if (written.ok !== true) return { ok: false, error: written.error }

  const contentHash = sha256(text)
  let index = null
  try {
    index = await indexer.addDocument({
      docId,
      filename: written.filename,
      relativePath: written.relativePath,
      title,
      description,
      text,
      date: iso.slice(0, 10),
      tags,
      status: 'active',
      source: 'diary',
      contentHash,
    })
  } catch (error) {
    warnings.push(`文件已写入，但增量索引失败：${error?.message ?? error}`)
  }

  return {
    ok: true,
    docId,
    filename: written.filename,
    relativePath: written.relativePath,
    tags,
    warnings,
    index,
  }
}

/**
 * 在已有日记里做**内容定位替换**。
 *
 * 语义：找到 target 出现的位置，用 replace 顶掉它，其余字节全部保留。
 * 这不是「重写整篇」—— 模型只声明它要改哪一段，其他内容由系统保证不变。
 *
 * 定位策略（按顺序，命中即停）：
 *   1. 规范化空白后精确匹配（容忍行尾空格、缩进差异）
 *   2. 去空白后精确匹配（容忍换行被吃掉）
 *
 * 两者都不命中就报错并**不改文件**。宁可失败也不猜 —— 猜错会静默破坏
 * 用户的记忆，这比一次失败的更新严重得多。
 *
 * @param {object} params
 * @param {object} params.config
 * @param {import('./indexer.js').Indexer} params.indexer
 * @param {string} params.target
 * @param {string} params.replace
 * @param {string} [params.folder]  限定搜索的子目录
 * @param {string} [params.docId]   已知 docId 时直接定位（最快路径）
 * @param {number} [params.minTarget]
 * @returns {Promise<WriteResult & { replacedIn?: string }>}
 */
export async function replaceInDiaryDoc(params) {
  const { config, indexer, target } = params
  const replace = typeof params.replace === 'string' ? params.replace : ''
  const minTarget = Number.isFinite(params.minTarget) ? params.minTarget : 15

  if (typeof target !== 'string' || target === '') {
    return { ok: false, error: '缺少 target（要定位的旧内容）。' }
  }
  if (target.length < minTarget) {
    return {
      ok: false,
      error: `target 太短（${target.length} < ${minTarget} 字）。太短的锚点会匹配到多处，替换就变成了随机破坏。`
        + '请给一段更长、更独特的原文。',
    }
  }

  const candidates = params.docId
    ? filesOfDocId(config, params.docId)
    : listDiaryFiles(config, params.folder)
  if (candidates.length === 0) {
    return { ok: false, error: params.docId !== undefined
      ? `找不到 docId 对应的日记文件：${params.docId}`
      : '日记目录里没有可更新的文件。' }
  }

  for (const file of candidates) {
    let raw
    try {
      raw = readFileSync(file.path, 'utf8')
    } catch {
      continue
    }
    const located = locate(raw, target)
    if (located === null) continue

    const next = raw.slice(0, located.start) + replace + raw.slice(located.end)
    if (next === raw) {
      return { ok: true, docId: file.docId, filename: file.filename, relativePath: file.relativePath,
        replacedIn: file.relativePath, warnings: ['替换前后内容一致，文件未变。'] }
    }

    const written = writeFileAt(file.path, next)
    if (written.ok !== true) return { ok: false, error: written.error }

    const warnings = []
    let index = null
    try {
      index = await indexer.addDocument({
        docId: file.docId,
        filename: file.filename,
        relativePath: file.relativePath,
        title: resolveTitle(undefined, next),
        description: next.replace(/\s+/g, ' ').slice(0, 120),
        text: next,
        date: file.date,
        tags: parseTagLine(next),
        status: 'active',
        source: 'diary',
        contentHash: sha256(next),
      })
    } catch (error) {
      warnings.push(`文件已更新，但增量索引失败：${error?.message ?? error}`)
    }

    return {
      ok: true,
      docId: file.docId,
      filename: file.filename,
      relativePath: file.relativePath,
      replacedIn: file.relativePath,
      warnings,
      index,
    }
  }

  return {
    ok: false,
    error: `在所有日记里都找不到 target 指定的原文（前 60 字：${target.slice(0, 60)}…）。`
      + '请先用 vcprag_search 或 vcprag_read 确认原文，保证 target 与原文逐字一致（含标点）。',
  }
}

// ---------------------------------------------------------------- 内部

/**
 * 在原文里定位 target。
 *
 * @returns {{ start: number, end: number } | null}
 */
function locate(raw, target) {
  // 1) 原文直出
  const direct = raw.indexOf(target)
  if (direct >= 0) return { start: direct, end: direct + target.length }

  // 2) 逐行比对：容忍行尾空白与 CRLF
  const normalised = normaliseWhitespace(raw)
  const normalisedTarget = normaliseWhitespace(target)
  const at = normalised.indexOf(normalisedTarget)
  if (at >= 0) {
    // 规范化后的下标不能直接用于原串切片，改为按「紧凑形式」再定位一次
    const compact = compactText(raw)
    const compactAt = compact.indexOf(compactText(target))
    if (compactAt >= 0) {
      const mapped = mapCompactRange(raw, compactAt, compactText(target).length)
      if (mapped !== null) return mapped
    }
  }

  // 3) 去空白匹配
  const source = compactText(raw)
  const needle = compactText(target)
  if (needle === '') return null
  const hit = source.indexOf(needle)
  if (hit < 0) return null
  return mapCompactRange(raw, hit, needle.length)
}

/** CRLF → LF，行尾空白去掉。用于宽松匹配。 */
function normaliseWhitespace(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
}

/** 只保留非空白字符，用于「换行被吃掉」这类差异。 */
function compactText(text) {
  return text.replace(/\s+/g, '')
}

/**
 * 把「去掉空白后的下标区间」映射回原文下标区间。
 *
 * 逐字符扫描原串，跳过空白字符，用计数器对齐。这样即使 target 与原文的
 * 换行/缩进不同，也能得到准确的原文起止位置，替换时不破坏周边格式。
 *
 * @returns {{ start: number, end: number } | null}
 */
function mapCompactRange(raw, compactStart, compactLength) {
  let seen = 0
  let start = -1
  let end = -1
  for (let i = 0; i < raw.length; i += 1) {
    if (/\s/.test(raw[i])) continue
    if (seen === compactStart && start < 0) start = i
    seen += 1
    if (start >= 0 && seen === compactStart + compactLength) {
      end = i + 1
      break
    }
  }
  if (start < 0 || end < 0) return null
  return { start, end }
}

/** 结构校验的 warning 列表（不阻断写入）。 */
function collectWarnings(config, text) {
  const warnings = []
  if (config.diary.timePrefix === true && parseTimePrefix(text) === '') {
    warnings.push('正文没有以 [HH:MM] 开头，未来检索失去时间锚点。')
  }
  if (config.diary.requireTag === true && parseTagLine(text).length === 0) {
    warnings.push('正文末行没有 `Tag: ...`，语义桥梁缺失，召回质量会下降。')
  }
  return warnings
}

/**
 * 找同标题的已有日记。
 *
 * 比对的是「标题」，不是全文 —— 模型换个措辞重写同一件事时，标题通常
 * 高度相似，这是最便宜的拦截点。命中后返回旧篇信息供上层提示。
 *
 * @returns {{ docId: string, filename: string, relativePath: string } | null}
 */
export function findSameTitle(config, title) {
  const needle = normaliseTitle(title)
  if (needle === '') return null
  for (const file of listDiaryFiles(config, undefined)) {
    let raw
    try {
      raw = readFileSync(file.path, 'utf8')
    } catch {
      continue
    }
    const candidate = normaliseTitle(resolveTitle(undefined, raw))
    if (candidate !== '' && candidate === needle) {
      return { docId: file.docId, filename: file.filename, relativePath: file.relativePath }
    }
  }
  return null
}

/** 标题归一：去空白与标点、小写。跨「中英混排 + 全半角」也能对上。 */
export function normaliseTitle(title) {
  return String(title ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/**
 * 枚举日记目录下的全部 .txt/.md。
 *
 * 文件名里带 8 位 docId 后缀（`2026-11-06-slug-1a2b3c4d.txt`），
 * 从文件名反推 docId 比读 frontmatter 快得多，且对 txt 格式也成立。
 */
export function listDiaryFiles(config, folder) {
  const root = typeof folder === 'string' && folder.trim() !== ''
    ? diaryWriteDir(config, folder)
    : config.diaryRoot
  if (typeof root !== 'string' || root === '' || !existsSync(root)) return []

  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // 「已整理」是归档区，不参与更新搜索
        if (entry.name === '已整理') continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(txt|md)$/i.test(entry.name)) continue
      const docId = docIdFromFilename(entry.name)
      out.push({
        docId,
        filename: entry.name,
        path: full,
        relativePath: buildDiaryRelativePath(config, full),
        date: entry.name.slice(0, 10),
        modified: statTime(full),
      })
    }
  }
  walk(root, 0)
  // 最近的优先
  out.sort((left, right) => right.modified - left.modified)
  return out
}

/** 按 docId 精确定位文件。 */
function filesOfDocId(config, docId) {
  const needle = String(docId).trim()
  if (needle === '') return []
  return listDiaryFiles(config, undefined).filter((file) => file.docId === needle)
}

/** 文件名末段的 8 位十六进制即 docId 前缀。 */
function docIdFromFilename(name) {
  const match = name.match(/-([0-9a-f]{8})\.(?:txt|md)$/i)
  return match === null ? '' : match[1]
}

/** 文件 mtime（毫秒）。用于「最近的日记优先」排序。 */
function statTime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 写入文件：原子替换。 */
function writeFileAt(path, raw) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, raw, 'utf8')
    renameSync(temporary, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `写入失败：${error?.message ?? error}` }
  }
}

/**
 * 按配置写一篇日记文件。
 *
 * 两种格式：
 *   txt（默认）纯文本，文件名 `<日期>-<slug>-<hash>.txt`
 *   md        带 YAML frontmatter，兼容旧语料工具链
 *
 * @returns {{ ok: true, filename: string, relativePath: string } | { ok: false, error: string }}
 */
function writeFile({ config, docId, title, description, content, tags, folder, iso }) {
  const dir = diaryWriteDir(config, folder)
  const datePart = iso.slice(0, 10)
  const slug = slugify(title, 40)
  const suffix = docId.slice(0, 8)
  const useMarkdown = config.diary.format === 'md'
  const filename = `${datePart}-${slug}-${suffix}.${useMarkdown ? 'md' : 'txt'}`

  let raw
  if (useMarkdown) {
    const frontmatter = [
      '---',
      `id: "${docId}"`,
      `title: ${JSON.stringify(title)}`,
      `description: ${JSON.stringify(description)}`,
      'status: "active"',
      `created_at: "${iso}"`,
      `updated_at: "${iso}"`,
      `content_hash: "${sha256(content)}"`,
      'source_paths: []',
      'session_ids: []',
      'memory_body_ids: []',
      '---',
      '',
    ].join('\n')
    const body = tags.length > 0 && parseTagLine(content).length === 0
      ? `${content}\n\nTag: ${tags.join(', ')}\n`
      : `${content}\n`
    raw = `${frontmatter}${body}`
  } else {
    raw = content.endsWith('\n') ? content : `${content}\n`
  }

  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, raw, 'utf8')
    renameSync(temporary, path)
    return {
      ok: true,
      filename,
      relativePath: buildDiaryRelativePath(config, path),
    }
  } catch (error) {
    return { ok: false, error: `写入失败：${error?.message ?? error}` }
  }
}

/** 标题推断：显式 title → 正文首个非时间戳行 → 正文前 24 字。 */
export function resolveTitle(explicit, content) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim().slice(0, 120)
  const lines = String(content).split(/\r?\n/)
  for (const line of lines) {
    const cleaned = line.replace(/^#+\s*/, '').replace(/^>\s*/, '').trim()
    if (cleaned === '') continue
    if (/^\[\d{1,2}:\d{2}\]/.test(cleaned)) continue
    if (/^tags?\s*[:：]/i.test(cleaned)) continue
    if (/^(command|title|folder|tags|target|replace|content)\s*[:：]/i.test(cleaned)) continue
    return cleaned.slice(0, 120)
  }
  return String(content).replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名日记'
}

/** 标题 → 文件名 slug（ASCII 保留，其余转 -）。 */
export function slugify(title, maxLength) {
  const ascii = String(title)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const text = ascii === '' ? 'note' : ascii
  return text.slice(0, maxLength) || 'note'
}

/** 把外部传入的日期（YYYY-MM-DD）套到当前时间上，非法则用 now。 */
function normaliseIso(dateOverride, now) {
  if (typeof dateOverride === 'string') {
    const match = dateOverride.trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/)
    if (match !== null) {
      const iso = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        now.getHours(), now.getMinutes(), now.getSeconds())
      if (!Number.isNaN(iso.getTime())) return iso.toISOString()
    }
  }
  return now.toISOString()
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
