// 把 cordis.personal.yml 的配置块替换进 profile 的 cordis.patch.yml。
//
// 只替换 `- id: vcprag` 到下一个顶层 `- ` 之间的内容，
// 其余条目原样保留。写盘前已由调用方做好备份。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const PROFILE = 'C:/Users/Lenovo/.dsh/profiles/desktop/cordis.patch.yml'
const SNIPPET = new URL('../cordis.personal.yml', import.meta.url).pathname.replace(/^\//, '')

if (!existsSync(PROFILE)) {
  console.error('找不到 profile 配置：' + PROFILE)
  process.exit(1)
}

const raw = readFileSync(PROFILE, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const snippetRaw = readFileSync(decodeURIComponent(SNIPPET), 'utf8')
const snippetLines = snippetRaw.split(/\r?\n/)

// 跳过多行注释头，从第一个 `- id:` 开始
let snippetStart = snippetLines.findIndex((line) => /^- id: vcprag\s*$/.test(line))
if (snippetStart < 0) {
  console.error('片段里找不到 `- id: vcprag` 行')
  process.exit(1)
}
// 去掉片段末尾的空行
let snippetEnd = snippetLines.length
while (snippetEnd > snippetStart && snippetLines[snippetEnd - 1].trim() === '') snippetEnd -= 1
const block = snippetLines.slice(snippetStart, snippetEnd)

let start = lines.findIndex((line) => /^- id: vcprag\s*$/.test(line))
if (start < 0) {
  console.log('profile 里没有 vcprag 条目，将追加到文件末尾')
  const out = [...lines, '', ...block]
  writeFileSync(PROFILE, out.join(eol), 'utf8')
  console.log('已追加')
  process.exit(0)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^- /.test(lines[i])) { end = i; break }
}

// 保留起始行上方的注释（`# ===== dsh-vcprag ... =====`）
let commentStart = start
while (commentStart > 0 && lines[commentStart - 1].trim().startsWith('#')) commentStart -= 1

const before = lines.slice(0, commentStart)
const after = lines.slice(end)
const out = [...before, ...block, ...after]

writeFileSync(PROFILE, out.join(eol), 'utf8')
console.log(`已替换：第 ${start + 1}~${end} 行（含上方注释从第 ${commentStart + 1} 行起）`)
console.log(`新块 ${block.length} 行`)
