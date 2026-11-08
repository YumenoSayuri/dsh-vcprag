/**
 * 文档切分。
 *
 * 关键约束：必须剥掉 YAML frontmatter，否则约 400 字/篇的元数据会污染向量，
 * 让所有文档看起来「都在讲同一个东西」（都有 id/title/description 这些词）。
 *
 * @module dsh-vcprag/chunker
 */

/** frontmatter 探测：文件开头 `---\n...\n---\n`。 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * 解析 YAML frontmatter（只支持记忆文档实际用到的子集）。
 *
 * 不引 js-yaml：frontmatter 只有
 *   `key: "string"` / `key: value` / `key:\n  - item` / `key: []`
 * 四种形态，40 行足够，且避免多一个依赖。
 *
 * @param {string} raw - 完整文件内容。
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(raw) {
  const match = raw.match(FRONTMATTER)
  if (match === null) return { frontmatter: {}, body: raw }

  const text = match[1]
  const body = raw.slice(match[0].length)
  /** @type {Record<string, unknown>} */
  const frontmatter = {}

  const lines = text.split(/\r?\n/)
  let currentKey = null
  let currentList = null

  for (const line of lines) {
    if (line.trim() === '') continue

    // 列表项：`  - "value"` 或 `  - value`
    const listItem = line.match(/^\s*-\s+(.*)$/)
    if (listItem !== null && currentKey !== null && currentList !== null) {
      currentList.push(unquote(listItem[1]))
      continue
    }

    // 键值行：`key: value`
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (kv === null) continue

    currentKey = kv[1]
    const rawValue = kv[2].trim()

    if (rawValue === '' || rawValue === '[]') {
      // 空值可能是空列表或列表开头
      currentList = []
      frontmatter[currentKey] = currentList
      continue
    }

    currentList = null
    frontmatter[currentKey] = unquote(rawValue)
  }

  return { frontmatter, body }
}

/** 去掉包裹引号。 */
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
 * 把一篇文档切成 chunk。
 *
 * 只在段落边界切（优先后退到最近的换行），避免把一句话劈成两半导致
 * 两半都检索不到。重叠 120 字符是为了让跨边界的概念仍能被单 chunk 命中。
 *
 * @param {{ docId: string, text: string, title?: string, description?: string, date?: string, tags?: string[], filename?: string }} doc
 * @param {{ size?: number, overlap?: number }} [options]
 * @returns {{ chunkId: string, docId: string, index: number, text: string, date: string, title: string, tags: string[], filename: string }[]}
 */
export function chunkDocument(doc, options = {}) {
  const size = options.size ?? 800
  const overlap = Math.min(options.overlap ?? 120, Math.floor(size / 2))

  // 元数据放进每个 chunk，供 BM25 的 Tag 加权与时间衰减使用
  const base = {
    docId: doc.docId,
    date: doc.date ?? '',
    title: doc.title ?? '',
    tags: doc.tags ?? [],
    filename: doc.filename ?? '',
  }

  const text = doc.text

  // 短文档：单 chunk，但把标题/摘要拼进打分文本（见 indexer 的 scoringText）
  if (text.length <= size) {
    return [{
      chunkId: `${doc.docId}#0`,
      index: 0,
      text,
      ...base,
    }]
  }

  /** @type {ReturnType<typeof chunkDocument>} */
  const chunks = []
  let start = 0
  let index = 0

  while (start < text.length) {
    let end = Math.min(start + size, text.length)

    // 不在文末时，尝试回退到最近的换行处（最多回退 200 字符）
    if (end < text.length) {
      const floor = Math.max(start + size - 200, start + 1)
      const newline = text.lastIndexOf('\n', end)
      if (newline > floor) end = newline + 1
    }

    chunks.push({
      chunkId: `${doc.docId}#${index}`,
      index,
      text: text.slice(start, end),
      ...base,
    })

    if (end >= text.length) break
    index += 1

    // 防御：overlap 不得造成死循环
    const nextStart = end - overlap
    start = nextStart > start ? nextStart : end
  }

  return chunks
}

/**
 * 生成参与 BM25 打分的文本。
 *
 * 标题和摘要重复计入（2 次），等效于给它们加权 —— 记忆文档的
 * `description` 通常是高密度摘要，用户提问往往就落在这个粒度上，
 * 值得比正文更高的权重。
 *
 * @param {{ text: string, title?: string, tags?: string[] }} chunk
 * @returns {string}
 */
export function scoringText(chunk) {
  const parts = [chunk.text]
  if (chunk.title) parts.push(chunk.title, chunk.title)
  if (Array.isArray(chunk.tags) && chunk.tags.length > 0) {
    const tagLine = chunk.tags.join(' ')
    parts.push(tagLine)
  }
  return parts.join('\n')
}
