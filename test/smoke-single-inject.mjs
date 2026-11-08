/**
 * smoke-single-inject —— 锁住「一次用户输入只注入一块」。
 *
 * ## 要防的 bug
 *
 * 会话事件的真实顺序是：
 *
 *     step/start            ← 插件 pre-step 在这里跑，新消息还没落库
 *     user/message/user     ← 新消息在这一步之后才被记录
 *
 * 所以首步 pre-step 读 `snapshotEvents()` 时拿到的是**上一条**用户消息。
 * 旧实现因此一条输入注入两块：
 *
 *   step 1：拿上一条当查询 → 冻结 → 注入（内容错但已落库）
 *   step 2：新消息已落库 → userKey 变了 → 重新召回 → 再注入一块
 *
 * 实测日志（同一条输入）：
 *     23:34:56 召回结果作为消息注入（4111 字）
 *     23:35:10 召回刷新（user-message）：5 条 / 4104 字
 *     23:35:10 召回结果作为消息注入（4104 字）
 *
 * 修法：调用方把本步认领的用户消息通过 `liveUser` 传进来，
 * `pickTrigger` 用它覆盖 snapshot 里的旧值，并把它的键记为已消费。
 *
 * 跑法：node test/smoke-single-inject.mjs
 */

import { RecallFridge } from '../lib/freeze.js'
import { pickClaimedUserMessage } from '../lib/message-channel.js'
import { pickTrigger, readSessionState } from '../lib/inject.js'

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? ` — ${detail}` : ''))
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------- 假会话

/** 最小 session 替身：只实现本插件用到的 snapshotEvents()。 */
function fakeSession(events) {
  return { snapshotEvents: () => events }
}

function userEvent(id, text) {
  return {
    type: 'user/message',
    data: { id, content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function recallEvent(text) {
  return {
    type: 'user/message',
    data: {
      id: `inj-${Math.random().toString(36).slice(2, 8)}`,
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-vcprag', form: 'recall' },
    },
  }
}

/**
 * 造一个 todo_write 调用事件。
 * @param {number} completed - status=completed 的条数
 * @param {string} inProgress - 唯一一条 in_progress 的 content
 */
function todoEvent(completed, inProgress) {
  const todos = []
  for (let i = 0; i < completed; i += 1) todos.push({ content: `已完成 ${i}`, status: 'completed' })
  if (inProgress !== '') todos.push({ content: inProgress, status: 'in_progress' })
  return { type: 'tool/call', data: { name: 'todo_write', arguments: { todos } } }
}

/**
 * 复刻 `ensureInjection` 的判定主干（不含真实召回）。
 *
 * 与 inject.js 的对应关系：
 *   trigger = pickTrigger(session, fridge, liveUser)
 *   if (!trigger.refresh && fridge.frozen) → 复用，不注入
 *   query === ''                          → freeze 空，不注入
 *   否则召回到 hits > 0 → markTrigger + freeze → 注入一块
 *
 * 返回 injected 表示「这一步真的吐出了一块新文本」。
 */
function stepOnce({ session, fridge, liveUser, hits }) {
  const trigger = pickTrigger(session, fridge, liveUser)
  if (trigger.refresh !== true && fridge.frozen) {
    return { injected: false, reason: 'reuse', trigger }
  }
  if (trigger.query === '') {
    if (!fridge.frozen) fridge.freeze({ text: '', reason: 'no-query', hits: [] })
    return { injected: false, reason: 'no-query', trigger }
  }
  if (hits <= 0) return { injected: false, reason: 'zero-hit', trigger }
  fridge.markTrigger(trigger.key, trigger.completedCount, trigger.userKey)
  fridge.freeze({ text: `block:${trigger.query}`, reason: trigger.reason, hits: [] })
  return { injected: true, reason: trigger.reason, trigger, text: fridge.currentText() }
}

// ================================================================ 1
console.log('=== 1. pickClaimedUserMessage：从本步认领里挑真人输入 ===')
{
  const claimed = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一条' }], source: { kind: 'user' } },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '这是最新的一条' }], source: { kind: 'user' } },
  ]
  const got = pickClaimedUserMessage(claimed)
  console.log('  →', JSON.stringify(got))
  check('取最后一条（不是第一条）', got?.id === 'm2', `实际 ${got?.id}`)
  check('文本正确', got?.text === '这是最新的一条')
}

// ================================================================ 2
console.log('')
console.log('=== 2. 必须排除本插件自己注入的消息 ===')
{
  const claimed = [
    { id: 'human', role: 'user', content: [{ type: 'text', text: '真人说的话' }], source: { kind: 'user' } },
    {
      id: 'injected',
      role: 'user',
      content: [{ type: 'text', text: '<vcprag-recall> 记忆块 </vcprag-recall>' }],
      source: { kind: 'dsh-vcprag', form: 'recall' },
    },
  ]
  const got = pickClaimedUserMessage(claimed)
  console.log('  →', JSON.stringify(got))
  check('跳过注入块，取真人消息', got?.id === 'human', `实际 ${got?.id}`)
}

// ================================================================ 3
console.log('')
console.log('=== 3. 必须排除 DSH 运行时快照 ===')
{
  const claimed = [
    { id: 'human', role: 'user', content: [{ type: 'text', text: '真人说的话' }], source: { kind: 'user' } },
    {
      id: 'snap',
      role: 'user',
      content: [{ type: 'text', text: 'working-directory: /x' }],
      source: { kind: 'runtime-context' },
    },
    {
      id: 'time',
      role: 'user',
      content: [{ type: 'text', text: 'Time sampled...' }],
      source: { kind: 'time-context' },
    },
  ]
  const got = pickClaimedUserMessage(claimed)
  check('跳过 runtime-context / time-context', got?.id === 'human', `实际 ${got?.id}`)
}

// ================================================================ 4
console.log('')
console.log('=== 4. 非 user 角色一律跳过 ===')
{
  const claimed = [
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '模型说的话' }] },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '真人说的话' }], source: { kind: 'user' } },
  ]
  check('跳过 assistant', pickClaimedUserMessage(claimed)?.id === 'u1')
  check(
    '全是 assistant 时返回 undefined',
    pickClaimedUserMessage([{ id: 'x', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]) === undefined,
  )
}

// ================================================================ 5
console.log('')
console.log('=== 5. 防御性输入 ===')
{
  check('空数组 → undefined', pickClaimedUserMessage([]) === undefined)
  check('undefined → undefined', pickClaimedUserMessage(undefined) === undefined)
  check('null → undefined', pickClaimedUserMessage(null) === undefined)
  check(
    '全是空文本 → undefined',
    pickClaimedUserMessage([{ role: 'user', content: [], source: { kind: 'user' } }]) === undefined,
  )
}

// ================================================================ 6
console.log('')
console.log('=== 6. source 缺失时按真人处理（DSH 有些消息不带 source）===')
{
  const claimed = [{ id: 'n', role: 'user', content: [{ type: 'text', text: '没有 source 的消息' }] }]
  const got = pickClaimedUserMessage(claimed)
  check('无 source 也认作真人输入', got?.id === 'n', `实际 ${got?.id}`)
}

// ================================================================ 7
console.log('')
console.log('=== 7. readSessionState：只认 source.kind=user ===')
{
  const events = [
    userEvent('u1', '第一句'),
    recallEvent('这是本插件注入的块，不算查询'),
    {
      type: 'user/message',
      data: {
        id: 'snap',
        content: [{ type: 'text', text: 'working-directory: /x' }],
        source: { kind: 'runtime-context' },
      },
    },
    userEvent('u2', '第二句'),
  ]
  const state = readSessionState(fakeSession(events))
  console.log('  →', JSON.stringify(state))
  check('lastUserText 取最后一条真人消息', state.lastUserText === '第二句', `实际 ${state.lastUserText}`)
  check('lastUserId 正确', state.lastUserId === 'u2', `实际 ${state.lastUserId}`)
  check('注入块 / 运行时快照没被计入 userCount', state.userCount === 2, `实际 ${state.userCount}`)
}

// ================================================================ 8
console.log('')
console.log('=== 8. readSessionState：session 不可用时退化，不抛错 ===')
{
  check('undefined → 空 state', readSessionState(undefined).lastUserText === '')
  check('null → 空 state', readSessionState(null).lastUserText === '')
  check('没有 snapshotEvents → 空 state', readSessionState({}).lastUserText === '')
  check(
    'snapshotEvents 抛错 → 空 state',
    readSessionState({
      snapshotEvents() {
        throw new Error('boom')
      },
    }).lastUserText === '',
  )
}

// ================================================================ 9
console.log('')
console.log('=== 9. readSessionState：todo 勾选计数 ===')
{
  const events = [userEvent('u1', '开始干活'), todoEvent(2, '第三步：写测试')]
  const state = readSessionState(fakeSession(events))
  console.log(`  completedCount=${state.completedCount} todoText="${state.todoText}"`)
  check('completedCount = 2', state.completedCount === 2, `实际 ${state.completedCount}`)
  check('todoText 取 in_progress 那条', state.todoText === '第三步：写测试', `实际 ${state.todoText}`)
}

// ================================================================ 10
console.log('')
console.log('=== 10. ★ 核心回归：一次用户输入只注入一块 ===')
console.log('    模拟真实事件顺序 step/start 早于 user/message 落库')
{
  const fridge = new RecallFridge()

  // ---- 步骤 1：会话里已有上一条消息 old，新消息 NEW 已认领但没落库
  //      snapshot 此刻只看得见 old
  let events = [userEvent('old', '上一条消息'), recallEvent('上一次的注入块')]
  const claimed = [
    { id: 'NEW', role: 'user', content: [{ type: 'text', text: '这一次的消息' }], source: { kind: 'user' } },
  ]
  const liveUser = pickClaimedUserMessage(claimed)
  const s1 = stepOnce({ session: fakeSession(events), fridge, liveUser, hits: 5 })
  console.log(`  step1 → injected=${s1.injected} reason=${s1.reason} query="${s1.trigger.query}"`)
  check('step1 注入了一块', s1.injected === true, s1.reason)
  check('step1 的查询是**本次**消息，不是上一条', s1.trigger.query === '这一次的消息', `实际 "${s1.trigger.query}"`)

  // ---- 步骤 2：新消息已落库，本步没有 liveUser（工具调用后的后续 step）
  events = [
    userEvent('old', '上一条消息'),
    userEvent('NEW', '这一次的消息'),
    recallEvent(s1.text),
  ]
  const s2 = stepOnce({ session: fakeSession(events), fridge, liveUser: undefined, hits: 5 })
  console.log(`  step2 → injected=${s2.injected} reason=${s2.reason} query="${s2.trigger.query}"`)
  check('step2 **不再**注入第二块', s2.injected === false, `实际注入了一块，reason=${s2.reason}`)

  // ---- 步骤 3：同回合又一次工具调用（step 3），仍然不许注入
  const s3 = stepOnce({ session: fakeSession(events), fridge, liveUser: undefined, hits: 5 })
  check('step3 也不注入', s3.injected === false, `实际注入了一块，reason=${s3.reason}`)
}

// ================================================================ 11
console.log('')
console.log('=== 11. 反向验证：不传 liveUser 时旧 bug 会复现（说明 liveUser 是必需项）===')
{
  const fridge = new RecallFridge()

  // step1：不传 liveUser —— 退化成旧行为，拿上一条当查询
  const events1 = [userEvent('old', '上一条消息')]
  const s1 = stepOnce({ session: fakeSession(events1), fridge, liveUser: undefined, hits: 5 })
  console.log(`  step1 → query="${s1.trigger.query}"`)
  check('不传 liveUser 时查的是上一条（复现旧 bug 的前提）', s1.trigger.query === '上一条消息', `实际 "${s1.trigger.query}"`)

  // step2：新消息落库 → userKey 变化 → 又注入一块 = 一次输入两块
  const events2 = [userEvent('old', '上一条消息'), userEvent('NEW', '这一次的消息'), recallEvent(s1.text)]
  const s2 = stepOnce({ session: fakeSession(events2), fridge, liveUser: undefined, hits: 5 })
  console.log(`  step2 → injected=${s2.injected} query="${s2.trigger.query}"`)
  check('旧行为确实注入了第二块（这就是要修的 bug）', s2.injected === true, s2.reason)
  check('第二块的查询才是真正的消息', s2.trigger.query === '这一次的消息', `实际 "${s2.trigger.query}"`)
}

// ================================================================ 12
console.log('')
console.log('=== 12. 用户换了新消息仍然必须刷新（别修过头）===')
{
  const fridge = new RecallFridge()

  // 第一轮
  const claimed1 = [{ id: 'A', role: 'user', content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } }]
  const s1 = stepOnce({
    session: fakeSession([]),
    fridge,
    liveUser: pickClaimedUserMessage(claimed1),
    hits: 5,
  })
  check('第一轮注入', s1.injected === true, s1.reason)

  // 用户又发了一条 B
  const events = [userEvent('A', '问题一'), recallEvent('块一')]
  const claimed2 = [{ id: 'B', role: 'user', content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } }]
  const s2 = stepOnce({
    session: fakeSession(events),
    fridge,
    liveUser: pickClaimedUserMessage(claimed2),
    hits: 5,
  })
  console.log(`  s2 → injected=${s2.injected} reason=${s2.reason} query="${s2.trigger.query}"`)
  check('新消息必须再注入一块', s2.injected === true, s2.reason)
  check('用的是新消息当查询', s2.trigger.query === '问题二', `实际 "${s2.trigger.query}"`)
}

// ================================================================ 13
console.log('')
console.log('=== 13. 零命中不冻结：下个触发点还能重试 ===')
{
  const fridge = new RecallFridge()
  const claimed = [{ id: 'A', role: 'user', content: [{ type: 'text', text: '冷门问题' }], source: { kind: 'user' } }]
  const s1 = stepOnce({ session: fakeSession([]), fridge, liveUser: pickClaimedUserMessage(claimed), hits: 0 })
  check('零命中不注入', s1.injected === false)
  check('零命中也不冻结', fridge.frozen === false)
  // markTrigger 没被调用，所以 lastUserKey 仍为空 → 下一次同一条消息还能再试
  check('lastUserKey 未消耗', fridge.lastUserKey === null, `实际 ${fridge.lastUserKey}`)
}

// ================================================================ 14
console.log('')
console.log('=== 14. todo 勾选推进阶段仍能触发（别被 user-message 饿死）===')
{
  const fridge = new RecallFridge()
  // 先跑一轮用户消息
  const claimed = [{ id: 'A', role: 'user', content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } }]
  stepOnce({ session: fakeSession([]), fridge, liveUser: pickClaimedUserMessage(claimed), hits: 5 })

  // 模型勾了一个 todo，用户没说话
  const events = [
    userEvent('A', '开始'),
    recallEvent('块一'),
    todoEvent(1, '第二步：做事'),
  ]
  const s = stepOnce({ session: fakeSession(events), fridge, liveUser: undefined, hits: 5 })
  console.log(`  → injected=${s.injected} reason=${s.reason} query="${s.trigger.query}"`)
  check('todo 勾选触发 phase-change', s.trigger.reason === 'phase-change', `实际 ${s.trigger.reason}`)
  check('用 in_progress 的 todo 当查询', s.trigger.query === '第二步：做事', `实际 "${s.trigger.query}"`)
  check('确实注入了一块', s.injected === true)
}

// ================================================================ 15
console.log('')
console.log('=== 15. 同一 todo 状态不再重复触发 ===')
{
  const events = [userEvent('A', '开始'), todoEvent(1, '第二步：做事')]
  const fridge = new RecallFridge()
  // 第一次 phase-change
  const s1 = stepOnce({ session: fakeSession(events), fridge, liveUser: undefined, hits: 5 })
  check('首次 phase-change 注入', s1.injected === true, s1.reason)
  // 第二步：todo 状态没变
  const s2 = stepOnce({ session: fakeSession(events), fridge, liveUser: undefined, hits: 5 })
  check('todo 状态不变 → 不再注入', s2.injected === false, `实际 ${s2.reason}`)
}

// ================================================================ 16
console.log('')
console.log('=== 16. liveUser 与 snapshot 已一致时不重复算作新消息 ===')
{
  // 边界：某些 DSH 版本 step/start 之后才认领，导致 liveUser 已经被
  // snapshot 收录。此时 alreadySnapshotted 分支必须让 userKey 保持稳定。
  const fridge = new RecallFridge()
  const state = readSessionState(fakeSession([userEvent('NEW', '同一条消息')]))
  check('前置：snapshot 已收录 NEW', state.lastUserId === 'NEW')
  const t = pickTrigger(fakeSession([userEvent('NEW', '同一条消息')]), fridge, { id: 'NEW', text: '同一条消息' })
  check('userKey 稳定为 user:NEW', t.userKey === 'user:NEW', `实际 ${t.userKey}`)
}

// ================================================================ 17
console.log('')
console.log('=== 17. liveUser 无 id 时用文本兜底判断 ===')
{
  const fridge = new RecallFridge()
  // snapshot 里已有同文本消息（但读写 id 不一致的情况），不应误判为新消息
  const session = fakeSession([userEvent('snap-id', '一模一样的话')])
  const marked = pickTrigger(session, fridge, { id: null, text: '一模一样的话' })
  console.log(`  → userKey=${marked.userKey} reason=${marked.reason}`)
  check('文本相同时不当作新消息', marked.userKey === 'user:snap-id', `实际 ${marked.userKey}`)
}

// ================================================================ 18
console.log('')
console.log('=== 18. ★ todo 的两条读取路径都必须能读出 todos ===')
console.log('    真实会话里 tool/call 的 arguments 是 **JSON 字符串**，不是对象')
{
  const todos = [
    { content: '已完成甲', status: 'completed' },
    { content: '已完成乙', status: 'completed' },
    { content: '正在做丙', status: 'in_progress' },
  ]

  // ---- 路径 1：原生 todo/write —— data.todos 直接就是数组（首选）
  const nativeState = readSessionState(fakeSession([
    userEvent('u1', '干活'),
    { type: 'todo/write', data: { todos } },
  ]))
  console.log(`  原生 todo/write  → completedCount=${nativeState.completedCount} todoText="${nativeState.todoText}"`)
  check('todo/write 能读出 completedCount', nativeState.completedCount === 2, `实际 ${nativeState.completedCount}`)
  check('todo/write 能读出 in_progress 文本', nativeState.todoText === '正在做丙', `实际 "${nativeState.todoText}"`)

  // ---- 路径 2：tool/call + arguments 为 JSON **字符串**（真实结构）
  const stringArgsState = readSessionState(fakeSession([
    userEvent('u1', '干活'),
    { type: 'tool/call', data: { name: 'todo_write', arguments: JSON.stringify({ todos }) } },
  ]))
  console.log(`  tool/call(string) → completedCount=${stringArgsState.completedCount} todoText="${stringArgsState.todoText}"`)
  check('JSON 字符串 arguments 也能读出 completedCount', stringArgsState.completedCount === 2, `实际 ${stringArgsState.completedCount}`)
  check('JSON 字符串 arguments 也能读出 in_progress 文本', stringArgsState.todoText === '正在做丙', `实际 "${stringArgsState.todoText}"`)

  // ---- 回归断言：拿字符串直接 .todos 取属性必须是 undefined
  // 这条钉住「为什么原代码静默失效」，防止有人改回裸取属性。
  const raw = JSON.stringify({ todos })
  check('裸取字符串的 .todos 是 undefined（原 bug 的机理）', raw.todos === undefined, `实际 ${typeof raw.todos}`)

  // ---- 两条路径都要能真正推动 phase-change（不只是计数对）
  for (const [label, event] of [
    ['原生 todo/write', { type: 'todo/write', data: { todos } }],
    ['tool/call JSON 字符串', { type: 'tool/call', data: { name: 'todo_write', arguments: JSON.stringify({ todos }) } }],
  ]) {
    const fridge = new RecallFridge()
    // 先消费掉用户消息触发
    stepOnce({ session: fakeSession([userEvent('A', '开始')]), fridge, liveUser: undefined, hits: 5 })
    const s = stepOnce({ session: fakeSession([userEvent('A', '开始'), event]), fridge, liveUser: undefined, hits: 5 })
    console.log(`  ${label} → reason=${s.trigger.reason} query="${s.trigger.query}"`)
    check(`${label} 能触发 phase-change`, s.trigger.reason === 'phase-change', `实际 ${s.trigger.reason}`)
    check(`${label} 的查询是 in_progress 文本`, s.trigger.query === '正在做丙', `实际 "${s.trigger.query}"`)
  }
}

// ================================================================ 19
console.log('')
console.log('=== 19. todo 读取的容错：坏 JSON / 缺字段不能抛错 ===')
{
  const cases = [
    ['arguments 是坏 JSON', { type: 'tool/call', data: { name: 'todo_write', arguments: '{不是json' } }],
    ['arguments 是数组', { type: 'tool/call', data: { name: 'todo_write', arguments: '[1,2]' } }],
    ['todos 不是数组', { type: 'tool/call', data: { name: 'todo_write', arguments: '{"todos":"x"}' } }],
    ['todo/write 没有 data', { type: 'todo/write' }],
    ['todo 项没有 content 字段', { type: 'tool/call', data: { name: 'todo_write', arguments: '{"todos":[{"status":"in_progress"}]}' } }],
  ]
  for (const [label, event] of cases) {
    let crashed = false
    let state
    try {
      state = readSessionState(fakeSession([userEvent('u1', '干活'), event]))
    } catch {
      crashed = true
    }
    check(`${label} → 不抛错且降级为空`, crashed === false && state.completedCount === 0 && state.todoText === '',
      crashed ? '抛错了' : `completedCount=${state.completedCount} todoText="${state.todoText}"`)
  }
}

// ================================================================ 结果
console.log('')
console.log(`通过了 ${pass} 项断言`)
if (fail > 0) {
  console.log(`❌ ${fail} 项失败：`)
  for (const f of failures) console.log('   - ' + f)
  process.exitCode = 1
} else {
  console.log('✅ 通过')
}
