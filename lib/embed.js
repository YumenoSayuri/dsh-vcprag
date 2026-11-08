/**
 * Embedding 客户端。
 *
 * Embedding 端点通常有两类成本，必须同时处理：
 *
 * 1. 每批有固定开销（常见 2~5 秒），与批量大小基本无关
 *    → 总耗时 ≈ 批次数 × 固定开销，所以批次要尽量大
 *
 * 2. 网关限流（常见阈值 100 请求/分钟）
 *    → 并发过高会触发 429，退避重试反而比串行更慢
 *
 * 结论：批量取端点的稳定上限（过大会被断连或返回 5xx），
 * 并发控制在限流以下，并加入请求间隔。
 *
 * 具体数值取决于你的端点，可以用面板「设置 → 测试连接」实测后再定。
 *
 * 必须做 LRU 缓存：增量重建会反复请求同一批文本。
 *
 * @module dsh-vcprag/embed
 */

import { createHash } from 'node:crypto'

/**
 * 实测安全上限。
 * 32 条会偶发 ECONNRESET（TLS 层被网关断开），16 条稳定。
 */
const HARD_BATCH_LIMIT = 16

/**
 * 默认并发批数。
 * 网关限流 100 请求/分钟，并发 2 配合 700ms 节流约 85 请求/分钟，留有余量。
 */
const DEFAULT_CONCURRENCY = 2

/** 两次请求之间的最小间隔（毫秒）。配合 concurrency=2 约 85 req/min。 */
const DEFAULT_MIN_INTERVAL_MS = 700

/** 网络层错误（ECONNRESET / terminated / abort）的重试次数。 */
const MAX_RETRIES = 3

/** 可重试的网络错误特征。网关在负载高时会直接断开 TLS 连接。 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'terminated',
])

/** LRU 缓存容量。334 chunk 全量 + 增量余量，2000 足够。 */
const CACHE_MAX = 2000

/**
 * @typedef {object} EmbeddingConfig
 * @property {string} baseUrl - 形如 `https://host/v1`（末尾斜杠可有可无）。
 * @property {string} apiKey
 * @property {string} model
 * @property {number} dimensions
 * @property {number} [batchSize]
 * @property {number} [timeoutMs]
 */

export class Embedder {
  /** @param {EmbeddingConfig} config */
  constructor(config) {
    this.config = config
    /** @type {Map<string, Float32Array>} */
    this.cache = new Map()
    this.requestCount = 0
    this.errorCount = 0
    this.retryCount = 0
    /** 上次请求完成的时间戳，用于节流。 */
    this.lastRequestAt = 0
    /** 进度回调，由 indexer 注入。 */
    this.onProgress = null
    this.totalBatches = 0
    this.doneBatches = 0
  }

  /**
   * 请求节流：保证两次请求之间至少隔 minIntervalMs。
   *
   * 网关限流 100 req/min，21 批如果在 20 秒内打完必定 429。
   * 加锁让并发 worker 串行进入，各自等待到下一个时间片。
   */
  async #throttle(signal) {
    const minInterval = this.config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    if (minInterval <= 0) return
    const now = Date.now()
    const wait = this.lastRequestAt + minInterval - now
    if (wait > 0) await sleep(wait, signal)
    this.lastRequestAt = Date.now()
  }

  /**
   * 拼请求 URL。
   *
   * 实测坑：baseUrl 若不带 `/v1`，请求会打到 New API 的首页返回 HTML
   * （HTTP 200 但 body 是网页），排查时极易误判成「成功」。
   */
  url() {
    const base = String(this.config.baseUrl ?? '').replace(/\/+$/, '')
    if (base === '') throw new Error('embedding.baseUrl 未配置')
    return base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`
  }

  get configured() {
    return (
      typeof this.config.baseUrl === 'string' &&
      this.config.baseUrl.trim() !== '' &&
      typeof this.config.model === 'string' &&
      this.config.model.trim() !== '' &&
      Number.isFinite(this.config.dimensions) &&
      this.config.dimensions > 0
    )
  }

  /** 文本 → 缓存键。 */
  static key(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
  }

  /** 写缓存（LRU：命中先删后插，超限淘汰最旧）。 */
  #remember(key, vector) {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, vector)
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    return vector
  }

  /**
   * 批量 embed。
   *
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>} 顺序与输入严格一致。
   */
  async embedBatch(texts, signal) {
    if (!Array.isArray(texts) || texts.length === 0) return []
    if (!this.configured) throw new Error('Embedding 未配置（缺 baseUrl / model / dimensions）')

    /** @type {(Float32Array|undefined)[]} */
    const out = new Array(texts.length)
    /** @type {{ index: number, key: string, text: string }[]} */
    const pending = []

    for (let i = 0; i < texts.length; i += 1) {
      const key = Embedder.key(texts[i])
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        this.#remember(key, cached) // 刷新 LRU 位置
        out[i] = cached
      } else {
        pending.push({ index: i, key, text: texts[i] })
      }
    }

    if (pending.length === 0) return /** @type {Float32Array[]} */ (out)

    const batchSize = Math.min(
      Math.max(1, Math.floor(this.config.batchSize ?? HARD_BATCH_LIMIT)),
      HARD_BATCH_LIMIT,
    )
    const concurrency = Math.min(
      Math.max(1, Math.floor(this.config.concurrency ?? DEFAULT_CONCURRENCY)),
      8,
    )

    // 切批次
    /** @type {{ index: number, key: string, text: string }[][]} */
    const batches = []
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      batches.push(pending.slice(offset, offset + batchSize))
    }
    this.totalBatches = batches.length
    this.doneBatches = 0

    // 并发执行。实测每批有 2~5 秒固定开销，与批量大小无关，
    // 所以并发是唯一有效的加速手段。
    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (signal?.aborted === true) throw new Error('embedding 被中断')
        const batchIndex = cursor
        cursor += 1
        if (batchIndex >= batches.length) return

        const slice = batches[batchIndex]
        const vectors = await this.#request(slice.map((item) => item.text), signal)
        for (let i = 0; i < slice.length; i += 1) {
          out[slice[i].index] = this.#remember(slice[i].key, vectors[i])
        }
        this.doneBatches += 1
        this.onProgress?.(this.doneBatches, this.totalBatches)
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, batches.length) },
      () => worker(),
    )
    await Promise.all(workers)

    return /** @type {Float32Array[]} */ (out)
  }

  /**
   * 单条 embed（查询用）。
   *
   * @param {string} text
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array>}
   */
  async embedOne(text, signal) {
    const [vector] = await this.embedBatch([text], signal)
    return vector
  }

  /**
   * 真正发请求，带重试。
   *
   * @param {string[]} batch
   * @param {AbortSignal} [signal]
   * @param {number} [attempt]
   * @returns {Promise<Float32Array[]>}
   */
  async #request(batch, signal, attempt = 0) {
    const body = {
      model: this.config.model,
      input: batch,
    }
    // gemini-embedding-2-preview 支持 dimensions；不支持的后端会忽略该字段
    if (Number.isFinite(this.config.dimensions)) body.dimensions = this.config.dimensions

    // 节流必须放在发请求之前，否则并发 worker 会同时冲进网关
    await this.#throttle(signal)

    const controller = new AbortController()
    const timeoutMs = this.config.timeoutMs ?? 120_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    this.requestCount += 1

    try {
      const response = await fetch(this.url(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const detail = text.slice(0, 300)
        // 429 是限流（实测 x-ratelimit-limit: 100 / reset: 60）。
        // 必须按 Retry-After 等足，否则重试也是立刻再次 429。
        if (response.status === 429) {
          if (attempt < MAX_RETRIES) {
            const retryAfter = Number(response.headers.get('retry-after'))
            const resetHeader = Number(response.headers.get('x-ratelimit-reset'))
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Number.isFinite(resetHeader) && resetHeader > 0
                ? Math.min(resetHeader, 60) * 1000
                : 20_000
            this.retryCount += 1
            // 节流点也往后推，避免其他 worker 立刻撞上同一窗口
            this.lastRequestAt = Date.now() + waitMs
            await sleep(waitMs, signal)
            return this.#request(batch, signal, attempt + 1)
          }
          this.errorCount += 1
          throw new Error(
            `embedding 限流（429）：网关限流 100 请求/分钟，重试 ${MAX_RETRIES} 次仍失败。`
            + `请降低 embedding.concurrency 或提高 embedding.minIntervalMs。`,
          )
        }

        // 502/503 是网关过载，短退避重试；4xx 配置错，重试无意义
        if ((response.status === 502 || response.status === 503) && attempt < MAX_RETRIES) {
          this.retryCount += 1
          await sleep(1200 * (attempt + 1), signal)
          return this.#request(batch, signal, attempt + 1)
        }
        this.errorCount += 1
        throw new Error(`embedding HTTP ${response.status}: ${detail}`)
      }

      const payload = await response.json()
      const rows = payload?.data
      if (!Array.isArray(rows) || rows.length !== batch.length) {
        this.errorCount += 1
        throw new Error(
          `embedding 返回条数不符：期望 ${batch.length}，实得 ${Array.isArray(rows) ? rows.length : 'N/A'}`,
        )
      }

      /** @type {Float32Array[]} */
      const out = new Array(batch.length)
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const embedding = row?.embedding
        if (!Array.isArray(embedding) || embedding.length === 0) {
          this.errorCount += 1
          throw new Error(`embedding 第 ${i} 条缺少向量`)
        }
        // 后端可能乱序返回，按 index 归位
        const target = Number.isInteger(row?.index) ? row.index : i
        if (target < 0 || target >= batch.length) {
          this.errorCount += 1
          throw new Error(`embedding 返回越界 index=${target}`)
        }
        out[target] = normalize(Float32Array.from(embedding))
      }

      // 维度校验：配置写错了必须在第一次请求就炸出来，不能带病入库
      const actual = out[0]?.length ?? 0
      if (actual !== this.config.dimensions) {
        this.errorCount += 1
        throw new Error(
          `维度不符：配置 ${this.config.dimensions}，后端实际返回 ${actual}。` +
          `请检查 embedding.dimensions 配置或更换模型。`,
        )
      }

      return out
    } catch (error) {
      // 网关在负载高时会直接断 TLS，undici 抛 TypeError('terminated')。
      // 这类错误必须重试，否则整批 chunk 会永久丢失向量。
      const code = error?.cause?.code ?? error?.code ?? ''
      const name = error?.name ?? ''
      const retryable =
        RETRYABLE_CODES.has(code) ||
        RETRYABLE_CODES.has(name) ||
        name === 'AbortError' ||
        String(error?.message ?? '').includes('terminated')

      // 用户主动中断不重试
      if (signal?.aborted === true) throw error

      if (retryable && attempt < MAX_RETRIES) {
        this.retryCount = (this.retryCount ?? 0) + 1
        await sleep(1200 * (attempt + 1), signal)
        return this.#request(batch, signal, attempt + 1)
      }

      this.errorCount += 1
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 供 UI 展示的运行时统计。 */
  stats() {
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      cached: this.cache.size,
    }
  }
}

/**
 * L2 归一化。
 *
 * 归一化后检索用点积代替余弦，省掉每次开方 —— 334 × 3072 的暴力扫描，
 * 这点差别在 5ms 量级上还是能感觉到的。
 *
 * @param {Float32Array} vector
 * @returns {Float32Array}
 */
export function normalize(vector) {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
  const norm = Math.sqrt(sum)
  if (norm === 0 || !Number.isFinite(norm)) return vector
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  return out
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
