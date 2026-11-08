/**
 * 模型可见的记忆工具。
 *
 * 关于 vcprag_edit：早期刻意不设，理由的「编辑 = read + write 新版本」。
 * 但语义写入通道（正文里写 update 块，按内容锚点替换）上线后，这条不
 * 成立了 —— 既然正文能改一段，工具侧也该能改一段，否则两条通道能力不对等，
 * 模型会按「哪个方便」而不是「哪个正确」去选。所以现在补上 vcprag_edit，
 * 语义与语义块一致：target/replace 内容定位替换，不是整篇覆盖。
 *
 * 写盘与索引逻辑全部在 diary-write.js，本文件只负责 schema 与结果渲染 ——
 * 两个通道各写一份写入实现的话必然漂移。
 *
 * @module dsh-vcprag/tools
 */

import { mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { readDocument, corpusStats } from './corpus.js'
import { recall, renderRecallBlock } from './recall.js'
import { runtimeFilePath } from './config.js'
import { writeDiaryDoc, replaceInDiaryDoc, resolveTitle } from './diary-write.js'

/**
 * 生成工具定义列表。
 *
 * @param {object} deps
 * @param {() => import('./config.js').ResolvedConfig} deps.getConfig
 * @param {import('./indexer.js').Indexer} deps.indexer
 * @param {import('./freeze.js').RecallFridge} deps.fridge
 * @param {(text: string) => void} [deps.refreshRuntimeSection] - 写完 runtime 记忆后通知重渲染 section
 * @returns {object[]}
 */
export function createTools(deps) {
  const { getConfig, indexer, fridge } = deps
  const tools = []

  // ---------------------------------------------------------------- search
  tools.push({
    name: 'vcprag_search',
    description:
      '在本地记忆库中检索历史记录。当需要回忆过去的排障过程、配置细节、'
      + '曾经做过的决定时使用。返回按相关度排序的片段。'
      + '注意：对话中通常已自动注入了相关记忆，只有在自动注入不足时才需要主动调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索语句，用自然语言描述你想找什么。' },
        limit: { type: 'number', description: '返回条数上限，默认按查询复杂度自动决定。' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') return '缺少 query 参数。'

      const config = getConfig()
      const result = await recall(query, {
        bm25: indexer.bm25,
        vectors: indexer.vectors,
        embedder: indexer.embedder,
        chunks: indexer.chunks,
        aliases: config.aliases,
        config,
      })

      if (result.hits.length === 0) {
        return `「${query}」没有命中任何记忆。\n`
          + `（索引状态：${indexer.chunks.size} chunk，混合召回${indexer.hybridReady ? '已启用' : '未启用，仅关键词'}）`
      }

      const limit = Number.isFinite(args.limit)
        ? Math.max(1, Math.min(result.hits.length, Math.floor(args.limit)))
        : result.hits.length

      const block = renderRecallBlock(result.hits.slice(0, limit), {
        reason: 'manual-search',
        maxChars: config.recall.maxChars * 2,
        blockName: config.inject.blockName,
        header: config.inject.header,
        disclaimer: config.inject.disclaimer,
        itemPrefix: config.inject.itemPrefix,
      })
      return `${block}\n\n检索统计：${result.hits.length} 条命中 · 词法 ${result.timing.lexicalMs}ms · 向量 ${result.timing.semanticMs}ms`
    },
  })

  // ------------------------------------------------------------------ read
  tools.push({
    name: 'vcprag_read',
    description: '按 docId 读取一篇记忆文档的完整内容。先 search 拿到 docId，再用本工具读全文。',
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: '文档 id，来自 search 或 list 的结果。' },
      },
      required: ['docId'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const docId = typeof args.docId === 'string' ? args.docId.trim() : ''
      if (docId === '') return '缺少 docId 参数。'
      const config = getConfig()
      const doc = readDocument(config.corpusRoot, docId, { diaryRoot: config.diaryRoot })
      if (doc === null) return `找不到文档：${docId}`

      const head = [
        `docId: ${doc.docId}`,
        `title: ${doc.frontmatter.title ?? doc.filename ?? ''}`,
        `created: ${doc.frontmatter.created_at ?? ''}`,
        `status: ${doc.status}`,
        `source: ${doc.source ?? 'corpus'}`,
        `file: ${doc.relativePath}`,
      ].join('\n')

      // 正文过长时截断，避免一次读爆上下文
      const limit = config.recall.maxChars * 3
      const body = doc.body.length > limit
        ? `${doc.body.slice(0, limit)}\n\n…（正文共 ${doc.body.length} 字，已截断）`
        : doc.body

      return `${head}\n\n---\n\n${body}`
    },
  })

  // ----------------------------------------------------------------- write
  tools.push({
    name: 'vcprag_write',
    description:
      '新增一篇日记 / 记忆，落盘并立即建立索引，下次检索即可命中。'
      + '遵循 system prompt 里的「日记写作规范」：正文以 [HH:MM] 开头，末行 Tag: ...，'
      + '记完整起因-过程-结果，不要记一次性的、可随时重新推导的内容。'
      + '**修改已有日记请用 vcprag_edit**，不要用本工具另写一篇 —— 那会让同一件事分裂成多篇。'
      + '优先考虑在回复正文里写 <<<DailyNoteStart>>> 语义块（更省一轮往返），'
      + '本工具是它不可用时的兜底。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '正文，Markdown。以 [HH:MM] 开头，最后一行是 `Tag: a, b, c`。',
        },
        title: {
          type: 'string',
          description: '一句话概括主题，会参与检索，务必写清楚。省略则从正文首行推断。',
        },
        description: { type: 'string', description: '一句话摘要，会作为高权重字段参与检索。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签列表。省略则自动从正文末行 Tag 解析。',
        },
        folder: {
          type: 'string',
          description: '分类子目录（日记根目录下的文件夹名），省略则用配置里的默认分类。',
        },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const config = getConfig()
      if (config.tools.writeEnabled !== true) return '写入功能已关闭（tools.writeEnabled = false）。'

      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content === '') return 'content 不能为空。'

      // 真正的落盘与索引在 diary-write.js —— 语义块通道走同一份实现，
      // 两条路的能力不会漂移。
      const result = await writeDiaryDoc({
        config,
        indexer,
        content,
        title: args.title,
        description: args.description,
        tags: Array.isArray(args.tags) ? args.tags : [],
        folder: args.folder,
      })

      if (result.ok !== true) {
        return result.duplicate === true
          ? `${result.error}\n\n改用 vcprag_edit（target/replace 定位替换），或换一个标题另开新篇。`
          : `写入失败：${result.error}`
      }

      const lines = [
        `已写入：${result.relativePath}`,
        `docId: ${result.docId}`,
        result.index?.vectorized === true
          ? '索引：已建立（混合召回可命中）'
          : `索引：仅关键词可见${result.index?.error ? `（${result.index.error}）` : result.index === null ? '（增量索引未执行）' : ''}`,
      ]
      if (Array.isArray(result.tags) && result.tags.length > 0) lines.push(`Tag：${result.tags.join(', ')}`)
      for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
      lines.push('', '（另一条更省事的路径：直接在回复正文里写 <<<DailyNoteStart>>> 块，无需一次工具往返。）')
      return lines.join('\n')
    },
  })

  // ------------------------------------------------------------------ edit
  tools.push({
    name: 'vcprag_edit',
    description:
      '修改已有日记里的一段内容：给一段原文（target）和替换后的内容（replace），系统定位后替换。'
      + '**这是改日记的唯一正确方式** —— 不要用 vcprag_write 另写一篇，也不要用 vcprag_forget 删旧的。'
      + 'target 必须与原文逐字一致（含标点），且至少 15 字，否则会匹配到多处而被拒绝。'
      + '传 replace 为空串表示删除该段。'
      + '不确定原文时，先用 vcprag_search 或 vcprag_read 读出来再复制。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '日记中要被替换掉的原文片段，至少 15 字，须与原文逐字一致。',
        },
        replace: {
          type: 'string',
          description: '替换后的新内容。传空串表示删除该段。',
        },
        docId: {
          type: 'string',
          description: '已知 docId 时直接定位该篇（最快路径），省略则全库按 target 搜索。',
        },
        folder: {
          type: 'string',
          description: '限定搜索的分类子目录，省略则全库搜索。',
        },
      },
      required: ['target', 'replace'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const config = getConfig()
      if (config.tools.writeEnabled !== true) return '写入功能已关闭（tools.writeEnabled = false）。'

      const result = await replaceInDiaryDoc({
        config,
        indexer,
        target: typeof args.target === 'string' ? args.target : '',
        replace: typeof args.replace === 'string' ? args.replace : '',
        docId: typeof args.docId === 'string' && args.docId.trim() !== '' ? args.docId.trim() : undefined,
        folder: args.folder,
        minTarget: config.diary.semantic.updateMinTarget,
      })

      if (result.ok !== true) return `更新失败：${result.error}`

      const lines = [
        `已更新：${result.relativePath}`,
        `docId: ${result.docId}`,
        result.index?.vectorized === true
          ? '索引：已同步（新内容可被语义召回）'
          : '索引：已更新关键词索引，向量索引待下次重建',
      ]
      for (const warning of result.warnings ?? []) lines.push(`注意：${warning}`)
      return lines.join('\n')
    },
  })

  // ------------------------------------------------------------------ list
  tools.push({
    name: 'vcprag_list',
    description: '列出记忆库中的文档。用于了解有哪些历史记录，或按关键词过滤标题。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '标题/摘要过滤词，可选。' },
        limit: { type: 'number', description: '返回条数，默认 20。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const config = getConfig()
      const rows = []
      for (const chunk of indexer.chunks.values()) {
        // 每篇文档只取第一个 chunk 作为代表
        if (chunk.index !== 0) continue
        rows.push(chunk)
      }
      rows.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''))

      const filter = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const filtered = filter === ''
        ? rows
        : rows.filter((row) => `${row.title} ${row.filename}`.toLowerCase().includes(filter))

      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 20
      const shown = filtered.slice(0, limit)

      const stats = corpusStats(config.corpusRoot, {
        diaryRoot: config.diaryRoot,
        runtimeFile: runtimeFilePath(config),
      })
      const lines = [
        `共 ${rows.length} 篇文档${filter ? `，匹配「${filter}」的 ${filtered.length} 篇` : ''}`
          + `（日记 ${stats.diaryDocs} 篇）`,
        `runtime 记忆 ${stats.runtimeCount} 条 / ${stats.runtimeChars} 字（常驻注入，不在此列表）`,
        '',
      ]
      for (const row of shown) {
        lines.push(`${row.date || '日期未知'}  ${row.title}`)
        lines.push(`  docId: ${row.docId}`)
      }
      if (filtered.length > shown.length) lines.push(`\n…另有 ${filtered.length - shown.length} 篇未显示`)
      return lines.join('\n')
    },
  })

  // ---------------------------------------------------------------- forget
  tools.push({
    name: 'vcprag_forget',
    description:
      '把一篇记忆归档（不物理删除）。用于记忆内容已过时或有误。'
      + '归档后不再参与检索，但文件仍保留可恢复。日记会移入「已整理」子目录。',
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: '要归档的文档 id。' },
        reason: { type: 'string', description: '归档原因，会记入日志。' },
      },
      required: ['docId'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      const config = getConfig()
      if (config.tools.forgetEnabled !== true) return '归档功能已关闭（tools.forgetEnabled = false）。'

      const docId = typeof args.docId === 'string' ? args.docId.trim() : ''
      if (docId === '') return '缺少 docId 参数。'

      const doc = readDocument(config.corpusRoot, docId, { diaryRoot: config.diaryRoot })
      if (doc === null) return `找不到文档：${docId}`
      if (doc.status === 'archived') return `文档已在归档中：${doc.filename}`

      let movedTo = ''
      try {
        if (doc.source === 'diary') {
          // 日记：移到同级「已整理」目录，保留分类结构
          const targetDir = join(config.diaryRoot, '已整理')
          mkdirSync(targetDir, { recursive: true })
          movedTo = join(targetDir, doc.filename)
          // 同名冲突时加时间戳
          if (existsSync(movedTo)) movedTo = join(targetDir, `${Date.now()}-${doc.filename}`)
        } else {
          const targetDir = join(config.corpusRoot, 'documents', 'archived')
          mkdirSync(targetDir, { recursive: true })
          movedTo = join(targetDir, doc.filename)
        }
        renameSync(doc.path, movedTo)
      } catch (error) {
        return `归档失败：${error?.message ?? error}`
      }

      // 从内存索引移除该文档的所有 chunk
      let removed = 0
      for (const [chunkId, chunk] of indexer.chunks) {
        if (chunk.docId === docId) {
          indexer.chunks.delete(chunkId)
          removed += 1
        }
      }

      const reason = typeof args.reason === 'string' ? args.reason.trim() : '未说明'
      return [
        `已归档：${doc.filename}`,
        `移到：${movedTo}`,
        `移除索引 chunk：${removed}`,
        `原因：${reason}`,
        '',
        '注意：向量索引文件未重建，检索时该文档不会再出现（内存已剔除）。',
      ].join('\n')
    },
  })

  // ---------------------------------------------------------------- status
  tools.push({
    name: 'vcprag_status',
    description: '查看记忆库状态：索引是否就绪、文档数、最近构建时间、是否有配置不兼容告警。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const config = getConfig()
      const summary = indexer.summary()
      const stats = corpusStats(config.corpusRoot, {
        diaryRoot: config.diaryRoot,
        runtimeFile: runtimeFilePath(config),
      })

      // 二级状态：索引里有向量 ≠ 现在能走向量通道。
      // 后者还需要 embedder 已配置（查询时也要 embed）。
      const vectorStatus = summary.hybridReady
        ? '已启用（混合召回）'
        : summary.vectorsIndexed
          ? `索引有向量但查询侧不可用（embedding ${summary.embeddingEnabled ? '未配置密钥' : '已关闭'}）→ 当前仅关键词`
          : '未建立向量索引 → 当前仅关键词'

      const lines = [
        `语料目录：${config.corpusRoot}（${stats.activeDocs} 篇 .md，归档 ${stats.archivedDocs} 篇）`,
        `日记目录：${config.diaryRoot}（${stats.diaryDocs} 篇 .txt）`,
        `runtime 记忆：${stats.runtimeCount} 条 / ${stats.runtimeChars} 字`,
        `索引 chunk：${summary.chunkCount}（已向量化 ${summary.vectorized}）`,
        `向量通道：${vectorStatus}`,
        `embedding：${summary.embedding?.model || config.embedding.model || '未配置'} / ${summary.embedding?.dimensions ?? config.embedding.dimensions} 维`,
        `建立于：${summary.builtAt ?? '尚未建立'}`,
        `BM25：${summary.bm25.docCount} 文档 / ${summary.bm25.vocabularySize} 词表`,
      ]

      if (summary.compatible.ok !== true) {
        lines.push('', `⚠ 索引告警（${summary.compatible.reason}）：`, summary.compatible.message ?? '')
      }
      if (summary.status.state === 'building') {
        lines.push('', `⏳ 正在构建：${summary.status.doneBatches}/${summary.status.totalBatches} 批`)
      }

      const frozen = fridge.snapshot()
      lines.push(
        '',
        `本次会话召回：${frozen.frozen ? `已冻结（${frozen.reason}，${frozen.frozenAt}）` : '尚未冻结'}`,
        `刷新次数：${frozen.refreshCount}`,
      )

      return lines.join('\n')
    },
  })

  return tools
}

// 写盘 / 命名 / frontmatter / 原子写 / slug / 相对路径等实现
// 已全部迁到 lib/diary-write.js —— 语义块通道走同一份代码，
// 两条写入路径不会漂移。
