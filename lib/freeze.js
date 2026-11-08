/**
 * 冻结状态机 —— 缓存命中的关键。
 *
 * 问题：每轮都重新召回并 context() 追加，命中率会掉。不是因为改了前缀，
 * 而是因为每轮都在尾部新增长文本，模型要重新 prefill 那一段。
 *
 * 实测基准（478 次真实调用）：不碰 system 消息时整体命中率 98.37%
 * （69,475,968 hit / 1,150,434 miss）。唯一断崖来自 system 消息长度变化
 * 20003→19537，一次就吃掉 5.5%。
 *
 * 所以规则只有两条：
 *   1. 会话内首次召回后冻结，后续轮次内容不变 → project() 返回 undefined → 零成本
 *   2. 只有「用户发新消息」或「todo 勾选数增加」才允许重新召回
 *
 * 编码类会话里 80% 的轮次是模型自己连续干活，用户不发言 —— 这些轮次
 * 全程命中原前缀。
 *
 * @module dsh-vcprag/freeze
 */

/**
 * @typedef {object} FrozenView
 * @property {string} text - 渲染好的注入文本。
 * @property {string} reason - first-turn / user-message / phase-change / manual。
 * @property {string} frozenAt - ISO 时间戳。
 * @property {string} key - 触发键，用于判断是否需要重算。
 * @property {object[]} hits - 原始命中结果，供 UI 与工具复用。
 */

export class RecallFridge {
  constructor() {
    /** @type {FrozenView|null} */
    this.view = null
    /** 上次观察到的 todo 勾选数。-1 表示尚未观察过。 */
    this.completedCount = -1
    /** 上次处理过的用户消息 id。 */
    this.lastUserMessageId = null
    /** 本会话已刷新次数，防御无限刷新。 */
    this.refreshCount = 0
    /**
     * 上次触发召回时的触发键。
     *
     * 与 lastUserMessageId 的区别：那个记的是「消息 id」，只能匹配
     * user/message 一种事件；这里记的是「触发点标识」，把用户消息和
     * todo 勾选统一成同一种可比较的键，判定逻辑就不用分两套状态。
     *
     * null = 从未成功触发过（对应「首回合」，必须召回一次）。
     * @type {string|null}
     */
    this.triggerKey = null
    /**
     * 上次处理过的**用户消息键**（`user:<id>`）。
     *
     * 必须与 triggerKey 分开：triggerKey 可能是 `phase-change`，
     * 那时它是「本轮由 todo 触发」，并不代表用户消息已经被消费过。
     * 混用一个字段会让同一条用户消息在 todo 触发之后又被召一次。
     *
     * null = 还没记录过用户消息。
     * @type {string|null}
     */
    this.lastUserKey = null
    /**
     * 本会话**已经注入到上下文里的记忆条目**（itemKey 集合）。
     *
     * 为什么必须有这一层：prompt 模式下每轮用新内容**替换**旧的 context 块，
     * 重复条目自然消失。但 message 模式下消息一旦落库就永久留在历史里，
     * 插件无法删除 —— 只做「整块摘要去重」是不够的：
     *
     *   一批命中里只要有一条不同，整块摘要就变 → 判定为新内容 → 整块重新注入
     *   → 那 4 条旧条目跟着再来一遍。实测 10 条消息 50 个条目里 19 个重复（38%），
     *   重复内容约 14835 字。
     *
     * 所以去重粒度必须下沉到**条目**：已经在历史里的条目不再注入，
     * 只注入新的。这个集合跨触发累积、只在会话重置时清空。
     *
     * @type {Set<string>}
     */
    this.surfacedItems = new Set()
  }

  /** 是否已冻结。 */
  get frozen() {
    return this.view !== null
  }

  /**
   * 判断此刻是否应该重新召回。
   *
   * @param {{ kind: string, payload?: any }} event
   * @param {{ onUserMessage?: boolean, onTodoCheck?: boolean }} config
   * @returns {{ refresh: boolean, reason: string }}
   */
  shouldRefresh(event, config = {}) {
    const kind = event?.kind ?? ''

    // 先把本条事件里的消息 id 记下来，再判断是否首次 ——
    // 否则首次走 first-turn 分支时不会记录 id，导致同一条消息
    // 在第二次经过时被当成新消息重复刷新（实测踩到过）。
    const incomingId =
      kind === 'user/message'
        ? (event?.payload?.id ?? event?.payload?.messageId ?? null)
        : null

    // 首次必召回
    if (this.view === null) {
      if (incomingId !== null) this.lastUserMessageId = incomingId
      return { refresh: true, reason: 'first-turn' }
    }

    // 用户发新消息
    if (kind === 'user/message') {
      if (config.onUserMessage === false) return { refresh: false, reason: 'user-message-disabled' }
      // 同一条消息不重复触发（模型可能在一个 turn 内多次询问）
      if (incomingId !== null && incomingId === this.lastUserMessageId) {
        return { refresh: false, reason: 'duplicate-user-message' }
      }
      this.lastUserMessageId = incomingId
      return { refresh: true, reason: 'user-message' }
    }

    // todo 出现新的勾选 → 编码阶段推进
    if (kind === 'tool/call') {
      const name = event?.payload?.name ?? event?.payload?.toolName ?? ''
      if (name !== 'todo_write') return { refresh: false, reason: 'other-tool' }
      if (config.onTodoCheck === false) return { refresh: false, reason: 'todo-check-disabled' }

      const todos = event?.payload?.args?.todos ?? event?.payload?.input?.todos ?? []
      if (!Array.isArray(todos)) return { refresh: false, reason: 'todo-shape-unknown' }

      const completed = todos.filter((todo) => todo?.status === 'completed' || todo?.completed === true).length

      // 只在新勾选出现时刷新。撤销勾选（数量减少）不触发 ——
      // 那通常意味着模型在纠错，召回内容仍然有效。
      if (completed > this.completedCount) {
        this.completedCount = completed
        return { refresh: true, reason: 'phase-change' }
      }
      if (this.completedCount === -1) this.completedCount = completed
      return { refresh: false, reason: 'no-new-completion' }
    }

    return { refresh: false, reason: 'ignored-event' }
  }

  /**
   * 记账：本次组装已经针对这个触发点召回过。
   *
   * 必须在召回**之后**调用，而且要与 freeze 分开：
   * 零命中时我们记触发点（避免同一条消息每轮重复召回），
   * 但**不 freeze**（避免永久零注入）。合成一个方法就做不到这点。
   *
   * `userKey` 必须与 `triggerKey` **分开记**：
   * triggerKey 表示「最近一次因为什么召回」，可能是 phase-change；
   * userKey 表示「最近处理过的用户消息是哪条」。混用一个字段会导致
   * phase-change 之后同一条用户消息又被当成新消息再触发一次
   * （实测：一次 todo 勾选连召两次，白白多花一次 embedding）。
   *
   * @param {string} key - 触发点标识，形如 `user:<id>` / `phase`
   * @param {number} completedCount - 观察到的 todo 勾选数
   * @param {string} [userKey] - 本次观察到的用户消息标识
   */
  markTrigger(key, completedCount, userKey) {
    if (typeof key === 'string' && key !== '') this.triggerKey = key
    if (typeof userKey === 'string' && userKey !== '') this.lastUserKey = userKey
    if (Number.isFinite(completedCount) && completedCount >= 0) this.completedCount = completedCount
  }

  /**
   * 冻结新视图。
   *
   * @param {Omit<FrozenView, 'frozenAt' | 'key'>} view
   * @returns {FrozenView}
   */
  freeze(view) {
    this.refreshCount += 1
    this.view = {
      ...view,
      frozenAt: new Date().toISOString(),
      key: `r${this.refreshCount}`,
    }
    return this.view
  }

  /** 取当前冻结文本（未冻结时为空串）。 */
  currentText() {
    return this.view?.text ?? ''
  }

  /**
   * 记下「这些条目已经进过上下文了」。
   *
   * 在**注入成功之后**调用。传入的是本次真正写进文本的条目键，
   * 不是候选命中的键 —— 被 maxChars 预算截掉、或因为已呈现而过滤掉的
   * 条目没有进上下文，不该被记为已呈现，否则它们永远没机会出现。
   *
   * @param {Iterable<string>} keys
   */
  markSurfacedItems(keys) {
    if (keys === null || keys === undefined) return
    for (const key of keys) {
      if (typeof key === 'string' && key !== '') this.surfacedItems.add(key)
    }
  }

  /** 本会话已呈现过哪些条目（快照副本，调用方改不到内部状态）。 */
  surfacedItemKeys() {
    return [...this.surfacedItems]
  }

  /** 会话结束 / 上下文压缩 / 切换工作区时重置。 */
  reset() {
    this.view = null
    this.completedCount = -1
    this.lastUserMessageId = null
    this.refreshCount = 0
    this.triggerKey = null
    this.lastUserKey = null
    this.surfacedItems = new Set()
  }

  /** 诊断信息，供 UI 的召回调试 Tab 展示。 */
  snapshot() {
    return {
      frozen: this.frozen,
      frozenAt: this.view?.frozenAt ?? null,
      reason: this.view?.reason ?? null,
      refreshCount: this.refreshCount,
      completedCount: this.completedCount,
      lastUserMessageId: this.lastUserMessageId,
      triggerKey: this.triggerKey,
      lastUserKey: this.lastUserKey,
      chars: this.view?.text.length ?? 0,
      hitCount: Array.isArray(this.view?.hits) ? this.view.hits.length : 0,
      // 已呈现条目数。与 hitCount 一起看能判断「这次是全新内容还是只剩重复」。
      surfacedItemCount: this.surfacedItems.size,
    }
  }
}
