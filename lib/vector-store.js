/**
 * 向量索引持久化。
 *
 * 裸二进制存储：`[4字节 metaLen][UTF-8 meta JSON][float32 数据]`
 * 334 × 3072 × 4B ≈ 3.9MB，读取时零拷贝成 Float32Array。
 *
 * 不引 HNSW：334 条暴力点积 < 5ms，引入原生依赖的维护成本远高于收益。
 *
 * @module dsh-vcprag/vector-store
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * @typedef {object} StoreMeta
 * @property {number} dimensions
 * @property {string[]} chunkIds - 与向量行一一对应。
 */

export class VectorStore {
  /**
   * @param {number} dimensions
   */
  constructor(dimensions) {
    this.dimensions = dimensions
    /** @type {string[]} */
    this.chunkIds = []
    /** @type {Float32Array|null} */
    this.data = null
    /** @type {Map<string, number>} chunkId → 行号 */
    this.rowOf = new Map()
  }

  get size() {
    return this.chunkIds.length
  }

  get ready() {
    return this.data !== null && this.chunkIds.length > 0
  }

  /**
   * 从磁盘加载。文件不存在或损坏时返回空 store（不抛错）——
   * 索引坏了应当降级为纯 BM25，不能阻断对话。
   *
   * @param {string} path
   * @param {number} dimensions
   * @returns {Promise<VectorStore>}
   */
  static async open(path, dimensions) {
    const store = new VectorStore(dimensions)
    let buffer
    try {
      buffer = await readFile(path)
    } catch {
      return store
    }

    try {
      const metaLength = buffer.readUInt32LE(0)
      if (metaLength <= 0 || metaLength > buffer.length - 4) return store

      const meta = JSON.parse(buffer.subarray(4, 4 + metaLength).toString('utf8'))
      const chunkIds = Array.isArray(meta?.chunkIds) ? meta.chunkIds : []
      const dims = Number.isFinite(meta?.dimensions) ? meta.dimensions : 0

      // 维度对不上 = 索引与当前配置不兼容，按「无索引」处理
      if (dims !== dimensions || chunkIds.length === 0) return store

      const dataStart = 4 + metaLength
      const expectedBytes = chunkIds.length * dims * 4
      if (buffer.length - dataStart < expectedBytes) return store

      // 切片后零拷贝成 Float32Array（要求 dataStart 对齐，故复制一份 header 之外的数据）
      const raw = buffer.subarray(dataStart, dataStart + expectedBytes)
      const aligned = new ArrayBuffer(expectedBytes)
      new Uint8Array(aligned).set(raw)

      store.chunkIds = chunkIds
      store.dimensions = dims
      store.data = new Float32Array(aligned)
      store.rowOf = new Map(chunkIds.map((id, index) => [id, index]))
      return store
    } catch {
      return store
    }
  }

  /**
   * 原子写盘：先写 .tmp 再 rename，避免进程被杀留下半截文件。
   *
   * @param {string} path
   */
  async save(path) {
    if (!this.data || this.chunkIds.length === 0) {
      // 空 store 不写盘，避免用空索引覆盖掉好的索引
      return
    }
    const meta = JSON.stringify({
      dimensions: this.dimensions,
      chunkIds: this.chunkIds,
      savedAt: new Date().toISOString(),
    })
    const metaBuffer = Buffer.from(meta, 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(metaBuffer.length, 0)
    const dataBuffer = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength)

    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, Buffer.concat([head, metaBuffer, dataBuffer]))
    await rename(temporary, path)
  }

  /**
   * 从「chunkId → 向量」的映射整体重建。
   *
   * @param {{ chunkId: string, vector: Float32Array }[]} rows
   */
  reset(rows) {
    this.chunkIds = []
    this.rowOf = new Map()
    const dims = rows.length > 0 ? rows[0].vector.length : this.dimensions
    this.dimensions = dims
    const flat = new Float32Array(rows.length * dims)
    for (let i = 0; i < rows.length; i += 1) {
      flat.set(rows[i].vector, i * dims)
      this.chunkIds.push(rows[i].chunkId)
      this.rowOf.set(rows[i].chunkId, i)
    }
    this.data = flat
    return this
  }

  /**
   * 暴力点积检索。查询向量必须已归一化，索引向量也已归一化，
   * 因此点积即余弦相似度。
   *
   * @param {Float32Array} query
   * @param {number} [limit]
   * @returns {{ chunkId: string, score: number }[]}
   */
  search(query, limit = 30) {
    if (!this.ready || !query || query.length !== this.dimensions) return []
    const { data, dimensions: dims, chunkIds } = /** @type {{ data: Float32Array, dimensions: number, chunkIds: string[] }} */ (this)
    const hits = []

    for (let row = 0; row < chunkIds.length; row += 1) {
      const base = row * dims
      let sum = 0
      for (let d = 0; d < dims; d += 1) sum += query[d] * data[base + d]
      hits.push({ chunkId: chunkIds[row], score: sum })
    }

    hits.sort((left, right) => right.score - left.score)
    return hits.slice(0, limit)
  }

  /** 取某 chunk 的向量（校验完整性用）。 */
  vectorOf(chunkId) {
    const row = this.rowOf.get(chunkId)
    if (row === undefined || !this.data) return null
    const start = row * this.dimensions
    return this.data.subarray(start, start + this.dimensions)
  }
}

/**
 * 字节数 → 人类可读。
 *
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`
}
