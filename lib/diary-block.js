/**
 * 语义写入块解析器 —— 「在回复正文里写一段结构化文本，由系统落盘」。
 *
 * 这是与 tool call 并存的第二条写入通道，默认优先：
 *
 *   tool call        模型发起 function calling → 框架调用 → 参数是 JSON
 *   语义块           模型在正文里写出块 → 框架解析文本 → 参数是结构化文本
 *
 * 为什么要有第二条？因为 tool call 有三个固有摩擦：
 *   1. 每次都要走一次完整的工具往返（模型出 call → 框架执行 → 结果回灌），
 *      多一轮上下文、多一次计费；
 *   2. 正文里已经写完整件事了，还要把同样内容再塞进 JSON 参数里，
 *      等于让模型把同一份东西写两遍 —— 长日记尤其浪费；
 *   3. 一旦 JSON 转义出错（引号、换行、反引号），整篇内容全废。
 *
 * 语义块没有这些问题：它就在正文里，写完即落盘，且人眼可读可校对。
 *
 * ---- 块格式 ----
 *
 *   <<<DailyNoteStart>>>
 *   command: create
 *   title: 一句话标题
 *   folder: 分类子目录（可选）
 *   tags: a, b, c（可选，省略则取正文末行 Tag）
 *
 *   正文……（以 [HH:MM] 开头，末行 Tag: ...）
 *   <<<DailyNoteEnd>>>
 *
 * 更新已有日记（按内容定位替换，不是整篇覆盖）：
 *
 *   <<<DailyNoteStart>>>
 *   command: update
 *   folder: 分类子目录（可选，用于缩小搜索范围）
 *   target: 日记中要被替换掉的旧内容，至少 15 字
 *   replace: 用于替换的新内容
 *   <<<DailyNoteEnd>>>
 *
 * update 用「内容锚点」而不是 docId，是因为模型在正文里写作时手里没有
 * docId —— 但它知道自己正在改哪句话。这和 VCP DailyNote 的 update 语义
 * 一致，也是唯一能在「无工具往返」前提下安全定位的方式。
 *
 * @module dsh-vcprag/diary-block
 */

/** 默认块标记。可配置，避免与其他插件的标记冲突。 */
export const DEFAULT_BLOCK_NAME = 'DailyNote'

/** target 的最短长度。太短的锚点会匹配到多处，替换就变成了随机破坏。 */
export const DEFAULT_MIN_TARGET = 15

/**
 * update 块里**算字段名**的那些名字。
 *
 * 为什么要白名单而不是「像 `key:` 就算」：replace 的正文里必然出现
 * `Tag: 甲, 乙`（模板要求每篇末尾都写 Tag 行）。用通用正则，这一行
 * 会被当成新字段，replace 又在 Tag 前被截断 —— 正是要修的那个 bug。
 *
 * 只有这七个名字开新字段，其余一律续到上一个字段。
 */
const UPDATE_FIELD_NAMES = new Set([
  'command', 'target', 'replace', 'folder', 'tags', 'title', 'content',
])

/**
 * 构造块标记。
 *
 * @param {string} blockName
 * @returns {{ start: string, end: string, regex: RegExp }}
 */
export function blockMarkers(blockName) {
  const name = typeof blockName === 'string' && blockName.trim() !== ''
    ? blockName.trim()
    : DEFAULT_BLOCK_NAME
  const start = `<<<${name}Start>>>`
  const end = `<<<${name}End>>>`
  // [\s\S] 而不是 . ，因为正文一定有换行；非贪婪取最近的一个结束标记
  const regex = new RegExp(`${escapeRegex(start)}([\\s\\S]*?)${escapeRegex(end)}`, 'g')
  return { start, end, regex }
}

/**
 * 从一段 assistant 正文里抽出所有语义块。
 *
 * 返回的 `raw` 是块内原文（已去掉首尾空行，但**没有**去掉缩进 ——
 * 缩进是正文结构的一部分，剥掉会让 Markdown 列表/代码块失真）。
 *
 * @param {string} text
 * @param {string} [blockName]
 * @returns {Array<{ raw: string, index: number, parsed: ParsedBlock }>}
 */
export function extractBlocks(text, blockName) {
  if (typeof text !== 'string' || text === '') return []
  const { regex } = blockMarkers(blockName)
  const out = []
  regex.lastIndex = 0
  let match = regex.exec(text)
  while (match !== null) {
    const raw = trimBlankEdges(match[1])
    out.push({
      raw,
      index: match.index,
      parsed: parseBlock(raw),
    })
    match = regex.exec(text)
  }
  return out
}

/**
 * @typedef {object} ParsedBlock
 * @property {'create'|'update'|''} command
 * @property {Record<string, string>} fields  头部键值（title/folder/target/replace/tags…）
 * @property {string} body                    头部之后的所有内容（create 的正文）
 * @property {string[]} problems              解析中发现的问题
 */

/**
 * 解析单个块的内部文本。
 *
 * ## 多行值（v0.4.4 修）
 *
 * 老实现是「头部逐行 `key: value`，遇空行终止」，`replace:` 只能吃到
 * 第一行。于是 update 块里写：
 *
 *   replace: 第一行
 *
 *   第二段正文……
 *
 * 只有第一行被当成 replace，后面全落进 body —— 而 **update 命令不读
 * body**，等于静默丢内容。`problems` 也是空的，没有任何征兆。
 *
 * 真实事故：一段 171 字的 replace 被截成 57 字写进日记，正文与 Tag 行
 * 全丢；紧接着两次 update 因为 target 已被改掉而全部失败。
 *
 * ## 现在的规则：先判 command，再决定用哪种扫描
 *
 * 两遍扫，因为「多行值」对两种命令的意义是**相反的**：
 *
 *   create  的 body 是真正文，非 key 行必须**终止**头部，
 *           否则 `[21:14] 正文` 会被当成 title 的续行吞掉。
 *   update  没有正文这个概念，非 key 行只能属于上一个字段，
 *           必须**续接**，否则 replace 只剩第一行。
 *
 * 所以：第一遍按老规则扫（遇空行终止），只为拿到 command；若判定为
 * update，第二遍改成「不匹配 key 的行一律续到上一个字段」。create
 * 沿用第一遍的结果，行为与以前逐字节一致。
 *
 * @param {string} raw
 * @returns {ParsedBlock}
 */
export function parseBlock(raw) {
  const problems = []
  const lines = String(raw).split(/\r?\n/)

  // ---- 第一遍：老规则（头部连续 key: value，遇空行终止）----
  const head = { fields: {}, cursor: 0, sawBlank: false }
  {
    let cursor = 0
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') { head.sawBlank = true; cursor += 1; break }
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*(.*)$/)
      if (match === null) break
      head.fields[match[1].toLowerCase()] = match[2]
    }
    head.cursor = cursor
  }

  const headBody = lines.slice(head.cursor).join('\n').replace(/^\s*\n/, '')

  // ---- 先定 command（用第一遍的结果判断）----
  let command = String(head.fields.command ?? '').toLowerCase().trim()
  if (command !== 'create' && command !== 'update') {
    if (head.fields.target !== undefined || head.fields.replace !== undefined) command = 'update'
    else if (head.fields.content !== undefined || headBody.trim() !== '') command = 'create'
    else command = ''
    if (command !== '') {
      problems.push(`块内没有合法的 command，已按字段推断为 ${command}。`)
    }
  }
  if (command === '') problems.push('无法判断这是 create 还是 update（既无 command，也无正文/target）。')

  // ---- 第二遍（仅 update）：只有**已知字段名**才开新字段 ----
  //
  // 这里不能用「像 key: 就算字段」的通用正则：replace 的正文里完全可能
  // 出现 `Tag: 甲, 乙`（模板要求每篇末尾都有 Tag 行），那一行长得和字段
  // 一模一样。通用正则会把 Tag 当成新字段，replace 又在 Tag 前被截断。
  //
  // 用白名单：只有这些名字才开新字段，其余一律续到上一个字段。
  let fields = head.fields
  let body = headBody
  const sawBlank = head.sawBlank

  if (command === 'update') {
    const multi = {}
    let lastKey = ''
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*(.*)$/)
      if (match !== null && UPDATE_FIELD_NAMES.has(match[1].toLowerCase())) {
        lastKey = match[1].toLowerCase()
        multi[lastKey] = match[2]
        continue
      }
      // 空行与普通文本一样：只要已经有字段，就续上去（保留空行本身）。
      if (lastKey === '') break
      multi[lastKey] = `${multi[lastKey]}\n${line}`
    }
    fields = multi
    body = ''
  }

  // 每个字段的首尾空白收一下，但**保留中间换行** —— 那是 replace 的正文。
  for (const key of Object.keys(fields)) {
    fields[key] = fields[key].replace(/^[ \t]+|[ \t]+$/g, '')
  }

  // 头部与正文之间必须有空行。没有空行、却又有「像正文的东西」，
  // 说明模型漏打了分隔 —— 此时首段正文会被当成键值行吃掉。
  //
  // 注意不能对所有「没空行」的块都报警：update 块本来就是纯头部、
  // 没有正文，那样会被误判成残块，日志里全是假警报。
  if (command !== 'update' && !sawBlank && body.trim() !== '') {
    problems.push('头部与正文之间缺少空行分隔，首段正文可能被误解析为头部字段。')
  }

  // 兼容 `Content:` 字段写法（VCP DailyNote 的风格）
  if (body.trim() === '' && typeof fields.content === 'string' && fields.content.trim() !== '') {
    return { command, fields, body: fields.content.trim(), problems }
  }

  return { command, fields, body, problems }
}

/**
 * 把 tags 字段拆成数组。支持 `a, b` / `a、b` / `a;b`。
 *
 * @param {string} value
 * @returns {string[]}
 */
export function splitTags(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return value
    .split(/[,，、;；|]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '')
}

/**
 * 校验一个已解析的块，返回「能不能执行」与原因。
 *
 * 校验只做**结构性**判断（缺正文、target 太短这类硬错误）。
 * 文风问题（没写 Tag、没写时间）不在这里拦，交给上层的 warning ——
 * 硬拦会让模型反复重试，浪费轮次，而内容本身通常是可用的。
 *
 * @param {ParsedBlock} parsed
 * @param {object} [options]
 * @param {number} [options.minTarget]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBlock(parsed, options = {}) {
  const minTarget = Number.isFinite(options.minTarget) ? options.minTarget : DEFAULT_MIN_TARGET
  const errors = []

  if (parsed.command === 'create') {
    if (parsed.body.trim() === '') errors.push('create 块缺少正文。')
  } else if (parsed.command === 'update') {
    if (typeof parsed.fields.target !== 'string' || parsed.fields.target === '') {
      errors.push('update 块缺少 target（要定位的旧内容）。')
    } else if (parsed.fields.target.length < minTarget) {
      errors.push(`update 块的 target 太短（${parsed.fields.target.length} < ${minTarget} 字），会误伤其他段落。`)
    }
    if (typeof parsed.fields.replace !== 'string') {
      errors.push('update 块缺少 replace（替换后的新内容）。传空串表示删除该段。')
    }
  } else {
    errors.push('块内没有可执行的 command。')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 从正文里剔除所有语义块，得到「给用户看的干净正文」。
 *
 * 用途：块是给系统看的，不该出现在气泡里。剔除后若剩下空行堆积，
 * 收敛成最多一个空行 —— 否则界面上会出现大片空白。
 *
 * @param {string} text
 * @param {string} [blockName]
 * @returns {string}
 */
export function stripBlocks(text, blockName) {
  if (typeof text !== 'string' || text === '') return text
  const { regex } = blockMarkers(blockName)
  const cleaned = text.replace(regex, '')
  // 连续 3 个以上换行收敛为 2 个
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

/** 生成给模型看的格式说明（工具/模板共用，避免两处文案漂移）。 */
export function blockFormatDoc(blockName) {
  const name = typeof blockName === 'string' && blockName.trim() !== ''
    ? blockName.trim()
    : DEFAULT_BLOCK_NAME
  return `<<<${name}Start>>>
command: create
title: 一句话标题
folder: 分类子目录（可选）
tags: 标签1, 标签2（可选）

[HH:MM] 正文第一段……

正文继续……
Tag: 标签1, 标签2
<<<${name}End>>>`
}

/** 去掉首尾的空行，但保留行内缩进。 */
function trimBlankEdges(text) {
  return String(text).replace(/^\s*\n/, '').replace(/\n\s*$/, '')
}

/** 正则转义。块名来自配置，必须转义后再拼进正则。 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
