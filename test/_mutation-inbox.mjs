/**
 * 变异测试：把「走 inbox」那个 bug 重新注入回去，确认测试能抓住。
 *
 * 做法：把 message-channel.js 里「直接拼进本步」那句 return 换成
 * 「prepend 到 inbox 然后原样返回 decision」，跑 smoke-message-channel。
 * 必须失败；然后还原，必须通过。
 *
 * 这是「测试有效性」的自检 —— 如果改坏了代码测试还是绿的，那测试就是假的。
 *
 * 注意两种「失败」要区分：
 *   - 断言失败（有 ❌ 行）              → 有效捕获
 *   - inbox 哨兵抛错（stderr 有特征串） → 有效捕获（这正是设计意图）
 *   - 语法错误 / import 失败            → 无效（说明变异本身写坏了）
 *
 *   node test/_mutation-inbox.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const TARGET = 'lib/message-channel.js'
const TEST = 'test/smoke-message-channel.mjs'

const original = readFileSync(TARGET, 'utf8')

// 「直接拼进本步」那句 return（含注释），整段替换成走 inbox 的老实现
const NEEDLE =
  /[ \t]*\/\/ 直接拼进本步，\*\*不碰 inbox\*\*。[\s\S]*?return \{ \.\.\.decision, messages: insertAfterClaimed\(decision\.messages, claimed, additions\) \}/

if (!NEEDLE.test(original)) {
  console.error('✗ 找不到要变异的代码块 —— 源码结构变了，请更新本脚本')
  process.exit(1)
}

const mutated = original.replace(
  NEEDLE,
  `      // [MUTATION] 老实现：走 inbox 排队（会导致每条注入多一轮 AI 回复）
      for (const message of additions) agent.inbox.prepend('next-step', message)
      return decision`,
)

function runTest() {
  try {
    const out = execFileSync(process.execPath, [TEST], { stdio: 'pipe', encoding: 'utf8' })
    return { failed: false, out }
  } catch (error) {
    return {
      failed: true,
      out: `${error.stdout ?? ''}`,
      err: `${error.stderr ?? ''}`,
    }
  }
}

let bad = 0

try {
  writeFileSync(TARGET, mutated)
  const result = runTest()

  if (result.failed !== true) {
    console.log('❌ 变异后测试仍然通过 —— 测试抓不住这个 bug')
    bad += 1
  } else {
    const hasAssertionFailure = result.out.includes('❌')
    const hasSentinelThrow = String(result.err).includes('inbox.prepend 不该被调用')
    const hasSyntaxError =
      String(result.err).includes('SyntaxError') ||
      String(result.err).includes('Cannot find module') ||
      String(result.err).includes('does not provide an export')

    if (hasAssertionFailure) {
      console.log('✅ 变异后被断言抓住（❌ 行）')
      result.out
        .split(/\r?\n/)
        .filter((line) => line.includes('❌'))
        .slice(0, 5)
        .forEach((line) => console.log('   ' + line.trim()))
    } else if (hasSentinelThrow) {
      console.log('✅ 变异后被 inbox 哨兵抓住（inbox.prepend 直接抛错）')
      console.log('   这正是设计意图：这条通道的契约就是不碰 inbox')
    } else if (hasSyntaxError) {
      console.log('❌ 变异后是语法/加载错误，不算真抓住 —— 变异写法需要修')
      console.log('   ' + String(result.err).split(/\r?\n/)[0])
      bad += 1
    } else {
      console.log('⚠️ 变异后失败，但原因不明：')
      console.log('   ' + `${result.out}${result.err}`.split(/\r?\n/).slice(0, 4).join('\n   '))
      bad += 1
    }
  }
} finally {
  writeFileSync(TARGET, original)
}

const restored = runTest()
if (restored.failed === false) {
  const passed = /(\d+) 通过 \/ (\d+) 失败/.exec(restored.out)
  console.log(`✅ 还原后测试通过（${passed ? `${passed[1]} 通过 / ${passed[2]} 失败` : '见输出'}）`)
} else {
  console.log('❌ 还原后测试仍然失败 —— 文件可能没恢复干净')
  bad += 1
}

console.log(bad === 0 ? '\n✅ 变异测试通过：测试确实能抓住 inbox 回归\n' : '\n❌ 变异测试失败\n')
if (bad > 0) process.exitCode = 1
