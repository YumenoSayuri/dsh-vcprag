/**
 * 消息通道 —— 把记忆作为 **对话消息** 注入，而不是 system prompt。
 *
 * 为什么需要它：反代上游有时做 system prompt 指纹检测，命中就直接清空
 * system 消息。这时 `section()` 和 `context()` 会一起失效 —— 模型彻底
 * 丢掉人设和记忆，表现得像换了个人。
 *
 * 对话历史里的消息不受这个影响：上游清空的是 system，消息照常发送。
 * 所以把关键内容放进消息流，是唯一能扛住 system 被清空的注入方式。
 *
 * ## 机制（与官方 agent-instructions 完全同构）
 *
 * 挂在 `agent/pre-step` 上：
 *
 *   1. 先 `await next()` 拿到本步决策（含已认领的用户消息）
 *   2. 算出「本步希望存在」的内容（常驻记忆 / 召回各一条）
 *   3. **直接拼进 decision.messages**，紧跟在本步已认领的用户消息之后
 *   4. 返回新的 decision
 *
 * ## 为什么不能走 agent.inbox
 *
 * 这是踩过的坑，代价是用户每条消息收到**多轮** AI 回复。
 *
 * `agent.inbox` 是「待处理的用户输入」队列。往里 prepend 一条消息，DSH
 * 会在**下一步**把它当作新的用户输入认领 —— 认领就意味着「又有话说了」，
 * 于是再跑一轮模型。每注入一条 = 多一轮回复，且越到后面模型越困惑：
 * 它看到的是一个只有记忆块、没有任何指令的 user 消息。
 *
 * 正确做法是像官方那样：**当步直接注入**，inbox 完全不碰。
 * 这样消息只在这一步出现一次，落库后成为普通历史，不会产生额外的轮次。
 *
 * ## 为什么必须去重 + 设上限
 *
 * `decision.messages` 里的消息会被落库进历史，插件无法删除。所以：
 *
 *   - 内容已在历史里 → 不再注入（否则每步都加一条，历史爆炸）
 *   - 内容变了 → 注入新的一条（旧的那条留着，这是消息模式固有的代价）
 *   - 每种 form 有 `maxMessages` 上限，超了就停发并告警
 *
 * ## 与 prompt 模式的关系
 *
 * 两种模式互斥（每个内容块各自选一种），由 config 决定：
 *   runtime.mode = 'section' | 'message'
 *   inject.mode  = 'context' | 'message'
 *
 * 不提供「双写」：同时塞 system 和消息会让同一份内容占用两处 token，
 * 且命中缓存的最优路径（section 常驻）反而被污染。
 *
 * @module dsh-vcprag/message-channel
 */

import { randomUUID } from 'node:crypto'

/** 消息来源标记。UI 和去重都靠它认领自己的消息。 */
export const MESSAGE_SOURCE_KIND = 'dsh-vcprag'

/** 内容块标识。同一个 form 视为同一类内容，互相 supersede。 */
export const FORM_RUNTIME = 'runtime'
export const FORM_RECALL = 'recall'

/**
 * 每种 form 默认允许的最大消息条数。
 *
 * 达到上限后不再注入（只告警）。这是防止历史被旧召回结果淹没的硬保险：
 * 消息一旦落库就无法撤回，没有上限的话长会话会累积几十条过期召回。
 */
export const DEFAULT_MAX_MESSAGES = 3

/** 上限的合法区间。0 是特殊值，表示「不限制」。 */
export const MAX_MESSAGES_CEILING = 200

/**
 * 归一化 maxMessages。
 *
 * 关键约定：**0 = 不限制**，而不是「一条都不许」。
 *
 * 早先的写法是 `surfaced.length >= maxMessages` 直接比，配 `clamp(0,50)`
 * 的结果是「填 0 就永远不注入」，而 UI 上没人会填 0 期待这个意思 ——
 * 用户填 0 想表达的是「别拿上限卡我」。语义错位比缺功能更难查：
 * 表面看是开关开着、检索也在跑，就是内容不进来。
 *
 * 所以这里把 0（以及任何非正数）解释成 Infinity，并且只在
 * 「确实还有内容可发、只是被上限挡住」时才返回具体数字。
 *
 * @param {unknown} value
 * @returns {number} 正数上限或 Infinity
 */
export function normaliseMaxMessages(value) {
  // 必须先显式挡掉「缺失」，再谈数值。
  // 坑：`Number(null) === 0`、`Number('') === 0`、`Number(false) === 0` ——
  // 如果直接 Number() 然后判 `<= 0`，配置里一个 null 会被当成
  // 「用户主动填 0 = 不限制」，于是上限彻底失效（历史无限膨胀）。
  // 缺失和「明确填 0」是两个语义，不能靠数值巧合混为一谈。
  if (value === null || value === undefined || value === '') return DEFAULT_MAX_MESSAGES

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_MESSAGES
  const rounded = Math.round(parsed)
  if (rounded <= 0) return Number.POSITIVE_INFINITY
  return Math.min(rounded, MAX_MESSAGES_CEILING)
}

/**
 * 造一条本插件自己的用户消息。
 *
 * 用 `role: 'user'` 而不是 system：上游几乎不会过滤用户消息，而且
 * DSH 的 surface 投影对 user 消息支持最完整（可回放、可压缩、可恢复）。
 *
 * `source.kind` 是身份标记 —— 后续靠它把自己的消息与真人输入区分开。
 * 注意它**不是** `'user'`，所以 inject.js 里「只认真人消息」的判定
 * 会自然跳过这些注入内容，不会把它们当成查询意图。
 *
 * `digest` 是**内容身份**，不是正文。去重靠它而不是靠 `text` 全等 ——
 * 正文里可能带时间戳、触发原因之类每次都不一样的装饰，用正文比对会永远
 * 判不出「已注入」，结果就是一路撞 maxMessages 上限、新结果送不进去。
 *
 * @param {string} text
 * @param {string} form - FORM_RUNTIME / FORM_RECALL
 * @param {string} [digest] - 内容摘要，缺省时用正文本身算
 * @returns {object}
 */
export function createVcpragMessage(text, form, digest, items) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: MESSAGE_SOURCE_KIND,
      form,
      ...(typeof digest === 'string' && digest !== '' ? { digest } : {}),
      // 存条目身份，供**后续轮次**做条目级去重。
      // 不存的话每轮都要从正文反解一遍（能解，但多一层依赖渲染格式）。
      ...(Array.isArray(items) && items.length > 0 ? { items } : {}),
    },
  }
}

/**
 * 把渲染文本里**易变的装饰**剥掉，留下可用于身份判断的稳定部分。
 *
 * 开标签上的 `frozen="…"` / `reason="…"` 分别随时间和触发原因变化：
 * 同一批命中，隔一轮再渲染就得到不同字符串。用它做 `includes` 比对
 * 永远失败 —— 这正是「39 次撞上限、1 次成功注入」的直接原因。
 *
 * 所以身份只取**标签名 + 正文**，属性一律丢弃。
 *
 * @param {string} text
 * @returns {string}
 */
export function stableIdentity(text) {
  if (typeof text !== 'string' || text === '') return ''
  return text
    // 开标签：只留标签名，丢掉所有属性
    .replace(/<([A-Za-z][\w-]*)\s+[^>]*>/g, '<$1>')
    // 行尾空白不影响语义
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * 算一份内容摘要。
 *
 * 输入应当已经过 {@link stableIdentity} 稳定化（内部也会再做一次，
 * 保证调用方忘了也不会错）。
 *
 * @param {string[]} parts
 * @returns {string}
 */
export function contentDigest(parts) {
  const payload = Array.isArray(parts)
    ? parts.filter((p) => typeof p === 'string' && p !== '').map(stableIdentity).join('\u0000')
    : ''
  if (payload === '') return ''
  // djb2 —— 够用且零依赖。这里只需要「可能不同就不同」，不需要抗碰撞。
  let hash = 5381
  for (let i = 0; i < payload.length; i += 1) hash = ((hash << 5) + hash + payload.charCodeAt(i)) | 0
  return `${(hash >>> 0).toString(36)}:${payload.length}`
}

/**
 * 单条记忆条目的**稳定身份**。
 *
 * 为什么不能拿整块文本当身份：整块里有一条不同，摘要就变，于是那几条
 * 旧条目跟着重新注入一遍。实测 10 条召回消息里 50 个条目有 19 个重复。
 *
 * 身份取「日期 + 标题」，与正文无关 —— 同一篇记忆换个截断位置、换个
 * 打分顺序都不该被当成新条目。标题里本身已带日期，但显式分开存更稳：
 * 有的日记日期在 itemPrefix 里、有的在标题里。
 *
 * 不取 chunkId：日记正文改动会重算 chunk，但「这是同一篇记忆」这件事没变，
 * 用户不希望改一个错别字就让它重新注入一次。
 *
 * @param {{ date?: string, title?: string }} hit
 * @returns {string}
 */
export function itemKeyOf(hit) {
  const date = typeof hit?.date === 'string' ? hit.date.trim() : ''
  const title = typeof hit?.title === 'string' ? hit.title.trim() : ''
  if (date === '' && title === '') return ''
  // 标题做一次规范化：渲染时可能被 trimEnd / 截断，产生尾部差异
  return `${date}\u0000${title.replace(/[ \t]+$/g, '')}`
}

/**
 * 从一段**已渲染**的召回文本里反解出条目身份。
 *
 * 用于识别「升级前写入的消息」：那些消息没有 digest、更没有条目键，
 * 只能从正文里把 `[n] 日期 · 标题` 的行头解析回来。不这么做的话，
 * 升级后第一轮会把历史里的旧条目全部当成新的、再注入一遍。
 *
 * 只看行首 `[n]`，与 renderRecallBlock 的 itemPrefix 约定一致。
 * 前缀被用户改成不含 `{n}` 的形态时解析不出 —— 那时退化为空集，
 * 行为等价于「本地没记录」，不会误判成已呈现。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseItemKeys(text) {
  if (typeof text !== 'string' || text === '') return []
  const out = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[(\d+)\]\s*(.+)$/.exec(line)
    if (m === null) continue
    const rest = m[2].trim()
    if (rest === '') continue
    // itemPrefix 默认是 `[{n}] {date} · {title}`
    const dot = rest.indexOf(' · ')
    let date = ''
    let title = rest
    if (dot !== -1) {
      date = rest.slice(0, dot).trim()
      title = rest.slice(dot + 3).trim()
    }
    const key = itemKeyOf({ date, title })
    if (key !== '' && !seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/** 是否本插件产出的消息。 */
export function isVcpragMessage(message) {
  return message?.source?.kind === MESSAGE_SOURCE_KIND
}

/** 取消息正文（只拼 text 块）。 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * 扫会话历史，收集本插件某 form 已落库消息的**内容摘要**。
 *
 * 只读 `surface.nodes`（模型可见的那条线），不读原始事件日志 ——
 * 后者是 append-only 的，会把已被替换掉的旧消息也算进来。
 *
 * 返回摘要而不是正文：正文可能含时间戳等装饰，逐字节比对不可靠；
 * 摘要取自「命中了哪些 chunk」，同一批记忆永远得到同一个值。
 * 旧消息没有 digest 字段（本版之前的写入），退化为用正文算，
 * 保证升级后仍能认出历史内容。
 *
 * @param {object|undefined} session
 * @param {string} form
 * @returns {string[]}
 */
export function surfacedDigests(session, form) {
  if (session === null || session === undefined) return []
  let nodes
  let eventAt
  try {
    nodes = session.surface?.nodes
    eventAt = session.eventAt
  } catch {
    return []
  }
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') return []

  const out = []
  for (const seq of nodes) {
    let event
    try {
      event = eventAt.call(session, seq)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    if (!isVcpragMessage(event.data)) continue
    if (event.data.source?.form !== form) continue
    // 旧消息没有 digest 字段（本版之前的写入）。**必须用正文重算**，
    // 不能因为「没有摘要」就当成「从没注入过」—— 那样升级后会立刻
    // 重复注入一遍历史里已有的内容。
    const stored = event.data.source?.digest
    out.push(typeof stored === 'string' && stored !== '' ? stored : contentDigest([messageText(event.data)]))
  }
  return out
}

/**
 * 扫会话历史，收集某 form 已落库消息的**条目身份**。
 *
 * 这是 message 模式真正的去重依据：整块摘要只回答「这批和以前某批一样吗」，
 * 而这里回答「这一条以前出现过吗」—— 后者才是用户要的语义。
 * 历史消息里没存条目列表时（旧版本写入）从正文反解。
 *
 * @param {object|undefined} session
 * @param {string} form
 * @returns {Set<string>}
 */
export function surfacedItems(session, form) {
  const out = new Set()
  if (session === null || session === undefined) return out
  let nodes
  let eventAt
  try {
    nodes = session.surface?.nodes
    eventAt = session.eventAt
  } catch {
    return out
  }
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') return out

  for (const seq of nodes) {
    let event
    try {
      event = eventAt.call(session, seq)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    if (!isVcpragMessage(event.data)) continue
    if (event.data.source?.form !== form) continue
    const stored = event.data.source?.items
    const keys = Array.isArray(stored) && stored.length > 0 ? stored : parseItemKeys(messageText(event.data))
    for (const key of keys) {
      if (typeof key === 'string' && key !== '') out.add(key)
    }
  }
  return out
}

/**
 * 兼容旧名：返回已落库消息的正文。
 *
 * 仅用于诊断展示（UI 的召回调试 Tab）。去重逻辑一律走 surfacedDigests，
 * 不要用这个做判断。
 *
 * @param {object|undefined} session
 * @param {string} form
 * @returns {string[]}
 */
export function surfacedTexts(session, form) {
  if (session === null || session === undefined) return []
  let nodes
  let eventAt
  try {
    nodes = session.surface?.nodes
    eventAt = session.eventAt
  } catch {
    return []
  }
  if (!Array.isArray(nodes) || typeof eventAt !== 'function') return []

  const out = []
  for (const seq of nodes) {
    let event
    try {
      event = eventAt.call(session, seq)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    if (!isVcpragMessage(event.data)) continue
    if (event.data.source?.form !== form) continue
    out.push(messageText(event.data))
  }
  return out
}

/**
 * 判断某个 form 的内容这一步该不该注入。
 *
 * 纯函数，不改任何状态 —— 决定只看「历史里已有什么」。
 *
 * 比对**内容摘要**而不是正文：正文带时间戳、触发原因之类的装饰，
 * 逐字节比对永远失败。摘要只取「命中了哪些 chunk」。
 *
 * @param {object|undefined} session
 * @param {string} form
 * @param {string} text - 已 trim 的正文
 * @param {string} digest - 内容摘要（空串表示无内容）
 * @param {number} maxMessages - 0 或负数表示不限制
 * @returns {{ inject: boolean, reason: string, surfaced: number, limit: number }}
 */
function resolveInjection(session, form, text, digest, maxMessages, items, itemsExhausted) {
  const limit = normaliseMaxMessages(maxMessages)
  if (text === '') return { inject: false, reason: 'empty', surfaced: 0, limit }

  const surfaced = surfacedDigests(session, form)

  // ---- 条目级去重（message 模式的核心）----
  //
  // 整块摘要只能回答「这批和以前某批完全一样吗」。实测 10 条召回消息里
  // 50 个条目有 19 个重复（38%）—— 因为只要一批里有一条不同，摘要就变。
  //
  // 调用方（inject.js）先按条目过滤再渲染，滤空了会返回空串走上面的
  // `empty` 分支。这里只处理「调用方明确告知：候选全都已呈现过」的情况，
  // 用来把日志与 `empty` 区分开。
  //
  // **不能用 `items.length === 0` 来判断。** 踩过：有的渲染文本解析不出
  // 条目（自定义 itemPrefix 不含 {n}、或者测试夹具塞的是任意文本），
  // 那样 `parseItemKeys` 返回空数组，若据此判「全部已呈现」，整条召回
  // 会被静默吞掉 —— smoke-message-channel 第 17 组当场抓到。
  if (itemsExhausted === true) {
    return { inject: false, reason: 'all-items-surfaced', surfaced: surfaced.length, limit, items: [] }
  }

  // 历史里已有同一份内容 → 不重复注入。
  // 这是热路径上的常态：注入过一次之后，之后每一步都走这里。
  if (digest !== '' && surfaced.includes(digest)) {
    return { inject: false, reason: 'already-surfaced', surfaced: surfaced.length, limit }
  }

  // 已达上限 → 停止追加。旧消息删不掉，只能靠这条兜底。
  if (surfaced.length >= limit) {
    return { inject: false, reason: 'max-reached', surfaced: surfaced.length, limit }
  }

  return { inject: true, reason: 'new', surfaced: surfaced.length, limit, items: Array.isArray(items) ? items : [] }
}

/**
 * 从本步认领的消息里挑出**最后一条真人输入**，供召回当查询用。
 *
 * 为什么需要它：pre-step 触发时，本步的用户消息还没落库
 * （会话事件顺序是 `step/start` → `user/message`），
 * 所以 `snapshotEvents()` 里拿不到它。不把它捞出来，
 * 首步就会拿上一条消息当查询 —— 于是同一条输入被注入两次，
 * 且第一次的内容完全对不上（实测 4111 字 vs 4104 字，
 * 词法命中 30 vs 20）。
 *
 * 排除项：
 *   - 本插件自己注入的消息（`source.kind === 'dsh-vcprag'`）
 *   - DSH 塞进 user/message 的运行时快照（working-directory 等）
 *   - 非 user 角色的消息
 *
 * @param {object[]} claimed
 * @returns {{ id: string|null, text: string }|undefined}
 */
export function pickClaimedUserMessage(claimed) {
  if (!Array.isArray(claimed) || claimed.length === 0) return undefined
  for (let i = claimed.length - 1; i >= 0; i -= 1) {
    const message = claimed[i]
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    if (isVcpragMessage(message)) continue
    const kind = message.source?.kind
    // 只认真人输入；运行时快照（time-context / skill-catalog 等）不是查询意图。
    if (typeof kind === 'string' && kind !== '' && kind !== 'user') continue
    const text = messageText(message)
    if (text === '') continue
    const id = typeof message.id === 'string' && message.id !== '' ? message.id : null
    return { id, text }
  }
  return undefined
}

/**
 * 把一条消息插到「本步已认领的用户消息」之后。
 *
 * 为什么不是简单 unshift：模型看到的消息顺序应该是
 *   用户原话 → 记忆补充 → （后面才是模型这步的输出）
 * 插到最前面会让记忆跑在用户原话之前，语义上「用户先说了记忆，
 * 又说了问题」，读起来别扭，也可能让模型误以为记忆才是重点。
 *
 * `claimed` 是本步认领的原始消息数组，靠引用相等定位边界；
 * 定位不到（decision 被别的插件重建过）就退化为追加到末尾，
 * 至少不会插到错误的位置。
 *
 * @param {object[]} messages - decision.messages
 * @param {object[]} claimed - 本步认领的原始消息
 * @param {object[]} additions
 * @returns {object[]}
 */
function insertAfterClaimed(messages, claimed, additions) {
  if (additions.length === 0) return messages
  if (!Array.isArray(messages)) return additions

  let anchor = -1
  if (Array.isArray(claimed) && claimed.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (claimed.includes(messages[i])) {
        anchor = i
        break
      }
    }
  }
  const at = anchor >= 0 ? anchor + 1 : messages.length
  return [...messages.slice(0, at), ...additions, ...messages.slice(at)]
}

/**
 * 挂载消息通道。
 *
 * **无条件挂载**。走哪条通道是每步读配置决定的，不是启动时决定的。
 *
 * 这一点踩过一次：早先写成「启动时若两个 mode 都是 prompt 就 return，
 * 不挂监听」，结果用户在设置里切到 message 后什么都不会发生 ——
 * 监听不存在，prompt 侧又已经让位，召回两条路都断。
 * 配置是热更新的，注入通道的装配就不能是启动期常量。
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {() => string} deps.getRuntimeText - 渲染好的常驻记忆正文
 * @param {(sessionId: string, assembleContext: object) => Promise<string>} deps.getRecallText
 * @param {(level: string, message: string) => void} deps.log
 */
export function attachMessageChannel(ctx, deps) {
  const { getConfig, getRuntimeText, getRecallText, log } = deps

  /**
   * 上限告警的「只报一次」记录。
   *
   * key 是 form，value 是上次报过的摘要（'' 表示「没卡住」）。
   *
   * 为什么要去重：上限只在**有新内容想进但进不去**的时候才有意义，
   * 而这种情况会持续存在于之后的每一步。曾经的做法是每次 pre-step
   * 打一条 warn，实测一晚上刷了 39 条一模一样的
   * `召回消息已达上限 3 条` —— 真正有用的那 1 条成功注入被埋掉了。
   *
   * 现在：同一个 form 卡在同一个摘要上只报一次；一旦注入成功就清标记，
   * 下次再卡住会重新报。
   */
  const capWarned = new Map()

  /**
   * @param {string} form
   * @param {string} digest - 本次想注入的内容摘要
   * @param {object|null} verdict - null 表示「已成功注入，清除标记」
   * @param {string} [hint]
   */
  function warnCapOnce(form, digest, verdict, hint) {
    if (verdict === null) {
      capWarned.delete(form)
      return
    }
    if (capWarned.get(form) === digest) return
    capWarned.set(form, digest)
    const label = form === FORM_RUNTIME ? '常驻消息' : '召回消息'
    const limit = verdict.limit === Number.POSITIVE_INFINITY ? '不限' : verdict.limit
    log(
      'warn',
      `${label}已达上限 ${limit} 条（当前历史 ${verdict.surfaced} 条），本次不再追加` +
        (hint ? `（${hint}）` : ''),
    )
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent
      const claimed = payload?.messages
      const step = payload?.step
      const signal = payload?.signal

      const decision = await next()

      // 拒答或已取消：不动 decision
      if (decision?.kind === 'reject' || signal?.aborted === true) return decision
      if (agent === undefined) return decision

      // 空步：这一步不会发模型请求，注入了也只是白白落库。
      // 官方 agent-instructions 用的是同一个条件。
      if (step === 1 && Array.isArray(decision.messages) && decision.messages.length === 0) return decision

      const current = getConfig()
      const additions = []

      // ---- 常驻记忆 ----
      if (current.runtime.mode === 'message' && current.runtime.inject === true) {
        let text = ''
        try {
          text = (getRuntimeText() ?? '').trim()
        } catch (error) {
          log('warn', `常驻记忆消息渲染失败：${error?.message ?? error}`)
        }
        // 常驻记忆的正文本身是稳定渲染（无时间戳），直接用正文算摘要。
        const digest = contentDigest([text])
        const verdict = resolveInjection(agent.session, FORM_RUNTIME, text, digest, current.runtime.maxMessages)
        if (verdict.inject) {
          additions.push(createVcpragMessage(text, FORM_RUNTIME, digest))
          warnCapOnce(FORM_RUNTIME, '', null)
          log('info', `常驻记忆作为消息注入（${text.length} 字）`)
        } else if (verdict.reason === 'max-reached') {
          // 按摘要去重告警：上限卡住时这一步本来什么都不发生，
          // 每步都打一条 warn 只会把日志刷满（实测 39 条重复告警）。
          warnCapOnce(FORM_RUNTIME, digest, verdict, '如需刷新请提高上限（0 = 不限制）或改用 prompt 模式')
        }
      }

      // ---- 召回 ----
      if (current.inject.mode === 'message' && current.inject.enabled === true) {
        let text = ''
        try {
          // 召回要在 pre-step 里 await —— 与 prompt 模式共用同一个实现，
          // 保证两条通道召回结果一致、冻结逻辑一致。
          //
          // `liveUser` 必须传：本步认领的用户消息此刻**还没落库**
          // （实测事件顺序是 step/start → user/message），
          // 不传的话 pre-step 只能拿上一条消息当查询，
          // 于是首步注入了错的内容、次步又为新消息再注入一块
          // —— 一次输入两块记忆，且第一块完全对不上。
          text = (await getRecallText(agent?.session?.id ?? '', {
            agent,
            signal,
            liveUser: pickClaimedUserMessage(claimed),
          })) ?? ''
          text = text.trim()
        } catch (error) {
          log('warn', `召回消息渲染失败：${error?.message ?? error}`)
          text = ''
        }
        // 召回文本带 `reason="…"` 等易变属性，contentDigest 内部会先做
        // stableIdentity 剥掉它们，所以同一批命中永远得到同一个摘要。
        const digest = contentDigest([text])
        // 条目身份：**渲染后**从文本里反解，而不是拿 hits 里的字段拼。
        //
        // 理由：注入的到底是什么，以渲染结果为准。renderRecallBlock 会按
        // maxChars 预算截断，被截掉的条目没有进上下文 —— 若拿 hits 当依据，
        // 它们会被误记为已呈现，永远没机会出现了。
        const items = parseItemKeys(text)
        // `getRecallText` 在「条目全被过滤掉」时返回空串 —— 那种情况上面
        // 的 text === '' 分支已经处理了（记 info 日志、不注入）。
        // 这里 text 非空说明确实有新内容要发，不需要额外的 exhausted 标记。
        const verdict = resolveInjection(
          agent.session,
          FORM_RECALL,
          text,
          digest,
          current.inject.maxMessages,
          items,
          false,
        )
        if (verdict.inject) {
          additions.push(createVcpragMessage(text, FORM_RECALL, digest, items))
          warnCapOnce(FORM_RECALL, '', null)
          log('info', `召回结果作为消息注入（${text.length} 字 / ${items.length} 条）`)
        } else if (verdict.reason === 'max-reached') {
          warnCapOnce(FORM_RECALL, digest, verdict, '如需刷新请提高上限（0 = 不限制）或改用 prompt 模式')
        } else if (verdict.reason === 'all-items-surfaced') {
          // 已在上下文里的内容不再重复注入。这是 message 模式下的常态 ——
          // 同一个主题追问第二次，命中往往是同一批条目。
          // 不打 warn：这不是异常，旧条目的正文就在历史里、模型看得见。
          log('info', `召回内容全部已呈现过（${verdict.surfaced} 条在历史里），本次不追加`)
        }
      }

      if (additions.length === 0) return decision

      // 直接拼进本步，**不碰 inbox**。
      // 这是与「每条注入多一轮回复」那个 bug 的分界线：
      // inbox 里的一步会被下一步当作新输入认领，等于又发起一轮对话。
      return { ...decision, messages: insertAfterClaimed(decision.messages, claimed, additions) }
    })

    const current = getConfig()
    log(
      'info',
      `消息通道已挂载（常驻=${current.runtime.mode === 'message' ? 'message' : 'prompt'}，` +
        `召回=${current.inject.mode === 'message' ? 'message' : 'prompt'}；运行中可切）`,
    )
  } catch (error) {
    log('error', `消息通道挂载失败：${error?.message ?? error}`)
  }
}
