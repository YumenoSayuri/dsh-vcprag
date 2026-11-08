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
 * 头部是 `key: value` 连续行，遇到第一个空行或第一个非 `key:` 行即结束。
 * 这条规则让「正文里恰好有 `注意: ...`」不会被误当头部 —— 因为头部
 * 段落一旦被空行打断就终止，日记正文按规范必然以空行分隔头部。
 *
 * @param {string} raw
 * @returns {ParsedBlock}
 */
export function parseBlock(raw) {
  const problems = []
  const fields = {}
  const lines = String(raw).split(/\r?\n/)

  let cursor = 0
  let sawBlank = false

  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() === '') {
      sawBlank = true
      cursor += 1
      break
    }
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*(.*)$/)
    if (match === null) break
    fields[match[1].toLowerCase()] = match[2].trim()
  }

  const body = lines.slice(cursor).join('\n').replace(/^\s*\n/, '')

  // command 推断：显式声明优先；缺省时按字段特征猜，避免模型漏写整块作废
  let command = String(fields.command ?? '').toLowerCase().trim()
  if (command !== 'create' && command !== 'update') {
    if (fields.target !== undefined || fields.replace !== undefined) command = 'update'
    else if (fields.content !== undefined || body.trim() !== '') command = 'create'
    else command = ''
    if (command !== '') {
      problems.push(`块内没有合法的 command，已按字段推断为 ${command}。`)
    }
  }
  if (command === '') problems.push('无法判断这是 create 还是 update（既无 command，也无正文/target）。')

  // 头部与正文之间必须有空行。没有空行、却又有「像正文的东西」，
  // 说明模型漏打了分隔 —— 此时首段正文会被当成键值行吃掉。
  //
  // 注意不能对所有「没空行」的块都报警：update 块本来就是纯头部、
  // 没有正文，那样会被误判成残块，日志里全是假警报。
  if (!sawBlank && body.trim() !== '') {
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
