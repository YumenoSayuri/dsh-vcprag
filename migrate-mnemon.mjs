/**
 * 把旧 mnemon 的 .md 记忆迁移成 dsh-vcprag 的 .txt 日记格式。
 *
 * 两种格式的真实差异：
 *   mnemon  .md  带 YAML frontmatter（id/title/description/created_at/source_paths…）
 *   vcprag  .txt 纯文本：`[HH:MM]` 开头 + 叙事正文 + 末行 `Tag: ...`
 *
 * 迁移不是「改个后缀」，是把元数据下沉进正文：
 *   frontmatter.title       → 正文里的 `# 标题`（同时进文件名）
 *   frontmatter.description → 正文开头的一句话摘要（高权重检索字段）
 *   frontmatter.created_at  → 文件名的 YYYY-MM-DD 前缀 + 正文的 [HH:MM]
 *   正文里的既有 Tag 行      → 保留，缺失则从 title 派生
 *
 * 用法：
 *   node migrate-mnemon.mjs <源目录> <目标目录>
 * 源目录默认 dsh-mnemon-memory，目标目录默认 dsh-vcprag-diaries。
 *
 * 幂等：目标文件已存在则跳过，不会覆盖手改过的内容。
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const SOURCE = resolve(
  process.argv[2] ?? join(HERE, '..', 'dsh-mnemon-memory', 'documents', 'active'),
)
const TARGET = resolve(process.argv[3] ?? join(HERE, '..', 'dsh-vcprag-diaries'))

/** 解析 YAML frontmatter（只处理记忆文档实际用的子集）。 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match === null) return { frontmatter: {}, body: raw }

  const frontmatter = {}
  let currentKey = null
  let currentList = null

  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '') continue

    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem !== null && currentKey !== null && currentList !== null) {
      currentList.push(unquote(listItem[1]))
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (kv === null) continue

    currentKey = kv[1]
    const value = kv[2].trim()
    if (value === '' || value === '[]') {
      currentList = []
      frontmatter[currentKey] = currentList
      continue
    }
    currentList = null
    frontmatter[currentKey] = unquote(value)
  }
  return { frontmatter, body: raw.slice(match[0].length) }
}

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 从 title / description 派生 Tag。
 *
 * 目标不是「穷举所有词」，而是给出 4~8 枚高特异性锚：
 * 专名、项目名、技术点优先，泛化词殿后（与日记规范的河道顺序一致）。
 */
function deriveTags(title, description, existing) {
  if (existing.length > 0) return existing

  const stop = new Set([
    '的', '了', '与', '和', '在', '是', '对', '为', '从', '到', '等', '及', '或',
    '记录', '说明', '结论', '情况', '整理', '处理', '问题', '相关', '以及', '一个',
    '本次', '当前', '实际', '具体', '可能', '需要', '已经', '没有', '可以', '如何',
  ])

  /**
   * 从一段文字里挑候选短语。
   *
   * 关键：不能按 `-` 切分。`sing-box`、`cf-probe`、`new-api` 这类连字符词
   * 一旦拆开就变成无意义的碎片（sing / box / cf / probe），
   * 而它们恰恰是最该被保留的高特异性锚。
   */
  const candidates = (text) => {
    const out = []
    // 括号里的通常是补充说明，跳过
    const cleaned = text.replace(/[（(][^）)]*[）)]/g, ' ')
    // 只按中文标点与空白切，保留 ASCII 连字符词
    for (const piece of cleaned.split(/[，,、。；;：:\s/|·—→+]+/)) {
      let token = piece.trim().replace(/^[-_]+|[-_]+$/g, '')
      if (token.length < 2 || token.length > 24) continue
      // 纯 ASCII 且长度 < 3 的碎片没有检索价值（box / cf / exe）
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(token) && token.length < 3) continue
      if (/^[A-Za-z]-/.test(token) || /-[A-Za-z]$/.test(token)) continue
      if (stop.has(token)) continue
      if (/^[0-9.\-]+$/.test(token)) continue
      out.push(token)
    }
    return out
  }

  const picked = []
  const push = (tag) => {
    if (picked.length >= 8) return
    if (picked.includes(tag)) return
    picked.push(tag)
  }

  // title 是密度最高的来源，先取
  for (const token of candidates(title)) push(token)
  // 不足 4 枚时从 description 补
  if (picked.length < 4) {
    for (const token of candidates(description)) push(token)
  }

  return picked
}

/** 标题 → 文件名片段。 */
function slugify(title, maxLength) {
  const ascii = title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const text = ascii === '' ? 'note' : ascii
  return text.slice(0, maxLength) || 'note'
}

/** 短稳定 hash，避免同名冲突。 */
function shortHash(text) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}

/** frontmatter 里的数组/字符串统一成字符串数组。 */
function toStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

/** 从正文末端找已有的 Tag 行。 */
function existingTagLine(body) {
  const lines = body.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/^tags?\s*[:：]\s*(.+)$/i)
    if (match === null) {
      if (i < lines.length - 4) break
      continue
    }
    return match[1]
      .split(/[,，、;；|]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }
  return []
}

/** 去掉正文里重复的 H1（标题已单独写入）与末尾旧 Tag 行。 */
function cleanBody(body) {
  const lines = body.split(/\r?\n/)
  // 跳过开头的空行与第一个 H1
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (start < lines.length && /^#\s+/.test(lines[start].trim())) start += 1
  while (start < lines.length && lines[start].trim() === '') start += 1

  const kept = lines.slice(start)
  // 末尾连续的 Tag 行剥掉（下面会统一重写）
  let end = kept.length
  while (end > 0 && kept[end - 1].trim() === '') end -= 1
  if (end > 0 && /^tags?\s*[:：]/i.test(kept[end - 1].trim())) end -= 1

  return kept.slice(0, end).join('\n').trim()
}

// ------------------------------------------------------------------ main

if (!existsSync(SOURCE)) {
  console.error(`源目录不存在：${SOURCE}`)
  process.exit(1)
}
mkdirSync(TARGET, { recursive: true })

const files = readdirSync(SOURCE).filter((name) => name.toLowerCase().endsWith('.md'))
console.log(`源：${SOURCE}`)
console.log(`目标：${TARGET}`)
console.log(`待迁移 ${files.length} 篇\n`)

const stats = { converted: 0, skipped: 0, failed: 0, warnings: [] }
const manifest = []

for (const filename of files) {
  try {
    const raw = readFileSync(join(SOURCE, filename), 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)

    // 有的 description 被写坏了（残留 <parameter name="sourcePaths">[...]），清掉
    let description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
    if (description.includes('<parameter')) {
      description = description.replace(/<parameter[\s\S]*$/i, '').trim()
      stats.warnings.push(`${filename}：description 含残留 XML，已清理`)
    }

    const title = typeof frontmatter.title === 'string' && frontmatter.title !== ''
      ? frontmatter.title
      : filename.replace(/\.[^.]+$/, '')

    const createdAt = typeof frontmatter.created_at === 'string' ? frontmatter.created_at : ''
    const date = /^\d{4}-\d{2}-\d{2}/.test(createdAt)
      ? createdAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    // [HH:MM] 取 created_at 的本地时间（不用 UTC，避免时间锚点看起来错位）
    let time = '00:00'
    if (createdAt !== '' && !Number.isNaN(Date.parse(createdAt))) {
      const parsed = new Date(createdAt)
      time = `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
    }

    const tags = deriveTags(title, description, existingTagLine(body))
    const cleanedBody = cleanBody(body)
    if (cleanedBody === '') {
      stats.failed += 1
      stats.warnings.push(`${filename}：正文为空，跳过`)
      continue
    }

    const outName = `${date}-${slugify(title, 40)}-${shortHash(filename + title)}.txt`
    const outPath = join(TARGET, outName)
    if (existsSync(outPath)) {
      stats.skipped += 1
      manifest.push({ from: filename, to: outName, status: 'skipped' })
      continue
    }

    // 组装：时间锚 → 标题 → 摘要 → 原始正文 → 溯源 → Tag
    //
    // 溯源必须放在 Tag **之前**，且只列前几条：
    // 有的记忆 source_paths 有 40+ 条，全列会把 Tag 行淹掉，
    // 无论解析器怎么放宽行数预算都不可靠。
    const parts = [
      `[${time}] ${title}`,
      '',
    ]
    if (description !== '') parts.push(`> ${description}`, '')
    parts.push(cleanedBody, '')

    const sourceId = typeof frontmatter.id === 'string' ? frontmatter.id : ''
    const sourcePaths = toStringArray(frontmatter.source_paths)
    if (sourceId !== '' || sourcePaths.length > 0) {
      parts.push('---')
      if (sourceId !== '') parts.push(`迁移自 mnemon：${sourceId}`)
      const shown = sourcePaths.slice(0, 3)
      for (const path of shown) parts.push(`原始来源：${path}`)
      if (sourcePaths.length > shown.length) {
        parts.push(`原始来源：另有 ${sourcePaths.length - shown.length} 条（见 _migration-report.json）`)
      }
      parts.push('')
    }

    parts.push(`Tag: ${tags.join(', ')}`)

    writeFileSync(outPath, `${parts.join('\n')}\n`, 'utf8')
    stats.converted += 1
    manifest.push({ from: filename, to: outName, status: 'converted', tags: tags.length })
  } catch (error) {
    stats.failed += 1
    stats.warnings.push(`${filename}：${error?.message ?? error}`)
  }
}

writeFileSync(
  join(TARGET, '_migration-report.json'),
  JSON.stringify({ migratedAt: new Date().toISOString(), source: SOURCE, target: TARGET, stats, manifest }, null, 2),
  'utf8',
)

console.log(`✓ 迁移 ${stats.converted} 篇`)
console.log(`- 跳过（已存在）${stats.skipped} 篇`)
console.log(`- 失败 ${stats.failed} 篇`)
if (stats.warnings.length > 0) {
  console.log('\n注意：')
  for (const warning of stats.warnings) console.log(`  · ${warning}`)
}
console.log(`\n报告：${join(TARGET, '_migration-report.json')}`)
