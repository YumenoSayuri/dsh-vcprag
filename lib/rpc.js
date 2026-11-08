/**
 * UI RPC 端点。
 *
 * 走 DSH 的 webServer.register，与 dsh-time-weaver 同构（已验证可行）。
 *
 * @module dsh-vcprag/rpc
 */

import { join, dirname } from 'node:path'
import { writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { corpusStats, readDocument, loadRuntimeMemories } from './corpus.js'
import { assertIndexCompatible } from './indexer.js'
import { recall, dynamicK } from './recall.js'
import {
  loadAliases,
  saveAliases,
  saveConfigOverlay,
  readConfigOverlay,
  deepMerge,
  CONFIG_DEFAULTS,
  runtimeFilePath,
} from './config.js'
import { parseTagLine, resolveDiaryTemplate, BUILT_IN_TEMPLATE } from './diary-template.js'
import { previewBlocks } from './diary-sink.js'
import { Embedder } from './embed.js'

const API = '/api/vcprag'
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 注册全部 RPC 端点。
 *
 * @param {object} ctx
 * @param {object} deps
 */
export function registerRpc(ctx, deps) {
  const { getConfig, setConfig, indexer, log, corpusRootOf, fridgeFor, buildJudge, getBaseConfig } = deps

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log('warn', 'webServer 不可用，UI 面板不会加载')
    return
  }

  const routes = {
    '/diary/semantic/preview': withErrors('/diary/semantic/preview', onSemanticPreview),
    '/state': onState,
    '/library': onLibrary,
    '/document': onDocument,
    '/document/save': onDocumentSave,
    '/runtime': onRuntime,
    '/runtime/save': onRuntimeSave,
    '/recall': onRecall,
    '/index/rebuild': onRebuild,
    '/index/verify': onVerify,
    '/index/progress': onProgress,
    '/settings': onSettings,
    '/settings/save': onSettingsSave,
    '/settings/test': onTestConnection,
    '/models': onModels,
    '/aliases': onAliases,
    '/aliases/save': onAliasesSave,
    '/diary/folders': onDiaryFolders,
    '/diary/template': onDiaryTemplate,
    '/diary/template/save': onDiaryTemplateSave,
  }

  for (const [path, handler] of Object.entries(routes)) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: API + path,
      handler: withErrors(path, handler),
    }))
  }

  log('info', `已注册 ${Object.keys(routes).length} 个 RPC 端点于 ${API}`)

  // ---------------------------------------------------------------- handlers

  async function onState(req, res) {
    const config = getConfig()
    const stats = corpusStats(config.corpusRoot, statsOptions(config))
    const summary = indexer.summary()
    return writeJson(res, 200, {
      ok: true,
      corpus: {
        root: config.corpusRoot,
        diaryRoot: config.diaryRoot,
        runtimeFile: runtimeFilePath(config),
        ...stats,
      },
      index: summary,
      config: publicConfig(config),
      keyPresent: keyOf(config) !== '',
      // 裁判的**运行时**状态，与 config.judge（声明式配置）分开报。
      //
      // 为什么要单列：这两个东西会不一致，而不一致正是最难查的那类问题。
      //   config.judge.enabled = true  但 apiKey 为空 → buildJudge 返回 null
      //   config.judge 看着正常       但环境变量把值盖掉了 → 实际打到别处
      // 曾经因为只有 config 可看，把「开关是开的但没生效」误判成「没接进链路」。
      // buildJudge 的返回值才是真相，这里直接把它摊出来。
      judgeRuntime: describeJudgeRuntime(config),
      frozen: typeof fridgeFor?.snapshots === 'function' ? fridgeFor.snapshots() : [],
    })
  }

  /**
   * 把 buildJudge 的真实结果翻译成可读字段。
   *
   * **不抛错**：这是诊断端点，它自己炸掉就失去意义了。
   */
  function describeJudgeRuntime(config) {
    if (typeof buildJudge !== 'function') {
      return { ok: false, reason: 'buildJudge 未注入（index.js 忘了传）' }
    }
    const settings = config.judge ?? {}
    const envKey = (process.env.VCPRAG_JUDGE_KEY ?? '').trim()
    const envUrl = (process.env.VCPRAG_JUDGE_URL ?? '').trim()
    // 与 buildJudge 里同一套回落顺序，保证这里报的就是它实际会用的
    const effective = {
      apiKeyFrom: envKey !== '' ? 'env' : (settings.apiKey !== '' ? 'config' : 'none'),
      url: envUrl !== '' ? envUrl
        : (settings.baseUrl !== '' ? settings.baseUrl : 'https://api.typesafe.ai/v1/systemone'),
      model: (process.env.VCPRAG_JUDGE_MODEL ?? '').trim() !== ''
        ? process.env.VCPRAG_JUDGE_MODEL.trim()
        : (settings.model !== '' ? settings.model : 'jev-latest'),
      proxy: (process.env.VCPRAG_JUDGE_PROXY ?? '').trim() !== ''
        ? process.env.VCPRAG_JUDGE_PROXY.trim()
        : (settings.proxyUrl !== '' ? settings.proxyUrl : ''),
      threshold: settings.threshold,
    }

    let live = null
    try {
      live = buildJudge(config)
    } catch (error) {
      return { ok: false, reason: `buildJudge 抛错：${error?.message ?? error}`, effective }
    }
    if (live === null) {
      return {
        ok: false,
        reason: settings.enabled !== true
          ? 'judge.enabled 不是 true'
          : 'enabled 为 true 但 apiKey 为空（面板和环境变量都没给）',
        effective,
      }
    }
    return {
      ok: true,
      // buildJudge 成功 = 这一轮召回真的会走裁判
      configured: live.isConfigured?.() === true,
      transport: effective.proxy === '' ? 'direct' : 'connect-tunnel',
      effective,
    }
  }

  async function onLibrary(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase()

    /** @type {Map<string, any>} */
    const seen = new Map()
    for (const chunk of indexer.chunks.values()) {
      if (chunk.index !== 0) continue
      seen.set(chunk.docId, {
        docId: chunk.docId,
        title: chunk.title,
        date: chunk.date,
        filename: chunk.filename,
        tags: chunk.tags ?? [],
        chunks: 0,
      })
    }
    for (const chunk of indexer.chunks.values()) {
      const row = seen.get(chunk.docId)
      if (row !== undefined) row.chunks += 1
    }

    let rows = [...seen.values()].sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''))
    if (query !== '') {
      rows = rows.filter((row) => `${row.title} ${row.filename}`.toLowerCase().includes(query))
    }
    return writeJson(res, 200, { ok: true, total: seen.size, rows })
  }

  async function onDocument(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const config = getConfig()
    const doc = readDocument(config.corpusRoot, url.searchParams.get('docId') ?? '', {
      diaryRoot: config.diaryRoot,
    })
    if (doc === null) return writeJson(res, 404, { ok: false, error: '文档不存在' })
    return writeJson(res, 200, {
      ok: true,
      docId: doc.docId,
      filename: doc.filename,
      status: doc.status,
      frontmatter: doc.frontmatter,
      body: doc.body,
      relativePath: doc.relativePath,
      sizeBytes: doc.raw.length,
    })
  }

  async function onDocumentSave(req, res) {
    const body = await readBody(req)
    const docId = typeof body?.docId === 'string' ? body.docId : ''
    const text = typeof body?.body === 'string' ? body.body : ''
    if (docId === '' || text.trim() === '') {
      return writeJson(res, 400, { ok: false, error: 'docId 与 body 不能为空' })
    }

    const config = getConfig()
    if (config.tools.writeEnabled !== true) {
      return writeJson(res, 403, { ok: false, error: '写入功能已关闭' })
    }

    const doc = readDocument(config.corpusRoot, docId, { diaryRoot: config.diaryRoot })
    if (doc === null) return writeJson(res, 404, { ok: false, error: '文档不存在' })

    const contentHash = createHash('sha256').update(text, 'utf8').digest('hex')

    if (doc.source === 'diary') {
      // .txt 日记：正文即全文，没有 frontmatter 可写
      try {
        await writeFile(doc.path, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
      } catch (error) {
        return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
      const tags = parseTagLine(text)
      const indexResult = await indexer.addDocument({
        docId: doc.docId,
        filename: doc.filename,
        relativePath: doc.relativePath,
        title: doc.filename,
        description: text.replace(/\s+/g, ' ').slice(0, 120),
        text,
        date: doc.relativePath.slice(0, 10),
        tags,
        status: doc.status,
        source: 'diary',
        contentHash,
      })
      return writeJson(res, 200, { ok: true, contentHash, index: indexResult })
    }

    const fm = { ...doc.frontmatter }
    fm.updated_at = new Date().toISOString()
    fm.content_hash = contentHash
    fm.revision = (Number(fm.revision) || 1) + 1

    try {
      await writeFile(doc.path, serializeFrontmatter(fm, text), 'utf8')
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }

    const indexResult = await indexer.addDocument({
      docId: doc.docId,
      filename: doc.filename,
      relativePath: doc.relativePath,
      title: String(fm.title ?? ''),
      description: String(fm.description ?? ''),
      text,
      date: String(fm.created_at ?? '').slice(0, 10),
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      status: doc.status,
      source: 'corpus',
      contentHash,
    })

    return writeJson(res, 200, { ok: true, contentHash, index: indexResult })
  }

  async function onRuntime(req, res) {
    const problems = []
    const path = runtimeFilePath(getConfig())
    const memories = loadRuntimeMemories(path, problems)
    return writeJson(res, 200, { ok: true, memories, problems, path })
  }

  async function onRuntimeSave(req, res) {
    const body = await readBody(req)
    const memories = Array.isArray(body?.memories) ? body.memories : null
    if (memories === null) return writeJson(res, 400, { ok: false, error: '缺少 memories 数组' })

    const path = runtimeFilePath(getConfig())
    const now = new Date().toISOString()
    const cleaned = memories
      .filter((entry) => typeof entry?.content === 'string' && entry.content.trim() !== '')
      .map((entry) => ({
        content: entry.content.trim(),
        created_at: typeof entry.created_at === 'string' ? entry.created_at : now,
        updated_at: now,
        target: entry.target === 'user' ? 'user' : 'memory',
        importance: entry.importance === 'critical' ? 'critical' : 'normal',
      }))

    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({ version: 1, entries: cleaned }, null, 2), 'utf8')
      // 顺带重生成拼接视图，便于人直接阅读
      await writeFile(
        join(dirname(path), 'MEMORY.md'),
        cleaned.map((m) => m.content).join('\n§\n'),
        'utf8',
      )
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }

    return writeJson(res, 200, {
      ok: true,
      count: cleaned.length,
      warning: 'system prompt 已变化，当前会话缓存前缀会重建一次。建议开新会话以获得最佳缓存命中。',
    })
  }

  async function onRecall(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const query = (url.searchParams.get('q') ?? '').trim()
    if (query === '') return writeJson(res, 400, { ok: false, error: '缺少 q 参数' })

    const onlyLexical = url.searchParams.get('only') === 'lexical'
    const onlySemantic = url.searchParams.get('only') === 'semantic'
    const limitParam = Number(url.searchParams.get('limit') ?? '')

    const config = getConfig()
    // 裁判必须在这里也传。
    //
    // 曾经漏了：`/recall`（召回调试 Tab）自己拼 recall 参数，只传了
    // bm25/vectors/embedder/chunks/aliases/config —— 没有 judge。
    // 而 index.js 的 runRecall（真正用于注入的那条路）传了。
    // 后果：**调试面板永远显示 timing.judge = null**，看上去像「裁判
    // 没接进链路」，其实注入路径是好的；反过来如果哪天注入路径漏了，
    // 调试面板也发现不了 —— 两条路各自拼参数，就会长期分叉。
    //
    // 所以 judge 由调用方注入（和 index.js 共用同一个 buildJudge），
    // 不在这里重复实现「怎么判断该不该开」。
    const judge = typeof buildJudge === 'function' ? buildJudge(config) : null
    const result = await recall(query, {
      bm25: indexer.bm25,
      vectors: onlyLexical ? { ready: false, search: () => [] } : indexer.vectors,
      // 这里曾经写成 `onlySemantic ? null : indexer.embedder` —— 条件反了。
      // 后果：`only=semantic` 把 embedder 摘掉，recall 里
      // `vectors.ready && embedder.configured` 不成立 → 语义通道直接跳过
      // → 返回的其实是纯词法结果。UI 调试 Tab 的「仅向量」选项因此一直
      // 在骗人：看起来有结果，但那些结果跟向量毫无关系。
      //
      // 正确条件是按「词法」排除：only=lexical 才禁 embedder。
      embedder: onlyLexical ? null : indexer.embedder,
      chunks: indexer.chunks,
      aliases: config.aliases ?? loadAliases(config.dataDir),
      config,
      judge,
    })

    const hits = Number.isFinite(limitParam) && limitParam > 0
      ? result.hits.slice(0, Math.floor(limitParam))
      : result.hits

    return writeJson(res, 200, {
      ok: true,
      k: result.k,
      dynamicK: dynamicK(query, config.recall),
      queryTokens: result.queryTokens,
      timing: result.timing,
      hits: hits.map((hit) => ({
        chunkId: hit.chunkId,
        docId: hit.docId,
        title: hit.title,
        date: hit.date,
        tags: hit.tags,
        filename: hit.filename,
        final: round(hit.final, 4),
        rrf: round(hit.rrf, 5),
        lexical: round(hit.lexical, 3),
        semantic: hit.semantic === undefined ? null : round(hit.semantic, 4),
        matched: hit.matched,
        moreChunks: hit.moreChunks ?? 0,
        excerpt: hit.text.slice(0, 400),
      })),
    })
  }

  async function onRebuild(req, res) {
    const body = await readBody(req)
    const force = body?.force === true
    const compatible = assertIndexCompatible(indexer.manifest, getConfig())

    // 闸 3：重建前的兼容性检查，fatal 时要求显式 force
    if (compatible.fatal === true && !force) {
      return writeJson(res, 409, {
        ok: false,
        requiresConfirm: true,
        reason: compatible.reason,
        message: compatible.message,
        hint: '确认要重建请带 force=true 重新请求。',
      })
    }
    if (indexer.building) return writeJson(res, 409, { ok: false, error: '已有构建任务在进行中' })

    // 不 await：让 UI 立刻拿到响应并轮询 /index/progress
    indexer.rebuild().then((report) => {
      log('info', `重建完成：${report.ok ? `${report.chunkCount} chunk` : `失败 ${report.error}`}`)
    })
    return writeJson(res, 202, { ok: true, started: true })
  }

  async function onProgress(req, res) {
    return writeJson(res, 200, { ok: true, status: indexer.status, building: indexer.building })
  }

  async function onVerify(req, res) {
    try {
      return writeJson(res, 200, { ok: true, verify: await indexer.verify(5) })
    } catch (error) {
      return writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  async function onSettings(req, res) {
    const config = getConfig()
    return writeJson(res, 200, {
      ok: true,
      config: publicConfig(config),
      defaults: CONFIG_DEFAULTS,
      manifestEmbedding: indexer.manifest?.embedding ?? null,
      compatible: assertIndexCompatible(indexer.manifest, config),
      keyPresent: keyOf(config) !== '',
      // 分词器三态：配置想用什么 / 实际能用什么 / 索引是用什么建的。
      // UI 必须能同时看到这三个 —— 只显示配置值的话，「配了 auto 但
      // 机器上没装 jieba」这种情形在界面上完全不可见。
      tokenizer: {
        configured: config.recall.tokenizer,
        active: indexer.tokenizerActive,
        indexed: indexer.manifest?.tokenizer ?? null,
        loadError: indexer.tokenizerError,
      },
    })
  }

  /**
   * 保存配置 —— 维度保护的第一道闸。
   *
   * 改动会让索引失效时返回 409 + requiresConfirm，前端必须弹窗确认。
   */
  async function onSettingsSave(req, res) {
    const body = await readBody(req)
    const raw = body?.config
    if (raw === null || typeof raw !== 'object') {
      return writeJson(res, 400, { ok: false, error: '缺少 config 对象' })
    }
    const force = body?.force === true

    // templateText 在 publicConfig 里是空串占位（模板正文单独走
    // /diary/template），这里必须剥掉，否则「改任意别的设置」都会顺带
    // 把用户的日记模板清空。
    const patch = stripMaskedDiary(raw)

    const current = getConfig()
    const merged = mergeForSave(current, patch)
    const compatible = assertIndexCompatible(indexer.manifest, merged)

    if (compatible.fatal === true && !force) {
      return writeJson(res, 409, {
        ok: false,
        requiresConfirm: true,
        reason: compatible.reason,
        title: 'Embedding 配置变更将导致索引失效',
        message: compatible.message,
        consequences: [
          `现有索引：${indexer.manifest?.docCount ?? 0} 篇 / ${indexer.manifest?.chunkCount ?? 0} chunk / ${indexer.manifest?.embedding?.dimensions ?? 0} 维`,
          `新配置：${merged.embedding.dimensions} 维（${merged.embedding.model}）`,
          '重建期间召回降级为纯关键词模式',
        ],
        actions: [
          { id: 'rebuild', label: '立即重建索引（推荐）', primary: true },
          { id: 'save', label: '仅保存配置，稍后手动重建' },
          { id: 'cancel', label: '取消，不保存' },
        ],
      })
    }

    // ---- 覆盖层的 delta 基准：必须是「部署配置」，不是「当前生效配置」----
    //
    // 覆盖层的语义是「相对 patch.yml 改了什么」。既然它是**整份覆盖写**，
    // 那么每次保存都必须把此前保存过的项**原样再算进来**，否则就会被抹掉。
    //
    // 用 `current`（= patch.yml + 旧覆盖层）当基准是个致命错误：
    //
    //   第 1 次保存：judge 还没生效 → delta 含 judge → 写进 overlay ✅
    //   重启后 judge 生效了
    //   第 2 次保存（只改 maxMessages）：judge 与 current 相同 →
    //            delta 里**没有** judge → 整份 overlay 被覆盖成
    //            `{inject:{maxMessages:0}}` → judge 的 URL/key/开关全丢 ❌
    //
    // 用户的体感就是「每次重启设置都没了」，实际是「每次保存都把上一次
    // 保存的内容擦掉，只是重启才看得见」。注入位置从 message 变回
    // section 也是同一条：`inject.mode` 同样被擦掉后回落到默认值。
    //
    // 改用 baseConfig（只解析 patch.yml）当基准后：凡是与部署配置不同的
    // 项都会**每次**被算进 delta，所以覆盖层天然幂等、可累积。
    const base = typeof getBaseConfig === 'function' ? getBaseConfig() : current
    try {
      // 再叠一层保护：把旧覆盖层里已有的项也并进新 overlay。
      //
      // 为什么光换基准还不够：有些项一旦等于 patch.yml 的值（用户手动改
      // 回部署值），按 delta 就该从 overlay 里删掉 —— 但**如果那次保存
      // 前端没带上这个字段，我们无从判断用户到底改了没有**。保守起见，
      // 旧 overlay 里有的项如果这次没被显式覆盖，原样保留。
      const previous = readConfigOverlay(current.dataDir)
      const overlay = buildOverlay(patch, base)
      // **必须深合并**。这里曾经写成 `{ ...previous, ...overlay }`（浅合并），
      // 结果是个只在重启后才暴露的密钥丢失 bug：
      //
      //   第 1 次保存：填了 judge.apiKey → overlay.judge 里有 key ✅
      //   面板重新加载：publicConfig 把 key 回成 '••••••••'
      //   第 2 次保存（只改了 timeoutMs）：掩码值被 isMaskedSecret 跳过
      //        → 本次 overlay.judge 里**没有** apiKey
      //        → 浅合并让 overlay.judge 整段替换掉 previous.judge
      //        → key 静默消失 ❌
      //
      // 用户看到的是「jev 的 key 存不住，重启就没了」。实际上不是没存进去，
      // 是下一次保存把它擦掉了。baseUrl 之所以没事：它每次都和 patch.yml
      // 的默认空串不同，所以每次都会重新进 delta。
      //
      // 深合并后，掩码跳过的字段会从 previous 原样保留下来。
      await saveConfigOverlay(current.dataDir, deepMerge(previous, overlay))
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
    setConfig(merged)

    return writeJson(res, 200, {
      ok: true,
      config: publicConfig(merged),
      compatible,
      warning: compatible.ok === true ? null : compatible.message,
    })
  }

  async function onTestConnection(req, res) {
    const body = await readBody(req)
    const candidate = body?.embedding ?? getConfig().embedding
    const started = Date.now()
    try {
      const embedder = new Embedder({ ...candidate, apiKey: keyOf({ embedding: candidate }) })
      const vector = await embedder.embedOne('test')
      return writeJson(res, 200, {
        ok: true,
        dimensions: vector.length,
        expected: Number(candidate.dimensions),
        match: vector.length === Number(candidate.dimensions),
        elapsedMs: Date.now() - started,
        model: candidate.model,
      })
    } catch (error) {
      return writeJson(res, 200, {
        ok: false,
        error: String(error?.message ?? error),
        elapsedMs: Date.now() - started,
      })
    }
  }

  async function onModels(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const config = getConfig()
    const baseUrl = (url.searchParams.get('baseUrl') ?? config.embedding.baseUrl).replace(/\/+$/, '')
    const apiKey = url.searchParams.get('apiKey') ?? keyOf(config)
    const root = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`

    try {
      const response = await fetch(`${root}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
      if (!response.ok) return writeJson(res, 200, { ok: false, error: `HTTP ${response.status}` })
      const payload = await response.json()
      const rows = Array.isArray(payload?.data) ? payload.data : []
      return writeJson(res, 200, {
        ok: true,
        total: rows.length,
        embeddings: rows
          .filter((row) => typeof row?.id === 'string' && /embed/i.test(row.id))
          .map((row) => row.id),
      })
    } catch (error) {
      return writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** 列出日记根目录下的分类子目录（含各目录里的 .txt 数量）。 */
  async function onDiaryFolders(req, res) {
    const config = getConfig()
    const root = config.diaryRoot
    const folders = [{ name: '', label: '（根目录）', count: 0 }]
    try {
      if (existsSync(root)) {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (entry.name === '已整理') continue
          let count = 0
          try {
            const inner = await readdir(join(root, entry.name))
            count = inner.filter((name) => name.toLowerCase().endsWith('.txt')).length
          } catch { /* 忽略 */ }
          folders.push({ name: entry.name, label: entry.name, count })
        }
        // 根目录直属 .txt 计数
        const topLevel = await readdir(root)
        folders[0].count = topLevel.filter((name) => name.toLowerCase().endsWith('.txt')).length
      }
    } catch (error) {
      return writeJson(res, 200, {
        ok: false,
        error: String(error?.message ?? error),
        root,
        folders,
      })
    }
    return writeJson(res, 200, { ok: true, root, folders })
  }

  /**
   * 预览一段文本里的语义块：只解析、不落盘。
   *
   * 存在的意义是自检：用户/开发者贴一段带 <<<DailyNoteStart>>> 的文本，
   * 立刻能看到「系统会把它解析成什么」。语义写入的失败模式大多是
   * 格式细节（漏空行、target 太短），而这些光看日志看不出来 ——
   * 日志只会说「没写进去」。
   */
  async function onSemanticPreview(req, res) {
    const config = getConfig()
    // GET 走 query，POST 走 body —— 一篇长日记塞进 URL 会被长度限制截断，
    // 而截断后的解析结果是「没有块」，看起来像功能坏了。
    let text = ''
    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
      const body = await readBody(req)
      text = typeof body?.text === 'string' ? body.text : ''
    } else {
      const url = new URL(req.url ?? '/', 'http://localhost')
      text = url.searchParams.get('text') ?? ''
    }
    if (text.trim() === '') {
      return writeJson(res, 400, { ok: false, error: '缺少 text（要预览的正文）' })
    }
    const semantic = config.diary.semantic
    const rows = previewBlocks(text, semantic)
    return writeJson(res, 200, {
      ok: true,
      semantic,
      found: rows.length,
      // 存不存在块、格式对不对，一眼可见
      rows,
      hint: rows.length === 0
        ? `没有找到 <<<${semantic.blockName}Start>>> …… <<<${semantic.blockName}End>>> 块。`
        : null,
    })
  }

  /** 读当前生效的日记模板（自定义或内置）。 */
  async function onDiaryTemplate(req, res) {
    const config = getConfig()
    const custom = typeof config.diary.templateText === 'string' ? config.diary.templateText : ''
    return writeJson(res, 200, {
      ok: true,
      template: resolveDiaryTemplate(config.diary),
      builtIn: BUILT_IN_TEMPLATE,
      isCustom: custom.trim() !== '',
      enabled: config.diary.templateEnabled === true,
      order: config.diary.templateOrder,
    })
  }

  /** 保存日记模板。传空串表示回退到内置模板。 */
  async function onDiaryTemplateSave(req, res) {
    const body = await readBody(req)
    if (body === null || typeof body !== 'object') {
      return writeJson(res, 400, { ok: false, error: '缺少请求体' })
    }
    const patch = {}
    if (typeof body.template === 'string') patch.templateText = body.template
    if (typeof body.enabled === 'boolean') patch.templateEnabled = body.enabled
    if (body.order !== undefined) patch.templateOrder = Number(body.order)

    const config = getConfig()
    try {
      // 这里**不能**走 stripMaskedDiary：这个端点就是专门改 templateText 的。
      // 传空串 = 明确回退到内置模板，是一次真实改动，必须落盘。
      await saveConfigOverlay(config.dataDir, buildOverlay({ diary: patch }, config))
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }

    // 热更新：模板是 section 的闭包常量，改动后必须重载插件才生效，
    // 所以这里只更新内存配置，并明确告知用户需要重启。
    const merged = mergeForSave(config, { diary: patch })
    setConfig(merged)

    return writeJson(res, 200, {
      ok: true,
      template: resolveDiaryTemplate(merged.diary),
      isCustom: (merged.diary.templateText ?? '').trim() !== '',
      warning: '日记模板注入是闭包常量，需重启 DSH 才生效。',
    })
  }

  async function onAliases(req, res) {
    const config = getConfig()
    return writeJson(res, 200, { ok: true, aliases: loadAliases(config.dataDir) })
  }

  async function onAliasesSave(req, res) {
    const body = await readBody(req)
    const aliases = body?.aliases
    if (aliases === null || typeof aliases !== 'object') {
      return writeJson(res, 400, { ok: false, error: '缺少 aliases 对象' })
    }
    const cleaned = {}
    for (const [key, value] of Object.entries(aliases)) {
      if (!Array.isArray(value)) continue
      const words = value.filter((word) => typeof word === 'string' && word.trim() !== '')
      if (words.length > 0) cleaned[key] = words
    }
    const config = getConfig()
    try {
      saveAliases(config.dataDir, cleaned)
      config.aliases = loadAliases(config.dataDir)
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
    return writeJson(res, 200, { ok: true, count: Object.keys(cleaned).length })
  }
}

// ------------------------------------------------------------------ helpers

function withErrors(path, handler) {
  return async (req, res) => {
    try {
      return await handler(req, res)
    } catch (error) {
      try {
        return writeJson(res, 500, { ok: false, error: String(error?.message ?? error), path })
      } catch {
        return undefined
      }
    }
  }
}

function writeJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
  return undefined
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/** 配置脱敏：密钥只报是否存在。 */
function publicConfig(config) {
  return {
    corpusRoot: config.corpusRoot,
    includeArchived: config.includeArchived,
    diaryRoot: config.diaryRoot,
    diary: {
      enabled: config.diary.enabled,
      format: config.diary.format,
      folder: config.diary.folder,
      templateEnabled: config.diary.templateEnabled,
      templateOrder: config.diary.templateOrder,
      // 模板正文可能很长，不进 config 回包；单独走 /diary/template
      templateText: '',
      requireTag: config.diary.requireTag,
      timePrefix: config.diary.timePrefix,
      runtimeFile: config.diary.runtimeFile,
      // 语义写入子段：UI 的 I 区块读写这里
      semantic: {
        enabled: config.diary.semantic.enabled,
        blockName: config.diary.semantic.blockName,
        updateMinTarget: config.diary.semantic.updateMinTarget,
        allowUpdate: config.diary.semantic.allowUpdate,
        indexImmediately: config.diary.semantic.indexImmediately,
        stripFromDisplay: config.diary.semantic.stripFromDisplay,
      },
    },
    embedding: {
      enabled: config.embedding.enabled,
      baseUrl: config.embedding.baseUrl,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      batchSize: config.embedding.batchSize,
      concurrency: config.embedding.concurrency,
      minIntervalMs: config.embedding.minIntervalMs,
      timeoutMs: config.embedding.timeoutMs,
      apiKey: config.embedding.apiKey === '' ? '' : '••••••••',
    },
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    recall: config.recall,
    // 裁判段：整个回传，但 apiKey 与 embedding 一样走掩码 ——
    // 这个回包会被前端原样回显到浏览器，明文 key 不能出去。
    judge: {
      ...config.judge,
      apiKey: config.judge.apiKey === '' ? '' : '••••••••',
    },
    timeDecay: config.timeDecay,
    freeze: config.freeze,
    runtime: config.runtime,
    inject: config.inject,
    tools: config.tools,
    dataDir: config.dataDir,
  }
}

/** corpusStats 需要的那几个派生路径。 */
function statsOptions(config) {
  return {
    diaryRoot: config.diaryRoot,
    runtimeFile: runtimeFilePath(config),
  }
}

function keyOf(config) {
  const fromEnv = process.env.VCPRAG_EMBEDDING_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return config?.embedding?.apiKey ?? ''
}

/** 顶层可直接覆盖的标量键。 */
const SCALAR_KEYS = [
  'corpusRoot',
  'includeArchived',
  'diaryRoot',
  'chunkSize',
  'chunkOverlap',
  'dataDir',
  'panelEnabled',
]

/**
 * 只在 UI 里「看得见但读不到真实值」的字段。
 *
 * publicConfig() 有意把 diary.templateText 回传成空串（模板正文可能有几千字，
 * 不该塞进每次 settings 回包；它的读写单独走 /diary/template）。
 *
 * 但前端提交时是把 publicConfig 的快照整体回传的，于是 patch 里那个空串
 * 只是「占位」，不是「用户要把模板清空」。如果不剥掉，delta 过滤会认为
 * 它由「有内容」变成「空」= 一次真实改动，从而把用户的模板悄悄清空。
 *
 * 只有 /diary/template/save 能改这个字段。
 */
const MASKED_DIARY_KEYS = ['templateText']

/** 剥掉 UI 占位字段，返回新对象（不改原 patch）。 */
function stripMaskedDiary(patch) {
  if (patch?.diary === null || typeof patch?.diary !== 'object') return patch
  const diary = { ...patch.diary }
  for (const key of MASKED_DIARY_KEYS) delete diary[key]
  if (Object.keys(diary).length === 0) {
    const copy = { ...patch }
    delete copy.diary
    return copy
  }
  return { ...patch, diary }
}

/** 分段合并的 key 白名单（避免前端塞入未知字段）。 */
const SECTION_KEYS = {
  diary: ['enabled', 'format', 'folder', 'templateEnabled', 'templateOrder', 'templateText', 'requireTag', 'timePrefix', 'runtimeFile'],
  // 语义写入是嵌套在 diary 下的子段，单独按 section 处理，
  // 这样不必把它摊平进 diary 的 key 列表（摊平后深合并会失效）。
  'diary.semantic': ['enabled', 'blockName', 'updateMinTarget', 'allowUpdate', 'indexImmediately', 'stripFromDisplay'],
  recall: [
    'lexicalLimit', 'semanticLimit', 'kBase', 'kMin', 'kMax', 'tagWeight', 'maxChars',
    'tokenizer', 'singleCharWeight', 'semanticWeight', 'lexicalWeight',
    'minSemantic', 'requireSemantic', 'minTokenLen', 'minTokenIdf',
  ],
  // 裁判段：数值项 + 连接信息都可写。
  //
  // apiKey 在 publicConfig 里是掩码（'••••••••'），mergeForSave /
  // buildOverlay 会跳过含 '•' 的值 —— 与 embedding.apiKey 同一套机制。
  // 环境变量仍然优先，见 index.js 的 buildJudge。
  judge: [
    'enabled', 'threshold', 'maxCandidates', 'concurrency', 'timeoutMs',
    'candidateChars', 'queryChars',
    'baseUrl', 'model', 'apiKey', 'proxyUrl',
  ],
  timeDecay: ['enabled', 'halfLifeDays', 'floor'],
  freeze: ['onUserMessage', 'onTodoCheck'],
  runtime: ['inject', 'mode', 'maxMessages', 'order', 'title', 'intro', 'criticalTitle', 'normalTitle', 'toolGuidance'],
  inject: ['enabled', 'mode', 'maxMessages', 'order', 'blockName', 'header', 'disclaimer', 'itemPrefix'],
  tools: ['enabled', 'writeEnabled', 'forgetEnabled'],
}

function mergeForSave(current, patch) {
  const merged = structuredClone(current)
  for (const key of SCALAR_KEYS) {
    if (patch[key] !== undefined) merged[key] = patch[key]
  }
  if (patch.embedding !== null && typeof patch.embedding === 'object') {
    for (const key of ['enabled', 'baseUrl', 'model', 'dimensions', 'batchSize', 'concurrency', 'minIntervalMs', 'timeoutMs']) {
      if (patch.embedding[key] !== undefined) merged.embedding[key] = patch.embedding[key]
    }
    // apiKey 为掩码时视为不修改
    if (typeof patch.embedding.apiKey === 'string' && !patch.embedding.apiKey.includes('•')) {
      merged.embedding.apiKey = patch.embedding.apiKey
    }
  }
  for (const [path, keys] of Object.entries(SECTION_KEYS)) {
    // section 可能是 'diary'，也可能是 'diary.semantic' —— 统一按路径取值，
    // 否则嵌套段的键永远读不到，UI 改了也不生效（且不会有任何报错）。
    const incoming = readPath(patch, path)
    if (incoming === null || typeof incoming !== 'object') continue
    const target = ensurePath(merged, path)
    if (target === null) continue
    for (const key of keys) {
      if (incoming[key] === undefined) continue
      // 掩码值 = 「用户没动这个字段」，绝不能把 '••••••••' 写进配置。
      // embedding.apiKey 在上面单独处理过，这里覆盖 judge.apiKey 这类
      // 走 SECTION_KEYS 的密钥字段。
      if (isMaskedSecret(incoming[key])) continue
      target[key] = incoming[key]
    }
  }
  return merged
}

/**
 * 是不是「已配置但没改动」的掩码值。
 *
 * publicConfig() 把 apiKey 回传成 '••••••••'。前端提交的是整份快照，
 * 所以这些点会原样回来。若不禁掉，保存任意别的设置都会把真实 key
 * 替换成八个圆点 —— 之后连接失败，而配置里看起来「有 key」。
 */
function isMaskedSecret(value) {
  return typeof value === 'string' && value.includes('•')
}

/** 按 'a.b.c' 取嵌套值。缺失返回 undefined。 */
function readPath(object, path) {
  let node = object
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/**
 * 按 'a.b.c' 取嵌套对象，不存在时创建。
 *
 * 目标是 current 的深拷贝，路径理论上是有的；但配置结构升级后可能缺段，
 * 这里顺手补出来，避免用户改动静默丢失。
 *
 * @returns {object | null}
 */
function ensurePath(object, path) {
  let node = object
  for (const part of path.split('.')) {
    if (node[part] === null || typeof node[part] !== 'object') node[part] = {}
    node = node[part]
  }
  return typeof node === 'object' && node !== null ? node : null
}

const EMBEDDING_KEYS = [
  'enabled', 'baseUrl', 'model', 'dimensions',
  'batchSize', 'concurrency', 'minIntervalMs', 'timeoutMs',
]

/**
 * 构造 overlay，**只保留与 current 相比真的变了的项**。
 *
 * 为什么必须做 delta 过滤：前端提交的 config 是 publicConfig(config) 的
 * 全量快照。如果整体写进 overlay，就等于把 cordis.patch.yml 里的有效配置
 * 原样复制一遍到更高优先级的文件里 —— 以后无论怎么改 patch.yml 都不生效。
 *
 * 踩过一次真实事故：UI 保存后 overlay 里落下
 *   {"diaryRoot": "", "corpusRoot": "", "dataDir": "...profiles/desktop/.vcprag"}
 * 于是插件只看得到全空默认值，UI 永远「文档 0 篇 / no-index」，
 * 而 patch.yml 里明明写着正确路径。
 *
 * @param {object} patch 前端提交的配置
 * @param {object} [current] 当前生效配置；提供则按值比对过滤
 */
function buildOverlay(patch, current) {
  const changed = (path, next) => {
    if (current === undefined) return true
    let node = current
    for (const part of path.split('.')) {
      if (node === null || node === undefined) return true
      node = node[part]
    }
    // 数字按数值比，避免 800 与 "800" 被当成不同
    if (typeof node === 'number' || typeof next === 'number') {
      return Number(node) !== Number(next)
    }
    return node !== next
  }

  const overlay = {}
  for (const key of SCALAR_KEYS) {
    if (patch[key] !== undefined && changed(key, patch[key])) overlay[key] = patch[key]
  }

  if (patch.embedding !== null && typeof patch.embedding === 'object') {
    const picked = {}
    for (const key of EMBEDDING_KEYS) {
      if (patch.embedding[key] !== undefined && changed(`embedding.${key}`, patch.embedding[key])) {
        picked[key] = patch.embedding[key]
      }
    }
    // apiKey 为掩码时视为不修改
    const apiKey = patch.embedding.apiKey
    if (typeof apiKey === 'string' && apiKey !== '' && !apiKey.includes('•')) {
      picked.apiKey = apiKey
    }
    if (Object.keys(picked).length > 0) overlay.embedding = picked
  }

  for (const [path, keys] of Object.entries(SECTION_KEYS)) {
    const incoming = readPath(patch, path)
    if (incoming === null || typeof incoming !== 'object') continue
    const picked = {}
    for (const key of keys) {
      const value = incoming[key]
      if (value === undefined) continue
      // 掩码值 = 前端回显的占位符，用户没动这个字段。
      // 不跳过的话，delta 过滤会认为「真 key → ••••••••」是一次改动，
      // 把密钥写成八个圆点 —— 之后连接 401，而配置里看起来有 key。
      if (isMaskedSecret(value)) continue
      if (!changed(`${path}.${key}`, value)) continue
      picked[key] = value
    }
    if (Object.keys(picked).length === 0) continue
    // 'diary.semantic' 要还原成嵌套结构写盘，否则下次读取时路径对不上
    const parts = path.split('.')
    let node = overlay
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (node[parts[i]] === null || typeof node[parts[i]] !== 'object') node[parts[i]] = {}
      node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = picked
  }
  return overlay
}

function serializeFrontmatter(frontmatter, body) {
  const lines = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`)
      else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${JSON.stringify(String(item))}`)
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value ?? ''))}`)
    }
  }
  lines.push('---', '')
  return `${lines.join('\n')}${body}`
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
