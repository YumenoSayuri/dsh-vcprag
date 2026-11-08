// 变异测试：临时砍掉 waterfall 注册，验证 smoke-recall-inject 会失败。
// 目的：证明这个测试**真的能**抓到「通道从未被驱动」这个 bug，
// 而不是恰好通过。用完自动还原。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const P = 'lib/inject.js'
const BAK = 'lib/inject.mutation-backup.js'

if (!existsSync(P)) {
  console.error('找不到 lib/inject.js')
  process.exit(2)
}

copyFileSync(P, BAK)
const original = readFileSync(P, 'utf8')

// 砍掉整个 `try { ctx.on('system-prompt/assemble', ...) } catch { ... }` 块，
// 也就是把通道 3 退回「只有占位 text()、没人来填」的状态。
// 用正则匹配：源文件是 CRLF，硬编码 \n 会匹配不到。
const startMatch = /[ \t]*try\s*\{\s*\r?\n[ \t]*ctx\.on\(\s*\r?\n[ \t]*'system-prompt\/assemble',/.exec(original)
const startAt = startMatch === null ? -1 : startMatch.index
if (startAt < 0) {
  console.error('没找到 waterfall 注册块，无法变异')
  copyFileSync(BAK, P)
  unlinkSync(BAK)
  process.exit(2)
}

// 从 startAt 开始配对花括号找到块结尾
let depth = 0
let i = original.indexOf('{', startAt)
const bodyStart = i
for (; i < original.length; i += 1) {
  const ch = original[i]
  if (ch === '{') depth += 1
  else if (ch === '}') {
    depth -= 1
    if (depth === 0) break
  }
}
const bodyEnd = i + 1

const mutated = `${original.slice(0, startAt)}  // [MUTATION] waterfall 注册已被移除\n${original.slice(bodyEnd)}`
writeFileSync(P, mutated)
console.log(`已移除 ${bodyEnd - startAt} 字符的 waterfall 注册`)

let exitCode = 0
try {
  const out = execFileSync(process.execPath, ['test/smoke-recall-inject.mjs'], { encoding: 'utf8' })
  console.log(out)
} catch (error) {
  exitCode = error.status ?? 1
  console.log(error.stdout ?? '')
  console.error(error.stderr ?? '')
} finally {
  copyFileSync(BAK, P)
  unlinkSync(BAK)
  console.log('已还原 lib/inject.js')
}

const caught = exitCode !== 0
console.log(caught
  ? '\n✅ 变异测试通过：移除 waterfall 后测试确实失败（说明测试能抓到该 bug）'
  : '\n❌ 变异测试失败：移除 waterfall 后测试仍然通过（说明测试是假的）')
process.exit(caught ? 0 : 1)
