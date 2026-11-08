/**
 * 索引构建与维度保护。
 *
 * 核心原则：**绝不因索引不兼容而抛错中断对话。**
 * 记忆是增强功能，索引坏了就降级为纯 BM25，主链路必须活着。
 *
 * @module dsh-vcprag/indexer
 */

import { readFile, writeFile, mkdir, rename, copyFile, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

import { loadCorpus } from './corpus.js'
import { runtimeFilePath } from './config.js'
import { chunkDocument, scoringText } from './chunker.js'
import { tokenize, resolveEngine, jiebaLoadError } from './tokenize.js'
import { BM25 } from './bm25.js'
import { VectorStore } from './vector-store.js'
import { Embedder } from './embed.js'

/** manifest 结构版本。改结构就加一，触发重建。 */
const SCHEMA_VERSION = 1

/** 保留的索引备份份数。 */
const BACKUP_KEEP = 3

/**
 * @typedef {object} Manifest
 * @property {number} schemaVersion
 * @property {string} builtAt
 * @property {{ baseUrl: string, model: string, dimensions: number }} embedding
 * @property {number} chunkSize
 * @property {number} chunkOverlap
 * @property {'jieba'|'gram'} [tokenizer]
 * @property {number} docCount
 * @property {number} chunkCount
 * @property {string} corpusHash
 * @property {{ docId: string, filename: string, title: string, createdAt: string, contentHash: string }[]} docs
 */

/**
 * 判断索引与当前配置是否兼容。
 *
 * 这是维度保护的核心闸门，被三处调用：
 *   1. UI 保存配置前（提示用户必须重建）
 *   2. 插件启动时（兜底，防止手改配置文件绕过 UI）
 *   3. 重建索引前（决定是否要备份）
 *
 * @param {Manifest|undefined|null} manifest
 * @param {object} config
 * @returns {{ ok: boolean, fatal?: boolean, reason?: string, message?: string }}
 */
export function assertIndexCompatible(manifest, config) {
  if (manifest === undefined || manifest === null) {
    return { ok: false, fatal: false, reason: 'no-index', message: '尚无索引，将降级为纯关键词召回。' }
  }

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      fatal: false,
      reason: 'schema-changed',
      message: `索引结构版本已变更（${manifest.schemaVersion} → ${SCHEMA_VERSION}），建议重建。`,
    }
  }

  const recorded = manifest.embedding ?? { baseUrl: '', model: '', dimensions: 0 }
  const current = {
    baseUrl: String(config.embedding.baseUrl ?? '').replace(/\/+$/, ''),
    model: String(config.embedding.model ?? ''),
    dimensions: Number(config.embedding.dimensions ?? 0),
  }

  // 维度不同 → 向量根本无法比较，检索结果会是无意义的随机排序
  if (recorded.dimensions !== current.dimensions) {
    return {
      ok: false,
      fatal: true,
      reason: 'dimension-mismatch',
      message:
        `向量维度不匹配：现有索引 ${recorded.dimensions} 维（${recorded.model || '未知模型'}），` +
        `当前配置 ${current.dimensions} 维（${current.model || '未配置'}）。\n` +
        `不同维度的向量无法比较，必须重建索引。`,
    }
  }

  // 模型/端点不同 → 即使维度相同，向量空间也不通用
  if (recorded.model !== current.model || recorded.baseUrl !== current.baseUrl) {
    return {
      ok: false,
      fatal: true,
      reason: 'model-mismatch',
      message:
        `Embedding 模型已变更：${recorded.model || '未知'} → ${current.model || '未配置'}。\n` +
        `即使维度相同，不同模型的向量空间也不通用，必须重建索引。`,
    }
  }

  if (manifest.chunkSize !== config.chunkSize || manifest.chunkOverlap !== config.chunkOverlap) {
    return {
      ok: false,
      fatal: false,
      reason: 'chunk-mismatch',
      message: '分块参数已变更，建议重建索引以获得一致结果。',
    }
  }

  // 分词器变更不影响向量（向量是对原文算的），但**影响 BM25 的词表**。
  // 老 manifest 没有这个字段（undefined）时不做判断，避免升级就报不兼容。
  const recordedTokenizer = manifest.tokenizer
  const currentTokenizer = resolveEngine(config.recall?.tokenizer ?? 'auto')
  if (
    typeof recordedTokenizer === 'string' &&
    recordedTokenizer !== '' &&
    recordedTokenizer !== currentTokenizer
  ) {
    return {
      ok: false,
      fatal: false,
      reason: 'tokenizer-changed',
      message:
        `分词器已变更：${recordedTokenizer} → ${currentTokenizer}。\n` +
        `词表不通用，但向量仍有效，重建索引只会重算 BM25（很快）。`,
    }
  }

  return { ok: true }
}

/**
 * 索引管理器。
 *
 * 持有内存中的 BM25 / 向量库 / chunk 表，负责构建、加载、增量更新。
 */
export class Indexer {
  /**
   * @param {object} options
   * @param {string} options.indexDir - 索引目录（与本插件数据目录同级）。
   * @param {() => object} options.getConfig - 取当前配置（配置可被 UI 热改）。
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor(options) {
    this.indexDir = options.indexDir
    this.getConfig = options.getConfig
    this.log = options.log ?? (() => {})

    /**
     * 占位 BM25：`#rebuildBm25FromChunks` 会用真实配置重新构造。
     * 这里只需要一个「built === false 时安全返回空数组」的实例。
     *
     * 单字权重给 0.15 而不是 1 —— 万一某条路径在重建之前就查询，
     * 至少不会用旧的不良默认值。
     *
     * @type {BM25}
     */
    this.bm25 = new BM25(1.5, 0.75, 0.15)
    /** @type {VectorStore} */
    this.vectors = new VectorStore(options.getConfig().embedding.dimensions)
    /** @type {Map<string, any>} chunkId → chunk */
    this.chunks = new Map()
    /** @type {Manifest|null} */
    this.manifest = null
    /** @type {Embedder|null} */
    this.embedder = null

    /** 构建状态，供 UI 轮询。 */
    this.status = {
      state: 'idle', // idle | building | ready | error | degraded
      progress: 0,
      totalBatches: 0,
      doneBatches: 0,
      message: '',
      error: null,
      startedAt: null,
      finishedAt: null,
    }

    this.building = false
  }

  get paths() {
    return {
      manifest: join(this.indexDir, 'manifest.json'),
      vectors: join(this.indexDir, 'vectors.f32'),
      chunks: join(this.indexDir, 'chunks.json'),
      bm25: join(this.indexDir, 'bm25.json'),
    }
  }

  /**
   * 混合召回是否可用。
   *
   * 注意：这里要求 embedder 已配置，因为**查询时也要 embed** ——
   * 只有索引向量而查询向量生成不了，等于没法用。
   * 但 embedding.enabled=false 时 embedder 为 null，索引即使存在也会
   * 降级为纯关键词，这是符合预期的（用户主动关掉了向量通道）。
   */
  get hybridReady() {
    return this.vectors.ready && this.embedder?.configured === true
  }

  /** 当前实际生效的分词引擎（配置可能 auto → gram）。 */
  get tokenizerActive() {
    return resolveEngine(this.getConfig().recall?.tokenizer ?? 'auto')
  }

  /** jieba 加载失败的原因；成功加载或强制 gram 时为 null。 */
  get tokenizerError() {
    return jiebaLoadError()
  }

  /**
   * 索引层面的向量就绪状态（与 hybridReady 区分开）。
   *
   * UI 需要用这个显示「索引里有多少向量」，而 hybridReady 表示
   * 「现在能不能真的走向量通道」。两个概念不能混。
   */
  get vectorsIndexed() {
    return this.vectors.ready
  }

  /**
   * 启动加载：读 manifest → 校验兼容 → 载向量 / chunk / BM25。
   *
   * 任何一步失败都降级，不抛错。
   *
   * @returns {Promise<{ compatible: object, chunkCount: number, docCount: number }>}
   */
  async load() {
    const config = this.getConfig()
    this.embedder = config.embedding.enabled
      ? new Embedder({ ...config.embedding, apiKey: resolveApiKey(config.embedding) })
      : null

    // 1) manifest
    try {
      this.manifest = JSON.parse(await readFile(this.paths.manifest, 'utf8'))
    } catch {
      this.manifest = null
    }

    const compatible = assertIndexCompatible(this.manifest, config)

    if (compatible.ok !== true) {
      this.log('warn', `索引不可用：${compatible.reason} — ${compatible.message}`)
      this.status.state = this.manifest === null ? 'idle' : 'degraded'
      this.status.message = compatible.message ?? ''
      // 即使不兼容也把 chunk 表读进来 —— BM25 还能用
      await this.#loadChunks()
      this.#rebuildBm25FromChunks()
      return { compatible, chunkCount: this.chunks.size, docCount: this.manifest?.docCount ?? 0 }
    }

    // 2) 向量 + chunk
    await this.#loadChunks()
    this.vectors = await VectorStore.open(this.paths.vectors, config.embedding.dimensions)
    this.#rebuildBm25FromChunks()

    this.status.state = this.chunks.size > 0 ? 'ready' : 'idle'
    this.status.message = this.hybridReady ? '混合召回已就绪' : '降级为纯关键词召回'

    return {
      compatible,
      chunkCount: this.chunks.size,
      docCount: this.manifest?.docCount ?? 0,
    }
  }

  /** 读 chunks.json 填充内存表。 */
  async #loadChunks() {
    this.chunks = new Map()
    try {
      const parsed = JSON.parse(await readFile(this.paths.chunks, 'utf8'))
      const rows = Array.isArray(parsed?.chunks) ? parsed.chunks : []
      for (const row of rows) {
        if (typeof row?.chunkId !== 'string') continue
        this.chunks.set(row.chunkId, row)
      }
    } catch {
      /* 无 chunk 表 = 空索引 */
    }
  }

  /** 用内存 chunk 表重建 BM25（不重新 embed）。 */
  #rebuildBm25FromChunks() {
    const config = this.getConfig()
    const aliases = config.aliases ?? null
    // 分词模式必须跟着配置走，且**必须与 recall 查询端用同一个模式**。
    // 两端不一致（比如索引用 gram 建、查询用 jieba 切）会造成
    // 词表不相交 → BM25 全部 0 分 → 静默退化成纯向量检索。
    const mode = config.recall?.tokenizer ?? 'auto'
    const docs = []
    for (const chunk of this.chunks.values()) {
      docs.push({
        chunkId: chunk.chunkId,
        text: scoringText(chunk),
        tags: chunk.tags ?? [],
        date: chunk.date ?? '',
      })
    }
    // 单字权重必须跟着配置走：它直接影响排序质量，不能写死在构造里。
    // 改了配置要重新 buildBm25 才生效（rebuild / 热更新时都会走到这里）。
    this.bm25 = new BM25(1.5, 0.75, singleCharWeightOf(config)).build(
      docs,
      (text) => tokenize(text, aliases, { mode }),
    )
  }

  /**
   * 全量重建索引。
   *
   * 流程：读语料 → 切分 → （可选）embed → 写盘。
   * Embedding 失败时仍写 chunk 表与 BM25 缓存，保证纯关键词可用。
   *
   * @param {{ signal?: AbortSignal, forceVectors?: boolean }} [options]
   * @returns {Promise<object>} 构建报告
   */
  async rebuild(options = {}) {
    if (this.building) {
      return { ok: false, error: '已有构建任务在进行中' }
    }
    this.building = true
    const startedAt = new Date().toISOString()
    this.status = {
      state: 'building',
      progress: 0,
      totalBatches: 0,
      doneBatches: 0,
      message: '读取语料…',
      error: null,
      startedAt,
      finishedAt: null,
    }

    const config = this.getConfig()

    try {
      // ---- 1. 读语料（历史 .md + 日记 .txt 合成一条流水线）----
      const { docs, runtime, problems } = loadCorpus(config.corpusRoot, {
        includeArchived: config.includeArchived === true,
        diaryRoot: config.diaryRoot,
        diaryConfig: config.diary,
        runtimeFile: runtimeFilePath(config),
      })
      if (docs.length === 0) {
        throw new Error(
          `没有可用文档。语料目录：${config.corpusRoot}；日记目录：${config.diaryRoot}`,
        )
      }

      // ---- 2. 切分 ----
      this.status.message = '切分…'
      /** @type {any[]} */
      const chunks = []
      for (const doc of docs) {
        const pieces = chunkDocument(doc, {
          size: config.chunkSize,
          overlap: config.chunkOverlap,
        })
        for (const piece of pieces) chunks.push(piece)
      }
      this.status.message = `${docs.length} 篇 → ${chunks.length} chunk`

      // ---- 3. Embedding ----
      let vectorError = null
      /** @type {{ chunkId: string, vector: Float32Array }[]} */
      let vectorRows = []

      const embedder = config.embedding.enabled
        ? new Embedder({ ...config.embedding, apiKey: resolveApiKey(config.embedding) })
        : null

      if (embedder !== null && embedder.configured) {
        const batchSize = Math.min(16, Math.max(1, config.embedding.batchSize ?? 16))
        const totalBatches = Math.ceil(chunks.length / batchSize)
        this.status.totalBatches = totalBatches

        // embedBatch 内部并发执行，这里只负责把进度映射到 status
        embedder.onProgress = (done, total) => {
          this.status.doneBatches = done
          this.status.progress = Math.round((done / Math.max(1, total)) * 100)
          this.status.message = `embedding 批次 ${done}/${total}（并发 ${config.embedding.concurrency ?? 3}）`
        }

        try {
          // 送去 embed 的文本 = 正文 + 标题（标题信息密度高，必须带）
          const texts = chunks.map((chunk) => {
            const head = chunk.title ? `${chunk.title}\n` : ''
            return `${head}${chunk.text}`.slice(0, 4000)
          })

          const vectors = await embedder.embedBatch(texts, options.signal)
          vectorRows = chunks.map((chunk, index) => ({ chunkId: chunk.chunkId, vector: vectors[index] }))
        } catch (error) {
          // 关键：embedding 失败不毁掉整个索引，只降级
          vectorError = String(error?.message ?? error)
          this.log('warn', `embedding 失败，降级为纯关键词：${vectorError}`)
        }
      } else {
        vectorError = 'embedding 未启用或未配置'
      }

      // ---- 4. 写盘（备份旧索引后原子替换）----
      this.status.message = '写盘…'
      await mkdir(this.indexDir, { recursive: true })
      if (existsSync(this.paths.vectors)) await this.#backupIndex()

      // chunk 表
      await writeJsonAtomic(this.paths.chunks, { chunks, savedAt: startedAt })

      // manifest
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        builtAt: startedAt,
        embedding: {
          baseUrl: String(config.embedding.baseUrl ?? '').replace(/\/+$/, ''),
          model: String(config.embedding.model ?? ''),
          dimensions: Number(config.embedding.dimensions ?? 0),
        },
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
        // 记录**实际生效**的引擎（可能因 jieba 缺失从 auto 降级成 gram），
        // 而不是配置里的原始值 —— 否则换台机器装了 jieba 会以为不用重建，
        // 实际词表对不上、BM25 静默全 0 分。
        tokenizer: resolveEngine(config.recall?.tokenizer ?? 'auto'),
        docCount: docs.length,
        chunkCount: chunks.length,
        corpusHash: hashCorpus(docs),
        documents: docs.map((doc) => ({
          docId: doc.docId,
          filename: doc.filename,
          title: doc.title,
          createdAt: doc.date,
          contentHash: doc.contentHash,
        })),
        runtimeCount: runtime.length,
        vectorized: vectorRows.length,
        problems: problems.slice(0, 20),
      }
      await writeJsonAtomic(this.paths.manifest, manifest)
      this.manifest = manifest

      // 向量（只有成功时才写，失败保留旧向量文件不动）
      if (vectorRows.length > 0) {
        const store = new VectorStore(config.embedding.dimensions).reset(vectorRows)
        await store.save(this.paths.vectors)
        this.vectors = store
      } else if (this.manifest !== null) {
        // 向量失败 → 清空内存向量，明确降级
        this.vectors = new VectorStore(config.embedding.dimensions)
      }

      // ---- 5. 更新内存状态 ----
      this.chunks = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
      this.#rebuildBm25FromChunks()
      if (embedder !== null) this.embedder = embedder

      const finishedAt = new Date().toISOString()
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt)

      this.status = {
        state: vectorError === null ? 'ready' : 'degraded',
        progress: 100,
        totalBatches: this.status.totalBatches,
        doneBatches: this.status.doneBatches,
        message: vectorError === null ? '索引已就绪（混合召回）' : `索引已就绪（纯关键词：${vectorError}）`,
        error: vectorError,
        startedAt,
        finishedAt,
      }

      return {
        ok: true,
        docCount: docs.length,
        chunkCount: chunks.length,
        vectorized: vectorRows.length,
        runtimeCount: runtime.length,
        durationMs,
        vectorError,
        problems,
        bm25: this.bm25.stats(),
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.log('error', `构建失败：${message}`)
      this.status = {
        ...this.status,
        state: 'error',
        message,
        error: message,
        finishedAt: new Date().toISOString(),
      }
      return { ok: false, error: message }
    } finally {
      this.building = false
    }
  }

  /**
   * 增量索引：单篇文档写入后立即更新，否则下次召回查不到刚写的东西。
   *
   * 失败只记 WARN，不让写入工具的返回失败 —— 但会明确告知模型
   * 「已写入但索引暂不可见，仅可通过关键词召回」。
   *
   * @param {import('./corpus.js').CorpusDoc} doc
   * @returns {Promise<{ vectorized: boolean, error?: string }>}
   */
  async addDocument(doc) {
    const config = this.getConfig()
    const pieces = chunkDocument(doc, { size: config.chunkSize, overlap: config.chunkOverlap })

    for (const piece of pieces) this.chunks.set(piece.chunkId, piece)
    this.#rebuildBm25FromChunks()

    // chunk 表落盘
    try {
      await writeJsonAtomic(this.paths.chunks, {
        chunks: [...this.chunks.values()],
        savedAt: new Date().toISOString(),
      })
    } catch (error) {
      return { vectorized: false, error: `chunk 表写入失败：${error?.message ?? error}` }
    }

    // 向量增量
    let vectorized = false
    let vectorError = null
    if (!this.hybridReady) {
      vectorError = '向量索引未就绪'
    } else {
      try {
        const texts = pieces.map((piece) => {
          const head = piece.title ? `${piece.title}\n` : ''
          return `${head}${piece.text}`.slice(0, 4000)
        })
        const vectors = await this.embedder.embedBatch(texts)

        // 追加到现有向量表
        const rows = []
        for (let i = 0; i < this.vectors.chunkIds.length; i += 1) {
          const existing = this.vectors.vectorOf(this.vectors.chunkIds[i])
          if (existing !== null) rows.push({ chunkId: this.vectors.chunkIds[i], vector: existing })
        }
        for (let i = 0; i < pieces.length; i += 1) {
          rows.push({ chunkId: pieces[i].chunkId, vector: vectors[i] })
        }
        const store = new VectorStore(config.embedding.dimensions).reset(rows)
        await store.save(this.paths.vectors)
        this.vectors = store
        vectorized = true
      } catch (error) {
        vectorError = String(error?.message ?? error)
        this.log('warn', `增量向量化失败（该文档仅关键词可见）：${vectorError}`)
      }
    }

    // manifest 必须跟着更新 —— 这一步以前漏了。
    //
    // 后果是一个**自相矛盾但没人报错**的状态：chunks.json 里已经有新文档，
    // manifest.docCount 却还停在增量前的数字。而 `summary()` 读的是
    // manifest（docCount / vectorized / builtAt 都取自那里），于是面板
    // 显示「62 篇日记 / 索引 61 篇」、向量数也偏少，看起来像索引坏了。
    // 更糟的是 `assertIndexCompatible` 也拿 manifest 比对 —— 拖久了
    // 会被判成不兼容而要求重建。
    //
    // 这里只改「随增量变化」的字段；embedding / chunkSize / tokenizer /
    // corpusHash 这些「构建指纹」**不能动** —— corpusHash 是建索引时的
    // 全量语料哈希，增量后重算不出来（手里没有全部 docs），
    // 硬改会让「是否需要重建」的判断失真。
    this.#syncManifestAfterAdd(doc, pieces.length, vectorized)

    if (this.manifest !== null) {
      try {
        await writeJsonAtomic(this.paths.manifest, this.manifest)
      } catch (error) {
        this.log('warn', `manifest 写入失败：${error?.message ?? error}`)
      }
    }

    return vectorized
      ? { vectorized: true }
      : { vectorized: false, error: vectorError ?? '向量索引未就绪' }
  }

  /**
   * 把 manifest 里「随文档数变化」的字段对齐到当前内存状态。
   *
   * 抽成独立方法是因为它必须和 addDocument 的写入路径成对出现 ——
   * 分成两处手写，就一定会有人只改一处。
   *
   * @param {import('./corpus.js').CorpusDoc} doc
   * @param {number} pieceCount 本次新增的 chunk 数
   * @param {boolean} vectorized 本次是否成功向量化
   */
  #syncManifestAfterAdd(doc, pieceCount, vectorized) {
    if (this.manifest === null) return
    const manifest = this.manifest

    // docCount 用真实去重后的数量，不用 `+1` ——
    // 同一个 docId 重复写入（update 通路）不该让篇数虚增。
    const docIds = new Set()
    for (const chunk of this.chunks.values()) docIds.add(chunk.docId)
    manifest.docCount = docIds.size
    manifest.chunkCount = this.chunks.size
    if (vectorized) manifest.vectorized = this.vectors.chunkIds.length

    // documents 列表同步：已存在就替换，不存在就追加。
    if (Array.isArray(manifest.documents)) {
      const entry = {
        docId: doc.docId,
        filename: doc.filename,
        title: doc.title,
        createdAt: doc.date,
        contentHash: doc.contentHash,
      }
      const at = manifest.documents.findIndex((row) => row.docId === doc.docId)
      if (at >= 0) manifest.documents[at] = entry
      else manifest.documents.push(entry)
    }

    // builtAt 有意不动：它表示「上次全量构建时间」，增量写入不该把它
    // 刷成当前时间 —— 否则 UI 上就再也看不出索引有多旧了。
    void pieceCount
  }

  /** 备份当前索引，保留最近 N 份。 */
  async #backupIndex() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const [name, path] of Object.entries(this.paths)) {
      if (name === 'bm25') continue
      if (!existsSync(path)) continue
      try {
        await copyFile(path, `${path}.bak-${stamp}`)
      } catch { /* 备份失败不阻断构建 */ }
    }
    // 清理过期备份
    try {
      const names = await readdir(this.indexDir)
      const backups = names
        .filter((name) => name.includes('.bak-'))
        .sort()
      const excess = backups.length - BACKUP_KEEP * 2
      for (let i = 0; i < excess; i += 1) {
        await unlink(join(this.indexDir, backups[i])).catch(() => {})
      }
    } catch { /* 忽略 */ }
  }

  /**
   * 校验完整性：抽若干 chunk 重新 embed，与磁盘向量比对余弦。
   *
   * similarity < 0.999 说明配置不一致或索引损坏。
   *
   * @param {number} [sampleSize]
   * @returns {Promise<object>}
   */
  async verify(sampleSize = 5) {
    if (!this.hybridReady) return { ok: false, error: '向量索引未就绪，无法校验' }
    const ids = [...this.chunks.keys()]
    if (ids.length === 0) return { ok: false, error: '索引为空' }

    const step = Math.max(1, Math.floor(ids.length / sampleSize))
    const picked = []
    for (let i = 0; i < ids.length && picked.length < sampleSize; i += step) picked.push(ids[i])

    const results = []
    for (const chunkId of picked) {
      const chunk = this.chunks.get(chunkId)
      const stored = this.vectors.vectorOf(chunkId)
      if (chunk === undefined || stored === null) {
        results.push({ chunkId, similarity: 0, error: '缺 chunk 或缺向量' })
        continue
      }
      try {
        const head = chunk.title ? `${chunk.title}\n` : ''
        const text = `${head}${chunk.text}`.slice(0, 4000)
        const fresh = await this.embedder.embedOne(text)
        results.push({ chunkId, title: chunk.title, similarity: cosine(stored, fresh) })
      } catch (error) {
        results.push({ chunkId, similarity: 0, error: String(error?.message ?? error) })
      }
    }

    const worst = results.reduce((min, row) => Math.min(min, row.similarity), 1)
    return {
      ok: worst >= 0.999,
      worst,
      samples: results.map((row) => ({
        chunkId: row.chunkId,
        title: (row.title ?? '').slice(0, 40),
        similarity: Math.round(row.similarity * 10000) / 10000,
        error: row.error,
      })),
    }
  }

  /**
   * 汇总状态，供 UI 与工具使用。
   *
   * ## 篇数 / chunk 数 / 向量数必须读内存里的真数据，不能读 manifest 缓存
   *
   * 这里曾经一律读 `manifest.docCount` / `manifest.vectorized`。但 manifest
   * 是**全量构建时写的快照**，而 `addDocument` 走的是增量路径、只更新
   * chunks.json。于是写完一篇新日记之后立刻就是这个自相矛盾的状态：
   *
   *   /library  62 行（读 chunks，含新的）
   *   /state    docCount 61（读 manifest，还是旧的）
   *
   * 用户看到的是「面板说 61 篇，列表里有 62 条」，向量数也偏少 —— 整体
   * 像是索引坏了，实际数据是好的，只是**报了缓存值**。
   *
   * 所以这三项一律按当前内存状态现算，manifest 只在内存里没数据时兜底。
   * 构建指纹（embedding / chunkSize / tokenizer / corpusHash）仍然读
   * manifest —— 那些本来就是「建索引时的决定」，不该随增量变化。
   */
  summary() {
    const config = this.getConfig()
    const compatible = assertIndexCompatible(this.manifest, config)

    // 真实篇数：从当前 chunk 表里去重数 docId。
    // 不用 `manifest.docCount + 1` —— 同一 docId 的 update 不该让篇数虚增。
    const liveDocs = new Set()
    for (const chunk of this.chunks.values()) liveDocs.add(chunk.docId)
    const docCount = this.chunks.size > 0 ? liveDocs.size : (this.manifest?.docCount ?? 0)

    // 真实向量数：向量表里的行数，比 manifest 的快照可靠。
    const vectorized = this.vectors !== null && this.vectors !== undefined
      && Array.isArray(this.vectors.chunkIds) && this.vectors.chunkIds.length > 0
      ? this.vectors.chunkIds.length
      : (this.manifest?.vectorized ?? 0)

    return {
      status: this.status,
      building: this.building,
      hybridReady: this.hybridReady,
      vectorsIndexed: this.vectorsIndexed,
      embeddingEnabled: config.embedding.enabled === true,
      compatible,
      indexDir: this.indexDir,
      docCount,
      chunkCount: this.chunks.size,
      vectorized,
      runtimeCount: this.manifest?.runtimeCount ?? 0,
      builtAt: this.manifest?.builtAt ?? null,
      embedding: this.manifest?.embedding ?? null,
      chunkSize: this.manifest?.chunkSize ?? config.chunkSize,
      chunkOverlap: this.manifest?.chunkOverlap ?? config.chunkOverlap,
      // 索引记录的分词器 vs 当前实际生效的分词器 —— UI 要靠这个提示重建。
      tokenizer: this.manifest?.tokenizer ?? null,
      tokenizerActive: resolveEngine(config.recall?.tokenizer ?? 'auto'),
      bm25: this.bm25.stats(),
      embedder: this.embedder?.stats() ?? null,
    }
  }
}

/** 从环境变量或配置解析 API key（环境变量优先，避免密钥落明文配置）。 */
export function resolveApiKey(embeddingConfig) {
  const fromEnv = process.env.VCPRAG_EMBEDDING_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return typeof embeddingConfig?.apiKey === 'string' ? embeddingConfig.apiKey : ''
}

/**
 * 从配置里取「汉字单字 token 权重」。
 *
 * 放在这里而不是 bm25.js，是因为它属于「召回策略」而不是「打分算法」：
 * 算法本身对任何 token 权重都成立，权重是业务选择。
 *
 * 默认 0.15：实测在 371 chunk / 61 篇的真实语料上，
 * 原始查询「我只是调高了对话消息召回的上限」的 top-5 从
 *   「AI 消息撤回」「dsh-rewind 架构」（全无关）
 * 变成
 *   「OrcaRouter prompt cap 上限」「Mnemon 热记忆容量上限」（相关）。
 * 改成 0 会丢掉「生僻词只靠单字命中」这种情形，改成 1 就是退回旧行为。
 *
 * @param {object} config
 * @returns {number}
 */
export function singleCharWeightOf(config) {
  const raw = config?.recall?.singleCharWeight
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.15
  return Math.max(0, Math.min(1, n))
}

/** 语料指纹：docId + contentHash 的稳定哈希。 */
function hashCorpus(docs) {
  const hash = createHash('sha256')
  for (const doc of [...docs].sort((left, right) => left.docId.localeCompare(right.docId))) {
    hash.update(doc.docId)
    hash.update(doc.contentHash ?? '')
    hash.update(String(doc.text.length))
  }
  return hash.digest('hex').slice(0, 32)
}

/** 原子写 JSON。 */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

/** 余弦相似度（两者均已归一化时等于点积）。 */
function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return 0
  let sum = 0
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i]
  return sum
}
