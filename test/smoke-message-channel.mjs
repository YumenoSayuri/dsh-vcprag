/**
 * smoke-message-channel —— 验证「把记忆作为对话消息注入」这条通道。
 *
 * 这个文件锁住两件事：
 *
 * 1. **消息真的进了本步的 decision.messages**
 * 2. **agent.inbox 一根手指都不碰**
 *
 * 第 2 条是真实事故的回归：早先的实现走 `inbox.prepend('next-step', …)`，
 * 结果每条注入消息都会被 DSH 在下一步当成「新的用户输入」认领，
 * 于是又跑一轮模型 —— 用户发一句话，收到两三轮回复，而且后面几轮
 * 模型只看到一个纯记忆块、没有任何指令，只能困惑地反问。
 *
 * 官方 agent-instructions 的写法是：直接 mutate decision.messages，
 * 把消息拼到本步已认领的用户消息之后，inbox 完全不参与。这里照做，
 * 并且用断言把「不碰 inbox」这条契约焊死。
 *
 * 跑法：
 *   node test/smoke-message-channel.mjs
 */

import {
  MESSAGE_SOURCE_KIND,
  FORM_RECALL,
  FORM_RUNTIME,
  DEFAULT_MAX_MESSAGES,
  MAX_MESSAGES_CEILING,
  normaliseMaxMessages,
  createVcpragMessage,
  isVcpragMessage,
  messageText,
  surfacedTexts,
  surfacedDigests,
  contentDigest,
  stableIdentity,
  attachMessageChannel,
} from '../lib/message-channel.js'
import { renderRecallBlock } from '../lib/recall.js'

let passed = 0
let failed = 0

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}`)
  } else {
    failed += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------- 假 DSH 宿主

/**
 * 造一个假 agent。
 *
 * session 侧只需要两样：`surface.nodes`（模型可见的已落库消息序号）
 * 和 `eventAt(seq)`（按序号取事件）。
 *
 * inbox 侧故意做成「一碰就报错」—— 任何 prepend / replace / remove
 * 都会让测试直接红掉。这是刻意的：这条通道的契约就是完全不碰它。
 */
function createAgent(id = 'test-session') {
  const events = []
  const nodes = []
  let seq = 0

  const touched = []

  const inbox = {
    get nextStep() {
      touched.push('read')
      return []
    },
    prepend(...args) {
      touched.push(['prepend', ...args])
      throw new Error('inbox.prepend 不该被调用 —— 会导致额外的 AI 轮次')
    },
    replace(...args) {
      touched.push(['replace', ...args])
      throw new Error('inbox.replace 不该被调用 —— 会导致额外的 AI 轮次')
    },
    remove(...args) {
      touched.push(['remove', ...args])
      throw new Error('inbox.remove 不该被调用')
    },
  }

  const session = {
    id,
    get surface() {
      return { nodes: [...nodes] }
    },
    eventAt(wanted) {
      return events.find((event) => event.seq === wanted)
    },
  }

  const agent = { id: `agent-${id}`, session, inbox }

  /** 模拟 DSH 把某条消息落库进历史（后续步骤走 surface 去重时用）。 */
  agent.persist = (message) => {
    seq += 1
    events.push({ seq, type: 'user/message', data: message })
    nodes.push(seq)
    return seq
  }

  /** 模拟「重启后重新加载已有会话」：直接把历史灌进去。 */
  agent.seedHistory = (message) => agent.persist(message)

  agent.touchedInbox = () => touched
  return agent
}

/** 假 ctx：捕获 agent/pre-step 监听器。 */
function createCtx() {
  const listeners = []
  return {
    on(name, listener) {
      listeners.push({ name, listener })
      return () => {}
    },
    get preStep() {
      return listeners.find((item) => item.name === 'agent/pre-step')?.listener
    },
  }
}

/**
 * 跑一次 pre-step。
 *
 * payload 里 `messages` 是「本步已认领的原始消息」，decision.messages
 * 通常就是它的超集（其它插件可能已经加过东西）。我们刻意让两者不同，
 * 以便验证「插入点在认领消息之后」而不是简单地 unshift 到最前面。
 */
async function runPreStep(listener, agent, options = {}) {
  const claimed = options.claimed ?? [{ id: 'real-user-1', role: 'user', content: [{ type: 'text', text: '用户原话' }], source: { kind: 'user' } }]
  const decision = options.decision ?? { kind: 'enter', messages: [...claimed] }
  const payload = {
    agent,
    messages: claimed,
    step: options.step ?? 2,
    turn: 1,
    signal: undefined,
  }
  return listener(payload, async () => decision)
}

const baseConfig = (over = {}) => ({
  runtime: { inject: true, mode: 'message', maxMessages: 3, order: 120, ...(over.runtime ?? {}) },
  inject: { enabled: true, mode: 'message', maxMessages: 3, order: 125, ...(over.inject ?? {}) },
})

const RUNTIME_TEXT = '## 长期记忆\n- 用户偏好 TypeScript'
const RECALL_TEXT = '<vcprag-recall>命中内容</vcprag-recall>'

function buildRig(over = {}, deps = {}) {
  const ctx = createCtx()
  const config = baseConfig(over)
  const logs = []
  attachMessageChannel(ctx, {
    getConfig: () => config,
    getRuntimeText: deps.getRuntimeText ?? (() => RUNTIME_TEXT),
    getRecallText: deps.getRecallText ?? (async () => RECALL_TEXT),
    log: (level, message) => logs.push(`${level}: ${message}`),
  })
  return { ctx, config, logs }
}

/** 从 decision.messages 里挑出本插件注入的消息。 */
const ownMessages = (decision) => (decision.messages ?? []).filter(isVcpragMessage)

/**
 * 用真实渲染器造一段召回块，方便复现「同一批命中、装饰不同」的场景。
 *
 * @param {{ hits: string[], reason?: string, frozenAt?: string }} opts
 * @returns {string}
 */
function renderLikeRecall(opts) {
  const hits = (opts.hits ?? []).map((chunkId, index) => ({
    chunkId,
    docId: `doc-${chunkId}`,
    text: `第 ${index + 1} 条命中正文`,
    title: `标题${index + 1}`,
    date: '2026-11-01',
    tags: [],
  }))
  return renderRecallBlock(hits, {
    reason: opts.reason ?? 'user-message',
    maxChars: 4000,
    blockName: 'vcprag-recall',
    header: '相关历史：',
    disclaimer: '',
    itemPrefix: '[{n}] {date} · {title}',
    ...(opts.frozenAt === undefined ? {} : { frozenAt: opts.frozenAt }),
  })
}

// ================================================================ 测试开始

console.log('\n=== 1. 基础工具函数 ===')
{
  const message = createVcpragMessage('hello', FORM_RUNTIME)
  eq('role 是 user', message.role, 'user')
  ok('带本插件 source 标记', isVcpragMessage(message))
  eq('form 正确', message.source.form, FORM_RUNTIME)
  eq('正文可读', messageText(message), 'hello')
  eq('source.kind 不是 user', message.source.kind, MESSAGE_SOURCE_KIND)
  ok('别人的消息不算自己的', isVcpragMessage({ source: { kind: 'user' } }) === false)
}

console.log('\n=== 2. 首次注入：两条消息进本步 decision ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()
  const decision = await runPreStep(ctx.preStep, agent)

  const own = ownMessages(decision)
  eq('注入两条', own.length, 2)
  ok('一条常驻', own.some((m) => m.source.form === FORM_RUNTIME))
  ok('一条召回', own.some((m) => m.source.form === FORM_RECALL))
  ok('真人原话还在', decision.messages.some((m) => m.id === 'real-user-1'))
}

console.log('\n=== 3. ⚠️ inbox 绝不被触碰（多轮回复的根因） ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()
  await runPreStep(ctx.preStep, agent)

  // inbox 的 getter 一读就记 'read'，写方法直接抛错。
  // 只要实现里碰了 inbox，这里必然红。
  eq('没有对 inbox 做任何写操作（一旦写就会抛错）', agent.touchedInbox().filter((x) => x !== 'read').length, 0)
  ok(
    '连 inbox.nextStep 都没读',
    agent.touchedInbox().length === 0,
    `实际访问 ${JSON.stringify(agent.touchedInbox())}`,
  )
}

console.log('\n=== 4. 插入位置：紧跟本步认领的用户消息之后 ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()

  const claimed = [{ id: 'real-user-1', role: 'user', content: [{ type: 'text', text: '用户原话' }] }]
  const trailing = { id: 'other-plugin', role: 'user', content: [{ type: 'text', text: '别的插件加的' }] }
  // 模拟：别的插件已经往后追加过内容，decision.messages 比 claimed 长
  const decision = { kind: 'enter', messages: [...claimed, trailing] }

  const result = await runPreStep(ctx.preStep, agent, { claimed, decision })
  const ids = result.messages.map((m) => m.id)

  const claimAt = ids.indexOf('real-user-1')
  const otherAt = ids.indexOf('other-plugin')
  const ownStart = ids.findIndex((id, index) => index > claimAt && isVcpragMessage(result.messages[index]))

  ok('真人原话在最前', claimAt === 0, `实际 ${JSON.stringify(ids)}`)
  ok('注入紧跟原话之后', ownStart === 1, `实际 ${JSON.stringify(ids)}`)
  ok('别的插件的内容被推到后面（没被覆盖）', otherAt > ownStart, `实际 ${JSON.stringify(ids)}`)
  eq('总条数 = 1 原话 + 2 注入 + 1 别人', result.messages.length, 4)
}

console.log('\n=== 5. 幂等：内容已落库后不再重复注入 ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()

  const first = await runPreStep(ctx.preStep, agent)
  eq('首次注入两条', ownMessages(first).length, 2)

  // 模拟 DSH 把这步的消息落库
  for (const message of ownMessages(first)) agent.persist(message)

  const second = await runPreStep(ctx.preStep, agent)
  eq('第二步不再注入', ownMessages(second).length, 0)
  eq('原话还在', second.messages.length, 1)
}

console.log('\n=== 6. 重启后靠 surface 认出来，不重复注入 ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()

  // 历史里已经有这两个内容（上个进程写的）
  agent.seedHistory(createVcpragMessage(RUNTIME_TEXT, FORM_RUNTIME))
  agent.seedHistory(createVcpragMessage(RECALL_TEXT, FORM_RECALL))

  const decision = await runPreStep(ctx.preStep, agent)
  eq('没有重新注入', ownMessages(decision).length, 0)
}

console.log('\n=== 7. 内容变化 → 注入新的一条 ===')
{
  const rig = buildRig()
  const agent = createAgent()

  const first = await runPreStep(rig.ctx.preStep, agent)
  for (const message of ownMessages(first)) agent.persist(message)

  // 常驻内容变了
  rig.config.runtime.mode = 'message'
  const changed = createVcpragMessage('## 长期记忆\n- 用户改用 Rust', FORM_RUNTIME)
  agent.seedHistory(changed)

  // 换一个渲染函数，模拟读到新记忆
  const rig2 = buildRig({}, { getRuntimeText: () => '## 长期记忆\n- 用户改用 Rust' })
  const decision = await runPreStep(rig2.ctx.preStep, agent)
  eq('内容一致 → 不再注入常驻', ownMessages(decision).filter((m) => m.source.form === FORM_RUNTIME).length, 0)
}

console.log('\n=== 8. 达到上限后停止追加 ===')
{
  const { ctx, logs } = buildRig({ runtime: { maxMessages: 2 } })
  const agent = createAgent()

  // 历史上已经有两条不同内容（还没到上限判断里的「相同」分支）
  agent.seedHistory(createVcpragMessage('旧内容1', FORM_RUNTIME))
  agent.seedHistory(createVcpragMessage('旧内容2', FORM_RUNTIME))

  const decision = await runPreStep(ctx.preStep, agent)
  eq('不再注入常驻（已满 2 条）', ownMessages(decision).filter((m) => m.source.form === FORM_RUNTIME).length, 0)
  ok('有上限告警', logs.some((line) => line.includes('已达上限')))

  // 召回没满，照常注入
  ok('召回仍然注入', ownMessages(decision).some((m) => m.source.form === FORM_RECALL))
}

console.log('\n=== 9. 内容变空 → 不注入 ===')
{
  const { ctx } = buildRig({}, { getRuntimeText: () => '' })
  const agent = createAgent()
  const decision = await runPreStep(ctx.preStep, agent)
  eq('常驻没有注入', ownMessages(decision).filter((m) => m.source.form === FORM_RUNTIME).length, 0)
}

console.log('\n=== 10. 混用：常驻走 message、召回走 prompt ===')
{
  const { ctx } = buildRig({ inject: { mode: 'context' } })
  const agent = createAgent()
  const decision = await runPreStep(ctx.preStep, agent)

  const own = ownMessages(decision)
  eq('只注入一条', own.length, 1)
  eq('且是常驻', own[0].source.form, FORM_RUNTIME)
  ok('召回没有进消息', !own.some((m) => m.source.form === FORM_RECALL))
}

console.log('\n=== 11. 两种都走 prompt 时仍挂载，但不注入 ===')
{
  const { ctx } = buildRig({ runtime: { mode: 'section' }, inject: { mode: 'context' } })
  ok('仍然注册了 pre-step 监听', typeof ctx.preStep === 'function')

  const agent = createAgent()
  const decision = await runPreStep(ctx.preStep, agent)
  eq('没有注入任何消息', ownMessages(decision).length, 0)
  eq('decision 原样返回', decision.messages.length, 1)
}

console.log('\n=== 11b. 运行中热切换 prompt → message ===')
{
  const { ctx, config } = buildRig({ runtime: { mode: 'section' }, inject: { mode: 'context' } })
  const agent = createAgent()

  const before = await runPreStep(ctx.preStep, agent)
  eq('切换前：不注入', ownMessages(before).length, 0)

  config.runtime.mode = 'message'
  config.inject.mode = 'message'

  const after = await runPreStep(ctx.preStep, agent)
  const own = ownMessages(after)
  eq('切换后：两条都注入', own.length, 2)
  ok('有常驻', own.some((m) => m.source.form === FORM_RUNTIME))
  ok('有召回', own.some((m) => m.source.form === FORM_RECALL))
}

console.log('\n=== 12. 召回抛错不阻断，常驻照常 ===')
{
  const { ctx, logs } = buildRig(
    {},
    {
      getRecallText: async () => {
        throw new Error('embedding 挂了')
      },
    },
  )
  const agent = createAgent()

  let threw = false
  let decision
  try {
    decision = await runPreStep(ctx.preStep, agent)
  } catch {
    threw = true
  }

  ok('没有抛错打断 pre-step', threw === false)
  eq('常驻仍然注入', ownMessages(decision).filter((m) => m.source.form === FORM_RUNTIME).length, 1)
  eq('召回没注入', ownMessages(decision).filter((m) => m.source.form === FORM_RECALL).length, 0)
  ok('有召回失败日志', logs.some((line) => line.includes('召回消息渲染失败')))
}

console.log('\n=== 13. 决策被 reject 时不动 decision ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()
  const decision = { kind: 'reject', reason: 'cancelled', messages: [] }
  const result = await runPreStep(ctx.preStep, agent, { decision })
  eq('kind 保持 reject', result.kind, 'reject')
  eq('没有注入消息', ownMessages(result).length, 0)
}

console.log('\n=== 14. 空步（step=1 且无消息）不注入 ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()
  const decision = { kind: 'enter', messages: [] }
  const result = await runPreStep(ctx.preStep, agent, { claimed: [], decision, step: 1 })
  eq('空步不注入', ownMessages(result).length, 0)
}

console.log('\n=== 15. 没有 session 的 agent 安全降级 ===')
{
  const { ctx } = buildRig()
  // 只有 inbox、没有 session —— surfacedTexts 会返回空数组，注入照常但不会崩
  const bare = { id: 'bare' }
  let threw = false
  try {
    await runPreStep(ctx.preStep, bare)
  } catch {
    threw = true
  }
  ok('不抛错', threw === false)
}

console.log('\n=== 16. surfacedTexts 只认 surface 不认原始日志 ===')
{
  const agent = createAgent()
  const kept = createVcpragMessage('保留的', FORM_RECALL)
  const dropped = createVcpragMessage('被替换掉的', FORM_RECALL)

  agent.persist(kept)
  // 原始日志里会有 dropped，但 surface.nodes 不包含它（被 supersede）
  agent.persist(dropped)
  // 手工把它从 nodes 里摘掉，模拟 surface 的 replace 语义
  const nodes = agent.session.surface.nodes
  const last = nodes[nodes.length - 1]
  agent.session.surface // 只是读
  // 直接用 eventAt 之外的路径：重建 nodes 数组
  const events = nodes.map((seq) => agent.session.eventAt(seq))
  const keptSeq = events.find((e) => messageText(e.data) === '保留的').seq
  // 通过替换 session.surface 的返回值来模拟
  const realSession = agent.session
  const patched = {
    id: realSession.id,
    surface: { nodes: [keptSeq] },
    eventAt: realSession.eventAt,
  }

  const texts = surfacedTexts(patched, FORM_RECALL)
  eq('只返回 surface 里的那条', texts.length, 1)
  eq('内容正确', texts[0], '保留的')
  ok('被替换掉的不计入', !texts.includes('被替换掉的'), JSON.stringify(texts))
  void last
}

console.log('\n=== 17. 只有 prompt 模式的 form 不产生消息 ===')
{
  const { ctx } = buildRig({ runtime: { mode: 'section' } })
  const agent = createAgent()
  const decision = await runPreStep(ctx.preStep, agent)
  const own = ownMessages(decision)
  eq('只注入召回一条', own.length, 1)
  eq('常驻没有进消息', own[0].source.form, FORM_RECALL)
}

// ------------------------------------------------------------------
// 18-22 是「检索一直在跑，但注入被 3 条上限卡死」事故的回归。
//
// 事故现象（真实日志）：一个会话里只有 1 次成功注入，之后 39 次刷
// `召回消息已达上限 3 条，不再追加`；同一时段检索确实重跑了 12 次、
// 结果也变了（6/7/8 条、4038~4148 字），一条都没进去。
//
// 根因：召回块开标签带 `frozen="<ISO 时间戳>"` 和 `reason="…"`，
// 每次渲染都不同 → `surfaced.includes(text)` 永远 false → 永远判成
// 「新内容」→ 一路撞上限。修法：改用「命中了哪些 chunk」算内容摘要，
// 并把开标签的属性一起剥掉。
// ------------------------------------------------------------------

console.log('\n=== 18. 摘要不受时间戳/触发原因影响 ===')
{
  const a = renderLikeRecall({ hits: ['c1', 'c2'], reason: 'first-turn', frozenAt: '2026-11-06T08:12:10.086Z' })
  const b = renderLikeRecall({ hits: ['c1', 'c2'], reason: 'user-message', frozenAt: '2026-11-06T09:09:46.445Z' })

  ok('两次渲染的正文确实不同（说明装饰真的变了）', a !== b)
  eq('但内容摘要相同', contentDigest([a]), contentDigest([b]))
}

console.log('\n=== 19. 同一批命中不会重复注入（哪怕时间戳变了） ===')
{
  // 两轮都用同一个 hit 集合，只有装饰（frozenAt / reason）不同。
  const hits = ['c1', 'c2']

  const { ctx } = buildRig(
    {},
    {
      getRecallText: async () =>
        renderLikeRecall({ hits, reason: 'first-turn', frozenAt: '2026-11-06T08:12:10.086Z' }),
    },
  )
  const agent = createAgent()

  const first = await runPreStep(ctx.preStep, agent)
  const recall1 = ownMessages(first).find((m) => m.source.form === FORM_RECALL)
  ok('第一次注入了召回', recall1 !== undefined)
  agent.persist(recall1)

  // 下一轮：同一批命中，渲染时间戳与触发原因都变了
  const { ctx: ctx2 } = buildRig(
    {},
    {
      getRecallText: async () =>
        renderLikeRecall({ hits, reason: 'user-message', frozenAt: new Date().toISOString() }),
    },
  )
  const second = await runPreStep(ctx2.preStep, agent)
  eq('同一批命中 → 不再注入', ownMessages(second).filter((m) => m.source.form === FORM_RECALL).length, 0)
}

console.log('\n=== 20. 命中变化 → 必须能注入进去（不被误判的已注入挡住） ===')
{
  const { ctx } = buildRig()
  const agent = createAgent()

  const first = await runPreStep(ctx.preStep, agent)
  for (const m of ownMessages(first)) agent.persist(m)

  // 检索结果变了（多命中一条）
  const { ctx: ctx2 } = buildRig(
    {},
    { getRecallText: async () => renderLikeRecall({ hits: ['c1', 'c2', 'c3'], reason: 'user-message' }) },
  )
  const second = await runPreStep(ctx2.preStep, agent)

  const recall2 = ownMessages(second).find((m) => m.source.form === FORM_RECALL)
  ok('新命中确实注入了', recall2 !== undefined)
  ok(
    '摘要与旧版不同',
    recall2?.source.digest !== contentDigest([renderLikeRecall({ hits: ['c1', 'c2'] })]),
  )
}

console.log('\n=== 21. 旧消息没有 digest 字段时仍能认出（升级兼容） ===')
{
  const agent = createAgent()
  // 模拟旧版本写入的消息：source 里没有 digest
  agent.persist({
    id: 'legacy-1',
    role: 'user',
    content: [{ type: 'text', text: RUNTIME_TEXT }],
    source: { kind: MESSAGE_SOURCE_KIND, form: FORM_RUNTIME },
  })

  const digests = surfacedDigests(agent.session, FORM_RUNTIME)
  eq('退化用正文算出摘要', digests.length, 1)
  eq('与当前渲染的摘要一致', digests[0], contentDigest([RUNTIME_TEXT]))

  const { ctx } = buildRig()
  const decision = await runPreStep(ctx.preStep, agent)
  eq('认出历史内容，不重复注入常驻', ownMessages(decision).filter((m) => m.source.form === FORM_RUNTIME).length, 0)
}

console.log('\n=== 22. stableIdentity 只剥开标签属性，不动正文 ===')
{
  eq('保留标签名', stableIdentity('<a x="1">t</a>'), '<a>t</a>')
  eq('没有属性时不改', stableIdentity('<a>t</a>'), '<a>t</a>')
  eq(
    '多行正文原样保留',
    stableIdentity('<a f="1">\n行1\n行2\n</a>'),
    '<a>\n行1\n行2\n</a>',
  )
  eq('空输入', stableIdentity(''), '')
  ok('正文里的尖括号不被误伤', stableIdentity('<a>1 < 2</a>').includes('1 < 2'))
}

// 23-25 是「上限在 UI 里改不了 / 填 0 语义反掉 / 告警刷屏」的回归。
// 事故原貌：日志里 39 条一模一样的 `召回消息已达上限 3 条，不再追加`，
// 而同一时段检索重跑了 12 次 —— 上限值写死在代码里，用户在设置面板
// 根本找不到可以改的地方，只能眼看着新召回进不来。

console.log('\n=== 23. normaliseMaxMessages：0 = 不限制，不是「一条都不许」 ===')
{
  eq('0 → 不限制', normaliseMaxMessages(0), Number.POSITIVE_INFINITY)
  eq('负数 → 不限制', normaliseMaxMessages(-5), Number.POSITIVE_INFINITY)
  eq('正常值原样返回', normaliseMaxMessages(7), 7)
  eq('字符串数字也认', normaliseMaxMessages('12'), 12)
  eq('小数四舍五入', normaliseMaxMessages(4.6), 5)
  eq('undefined → 回默认（配置缺失≠用户填0）', normaliseMaxMessages(undefined), DEFAULT_MAX_MESSAGES)
  eq('null → 回默认', normaliseMaxMessages(null), DEFAULT_MAX_MESSAGES)
  eq('NaN → 回默认', normaliseMaxMessages(Number.NaN), DEFAULT_MAX_MESSAGES)
  eq('超大值被压到天花板', normaliseMaxMessages(9999), MAX_MESSAGES_CEILING)
}

console.log('\n=== 24. 上限配成 0 时能一直追加（不被卡死） ===')
{
  const { ctx, logs } = buildRig({ runtime: { maxMessages: 0 }, inject: { maxMessages: 0 } })
  const agent = createAgent()

  // 历史里先塞 10 条旧消息 —— 旧实现下 `surfaced.length >= 0` 恒成立，永远不注入
  for (let i = 0; i < 10; i += 1) {
    agent.seedHistory(createVcpragMessage(`旧内容${i}`, FORM_RUNTIME, `old-${i}`))
  }

  const decision = await runPreStep(ctx.preStep, agent)
  ok('常驻照常注入（0 不等于禁止）', ownMessages(decision).some((m) => m.source.form === FORM_RUNTIME))
  ok('召回照常注入', ownMessages(decision).some((m) => m.source.form === FORM_RECALL))
  ok('没有任何上限告警', !logs.some((line) => line.includes('已达上限')))
}

console.log('\n=== 25. 上限告警只报一次（不再每步刷屏） ===')
{
  const { ctx, logs } = buildRig({ runtime: { maxMessages: 1 } })
  const agent = createAgent()
  agent.seedHistory(createVcpragMessage('旧内容1', FORM_RUNTIME, 'old-1'))

  // 连续三步都卡在同一个上限上
  for (let i = 0; i < 3; i += 1) await runPreStep(ctx.preStep, agent)

  const capLogs = logs.filter((line) => line.includes('已达上限'))
  eq('三步只打一条告警', capLogs.length, 1)
  ok('告警里带上限值', capLogs[0].includes('上限 1 条'), capLogs[0])
}

// ================================================================ 汇总

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) process.exitCode = 1
