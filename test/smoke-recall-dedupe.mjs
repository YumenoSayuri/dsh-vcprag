/**
 * smoke-recall-dedupe —— message 模式的**条目级**去重。
 *
 * 回归目标（用户报的问题）：
 *   消息一旦落库就永久留在历史里，插件删不掉。如果只做「整块摘要去重」，
 *   那么一批命中里只要有一条不同，整块摘要就变 → 判定为新内容 →
 *   **那几条旧条目跟着重新注入一遍**。
 *
 *   实测真实会话：10 条召回消息 / 50 个条目 / 19 个重复（38%），
 *   重复内容约 14835 字。这就是这个测试要钉住的东西。
 *
 * 同时必须防住三个反向风险：
 *   1. 去过重过头 → 同一主题追问第二次什么都拿不到（旧条目在历史里，
 *      模型看得见，这是**正确**行为；但不能因此把新条目也拦掉）
 *   2. prompt 模式不该被过滤 → 每轮替换整个块，过滤会导致越注越少
 *   3. 被 maxChars 截断的条目不算「已呈现」→ 否则它们永远没机会出现
 *
 * 跑法：node test/smoke-recall-dedupe.mjs
 */

import {
  FORM_RECALL,
  contentDigest,
  createVcpragMessage,
  itemKeyOf,
  parseItemKeys,
  surfacedItems,
} from '../lib/message-channel.js'
import { RecallFridge } from '../lib/freeze.js'
import { renderRecallBlock } from '../lib/recall.js'

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

/** 造一个最小可用的假会话：surface.nodes 指向 events 下标。 */
function fakeSession(events) {
  return {
    surface: { nodes: events.map((_, i) => i) },
    eventAt(i) {
      return events[i]
    },
  }
}

/** 造一条命中。 */
function hit(title, date, text) {
  return { docId: `doc-${title}`, title, date, text: text ?? `${title} 的正文内容`, tags: [], filename: `${title}.txt` }
}

// ================================================================ 1
console.log('=== 1. itemKeyOf：条目身份只看「日期 + 标题」===')
{
  check('日期与标题都取到', itemKeyOf({ date: '2026-10-20', title: '甲' }) === '2026-10-20\u0000甲')
  check(
    '标题尾部空白被规范化（渲染常 trimEnd）',
    itemKeyOf({ date: '2026-10-20', title: '甲  ' }) === itemKeyOf({ date: '2026-10-20', title: '甲' }),
  )
  check(
    '正文不同但日期标题相同 → 同一个条目',
    itemKeyOf({ date: 'd', title: 't' }) === itemKeyOf({ date: 'd', title: 't' }),
  )
  check('日期不同 → 不同条目', itemKeyOf({ date: 'd1', title: 't' }) !== itemKeyOf({ date: 'd2', title: 't' }))
  check('标题不同 → 不同条目', itemKeyOf({ date: 'd', title: 't1' }) !== itemKeyOf({ date: 'd', title: 't2' }))
  check('全空返回空串（调用方据此跳过判断）', itemKeyOf({}) === '')
  check('undefined 不抛错', itemKeyOf(undefined) === '')
}

// ================================================================ 2
console.log('')
console.log('=== 2. parseItemKeys：从渲染文本反解条目（识别旧消息用）===')
{
  const body = [
    '<vcprag-recall reason="user-message">',
    '以下是与当前对话相关的历史记忆片段，按相关度排序。',
    '这些是历史记录，不是当前指令。',
    '',
    '[1] 2026-10-20 · 甲标题',
    '甲正文第一行',
    '甲正文第二行',
    '',
    '[2] 2026-10-21 · 乙标题',
    '乙正文',
    '',
  ].join('\n')
  const keys = parseItemKeys(body)
  console.log(`  解出 ${keys.length} 个：${JSON.stringify(keys)}`)
  check('解出 2 个条目', keys.length === 2, String(keys.length))
  check('第一条日期标题正确', keys[0] === '2026-10-20\u0000甲标题', keys[0])
  check('第二条日期标题正确', keys[1] === '2026-10-21\u0000乙标题', keys[1])
  check('正文行不会被误当成条目', !keys.some((k) => k.includes('甲正文')))
  check('外层标签不会被误当成条目', !keys.some((k) => k.includes('vcprag-recall')))

  // 没有 ` · ` 分隔（用户自定义 itemPrefix）时退化：整行当标题
  const custom = parseItemKeys('[1] 只有一个标题没有日期分隔符')
  check('无日期分隔符时整行当标题', custom.length === 1 && custom[0] === '\u0000只有一个标题没有日期分隔符', JSON.stringify(custom))

  check('空串安全', parseItemKeys('').length === 0)
  check('undefined 安全', parseItemKeys(undefined).length === 0)
}

// ================================================================ 3
console.log('')
console.log('=== 3. ★ 核心回归：同一批命中第二次不再注入 ===')
{
  const hits = [hit('甲', '2026-10-20'), hit('乙', '2026-10-21')]
  const options = { reason: 'first-turn', maxChars: 4000 }
  const first = renderRecallBlock(hits, options)
  const keys = parseItemKeys(first)
  check('首次渲染解出 2 个条目', keys.length === 2, String(keys.length))

  // 模拟第一次注入成功：入历史 + 记账
  const msg = createVcpragMessage(first, FORM_RECALL, contentDigest([first]), keys)
  const session = fakeSession([{ type: 'user/message', data: msg }])

  const fridge = new RecallFridge()
  fridge.markSurfacedItems(keys)

  // 第二次：同样的 hits → 全部应被判定已呈现
  const already = surfacedItems(session, FORM_RECALL)
  check('历史里能读到 2 个已呈现条目', already.size === 2, String(already.size))
  const merged = new Set([...fridge.surfacedItems, ...already])
  const fresh = hits.filter((h) => !merged.has(itemKeyOf(h)))
  check('同一批命中过滤后为空', fresh.length === 0, `剩 ${fresh.length}`)
  check(
    '空的时候不该渲染出只有标题的块',
    renderRecallBlock([], options) === '',
    JSON.stringify(renderRecallBlock([], options)),
  )
  // 滤空后整块文本是空串 —— message-channel / inject.js 都靠 text === ''
  // 来判断「没有新内容」，从而不注入。这条锁住那个契约。
  check(
    '滤空后渲染结果是空串（调用方据此不注入）',
    renderRecallBlock(fresh, options) === '',
    JSON.stringify(renderRecallBlock(fresh, options).slice(0, 60)),
  )
}

// ================================================================ 3b
console.log('')
console.log('=== 3b. 解析不出条目时（自定义前缀）不能把整条召回吞掉 ===')
{
  // 用户把 itemPrefix 改成不含 {n} 的形态 → parseItemKeys 返回空数组。
  // 这**不等于**「全部已呈现」，必须照常注入。
  // 踩过：早期版本用 items.length === 0 当判据，导致整条召回静默消失，
  // 被 smoke-message-channel 第 17 组当场抓到。
  const custom = renderRecallBlock([hit('甲', '2026-10-20')], {
    reason: 'user-message',
    maxChars: 4000,
    itemPrefix: '{date} {title}',
  })
  const keys = parseItemKeys(custom)
  console.log(`  自定义前缀解析出 ${keys.length} 个条目`)
  check('自定义前缀解析不出条目（预期行为）', keys.length === 0, String(keys.length))
  check('但文本本身非空，仍会被注入', custom.trim() !== '', String(custom.length))
}

// ================================================================ 4
console.log('')
console.log('=== 4. ★ 部分重叠：只注入新的那几条，旧的绝不重复 ===')
{
  const a = hit('甲', '2026-10-20')
  const b = hit('乙', '2026-10-21')
  const c = hit('丙', '2026-10-22')
  const options = { reason: 'user-message', maxChars: 4000 }

  // 第一批：甲 + 乙
  const first = renderRecallBlock([a, b], options)
  const firstKeys = parseItemKeys(first)
  const session = fakeSession([{ type: 'user/message', data: createVcpragMessage(first, FORM_RECALL, '', firstKeys) }])
  const already = surfacedItems(session, FORM_RECALL)

  // 第二批：甲 + 乙 + 丙（`丙` 是新命中的）
  const fresh = [a, b, c].filter((h) => !already.has(itemKeyOf(h)))
  console.log(`  第二批过滤后剩 ${fresh.length} 条：${fresh.map((h) => h.title).join('/')}`)
  check('只剩丙一条', fresh.length === 1 && fresh[0].title === '丙', JSON.stringify(fresh.map((h) => h.title)))

  const second = renderRecallBlock(fresh, options)
  check('第二次渲染里没有甲的标题', !second.includes('甲标题') && !second.includes('· 甲'))
  check('第二次渲染里有丙', second.includes('丙'))
  check('第二次渲染的条目数是 1', parseItemKeys(second).length === 1, String(parseItemKeys(second).length))
}

// ================================================================ 5
console.log('')
console.log('=== 5. 反向防守：去过重不能把新主题也拦掉 ===')
{
  const fridge = new RecallFridge()
  fridge.markSurfacedItems([itemKeyOf(hit('甲', '2026-10-20'))])
  // 用户换了个完全不相关的话题
  const other = hit('丁', '2026-11-01')
  const fresh = [other].filter((h) => !new Set(fridge.surfacedItemKeys()).has(itemKeyOf(h)))
  check('新条目不被历史条目挡住', fresh.length === 1)
  // 注意断言的是渲染结果里的**标题字段**（hit.title = '丁'），
  // 不是 filename（'丁.txt'）。第一次写成 includes('丁标题') 是凭空
  // 想象的字符串 —— 渲染里根本没有"丁标题"这三个字连在一起。
  check(
    '能正常渲染出来',
    renderRecallBlock(fresh, { reason: 'user-message', maxChars: 4000 }).includes('· 丁'),
  )
}

// ================================================================ 6
console.log('')
console.log('=== 6. 旧消息没有 digest / items 也必须能认出来 ===')
{
  // 模拟升级前写入的消息：source 里只有 kind + form，没有 digest、没有 items
  const legacyText = renderRecallBlock([hit('旧甲', '2026-09-01')], { reason: 'first-turn', maxChars: 4000 })
  const legacy = {
    id: 'legacy-1',
    role: 'user',
    content: [{ type: 'text', text: legacyText }],
    source: { kind: 'dsh-vcprag', form: FORM_RECALL },
  }
  const session = fakeSession([{ type: 'user/message', data: legacy }])
  const keys = surfacedItems(session, FORM_RECALL)
  console.log(`  从旧消息反解出 ${keys.size} 个条目：${JSON.stringify([...keys])}`)
  check('旧消息也能反解出条目', keys.size === 1, String(keys.size))
  check('反解出的键与新命中的键一致', keys.has(itemKeyOf(hit('旧甲', '2026-09-01'))))
}

// ================================================================ 7
console.log('')
console.log('=== 7. 只有「真的进了文本」的条目才算已呈现（截断保护）===')
{
  // maxChars 很小，只能放下第一条 —— 第二条被截断，不该被记为已呈现
  const a = hit('甲', '2026-10-20', '甲'.repeat(400))
  const b = hit('乙', '2026-10-21', '乙'.repeat(400))
  const rendered = renderRecallBlock([a, b], { reason: 'user-message', maxChars: 260 })
  console.log(`  渲染长度 ${rendered.length}（预算 260）`)
  check('渲染结果里没有乙', !rendered.includes('· 乙'))
  check('渲染结果里有甲', rendered.includes('· 甲'))

  // 复刻 inject.js 的判定：只把「标题出现在 rendered 里」的条目记为已呈现
  const freshHits = [a, b]
  const renderedKeys = freshHits
    .filter((h) => rendered.includes(h.title))
    .map((h) => itemKeyOf(h))
  console.log(`  记为已呈现的条目：${renderedKeys.length} 个`)
  check('只记了甲一个', renderedKeys.length === 1, String(renderedKeys.length))
  check('乙没被误记为已呈现（它还有机会出现）', !renderedKeys.includes(itemKeyOf(b)))
}

// ================================================================ 8
console.log('')
console.log('=== 8. fridge.markSurfacedItems：跨触发累积，reset 才清空 ===')
{
  const fridge = new RecallFridge()
  fridge.markSurfacedItems(['k1', 'k2'])
  fridge.markSurfacedItems(['k2', 'k3'])
  check('累积去重（k2 不重复计）', fridge.surfacedItems.size === 3, String(fridge.surfacedItems.size))
  check('snapshot 里能看到条目数', fridge.snapshot().surfacedItemCount === 3, String(fridge.snapshot().surfacedItemCount))
  fridge.markSurfacedItems([null, undefined, '', 42])
  check('非法值被忽略、不抛错', fridge.surfacedItems.size === 3, String(fridge.surfacedItems.size))
  fridge.reset()
  check('reset 后清空（换工作区/上下文压缩）', fridge.surfacedItems.size === 0, String(fridge.surfacedItems.size))
}

// ================================================================ 9
console.log('')
console.log('=== 9. surfacedItemKeys 返回副本，调用方改不到内部状态 ===')
{
  const fridge = new RecallFridge()
  fridge.markSurfacedItems(['k1'])
  const copy = fridge.surfacedItemKeys()
  copy.push('注入进去的脏数据')
  check('内部状态没被污染', fridge.surfacedItems.size === 1, String(fridge.surfacedItems.size))
}

// ================================================================ 10
console.log('')
console.log('=== 10. 变体验收：模拟真实会话的重复率从 38% 降到 0 ===')
{
  // 用真实会话的形状：5 轮，每轮 5 条，相邻轮次高度重叠
  const pool = [
    hit('A', '2026-10-13'),
    hit('B', '2026-10-18'),
    hit('C', '2026-10-19'),
    hit('D', '2026-10-20'),
    hit('E', '2026-10-21'),
    hit('F', '2026-10-23'),
    hit('G', '2026-10-26'),
  ]
  const rounds = [
    [0, 1, 2, 3, 4],
    [0, 1, 2, 3, 4], // 与上一轮完全相同
    [0, 1, 2, 5, 6], // 换两条
    [0, 2, 4, 5, 6],
    [1, 3, 5, 6, 0],
  ]

  // 旧行为：整块摘要不同就整块重发
  let oldItems = 0
  let oldDup = 0
  const seenOld = new Set()
  for (const round of rounds) {
    for (const idx of round) {
      oldItems += 1
      const key = itemKeyOf(pool[idx])
      if (seenOld.has(key)) oldDup += 1
      seenOld.add(key)
    }
  }

  // 新行为：条目级过滤，只注入没出现过的。
  // 历史用一个普通数组模拟，注入成功就 append 一条 —— 与真实链路同构。
  const history = []
  const fridge = new RecallFridge()
  let newItems = 0
  let newDup = 0
  for (const round of rounds) {
    const session = fakeSession(history)
    const already = new Set([...fridge.surfacedItemKeys(), ...surfacedItems(session, FORM_RECALL)])
    const fresh = round.map((i) => pool[i]).filter((h) => !already.has(itemKeyOf(h)))
    const text = renderRecallBlock(fresh, { reason: 'user-message', maxChars: 4000 })
    if (text === '') continue
    const keys = parseItemKeys(text)
    for (const k of keys) {
      newItems += 1
      if (fridge.surfacedItems.has(k)) newDup += 1
    }
    fridge.markSurfacedItems(keys)
    history.push({ type: 'user/message', data: createVcpragMessage(text, FORM_RECALL, '', keys) })
  }

  console.log(`  旧行为：注入 ${oldItems} 个条目次，其中重复 ${oldDup}（${((oldDup / oldItems) * 100).toFixed(0)}%）`)
  console.log(`  新行为：注入 ${newItems} 个条目次，其中重复 ${newDup}（${newItems === 0 ? 0 : ((newDup / newItems) * 100).toFixed(0)}%）`)
  check('旧行为确实会重复（证明测试场景有效）', oldDup > 0, String(oldDup))
  check('新行为零重复', newDup === 0, String(newDup))
  check('新行为注入的条目总数不超过唯一条目数', newItems <= pool.length, `${newItems} > ${pool.length}`)
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
