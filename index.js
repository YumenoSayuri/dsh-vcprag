/**
 * dsh-vcprag — 记忆召回插件。
 *
 * 三层注入通道：
 *   1. 常驻记忆 → systemPrompt.section()  内容恒定，零缓存代价
 *   2. 长文档召回 → systemPrompt.context() 尾部追加，被冻结机制压制
 *   3. 6 个工具  → ctx.tools.register()   模型按需调用
 *
 * 语料只读，索引另存于独立的 dataDir（与插件代码目录分离）。
 *
 * @module dsh-vcprag
 */

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

import { resolveConfig, loadAliases, mergeConfigOverlay, runtimeFilePath } from './lib/config.js'
import { Indexer } from './lib/indexer.js'
import { RecallFridge } from './lib/freeze.js'
import { registerInjections, readRuntimeSectionSync } from './lib/inject.js'
import { attachMessageChannel, itemKeyOf, parseItemKeys, surfacedItems } from './lib/message-channel.js'
import { createTools } from './lib/tools.js'
import { recall, renderRecallBlock } from './lib/recall.js'
import { registerRpc } from './lib/rpc.js'
import { createDiarySink } from './lib/diary-sink.js'
import { createJudge, createFetchTransport, createProxyTransport } from './lib/relevance-judge.js'

export const name = 'vcprag'
// webServer 必须声明：rpc.js 里用 ctx.get('webServer') 注册 UI 端点。
// 不声明就拿不到服务（返回 undefined），registerRpc 会静默 return，
// 结果是 UI 能打开但每个请求都 404/401 → 永远"读取状态…"、0 篇文档。
// tools 通过 ctx.inject(['tools'], ...) 动态取，不需要写在这里。
export const inject = ['systemPrompt', 'webServer']

/**
 * 插件入口。
 *
 * @param {object} ctx
 * @param {object} rawConfig - cordis.patch.yml 的 config 段
 */
export function apply(ctx, rawConfig) {
  /** 诊断日志。日志通道不可用时静默。 */
  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('vcprag') : ctx.logger
      const write = logger?.[level]
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      /* 忽略 */
    }
  }

  // ---- 配置：patch.yml → 磁盘覆盖层 → 解析 ----
  //
  // 这里必须**同时保留两份**，它们回答的是两个不同的问题：
  //
  //   baseConfig  = 只解析 patch.yml（不含 UI 覆盖层）
  //                 → 「部署时写死的是什么」
  //   config      = patch.yml + 覆盖层
  //                 → 「现在实际生效的是什么」
  //
  // 覆盖层（dataDir/config.json）保存的是「UI 改过、且和 patch.yml 不同」
  // 的项。判断「是否不同」必须拿 baseConfig 比 —— 曾经拿 config 比，
  // 于是出现了一个会把设置吃掉的 bug：
  //
  //   第 1 次保存：judge 还没生效 → delta 含 judge → 写进 overlay ✅
  //   重启后：judge 生效了
  //   第 2 次保存（只改了 maxMessages）：judge 与「当前值」相同 →
  //            delta 里没有 judge → **整份 overlay 被覆盖成只有
  //            maxMessages** → judge 的 URL/key/开关全丢 ❌
  //
  // 用户看到的就是「每次重启设置都没了」。实际上是「每次保存都会
  // 把上一次保存的东西抹掉」，只是重启才暴露出来。
  const baseConfig = resolveConfig(rawConfig ?? {})
  let config = resolveConfig(mergeConfigOverlay(baseConfig.dataDir, rawConfig ?? {}))
  config.aliases = loadAliases(config.dataDir)

  log('info', `apply() 语料=${config.corpusRoot} 日记=${config.diaryRoot} 数据目录=${config.dataDir}`)
  log('info', `runtime 记忆文件=${runtimeFilePath(config)}`)

  try {
    mkdirSync(join(config.dataDir, 'index'), { recursive: true })
  } catch (error) {
    log('error', `数据目录创建失败：${error?.message ?? error}`)
  }

  /** 取当前配置。UI 改配置后这里返回新值，无需重启。 */
  const getConfig = () => config

  // ---- 索引 ----
  const indexer = new Indexer({
    indexDir: join(config.dataDir, 'index'),
    getConfig,
    log,
  })

  // ---- 冻结状态机（每个会话一个实例由 rpc/session 层管理，这里持默认）----
  /** @type {Map<string, RecallFridge>} sessionId → fridge */
  const fridges = new Map()
  const fridgeFor = (sessionId) => {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '__default__'
    let fridge = fridges.get(key)
    if (fridge === undefined) {
      fridge = new RecallFridge()
      fridges.set(key, fridge)
      // 防御：会话太多时清理最旧的
      if (fridges.size > 64) {
        const oldest = fridges.keys().next()
        if (!oldest.done) fridges.delete(oldest.value)
      }
    }
    return fridge
  }
  /** 列出所有会话的冻结快照，供 UI 展示（fridgeFor 是函数，快照另挂一个方法）。 */
  fridgeFor.snapshots = () => {
    const out = []
    for (const [sessionId, fridge] of fridges) out.push({ sessionId, ...fridge.snapshot() })
    return out
  }

  // ---- 异步启动加载（不阻塞插件 apply）----
  indexer
    .load()
    .then((result) => {
      log('info', `索引加载完成：${result.chunkCount} chunk / ${result.docCount} 文档`)
      if (result.compatible.ok !== true) {
        log('warn', `索引降级：${result.compatible.message ?? result.compatible.reason}`)
      }
    })
    .catch((error) => log('error', `索引加载失败：${error?.message ?? error}`))

  /**
   * 按当前配置造一个裁判实例。**每次召回都重建**是有意的：
   * 用户在设置面板改完阈值应该立刻生效，不需要重启插件。
   * 构造本身只是几个对象字面量，开销可忽略（词典/连接池都在 transport 之外）。
   *
   * 密钥只从环境变量读，**绝不落进配置文件** —— 配置文件会被 UI 读出来
   * 回显到浏览器，写在那里等于把 key 摊在面板上。
   */
  const buildJudge = (current) => {
    const settings = current.judge ?? {}
    if (settings.enabled !== true) return null

    // 两项来源：配置文件（面板可改）与环境变量。
    //
    // **环境变量优先**，不是配置文件优先。理由：环境变量是显式部署动作
    // （CI、容器、临时换 key），配置文件可能被面板回显/整体回写，
    // 让「我明明在环境里设了」被一个陈旧的配置值盖掉会更难排查。
    // 面板留空则自动回落到环境变量，所以两种用法互不干扰。
    const pick = (fromConfig, envName, fallback) => {
      const env = process.env[envName]
      if (typeof env === 'string' && env.trim() !== '') return env.trim()
      if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
      return fallback
    }

    const apiKey = pick(settings.apiKey, 'VCPRAG_JUDGE_KEY', '')
    const url = pick(settings.baseUrl, 'VCPRAG_JUDGE_URL', 'https://api.typesafe.ai/v1/systemone')
    const model = pick(settings.model, 'VCPRAG_JUDGE_MODEL', 'jev-latest')
    const proxyUrl = pick(settings.proxyUrl, 'VCPRAG_JUDGE_PROXY', '')

    // 开了开关但没给 key：**不要静默降级成「关着」**，那样用户会以为
    // 裁判在跑。返回一个 enabled=false 的实例没有意义，直接 null，
    // 但日志里必须说话 —— 否则「为什么裁判没生效」又是一次无头排查。
    if (apiKey === '') {
      log('warn', 'judge.enabled=true 但既没在面板填 API Key、也没设 VCPRAG_JUDGE_KEY，本轮按关闭处理')
      return null
    }

    // 官方端点对部分地区返回 451（Typesafe is not available in your
    // region），直连永远不通、且失败是静默的（applied:false）。
    // 所以有代理就直接走 CONNECT 隧道 —— 这是「开关能不能真的生效」
    // 的分水岭，不是可选优化。
    const transport = proxyUrl === ''
      ? createFetchTransport({ url, apiKey, model })
      : createProxyTransport({ url, apiKey, model, proxyUrl })

    log('info', `judge transport: ${proxyUrl === '' ? '直连' : `代理 ${proxyUrl}`} → ${url} (${model})`)

    return createJudge({
      ...settings,
      enabled: true,
      transport,
    })
  }

  /**
   * 跑一次召回，供注入通道在 assemble 时调用。
   *
   * 独立成函数（而不是内联在 maybeRefresh 里），因为注入通道要在
   * `system-prompt/assemble` 里 await 它 —— 它必须能被随时调用，
   * 不依赖任何「事件先到」的前置条件。
   *
   * @param {string} sessionId
   * @param {string} query
   * @returns {Promise<{ hits: object[] }>}
   */
  const runRecall = async (sessionId, query) => {
    const current = getConfig()
    const judge = buildJudge(current)
    return recall(query, {
      bm25: indexer.bm25,
      vectors: indexer.vectors,
      embedder: indexer.embedder,
      chunks: indexer.chunks,
      aliases: current.aliases,
      config: current,
      // 传 null 与不传等价（recall 里判的是 undefined/null）。显式传 null
      // 是为了让「关着」这件事在调用点就可见，而不是靠字段缺失隐式表达。
      judge: judge,
    })
  }

  // ---- 通道 1 / 2 / 3：注入（prompt 侧）----
  //
  // 通道 3 必须拿到 fridgeFor（而不是单个 fridge 实例）：
  // systemPrompt 的注册是全局 layer，text() 回调靠 context.agent.session
  // 区分会话，所以冻结状态也得按会话取。
  //
  // 返回值里的 ensureInjection 给消息通道复用 —— 两种注入模式必须共用
  // 同一个召回实现，否则冻结状态会分叉成两套。
  const { ensureInjection } = registerInjections(ctx, {
    getConfig,
    fridgeFor,
    runRecall,
    renderRecallBlock,
    log,
    // 条目级去重的两个依赖。只对 message 模式生效 ——
    // prompt 模式每轮替换整个 context 块，过滤反而会造成「越注越少」。
    itemKeyOf,
    surfacedItems,
    parseItemKeys,
  })

  // ---- 通道 1'/2'：同一批内容的「消息」注入模式 ----
  //
  // 上游反代有时做 system prompt 指纹检测，命中就清空 system —— 这时
  // section/context 全丢，模型彻底失去人设与记忆。消息在对话历史里，
  // 不受影响。设置里可把常驻记忆、召回各自切到 message 模式。
  attachMessageChannel(ctx, {
    getConfig,
    getRuntimeText: () => readRuntimeSectionSync(getConfig()),
    getRecallText: (sessionId, assembleContext) => ensureInjection(sessionId, getConfig(), assembleContext),
    log,
  })

  // ---- 通道 1.5：语义写入（正文里的结构化块 → 日记）----
  //
  // 这条通道比 tool call 更"语义级"：模型在正文里写 <<<DailyNoteStart>>>…
  // 直接落盘，不必先发起一次函数调用、再把同样的正文塞进 JSON 参数里
  // 重写一遍。少一轮往返、少一次转义风险，而且块本身人眼可读可校对。
  //
  // 两条事件都挂，因为它们的时机不同、可靠性不同：
  //   session/event        assistant/message 一落库就来，最早
  //   agent/turn-stopping  回合收尾，作为兜底（上一条若因特殊路径漏掉）
  // 用指纹去重，两条都触发也只会写一次。
  const diarySink = createDiarySink({ getConfig, indexer, log })
  attachSemanticSink(ctx, { sink: diarySink, getConfig, log })

  // ---- 通道 3：工具 ----
  if (config.tools.enabled) {
    ctx.inject(['tools'], (child) => {
      const tools = createTools({ getConfig, indexer, fridge: fridgeFor(undefined) })
      child.effect(
        () => tools.map((tool) => child.tools.register(tool)),
        'vcprag: tools',
      )
      log('info', `已注册 ${tools.length} 个记忆工具`)
    })
  }

  // ---- RPC（UI 面板）----
  if (config.panelEnabled) {
    registerRpc(ctx, {
      getConfig,
      setConfig: (next) => {
        config = next
      },
      // 保存时的 delta 基准：「部署配置」而不是「当前生效配置」。
      //
      // 覆盖层语义是「相对 patch.yml 改了什么」。拿当前生效值当基准，
      // 任何一项只要已经写进覆盖层，下次保存就会被判成「没变」而剔除，
      // 于是**整份覆盖层被后一次保存覆盖掉**。见上面的长注释。
      getBaseConfig: () => baseConfig,
      indexer,
      fridgeFor,
      log,
      corpusRootOf: () => getConfig().corpusRoot,
      // 召回调试 Tab 也要跑裁判。
      //
      // 之前没传：`/recall` 端点自己拼 recall 参数时漏了 judge，于是
      // 调试面板的 timing.judge 恒为 null，看着像「裁判没接进链路」。
      // 让它和注入路径共用同一个 buildJudge —— 两条路各自拼参数就会分叉，
      // 而分叉在两个方向上都危险：调试面板看不到裁判的作用，
      // 或者调试面板在跑裁判而真实注入没跑。
      buildJudge,
    })
  }

  // ---- 会话生命周期 ----
  try {
    ctx.on('session/end', (payload) => {
      const sessionId = payload?.session?.id ?? payload?.sessionId
      if (typeof sessionId === 'string') fridges.delete(sessionId)
    })
  } catch {
    /* 事件不存在时忽略 */
  }

  // 暴露给测试与 RPC。
  //
  // 注意这里**不再有 maybeRefresh**：召回不再由「某个外部调用方记得来推」
  // 驱动，而是挂在 `system-prompt/assemble` 上自己拉。少一个调用约定，
  // 就少一个「代码写了但没人调用、面板显示 0」的故障面。
  ctx.provide?.('vcprag', {
    indexer,
    fridgeFor,
    runRecall,
    getConfig,
    // 供 RPC 面板「手动召回一次」按钮使用
    injectNow: (sessionId, query) => runRecall(sessionId, query),
  })
}

/**
 * 挂载语义写入的两条事件监听。
 *
 * 为什么要两个入口：DSH 的 assistant 消息会先以 `session/event`
 * （type = "assistant/message"）落库，随后回合收尾触发 `agent/turn-stopping`。
 * 正常路径下前者一定先到；但恢复场景（renderer recovery、会话重放）里
 * 可能只补发后者。两个都挂 + 指纹去重，既不漏也不重。
 *
 * 全部包在 try/catch 里：语义写入是「锦上添花」，
 * 它挂掉绝不能让整轮对话或会话启动失败。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {{ consume: Function }} deps.sink
 * @param {() => object} deps.getConfig
 * @param {Function} deps.log
 */
function attachSemanticSink(ctx, deps) {
  const { sink, getConfig, log } = deps

  if (getConfig()?.diary?.semantic?.enabled !== true) {
    log('info', '语义写入未启用（diary.semantic.enabled = false）')
    return
  }

  /**
   * 把 assistant 消息的 content 拍平成纯文本。
   *
   * content 可能是 string，也可能是 block 数组（text / tool-result 混合）。
   * 只取 text 块 —— 语义块只可能出现在模型自己写的正文里。
   */
  const blocksText = (content) => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((block) => {
        if (block === null || typeof block !== 'object') return ''
        if (block.type === 'text' && typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  /** 统一的投递入口。fire-and-forget，失败只记日志。 */
  const deliver = (text, meta) => {
    if (typeof text !== 'string' || !text.includes('<<<')) return
    Promise.resolve()
      .then(() => sink.consume(text, meta))
      .catch((error) => log('warn', `语义写入异常：${error?.message ?? error}`))
  }

  // ---- 入口 A：session/event 的 assistant/message ----
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object') return
        if (event.type !== 'assistant/message') return
        const message = event.data?.message
        if (message === null || typeof message !== 'object') return

        // 跳过工具调用产生的中间消息：那里的 text 是框架写的，不是模型正文
        if (message.role !== undefined && message.role !== 'assistant') return

        deliver(blocksText(message.content), {
          sessionId: session?.id ?? session?.sessionId ?? event.data?.sessionId,
          messageId: message.id,
          turn: event.data?.turn ?? event.turn,
          source: 'session/event',
        })
      } catch (error) {
        log('warn', `session/event 处理失败：${error?.message ?? error}`)
      }
    })
    log('info', '语义写入已挂载（session/event → assistant/message）')
  } catch (error) {
    log('warn', `session/event 监听注册失败：${error?.message ?? error}`)
  }

  // ---- 入口 B：agent/turn-stopping 兜底 ----
  try {
    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const messages = payload?.messages ?? payload?.events
        if (!Array.isArray(messages)) return
        for (const item of messages) {
          const message = item?.message ?? item
          if (message?.role !== 'assistant') continue
          deliver(blocksText(message.content), {
            sessionId: payload?.session?.id ?? payload?.sessionId,
            messageId: message.id,
            turn: payload?.turn,
            source: 'agent/turn-stopping',
          })
        }
      } catch (error) {
        log('warn', `agent/turn-stopping 处理失败：${error?.message ?? error}`)
      }
    })
    log('info', '语义写入已挂载（agent/turn-stopping 兜底）')
  } catch (error) {
    // 事件不存在时静默 —— 不同 DSH 版本事件集不同，不该因此报错
  }
}

// 注：原先这里有个 `queryFromEvent(event)`，配合 `maybeRefresh` 用。
// 两者都已删除 —— 召回改成在 `system-prompt/assemble` 里从会话事件
// 自行推导查询（见 lib/inject.js 的 pickTrigger / readSessionState），
// 不再依赖任何「谁记得在事件里推一把」的外部约定。
