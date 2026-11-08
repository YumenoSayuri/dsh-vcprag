/**
 * smoke-recall-inject —— 验证「自动召回」这条链路真的能产出非空注入文本。
 *
 * 为什么需要这个测试：之前真实事故是「插件加载了、索引 371 chunk 都在、
 * UI 面板也正常，但用户发消息什么都没召回」。根因是注入通道从没被驱动过 ——
 * 代码里写着一个 `maybeRefresh`，但全世界没有一个调用方。
 *
 * 这种故障**单元测试抓不到**：每个函数单独调都正确，坏的是「没人调」。
 * 所以这里不测单个函数，而是照 DSH 真实的调用顺序搭一条最小流水线：
 *
 *   mockSystemPrompt.assemble(context)
 *     ├─ 先求值 context.text()      ← 同步，此时召回还没发生
 *     ├─ 再跑 system-prompt/assemble waterfall
 *     └─ 返回最终 assembly
 *
 * 然后断言：**最终 assembly.contexts 里那条召回条目的 text 非空**。
 * 这个断言在修复前必定失败（text 是 ''），修复后必须通过。
 */

import { registerInjections } from '../lib/inject.js'
import { RecallFridge } from '../lib/freeze.js'
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
 * 最小 systemPrompt 服务实现，语义对齐 DSH 的 `SystemPrompt` 类。
 * 关键点：
 *   - contexts 注册项在 assemble 里**同步**求值
 *   - section/context 是全局层，所有会话共用
 *   - waterfall 在 contexts 求值**之后**跑，且带 prepend 排序
 */
function createSystemPrompt() {
  const contexts = new Map()
  const sections = new Map()
  const listeners = []

  return {
    section(entry) {
      if (!Number.isFinite(entry.order)) throw new TypeError('order must be finite')
      sections.set(entry.name, entry)
      return () => sections.delete(entry.name)
    },
    context(entry) {
      if (!Number.isFinite(entry.order)) throw new TypeError('order must be finite')
      contexts.set(entry.name, entry)
      return () => contexts.delete(entry.name)
    },
    on(name, listener, options = {}) {
      if (name !== 'system-prompt/assemble') return () => {}
      listeners.push({ listener, prepend: options.prepend === true })
      return () => {
        const index = listeners.findIndex((item) => item.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    /** 复刻 DSH 的 assemble：先求值 contexts，再跑 waterfall。 */
    async assemble(context = {}) {
      const assembly = {
        sections: [...sections.values()].map((entry) => ({
          name: entry.name,
          text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
          ...entry.interpolate !== void 0 ? { interpolate: entry.interpolate } : {},
        })),
        contexts: [...contexts.values()].map((entry) => ({
          name: entry.name,
          text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
          ...entry.interpolate !== void 0 ? { interpolate: entry.interpolate } : {},
        })),
        variables: {},
      }

      // waterfall：prepend 的排最前（最先执行、最外包）
      const ordered = [
        ...listeners.filter((item) => item.prepend),
        ...listeners.filter((item) => !item.prepend),
      ]
      let index = 0
      const next = async () => {
        const item = ordered[index]
        index += 1
        if (item === undefined) return assembly
        return item.listener(assembly, context, next)
      }
      return next()
    },
  }
}

/** 假 provider ctx：只实现我们用到的那几个方法。 */
function createCtx() {
  const systemPrompt = createSystemPrompt()
  return { systemPrompt, on: systemPrompt.on.bind(systemPrompt) }
}

/** 造一个假 session：只有 snapshotEvents() 是真的被读的。 */
function createSession(id, events) {
  return { id, snapshotEvents: () => events }
}

/** 一条真人用户消息事件。 */
function userEvent(id, text) {
  return {
    type: 'user/message',
    data: { id, content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** todo_write 工具调用事件。 */
function todoEvent(callId, todos) {
  return { type: 'tool/call', data: { callId, name: 'todo_write', arguments: { todos } } }
}

/** 基础配置：解析后的形态里我们只用到这几段。 */
const baseConfig = {
  runtime: { inject: false, order: 120 },
  diary: {
    enabled: false,
    format: 'txt',
    folder: '',
    templateEnabled: false,
    templateOrder: 130,
    templateText: '',
  },
  inject: {
    enabled: true,
    order: 125,
    blockName: 'vcprag-recall',
    header: '相关历史：',
    disclaimer: '',
    itemPrefix: '[{n}] {date} · {title}',
  },
  recall: { maxChars: 4000 },
}

/** 假召回：固定返回两条命中，记录调用次数与查询。 */
function makeRecaller() {
  const calls = []
  const runRecall = async (sessionId, query) => {
    calls.push({ sessionId, query })
    return {
      hits: [
        { chunkId: 'c1', docId: 'd1', text: '关于向量召回的排障记录。', title: '召回排障', date: '2026-11-01', tags: [] },
        { chunkId: 'c2', docId: 'd2', text: 'BM25 与语义通道的融合方式。', title: '融合策略', date: '2026-10-20', tags: [] },
      ],
      k: 2,
      queryTokens: query.split(/\s+/).filter(Boolean),
    }
  }
  runRecall.calls = calls
  return runRecall
}

/** 把整条链路搭起来。 */
function buildRig(configOverride = {}) {
  const config = { ...baseConfig, ...configOverride }
  const ctx = createCtx()
  const fridges = new Map()
  const fridgeFor = (sessionId) => {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : '__default__'
    if (!fridges.has(key)) fridges.set(key, new RecallFridge())
    return fridges.get(key)
  }
  const runRecall = makeRecaller()

  registerInjections(ctx, {
    getConfig: () => config,
    fridgeFor,
    runRecall,
    renderRecallBlock,
    log: () => {},
  })

  return { ctx, fridgeFor, runRecall, fridges }
}

const recallEntryOf = (assembly) => assembly.contexts.find((item) => item.name === 'vcprag:recall')

// ================================================================ 测试开始

console.log('\n=== 1. 通道 3 占位注册 ===')
{
  const { ctx } = buildRig()
  const assembly = await ctx.systemPrompt.assemble({ agent: { session: createSession('s-none', []) } })
  const entry = recallEntryOf(assembly)
  ok('召回 context 已注册', entry !== undefined)
  eq('无用户消息时占位为空串（不注入垃圾）', entry?.text ?? null, '')
}

console.log('\n=== 2. 首个回合：必须真的召回并注入 ===')
{
  const { ctx, runRecall } = buildRig()
  const session = createSession('s1', [userEvent('m1', '上次那个向量召回的 bug 是怎么修的？')])
  const assembly = await ctx.systemPrompt.assemble({ agent: { session } })
  const entry = recallEntryOf(assembly)

  ok('注入文本非空', typeof entry?.text === 'string' && entry.text.length > 0, `实际 ${JSON.stringify(entry?.text?.slice(0, 40))}`)
  ok('注入文本含外层标签', entry?.text?.startsWith('<vcprag-recall') === true)
  ok('注入文本含命中正文', entry?.text?.includes('量化') === true || entry?.text?.includes('召回排障') === true)
  eq('召回被真实调用一次', runRecall.calls.length, 1)
  eq('查询用的是用户原话', runRecall.calls[0].query, '上次那个向量召回的 bug 是怎么修的？')
  eq('会话 id 传对了', runRecall.calls[0].sessionId, 's1')
}

console.log('\n=== 3. 冻结：同一条用户消息不重复召回 ===')
{
  const { ctx, runRecall } = buildRig()
  const session = createSession('s2', [userEvent('m1', '向量召回怎么配')])
  const context = { agent: { session } }

  const first = await ctx.systemPrompt.assemble(context)
  const second = await ctx.systemPrompt.assemble(context)
  const third = await ctx.systemPrompt.assemble(context)

  eq('三轮组装只召回一次', runRecall.calls.length, 1)
  const a = recallEntryOf(first)?.text
  const b = recallEntryOf(second)?.text
  const c = recallEntryOf(third)?.text
  ok('三轮注入文本完全一致（缓存安全）', a === b && b === c)
  ok('且非空', typeof a === 'string' && a.length > 0)
}

console.log('\n=== 4. 新用户消息 → 重新召回 ===')
{
  const { ctx, runRecall } = buildRig()
  const events = [userEvent('m1', '向量召回怎么配')]
  const session = createSession('s3', events)

  await ctx.systemPrompt.assemble({ agent: { session } })
  eq('首轮召回一次', runRecall.calls.length, 1)

  events.push(userEvent('m2', '那 BM25 的权重怎么调'))
  await ctx.systemPrompt.assemble({ agent: { session } })
  eq('新消息后再次召回', runRecall.calls.length, 2)
  eq('用的新查询', runRecall.calls[1].query, '那 BM25 的权重怎么调')

  await ctx.systemPrompt.assemble({ agent: { session } })
  eq('同一条消息不重复', runRecall.calls.length, 2)
}

console.log('\n=== 5. todo 勾选增加 → 阶段推进召回 ===')
{
  const { ctx, runRecall } = buildRig()
  const events = [
    userEvent('m1', '重构召回模块'),
    todoEvent('t1', [
      { content: '拆分 inject.js', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ]),
  ]
  const session = createSession('s4', events)

  await ctx.systemPrompt.assemble({ agent: { session } })
  const afterFirst = runRecall.calls.length

  // 模型干完一项，勾上
  events.push(todoEvent('t2', [
    { content: '拆分 inject.js', status: 'completed' },
    { content: '补测试', status: 'in_progress' },
  ]))
  const assembly = await ctx.systemPrompt.assemble({ agent: { session } })

  ok('阶段推进触发了额外召回', runRecall.calls.length > afterFirst, `调用数 ${runRecall.calls.length}`)
  eq('查询用的是当前 in_progress 条目', runRecall.calls.at(-1).query, '补测试')
  const entry = recallEntryOf(assembly)
  ok('注入文本仍非空', typeof entry?.text === 'string' && entry.text.length > 0)
}

console.log('\n=== 6. 零命中不冻结：下一轮还能再召回 ===')
{
  const ctx = createCtx()
  const fridgeFor = () => new RecallFridge()
  let calls = 0
  // 第一次零命中，第二次有命中
  const runRecall = async () => {
    calls += 1
    if (calls === 1) return { hits: [], k: 0, queryTokens: [] }
    return {
      hits: [{ chunkId: 'c1', docId: 'd1', text: '有内容了。', title: 'T', date: '2026-11-01', tags: [] }],
      k: 1,
      queryTokens: [],
    }
  }
  registerInjections(ctx, {
    getConfig: () => ({ ...baseConfig, runtime: { inject: false, order: 120 } }),
    fridgeFor,
    runRecall,
    renderRecallBlock,
    log: () => {},
  })

  const events = [userEvent('m1', '第一次查询')]
  const session = createSession('s5', events)

  const first = await ctx.systemPrompt.assemble({ agent: { session } })
  eq('零命中时注入为空', recallEntryOf(first)?.text ?? null, '')

  // 换一句话，应该还能再试
  events.push(userEvent('m2', '第二次查询'))
  const second = await ctx.systemPrompt.assemble({ agent: { session } })
  ok('零命中未污染后续召回', (recallEntryOf(second)?.text ?? '').length > 0, `实际 ${JSON.stringify(recallEntryOf(second)?.text)}`)
  eq('总共尝试两次', calls, 2)
}

console.log('\n=== 7. 会话隔离：不同会话互不串味 ===')
{
  const { ctx, runRecall } = buildRig()
  const sA = createSession('sA', [userEvent('a1', '会话A的问题')])
  const sB = createSession('sB', [userEvent('b1', '会话B的问题')])

  await ctx.systemPrompt.assemble({ agent: { session: sA } })
  await ctx.systemPrompt.assemble({ agent: { session: sB } })

  eq('两个会话各召回一次', runRecall.calls.length, 2)
  eq('会话A 用 A 的查询', runRecall.calls[0].query, '会话A的问题')
  eq('会话B 用 B 的查询', runRecall.calls[1].query, '会话B的问题')

  // 冻结互不影响：A 再组装一次不该再召回
  await ctx.systemPrompt.assemble({ agent: { session: sA } })
  eq('A 复用自己冻结的文本（不重复召回）', runRecall.calls.length, 2)
}

console.log('\n=== 8. 只有 assistant/工具事件时不该瞎召回 ===')
{
  const { ctx, runRecall } = buildRig()
  // DSH 自己写的 user/message（runtime-context 等）source.kind 不是 'user'
  const synthetic = [
    { type: 'user/message', data: { id: 'x1', content: [{ type: 'text', text: 'Current working directory: "C:\\\\x".' }], source: { kind: 'working-directory' } } },
    { type: 'user/message', data: { id: 'x2', content: [{ type: 'text', text: 'Current runtime context: none.' }], source: { kind: 'runtime-context' } } },
  ]
  const session = createSession('s6', synthetic)
  const assembly = await ctx.systemPrompt.assemble({ agent: { session } })

  eq('框架注入的伪 user 消息不触发召回', runRecall.calls.length, 0)
  eq('注入为空', recallEntryOf(assembly)?.text ?? null, '')
}

console.log('\n=== 9. 没有 agent（全局组装）时安全降级 ===')
{
  const { ctx, runRecall } = buildRig()
  const assembly = await ctx.systemPrompt.assemble({})
  eq('不召回', runRecall.calls.length, 0)
  eq('注入为空', recallEntryOf(assembly)?.text ?? null, '')
}

console.log('\n=== 10. inject.enabled=false 时彻底不召回 ===')
{
  const { ctx, runRecall } = buildRig({
    inject: { ...baseConfig.inject, enabled: false },
  })
  const session = createSession('s7', [userEvent('m1', '随便问点什么')])
  await ctx.systemPrompt.assemble({ agent: { session } })
  eq('关闭后不召回', runRecall.calls.length, 0)
}

console.log('\n=== 11. 召回抛错时不影响组装 ===')
{
  const ctx = createCtx()
  registerInjections(ctx, {
    getConfig: () => baseConfig,
    fridgeFor: () => new RecallFridge(),
    runRecall: async () => {
      throw new Error('embedding 服务炸了')
    },
    renderRecallBlock,
    log: () => {},
  })
  const session = createSession('s8', [userEvent('m1', '会失败的查询')])
  let assembly
  let threw = false
  try {
    assembly = await ctx.systemPrompt.assemble({ agent: { session } })
  } catch {
    threw = true
  }
  ok('召回失败没有把组装打断', threw === false)
  eq('只是不注入', recallEntryOf(assembly ?? { contexts: [] })?.text ?? null, '')
}

console.log('\n=== 12. 占位内容不被当成文本注入 ===')
{
  const { ctx } = buildRig()
  const assembly = await ctx.systemPrompt.assemble({ agent: { session: createSession('s9', []) } })
  const entry = recallEntryOf(assembly)
  ok('contexts 条目存在', entry !== undefined)
  eq('text 为空（不是 undefined 也不是占位符）', entry?.text, '')
  eq('interpolate=false 保留', entry?.interpolate, false)
}

// ------------------------------------------------------------------
// 13/14 是真实事故的回归测试。
//
// 事故：启动时 mode 是 context，用户在设置里切成 message 后召回彻底消失。
// 根因是注入通道的装配被判成启动期常量 —— context 的 waterfall 钩子
// 因为在注册时 mode 还是 context 所以确实挂上了，但它在运行时读到
// mode==='message' 就 return（正确）；而消息通道因为在启动时看到 mode
// 还是 context，压根没挂监听。两条路都空。
//
// 修法：装配一律静态（section / context / waterfall / pre-step 全挂），
// 走哪条通道由每轮读到的 config 决定。下面两条锁住这个契约。
// ------------------------------------------------------------------

console.log('\n=== 13. mode=message 时 context 仍注册，只是不注入 ===')
{
  const { ctx, runRecall } = buildRig({
    inject: { ...baseConfig.inject, mode: 'message' },
  })
  const session = createSession('s10', [userEvent('m1', '向量召回怎么配')])
  const assembly = await ctx.systemPrompt.assemble({ agent: { session } })
  const entry = recallEntryOf(assembly)

  ok('context 条目仍然注册（否则热切回 prompt 就没了）', entry !== undefined)
  eq('text 空（不往 system 里塞内容）', entry?.text ?? null, '')
  eq('prompt 通道不召回（交给消息通道）', runRecall.calls.length, 0)
}

console.log('\n=== 14. 运行中热切换 context → message → context ===')
{
  const config = {
    ...baseConfig,
    inject: { ...baseConfig.inject, mode: 'context' },
  }
  const ctx = createCtx()
  const fridges = new Map()
  const runRecall = makeRecaller()
  registerInjections(ctx, {
    getConfig: () => config,
    fridgeFor: (sessionId) => {
      if (!fridges.has(sessionId)) fridges.set(sessionId, new RecallFridge())
      return fridges.get(sessionId)
    },
    runRecall,
    renderRecallBlock,
    log: () => {},
  })

  const session = createSession('s11', [userEvent('m1', '向量召回怎么配')])
  const context = { agent: { session } }

  const first = await ctx.systemPrompt.assemble(context)
  ok('起步（context）：注入非空', (recallEntryOf(first)?.text ?? '').length > 0)
  eq('召回调了一次', runRecall.calls.length, 1)

  // 用户切成 message：prompt 侧让位
  config.inject.mode = 'message'
  const second = await ctx.systemPrompt.assemble(context)
  eq('切到 message 后 prompt 侧为空', recallEntryOf(second)?.text ?? null, '')
  eq('没有重复召回', runRecall.calls.length, 1)

  // 再切回 context：必须能继续注入（这是事故里丢掉的那一半）
  config.inject.mode = 'context'
  const third = await ctx.systemPrompt.assemble(context)
  ok('切回 context 后重新有内容', (recallEntryOf(third)?.text ?? '').length > 0)
}

console.log('\n=== 14b. todo 触发不被 user-message 分支饿死 ===')
{
  // 真实事故：一整天 12 次刷新里 phase-change 是 **0 次**。
  //
  // 根因在 pickTrigger 的判定顺序：先判 user-message。它一旦成立就
  // `markTrigger(key, state.completedCount)` —— 顺手把 completedCount
  // 基线刷成当前值。等下一轮走到 todo 分支时，差值永远是 0，
  // `completedCount > fridge.completedCount` 恒为 false，触发器饿死。
  //
  // 修法：todo 分支提到 user-message 之前。这里锁住「两者同时成立时
  // 优先走 phase-change」。
  const config = { ...baseConfig, inject: { ...baseConfig.inject } }
  const ctx = createCtx()
  const fridges = new Map()
  const runRecall = makeRecaller()
  const logs = []
  registerInjections(ctx, {
    getConfig: () => config,
    fridgeFor: (sessionId) => {
      if (!fridges.has(sessionId)) fridges.set(sessionId, new RecallFridge())
      return fridges.get(sessionId)
    },
    runRecall,
    renderRecallBlock,
    log: (level, message) => logs.push(`${level}: ${message}`),
  })

  const session = createSession('s-todo', [userEvent('m1', '开始干活')])
  await ctx.systemPrompt.assemble({ agent: { session } })
  const afterFirst = runRecall.calls.length
  eq('首轮召回一次', afterFirst, 1)

  // 之后：todo 勾了一个 **且** 来了新用户消息（两者同时成立）
  session.snapshotEvents = () => [
    userEvent('m1', '开始干活'),
    todoEvent('t1', [
      { content: '步骤一', status: 'completed' },
      { content: '步骤二', status: 'in_progress' },
    ]),
    userEvent('m2', '继续'),
  ]

  await ctx.systemPrompt.assemble({ agent: { session } })
  ok('又召回了一次', runRecall.calls.length > afterFirst)

  // 关键断言：日志里的触发原因必须是 phase-change，不能被 user-message 抢走
  const refreshed = logs.filter((line) => line.includes('召回刷新'))
  const last = refreshed[refreshed.length - 1] ?? ''
  ok('触发原因是 phase-change（todo 没被饿死）', last.includes('phase-change'), `实际：${last}`)
  ok('查询用的是 in_progress 条目', runRecall.calls[runRecall.calls.length - 1].query.includes('步骤二'))

  // 同一状态再来一次：不该重复召回
  const before = runRecall.calls.length
  await ctx.systemPrompt.assemble({ agent: { session } })
  eq('同一状态不重复召回', runRecall.calls.length, before)
}

console.log('\n=== 15. runtime section 同样按 mode 动态让位 ===')
{
  const config = {
    runtime: { inject: true, mode: 'section', order: 120 },
    diary: baseConfig.diary,
    inject: { ...baseConfig.inject },
    recall: baseConfig.recall,
  }
  // 用一个存在的 runtime 文件才有内容；这里直接读不到就断言空串让位即可，
  // 关键契约是「注册存在、mode=message 时一定返回空」。
  const ctx = createCtx()
  registerInjections(ctx, {
    getConfig: () => config,
    fridgeFor: () => new RecallFridge(),
    runRecall: async () => ({ hits: [] }),
    renderRecallBlock,
    log: () => {},
  })

  ok('runtime section 已注册', ctx.systemPrompt !== undefined)
  const asSection = await ctx.systemPrompt.assemble({ agent: { session: createSession('s12', []) } })
  const sectionEntry = asSection.sections.find((item) => item.name === 'vcprag:runtime')
  ok('section 条目存在（不是 undefined）', sectionEntry !== undefined)

  config.runtime.mode = 'message'
  const asMessage = await ctx.systemPrompt.assemble({ agent: { session: createSession('s12', []) } })
  const sectionEntry2 = asMessage.sections.find((item) => item.name === 'vcprag:runtime')
  eq('切到 message 后 section 让位（空串）', sectionEntry2?.text ?? null, '')
}

// ================================================================ 汇总

console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有失败'}：${passed} 通过 / ${failed} 失败\n`)
if (failed > 0) process.exitCode = 1
