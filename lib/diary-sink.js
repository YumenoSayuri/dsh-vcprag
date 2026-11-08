/**
 * 语义写入的执行器 —— 把正文里的块变成磁盘上的日记。
 *
 * 职责边界：
 *   diary-block.js   只管「文本 → 结构化参数」（纯函数，无 IO）
 *   diary-write.js   只管「参数 → 磁盘 + 索引」（无块概念）
 *   diary-sink.js    本文件：编排 + 幂等 + 结果汇总（把两边接起来）
 *
 * 为什么不把编排塞进 block 或 write：
 *   block 要保持纯函数才能单测；write 要能被 tool 通道直接调用而不依赖
 *   块的概念。编排层是唯一知道「一次 assistant 回复可能含多个块、
 *   可能重复投递、需要去重」的地方。
 *
 * ---- 幂等 ----
 *
 * 同一个块可能被投递两次（session/event 与 turn-stopping 都会看到它，
 * 或框架重放）。所以每个块算一个指纹：`blockName + 块原文的 sha256 前 16 位`。
 * 已处理过的指纹记在内存 Set 里，重复的直接跳过。
 *
 * 不做「文件已存在」判断——同一篇内容换个时间写应该是新增，不是跳过；
 * 真正要防的是「同一次回复被处理两遍」。
 *
 * @module dsh-vcprag/diary-sink
 */

import { createHash } from 'node:crypto'

import { extractBlocks, validateBlock, stripBlocks } from './diary-block.js'
import { writeDiaryDoc, replaceInDiaryDoc, normaliseTitle } from './diary-write.js'

/** 内存里去重表的容量上限。超了就清最旧的，避免长会话无限增长。 */
const MAX_SEEN = 500

/**
 * 创建一个语义写入执行器。
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {import('./indexer.js').Indexer} deps.indexer
 * @param {(level: string, message: string) => void} [deps.log]
 * @returns {{ consume: (text: string, meta?: object) => Promise<ConsumeResult>, stats: () => object }}
 */
export function createDiarySink(deps) {
  const { getConfig, indexer, log } = deps

  /** @type {Set<string>} 已处理的块指纹（按插入顺序，便于淘汰） */
  const seen = new Set()

  /**
   * 消费一段 assistant 正文：解析、执行、汇总。
   *
   * 永不抛异常 —— 语义写入失败绝不能让整轮对话挂掉。
   * 所有错误都转成 results[].error 返回给上层记日志。
   *
   * @param {string} text
   * @param {object} [meta] 诊断用上下文（sessionId / turn / messageId）
   * @returns {Promise<ConsumeResult>}
   */
  async function consume(text, meta = {}) {
    const config = getConfig()
    const semantic = config?.diary?.semantic ?? {}

    const empty = { blocks: 0, written: 0, updated: 0, skipped: 0, failed: 0, results: [], displayText: text }

    if (semantic.enabled !== true) return empty
    if (config?.diary?.enabled !== true) return empty
    if (typeof text !== 'string' || text === '') return empty

    const blocks = extractBlocks(text, semantic.blockName)
    if (blocks.length === 0) return empty

    const minTarget = Number.isFinite(semantic.updateMinTarget) ? semantic.updateMinTarget : 15
    const results = []

    for (const block of blocks) {
      const parsed = block.parsed

      // 幂等：同一次回复被投递两遍时不再重复落盘
      const fingerprint = fingerprintOf(semantic.blockName ?? 'DailyNote', block.raw)
      if (seen.has(fingerprint)) {
        results.push({ status: 'skipped', reason: '重复投递（同指纹已处理）', command: parsed.command })
        continue
      }

      if (parsed.command === 'update' && semantic.allowUpdate === false) {
        results.push({ status: 'failed', command: 'update', error: 'update 已被配置关闭（diary.semantic.allowUpdate = false）。' })
        markSeen(fingerprint)
        continue
      }

      const check = validateBlock(parsed, { minTarget })
      if (!check.ok) {
        results.push({ status: 'failed', command: parsed.command, error: check.errors.join(' ') })
        // 结构错误的块也记指纹：它不会因为再投递一次就变好，
        // 反复尝试只会刷屏日志。
        markSeen(fingerprint)
        continue
      }

      try {
        const outcome = parsed.command === 'update'
          ? await runUpdate(parsed, { config, indexer, minTarget, semantic })
          : await runCreate(parsed, { config, indexer, semantic })

        results.push(outcome)
        markSeen(fingerprint)
      } catch (error) {
        results.push({ status: 'failed', command: parsed.command, error: String(error?.message ?? error) })
        markSeen(fingerprint)
        log?.('warn', `语义块执行失败（${parsed.command}）：${error?.message ?? error}`)
      }
    }

    const summary = {
      blocks: blocks.length,
      written: results.filter((row) => row.status === 'written').length,
      updated: results.filter((row) => row.status === 'updated').length,
      skipped: results.filter((row) => row.status === 'skipped').length,
      failed: results.filter((row) => row.status === 'failed').length,
      results,
      // 给 UI 用的干净正文（块已剔除）
      displayText: semantic.stripFromDisplay === false ? text : stripBlocks(text, semantic.blockName),
    }

    if (summary.written + summary.updated > 0) {
      log?.('info', `语义写入：新增 ${summary.written} 篇 / 更新 ${summary.updated} 篇`
        + (summary.failed > 0 ? ` / 失败 ${summary.failed}` : '')
        + `（session=${meta.sessionId ?? '-'} turn=${meta.turn ?? '-'}）`)
    } else if (summary.failed > 0) {
      const first = results.find((row) => row.status === 'failed')
      log?.('warn', `语义写入失败 ${summary.failed} 个块：${first?.error ?? ''}`)
    }
    for (const row of results) {
      if (row.status === 'failed') log?.('warn', `  块错误：${row.error}`)
    }

    return summary
  }

  /** 记指纹并维持容量上限。 */
  function markSeen(fingerprint) {
    seen.add(fingerprint)
    while (seen.size > MAX_SEEN) {
      const oldest = seen.values().next()
      if (oldest.done) break
      seen.delete(oldest.value)
    }
  }

  return {
    consume,
    stats: () => ({ seen: seen.size, enabled: getConfig()?.diary?.semantic?.enabled === true }),
  }
}

/**
 * @typedef {object} ConsumeResult
 * @property {number} blocks     解析到的块数
 * @property {number} written    新增篇数
 * @property {number} updated    更新篇数
 * @property {number} skipped    跳过数
 * @property {number} failed     失败数
 * @property {object[]} results  逐块明细
 * @property {string} displayText 剔除块后的正文
 */

// ---------------------------------------------------------------- 执行

/**
 * create：正文即日记，直接落盘。
 *
 * tags 优先级：块头 `tags:` 字段 > 正文末行 `Tag:`。
 * 显式字段优先，因为模型在头部写 tags 时通常是认真排过序的。
 */
async function runCreate(parsed, ctx) {
  const { config, indexer, semantic } = ctx
  const { fields, body } = parsed

  const result = await writeDiaryDoc({
    config,
    indexer,
    content: body,
    title: fields.title,
    description: fields.description,
    tags: splitTagField(fields.tags),
    folder: fields.folder,
    dateOverride: fields.date,
  })

  if (result.ok !== true) {
    return {
      status: result.duplicate === true ? 'skipped' : 'failed',
      command: 'create',
      // 同标题命中的话 result.error 已经把「怎么办」写清楚了，直接透传
      error: result.duplicate === true ? undefined : result.error,
      reason: result.duplicate === true ? result.error : undefined,
      docId: result.docId,
      relativePath: result.relativePath,
    }
  }

  return {
    status: 'written',
    command: 'create',
    docId: result.docId,
    relativePath: result.relativePath,
    tags: result.tags,
    warnings: result.warnings,
    indexed: result.index?.vectorized === true,
    skipIndex: semantic.indexImmediately === false,
  }
}

/**
 * update：按内容锚点替换。
 *
 * 先在指定 folder 里找，找不到再全库找 —— 模型经常记错分类，
 * 而「因为分类猜错就更新失败」对使用者来说是不可理解的失败。
 */
async function runUpdate(parsed, ctx) {
  const { config, indexer, minTarget } = ctx
  const { fields } = parsed

  const scoped = typeof fields.folder === 'string' && fields.folder.trim() !== ''
  const first = await replaceInDiaryDoc({
    config,
    indexer,
    target: fields.target,
    replace: fields.replace ?? '',
    folder: fields.folder,
    minTarget,
  })
  if (first.ok === true || !scoped) {
    return toUpdateOutcome(first)
  }

  // 指定目录里没找到 → 全库再试一次，并在结果里说明
  const second = await replaceInDiaryDoc({
    config,
    indexer,
    target: fields.target,
    replace: fields.replace ?? '',
    minTarget,
  })
  const outcome = toUpdateOutcome(second)
  if (outcome.status === 'updated') {
    outcome.warnings = [...(outcome.warnings ?? []), `target 不在指定分类「${fields.folder}」中，已改到全库命中的那篇。`]
  }
  return outcome
}

function toUpdateOutcome(result) {
  if (result.ok !== true) {
    return { status: 'failed', command: 'update', error: result.error }
  }
  return {
    status: 'updated',
    command: 'update',
    docId: result.docId,
    relativePath: result.relativePath,
    warnings: result.warnings,
    indexed: result.index?.vectorized === true,
  }
}

// ---------------------------------------------------------------- 工具

/** blocks 的 tags 字段 → 数组。 */
function splitTagField(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value.split(/[,，、;；|]/).map((tag) => tag.trim()).filter((tag) => tag !== '')
}

/**
 * 块指纹：块名 + 归一化后原文的哈希。
 *
 * 归一化的是「空白」，不是内容 —— 模型重放同一个块时空白可能被改写，
 * 但文字本身不会变。这样既能去重，又不会把「内容相同但确实要写两次」
 * 的两个块误判成重复（那两块的空白布局通常也不同）。
 */
function fingerprintOf(blockName, raw) {
  const normalised = String(raw).replace(/\s+/g, ' ').trim()
  return `${blockName}:${createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 16)}`
}

/** 供测试与调试：判断一段文本里有没有块。 */
export function hasBlock(text, blockName) {
  return extractBlocks(text, blockName).length > 0
}

/** 供 RPC 预览用：只解析不落盘。 */
export function previewBlocks(text, semantic = {}) {
  const minTarget = Number.isFinite(semantic.updateMinTarget) ? semantic.updateMinTarget : 15
  return extractBlocks(text, semantic.blockName).map((block) => {
    const check = validateBlock(block.parsed, { minTarget })
    return {
      command: block.parsed.command,
      title: block.parsed.fields.title ?? '',
      folder: block.parsed.fields.folder ?? '',
      tags: splitTagField(block.parsed.fields.tags),
      bodyChars: block.parsed.body.length,
      target: block.parsed.fields.target ?? '',
      replace: block.parsed.fields.replace ?? '',
      bodyTitle: normaliseTitle(block.parsed.fields.title ?? '').slice(0, 40),
      ok: check.ok,
      errors: check.errors,
      problems: block.parsed.problems,
    }
  })
}
