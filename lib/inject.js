/**
 * 注入通道。
 *
 *   通道 1  runtime 记忆     → systemPrompt.section()   常驻，逐字节恒定 → 缓存安全
 *   通道 2  日记写作规范     → systemPrompt.section()   常驻，纯静态
 *   通道 3  长文档召回       → systemPrompt.context()   尾部追加，被冻结压制
 *   通道 4  6 个工具         → ctx.tools.register()     模型按需调用
 *
 * 通道 1 之所以必须走 section 而不是 context：常驻记忆是长期稳定的核心设定。
 * 走 context 意味着每轮重新注入整段文本 → 每轮都 miss，且某轮召回失败就丢失设定。
 * 走 section 一次写入永久命中。
 *
 * 日记规范（通道 2）同理走 section —— 它是纯静态提示词，每轮一字不差，
 * 自然命中缓存；放 context 会每轮多付一次全量 token。
 *
 * 代价：用户手改 runtime 记忆会改变 system 消息 → 触发一次头部 replace。
 * 这是低频手动操作，可接受。
 *
 * @module dsh-vcprag/inject
 */

import { readFileSync, existsSync } from 'node:fs'
import { runtimeFilePath } from './config.js'
import { resolveDiaryTemplate } from './diary-template.js'

/** section 名。改这个会导致缓存重建，不要随意动。 */
const RUNTIME_SECTION = 'vcprag:runtime'
const DIARY_SECTION = 'vcprag:diary'
const DOCS_CONTEXT = 'vcprag:recall'

/** 工具用法说明。**必须是常量**——任何动态内容都会打穿前缀缓存。 */
const TOOL_GUIDANCE = `## 记忆工具（vcprag）

你有 6 个记忆工具，用于访问本地长期记忆库（历史排障记录、配置决策、环境事实）。

- \`vcprag_search\` 检索历史记忆。**对话中通常已自动注入相关记忆**，只有在自动注入不足时才需要主动调用。
- \`vcprag_read\` 按 docId 读全文。先 search 拿到 docId。
- \`vcprag_write\` 写日记 / 记值得长期保留的结论、排障过程、配置决策。
- \`vcprag_list\` 列出已有文档，可按关键词过滤。
- \`vcprag_forget\` 把过时或有误的记忆归档（不物理删除）。
- \`vcprag_status\` 查看索引状态。

写记忆的判断标准：**下次遇到同类问题时，这条记录能不能省下重新排查的时间。**`

/**
 * 渲染 runtime 记忆为 section 文本。
 *
 * 严格按 importance 排序后拼接，**不插入任何时间戳或计数器** ——
 * 那会让每次组装都产出不同文本，直接打穿前缀缓存。
 *
 * @param {import('./corpus.js').RuntimeMemory[]} memories
 * @param {object} [runtimeConfig] - config.runtime（标题/引导语可自定义）
 * @returns {string}
 */
export function renderRuntimeSection(memories, runtimeConfig = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return ''

  const title = runtimeConfig.title || '## 长期记忆（runtime）'
  const intro = runtimeConfig.intro || '以下是与用户相关的长期事实与偏好，**在任何回复中都应遵守**。'
  const criticalTitle = runtimeConfig.criticalTitle || '### 必须遵守'
  const normalTitle = runtimeConfig.normalTitle || '### 一般事实'
  const withTools = runtimeConfig.toolGuidance !== false

  const critical = memories.filter((memory) => memory.importance === 'critical')
  const normal = memories.filter((memory) => memory.importance !== 'critical')

  const lines = [title, '', intro, '']

  if (critical.length > 0) {
    lines.push(criticalTitle, '')
    for (const memory of critical) lines.push(`- ${memory.content}`)
    lines.push('')
  }
  if (normal.length > 0) {
    lines.push(normalTitle, '')
    for (const memory of normal) lines.push(`- ${memory.content}`)
    lines.push('')
  }

  if (withTools) lines.push(TOOL_GUIDANCE)
  return lines.join('\n')
}

/**
 * 读 runtime 记忆（供 section 的 text 回调同步调用）。
 *
 * 用同步读：section 的 text 回调由同步的 assemble 流程调用，
 * 返回 Promise 会被当成文本字符串。文件很小（几 KB），同步读在毫秒级。
 *
 * @param {import('./config.js').ResolvedConfig} config
 * @returns {string} 渲染好的 section 文本
 */
export function readRuntimeSectionSync(config) {
  const path = runtimeFilePath(config)
  if (!existsSync(path)) return ''
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const memories = entries
      .filter((entry) => typeof entry?.content === 'string' && entry.content.trim() !== '')
      .map((entry) => ({
        content: entry.content.trim(),
        importance: entry.importance === 'critical' ? 'critical' : 'normal',
      }))
    return renderRuntimeSection(memories, config.runtime)
  } catch {
    return ''
  }
}

/**
 * 注册全部注入通道。
 *
 * @param {object} ctx - DSH 插件上下文
 * @param {object} deps
 * @param {() => import('./config.js').ResolvedConfig} deps.getConfig
 * @param {(sessionId: string|undefined) => import('./freeze.js').RecallFridge} deps.fridgeFor
 *   按会话取冻结状态机。**不能传单个实例**：DSH 的 assemble 是全局 layer，
 *   section/context 的 text() 由所有会话共享注册，必须靠 context 参数区分会话。
 * @param {(sessionId: string, query: string) => Promise<object>} [deps.runRecall]
 *   跑一次召回（返回 { hits, ... }），由 index.js 注入。
 * @param {(hits: object[], options: object) => string} [deps.renderRecallBlock]
 *   把命中渲染成注入文本。
 * @param {(level: string, message: string) => void} deps.log
 */
export function registerInjections(ctx, deps) {
  const { getConfig, fridgeFor, runRecall, renderRecallBlock, log } = deps

  /**
   * 条目级去重用到的两个外部依赖，都是可选的。
   *
   * 单独收成一个对象而不是直接解构，是为了让「没传」的语义明确：
   * 测试里只关心召回逻辑时可以不传，此时过滤整体跳过（等价于旧行为），
   * 而不是因为 `undefined is not a function` 把组装打断。
   */
  const dedupe = {
    itemKeyOf: typeof deps.itemKeyOf === 'function' ? deps.itemKeyOf : null,
    surfacedItems: typeof deps.surfacedItems === 'function' ? deps.surfacedItems : null,
    parseItemKeys: typeof deps.parseItemKeys === 'function' ? deps.parseItemKeys : null,
  }

  /** 从 assemble 上下文里取会话 id。拿不到就返回空串，绝不回落成全局桶。 */
  const sessionIdOf = (context) => {
    const id = context?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : ''
  }

  // ---------------------------------------------------------- 通道 1：常驻
  //
  // **一律注册**，是否真的产出文本由 text() 在每轮组装时现读配置决定。
  //
  // 早先的写法是「mode/开关在注册时判一次，不符合就不注册」，结果把
  // 注入位置当成了启动期常量。可配置是热更新的（UI 一点就写 overlay），
  // 于是运行中切到 message 会变成：section 已注册但被判空、消息通道
  // 因为启动时是 prompt 而压根没挂 —— 两边都空，召回彻底消失。
  //
  // 现在改成：注册是静态的（成本为零，空串不产生 token），
  // 决策是每轮的（getConfig() 读最新值）。
  const config = getConfig()
  try {
    ctx.systemPrompt.section({
      name: RUNTIME_SECTION,
      order: config.runtime.order,
      // 不做变量插值：记忆内容里可能有 ${} 或 {{}}，会被误解析
      interpolate: false,
      text: () => {
        const current = getConfig()
        // 关掉 / 改走对话消息 → section 让位，空串不产生任何 token
        if (current.runtime.inject !== true) return ''
        if (current.runtime.mode === 'message') return ''
        try {
          return readRuntimeSectionSync(current)
        } catch (error) {
          log('warn', `runtime section 渲染失败：${error?.message ?? error}`)
          // 失败时返回空串而不是保留旧内容 —— 空串是稳定输出，不影响缓存
          return ''
        }
      },
    })
    log(
      'info',
      `runtime 常驻 section 已注册（order=${config.runtime.order}；` +
        `当前位置=${config.runtime.mode === 'message' ? 'message' : 'section'}，运行中可切）`,
    )
  } catch (error) {
    log('error', `runtime section 注册失败：${error?.message ?? error}`)
  }

  // ------------------------------------------------- 通道 2：日记写作规范
  const diaryTemplate = resolveDiaryTemplate(config.diary)
  if (diaryTemplate !== '') {
    try {
      ctx.systemPrompt.section({
        name: DIARY_SECTION,
        order: config.diary.templateOrder,
        interpolate: false,
        // 模板是纯静态文本（改了要重启），所以直接闭包捕获，不做每轮 IO
        text: () => diaryTemplate,
      })
      log('info', `日记规范注入已注册（order=${config.diary.templateOrder}，${diaryTemplate.length} 字）`)
    } catch (error) {
      log('error', `日记规范 section 注册失败：${error?.message ?? error}`)
    }
  }

  // ---------------------------------------------------------- 通道 3：动态召回
  //
  // 这里有两个必须讲清楚的机制，否则会写成一个永不生效的通道：
  //
  // 1) `context.text()` 是**同步**求值的，而且发生在 `assemble()` 里、
  //    在 `system-prompt/assemble` waterfall **之前**。所以想在注入前
  //    await 一次召回，靠 text() 是做不到的（返回 Promise 会被当成
  //    字符串塞进去）。
  //
  // 2) 注册在插件 ctx 上的 section/context 是**全局 layer**，所有会话
  //    共用同一条注册。要靠 `context.agent.session` 区分会话，
  //    不能给某一个固定 sessionId 开个闭包。
  //
  // 官方 `working-directory` 就是这么做的：text() 返回空串占位，
  // 真正的文本在 waterfall 里 `await next()` 之后回填 assembly.contexts。
  // `{ prepend: true }` 让本监听排在其它监听之前，保证我们 mutate 的
  // contexts 数组是 `next()` 已经填好的那一份。
  //
  // **一律注册**，理由同上：注册是静态的，走哪条通道是每轮的决策。
  try {
    ctx.systemPrompt.context({
      name: DOCS_CONTEXT,
      order: config.inject.order,
      interpolate: false,
      // 占位：真正的内容由下面的 waterfall 监听填入。
      // 这里不返回 fridge 文本，因为此回调拿不到「已完成召回」的状态。
      text: () => '',
    })
    log(
      'info',
      `长文档动态 context 已注册（order=${config.inject.order}；` +
        `当前位置=${config.inject.mode === 'message' ? 'message' : 'context'}，运行中可切）`,
    )
  } catch (error) {
    log('error', `context 注册失败：${error?.message ?? error}`)
  }

  /**
   * 在 prompt 组装上挂召回。
   *
   * 流程：先让其它监听跑完（next()），再针对**本会话**做一次召回判定，
   * 把渲染结果写进对应 context 条目的 text。
   *
   * **一律挂载**：是否真的注入由每轮读到的 config 决定（见下面的三个
   * return）。早先在注册时判一次 mode，导致运行中切到 message 后
   * 这个钩子不存在，而消息通道又是在启动期决定挂不挂 —— 两边都空。
   *
   * 全流程包 try/catch：召回失败绝不能阻断对话，最差就是不注入。
   */
  try {
    ctx.on(
      'system-prompt/assemble',
      async (assembly, context, next) => {
        // 先取下游结果，保证 assembly.contexts 已经完整
        const resolved = await next()

        const sessionId = sessionIdOf(context)
        if (sessionId === '') return resolved

        const current = getConfig()
        if (current.inject.enabled !== true) return resolved
        // 走对话消息时这里让位（占位条目本来就是空串，不必清）
        if (current.inject.mode === 'message') return resolved

        // 冻结：每个会话一个状态机。这里只是「要不要重算」的判定，
        // 真正的召回放在 ensureInjection 里，热路径能直接命中缓存。
        let text = ''
        try {
          text = await ensureInjection(sessionId, current, context)
        } catch (error) {
          log('warn', `召回注入失败（${sessionId}）：${error?.message ?? error}`)
          return resolved
        }
        if (typeof text !== 'string' || text === '') return resolved

        const entry = resolved.contexts.find((item) => item.name === DOCS_CONTEXT)
        if (entry === undefined) {
          resolved.contexts.unshift({ name: DOCS_CONTEXT, text, interpolate: false })
        } else {
          entry.text = text
          entry.interpolate = false
        }
        return resolved
      },
      // 必须在其它监听之前：我们要 mutate 的是 next() 返回的最终数组
      { prepend: true },
    )
    log('info', '召回组装钩子已挂载（system-prompt/assemble；运行中可切）')
  } catch (error) {
    log('error', `召回组装钩子注册失败：${error?.message ?? error}`)
  }

  /**
   * 确保本会话的注入文本是最新的，并返回它。
   *
   * 判定维度只看「会话里出现过什么」，不看时间：
   *   - 会话首个回合 → 必须召回一次（否则整个会话零注入）
   *   - 有新的用户消息 → 用新消息重新召回
   *   - todo 出现新勾选 → 阶段推进，重新召回
   *
   * 其余情况直接返回已冻结的文本。这样模型连续自转的回合
   * （用户不说话）不会每轮重算，也不会每轮改写 prompt 尾部，
   * 前缀缓存保持命中。
   *
   * @param {string} sessionId
   * @param {object} current - 当前解析后配置
   * @param {object} assembleContext - DSH 传来的组装上下文（含 agent / signal）
   * @returns {Promise<string>}
   */
  async function ensureInjection(sessionId, current, assembleContext) {
    const fridge = fridgeFor(sessionId)
    const signal = assembleContext?.signal

    // 先把「本会话已经走到哪」从 session 事件里读出来，
    // 这样即使插件是在会话中途才加载（或重启后恢复旧会话），
    // 也不会因为错过历史事件而永远停在首回合判定上。
    //
    // 第三个参数是本步**已认领但可能还没落库**的用户消息 —— 见 pickTrigger
    // 里那段注释，它修的是「一次输入注入两块」。
    const trigger = pickTrigger(assembleContext?.agent?.session, fridge, assembleContext?.liveUser)

    // 触发条件不变且已冻结 → 直接复用，零召回开销
    if (trigger.refresh !== true && fridge.frozen) {
      return fridge.currentText()
    }

    const query = trigger.query
    if (query === '') {
      // 没有可用查询：首次也要标记「已尝试过」，否则每次组装都重试
      if (!fridge.frozen) fridge.freeze({ text: '', reason: 'no-query', hits: [] })
      return fridge.currentText()
    }

    if (signal?.aborted === true) return fridge.currentText()

    const result = await runRecall(sessionId, query)

    // 记下触发点，避免同一触发重复召回。
    // 第三个参数是「本次观察到的用户消息键」，与 trigger.key 分开记 ——
    // 否则 phase-change 之后同一条用户消息会被再召一次。
    fridge.markTrigger(trigger.key, trigger.completedCount, trigger.userKey)

    // ---- 条目级去重：把已经在上下文里的条目筛掉 ----
    //
    // 只对 message 模式做。prompt 模式每轮**替换**整个 context 块，
    // 旧条目自然消失，过滤反而会让后面的轮次越注越少（同一个会话里
    // 用户追问同一个主题，第二次就不给任何东西了 —— 那是过度去重）。
    //
    // 判据取并集：
    //   - fridge.surfacedItems：本进程内注入过的（最准，含刚注入还没落库的）
    //   - callbacks.surfacedItems(session)：历史里已落库的（跨重启仍有效）
    const isMessageMode = current.inject.mode === 'message'
    let alreadyItems = null
    if (isMessageMode) {
      alreadyItems = new Set(fridge.surfacedItemKeys())
      try {
        const fromHistory = dedupe.surfacedItems?.(assembleContext?.agent?.session, 'recall')
        if (fromHistory !== undefined && fromHistory !== null) {
          for (const key of fromHistory) alreadyItems.add(key)
        }
      } catch (error) {
        log('warn', `读取历史条目失败（不影响本次召回）：${error?.message ?? error}`)
      }
    }

    // 渲染前过滤。抽成 deps 里的函数是为了让「已呈现就不给」这条
    // 与 message-channel 的 itemKeyOf 共用同一个定义 —— 两处各自实现
    // 一份身份规则，迟早会不一致。
    const pickKey = dedupe.itemKeyOf
    const freshHits = alreadyItems === null || typeof pickKey !== 'function'
      ? result.hits
      : result.hits.filter((hit) => {
          const key = pickKey(hit)
          return key === '' || !alreadyItems.has(key)
        })

    const dedupedAway = result.hits.length - freshHits.length

    const rendered = renderRecallBlock(freshHits, {
      reason: trigger.reason,
      maxChars: current.recall.maxChars,
      blockName: current.inject.blockName,
      header: current.inject.header,
      disclaimer: current.inject.disclaimer,
      itemPrefix: current.inject.itemPrefix,
    })

    // **零命中不冻结**。冻结空串会让这个会话永久零注入，
    // 即使用户接着说了更相关的话也没机会再召回。实测踩到过。
    //
    // 「全部条目都已呈现」也走这条路：不注入、不冻结。
    // 冻结一个空块会让后面真的出现新条目时也送不进去。
    if (rendered === '' || freshHits.length === 0) {
      const why = dedupedAway > 0 ? `全部 ${dedupedAway} 条已呈现过` : '零命中'
      log('info', `召回${why}（${trigger.reason}），不冻结，下个触发点可重试`)
      return fridge.currentText()
    }

    // 只有**真的进了文本**的条目才算已呈现。
    //
    // renderRecallBlock 会按 maxChars 预算截断，被截掉的条目没有进上下文，
    // 若把它们也记为已呈现，它们就永远没机会出现了。
    //
    // 判定方式：不拿 hit.title 去 `rendered.includes(...)` —— 标题为空、
    // 标题互为子串、或标题在正文里也出现过时，那种写法会误判。改为
    // **从渲染结果里反解条目**，与 itemPrefix 的渲染规则保持一致
    // （message-channel 识别历史消息时用的是同一个函数）。
    const renderedKeys = typeof dedupe.parseItemKeys === 'function'
      ? dedupe.parseItemKeys(rendered)
      : []
    fridge.markSurfacedItems(renderedKeys)

    fridge.freeze({ text: rendered, reason: trigger.reason, hits: freshHits })

    // 日志必须能回答「这次召回质量为什么可疑」。
    //
    // 旧日志只有「5 条 / 4102 字」，完全看不出：
    //   - 语义通道跑没跑（可能因 apiKey / 索引未就绪被整个跳过）
    //   - 词法和语义各贡献了多少候选
    //   - 命中的是双字词（有区分度）还是一堆单字（没区分度）
    // 结果就是用户看到「召回的全是无关文档」而日志一片祥和，无从下手。
    const timing = result.timing ?? {}
    // 闸门剔除数分项打：「被余弦剔」和「被实词剔」是两回事，
    // 混成一个数字的话，看到「闸门剔 0」就无法判断到底是闸门没生效、
    // 还是这道闸门本来就没用。v0.2.2 就踩过这个坑 —— 日志里
    // 「闸门剔 27」看着像在干活，实际那些是 requireSemantic 剔的，
    // minSemantic 一条都没拦住。
    const gateParts = []
    if ((timing.gatedByToken ?? 0) > 0) gateParts.push(`实词 ${timing.gatedByToken}`)
    if ((timing.gatedBySemantic ?? 0) > 0) gateParts.push(`语义 ${timing.gatedBySemantic}`)
    const gateDetail = gateParts.length > 0 ? `（${gateParts.join(' + ')}）` : ''
    const detail = [
      `词法 ${timing.lexicalCount ?? '?'}`,
      `语义 ${timing.semanticCount ?? 0}`,
      `融合 ${timing.fusedCount ?? '?'}`,
      `去重后 ${timing.dedupedCount ?? '?'}`,
      `闸门剔 ${timing.gatedOut ?? 0}${gateDetail}`,
      `分词 ${timing.tokenizer ?? '?'}`,
    ].join(' / ')
    const skip = timing.semanticSkipped ? `；语义通道跳过：${timing.semanticSkipped}` : ''
    // 闸门把候选全剔光 = 语料里确实没有相关内容。这跟「索引坏了」
    // 表现一样是「0 条」，必须明确区分，否则下次排查又会绕远路。
    const gatedAll = result.hits.length === 0 && (timing.gatedOut ?? 0) > 0
      ? `；ℹ️ 全部候选未过相关性闸门（${timing.gatedBy ?? '?'}），本次不注入`
      : ''
    // 命中 token 里单字占比高 = 这条召回主要靠「常见字」凑出来的，可信度低
    const matchedAll = result.hits.flatMap((hit) => hit.matched ?? [])
    const singles = matchedAll.filter((token) => token.length === 1).length
    const singleRatio = matchedAll.length === 0 ? 0 : singles / matchedAll.length
    const quality = singleRatio >= 0.5
      ? `；⚠️ 命中 token 单字占比 ${Math.round(singleRatio * 100)}%，可能靠常见字凑出`
      : ''

    // 把「这次到底拿什么当查询」也打出来。
    //
    // 不加这条，遇到「一次用户输入触发两轮召回」只能靠猜：日志里有
    // 刷新次数、条数、字数，唯独没有 query —— 而两次刷新的词法命中数
    // 不同（30 vs 20）恰恰说明 query 变了，光看字数（4111 vs 4104）
    // 是看不出这一点的。
    //
    // 同时打 userKey：它是去重的唯一依据，一旦 lastUserKey 与它不等
    // 就会再召一次，而这个比较过程在日志里原本完全不可见。
    const queryPreview = query.replace(/\s+/g, ' ').slice(0, 40)
    log(
      'info',
      `召回刷新（${trigger.reason}）：${result.hits.length} 条 / ${rendered.length} 字`
        + `（${detail}${skip}${gatedAll}${quality}）`
        + `\n    query(${query.length}字)="${queryPreview}"`
        + `\n    触发键=${trigger.key} userKey=${trigger.userKey}`
        + ` 上次userKey=${fridge.lastUserKey ?? 'null'}`,
    )
    return rendered
  }

  // 暴露给 message-channel：消息模式与 prompt 模式必须共用同一个召回实现，
  // 否则两条通道会各自冻结、各自召回，行为分叉。
  return { ensureInjection }
}

/**
 * 从会话状态里判定这次组装要不要重新召回。
 *
 * 只读会话已有事件，不改状态 —— 真正的状态提交在 fridge.markTrigger 里，
 * 避免「判定一次就消耗掉触发点」导致重复召回。
 *
 * 返回的 `userKey` 是**本次观察到的用户消息键**，调用方要原样传给
 * markTrigger：它和 `key`（触发原因）是两件事，分开记账才不会出现
 * 「todo 触发完，同一条用户消息又被当成新消息再召一次」。
 *
 * ## 为什么需要 `liveUser`
 *
 * 这是「一次用户输入注入两块」的根因修复。
 *
 * 会话事件里的实际顺序是：
 *
 *     step/start            ← pre-step 在这里跑，此时**新消息还没落库**
 *     user/message/user     ← 新消息在这一步之后才被记录
 *     user/message/dsh-vcprag/recall
 *
 * 所以首步 pre-step 调 `snapshotEvents()` 时，`lastUserText` 还是**上一条**
 * 用户消息。后果是一条消息被注入两次：
 *
 *   step 1：拿上一条消息当查询 → 冻结 → 注入（内容错，但已落库）
 *   step 2：新消息已落库 → userKey 变了 → 重新召回 → 再注入一块
 *
 * 实测日志（同一条输入 `神秘，改好了，现在应该好了`）：
 *
 *     15:33:18  召回刷新（user-message）6 条 / 4111 字   ← 查的是上一条
 *     15:34:56  注入 4111 字
 *     15:35:10  召回刷新（user-message）5 条 / 4104 字   ← 这才查到这条
 *     15:35:10  注入 4104 字
 *
 * 两次的词法命中数不同（30 → 20），证明 query 真的换了。
 *
 * 修法：调用方把本步**已认领**的用户消息通过 `liveUser` 传进来。
 * 它比 snapshot 更新，因此用它当查询；同时把它的键记为已消费，
 * 这样等它真正落库后 userKey 比对不会再次触发。
 *
 * @param {object|undefined} session
 * @param {import('./freeze.js').RecallFridge} fridge
 * @param {{ id?: string|null, text?: string }|undefined} liveUser
 *   本步认领的用户消息（可能尚未落库）。
 * @returns {{ refresh: boolean, reason: string, query: string, key: string, userKey: string, completedCount: number }}
 */
export function pickTrigger(session, fridge, liveUser) {
  const state = readSessionState(session)
  const marked = fridge.triggerKey
  const seenUserKey = fridge.lastUserKey

  // ---- 关键：把「本步已认领、但可能还没落库」的用户消息并进 state ----
  //
  // 用 `id` 判断是否已被 snapshot 收录：有 id 就用 id 比对，没 id 就用
  // 文本比对（DSH 不同版本对 payload 的字段名不一致，两手都要）。
  const liveText = typeof liveUser?.text === 'string' ? liveUser.text.trim() : ''
  const liveId = typeof liveUser?.id === 'string' && liveUser.id !== '' ? liveUser.id : null
  if (liveText !== '') {
    const alreadySnapshotted = liveId !== null
      ? state.lastUserId === liveId
      : state.lastUserText === liveText
    if (!alreadySnapshotted) {
      state.lastUserText = liveText
      state.lastUserId = liveId
      // userCount 故意不 +1：它只在无 id 时充当兜底键，而现在有真实消息了。
    }
  }

  const userKey = liveId !== null && state.lastUserId === liveId
    ? `user:${liveId}`
    : `user:${state.lastUserId ?? state.userCount}`

  // 首个回合：会话里已有用户消息，但本会话还没冻结过
  if (state.lastUserText !== '' && marked === null) {
    return {
      refresh: true,
      reason: 'first-turn',
      query: state.lastUserText,
      key: userKey,
      userKey,
      completedCount: state.completedCount,
    }
  }

  // todo 出现新勾选 → 阶段推进。
  //
  // **必须排在 user-message 之前**：这两个触发可能同时成立（用户刚说话、
  // 同时模型勾了一个 todo）。如果先判 user-message，它会把 completedCount
  // 基线一起重置成当前值，等下一轮轮到 todo 分支时
  // `state.completedCount > fridge.completedCount` 永远为 false ——
  // todo 触发器被彻底饿死（实测整天 12 次刷新里 phase-change 为 0）。
  if (state.completedCount > fridge.completedCount && state.todoText !== '') {
    return {
      refresh: true,
      reason: 'phase-change',
      query: state.todoText,
      key: 'phase',
      userKey,
      completedCount: state.completedCount,
    }
  }

  // 新的用户消息（比对 lastUserKey，不是 triggerKey）
  if (state.lastUserText !== '' && seenUserKey !== userKey) {
    return {
      refresh: true,
      reason: 'user-message',
      query: state.lastUserText,
      key: userKey,
      userKey,
      completedCount: state.completedCount,
    }
  }

  return {
    refresh: false,
    reason: 'frozen',
    query: '',
    key: marked ?? '',
    userKey,
    completedCount: state.completedCount,
  }
}

/**
 * 读会话里与召回相关的状态。
 *
 * 只用 DSH 的公开读接口 `snapshotEvents()`。会话对象不可用、或其实现
 * 变了导致读不到，都退化成「没有用户消息」—— 此时首次判定不会触发，
 * 通道会静默不注入，而不是抛错阻断对话。
 *
 * @param {object|undefined} session
 * @returns {{ lastUserText: string, lastUserId: string|null, userCount: number, todoText: string, completedCount: number }}
 */
export function readSessionState(session) {
  const empty = { lastUserText: '', lastUserId: null, userCount: 0, todoText: '', completedCount: 0 }
  if (session === undefined || session === null) return empty
  let events
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    return empty
  }
  if (!Array.isArray(events)) return empty

  let lastUserText = ''
  let lastUserId = null
  let userCount = 0

  for (const event of events) {
    if (event?.type !== 'user/message') continue
    // 只认真人输入。DSH 自己也往 user/message 里写运行时快照
    // （working-directory、runtime-context 等），那些不是查询意图。
    if (event.data?.source?.kind !== 'user') continue
    const text = flattenContent(event.data.content)
    if (text === '') continue
    lastUserText = text
    lastUserId = typeof event.data.id === 'string' ? event.data.id : null
    userCount += 1
  }

  // ---- todo:阶段推进的触发源 ----
  //
  // 两个来源，**优先原生事件**：
  //
  //   1. `todo/write`（DSH 自己发的，`data.todos` 已经是数组）← 首选
  //   2. `tool/call` name=todo_write（**`arguments` 是 JSON 字符串**）← 兜底
  //
  // 为什么必须优先 1：`tool/call` 的 `arguments` 是**字符串**
  // （实测 11/11 条全是 `typeof === 'string'`），裸取 `.todos`
  // 永远 undefined → `Array.isArray` 为假 → completedCount 恒 0、
  // todoText 恒空 → **phase-change 分支永远进不去**，日志里连
  // 「刷新过但被拦」都不会出现，因为它压根没被调用过。
  //
  // 这个 bug 的表现极具迷惑性：todo 功能看起来「静默失效」而不是报错。
  // 原生 `todo/write` 事件省掉解析这一步，所以它是对的一侧；
  // 但不同 DSH 版本未必都有，兜底路径必须能解析字符串才算完整。
  const counted = readTodoState(events)

  return {
    lastUserText,
    lastUserId,
    userCount,
    todoText: counted.todoText,
    completedCount: counted.completedCount,
  }
}

/**
 * 从会话事件里读出 todo 状态。
 *
 * 倒序扫描，遇到第一个「能解析出 todos 数组」的事件就停。
 * 两个来源都试，**任一成功即返回**，防止某版本缺其中一个来源。
 *
 * @param {object[]} events
 * @returns {{ todoText: string, completedCount: number }}
 */
function readTodoState(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]

    // 来源 1：原生 todo/write —— data.todos 直接就是数组
    if (event?.type === 'todo/write') {
      const todos = event.data?.todos
      if (Array.isArray(todos)) return summariseTodos(todos)
      continue
    }

    // 来源 2：tool/call —— arguments 可能是字符串，也可能是对象
    if (event?.type !== 'tool/call' || event.data?.name !== 'todo_write') continue
    const todos = parseToolArguments(event.data?.arguments)?.todos
    if (Array.isArray(todos)) return summariseTodos(todos)
  }
  return { todoText: '', completedCount: 0 }
}

/**
 * 把 `tool/call` 的 `arguments` 归一成对象。
 *
 * DSH 实际写入的是 **JSON 字符串**（`'{"todos":[...]}'`）。直接 `.todos`
 * 拿到 undefined，且 `Array.isArray(undefined)` 为假 —— 于是整段逻辑
 * 静默跳过。这里两种形态都吃。
 *
 * 只做一层，不递归解析：实测没有「字符串里套字符串」的情况，
 * 递归反而会在内容恰好是 JSON 文本时误判。
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
function parseToolArguments(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // 快速排除：明显不是 JSON 对象就别浪费 JSON.parse
  if (trimmed[0] !== '{') return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 从 todos 数组里算出「已完成条数」和「进行中项拼成的查询文本」。
 *
 * `content` / `text` / `title` 三种字段名都试：todo 的数据结构
 * 在不同 DSH 版本 / 不同工具实现里换过名字，只认 content 会静默取空。
 *
 * @param {object[]} todos
 * @returns {{ todoText: string, completedCount: number }}
 */
function summariseTodos(todos) {
  const completedCount = todos.filter(
    (todo) => todo?.status === 'completed' || todo?.completed === true,
  ).length
  const todoText = todos
    .filter((todo) => todo?.status === 'in_progress')
    .map((todo) => {
      if (typeof todo?.content === 'string') return todo.content
      if (typeof todo?.text === 'string') return todo.text
      if (typeof todo?.title === 'string') return todo.title
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return { todoText, completedCount }
}

/** 把 message.content 拍平成纯文本（string 或 block 数组都吃）。 */
function flattenContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
