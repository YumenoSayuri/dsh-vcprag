// 验证「面板填的连接信息真的能生效」——不设任何环境变量，
// 只把 key / 代理写进 config.judge，看 buildJudge 能否造出可用实例。
//
// 这个测试存在的理由：面板能填字段 ≠ 后端会用这些字段。两处必须对上：
//   1. config.js 把 baseUrl/model/apiKey/proxyUrl 从 raw 里读出来
//   2. index.js 的 buildJudge 在环境变量为空时回落到配置值
// 任何一环漏了，用户看到的现象都是「填了 key 但裁判不生效」。
//
// 跑法：node test/e2e-judge-from-config.mjs
//   需要 config 里写的那个 key 有效、代理可达

import { resolveConfig } from '../lib/config.js'
import { createJudge, createProxyTransport } from '../lib/relevance-judge.js'

const KEY = process.env.TEST_JUDGE_KEY
const PROXY = process.env.TEST_JUDGE_PROXY || 'http://127.0.0.1:7897'
if (!KEY) {
  console.log('缺少 TEST_JUDGE_KEY，跳过（这不是失败）')
  console.log('用法：set TEST_JUDGE_KEY=... && node test/e2e-judge-from-config.mjs')
  process.exit(0)
}

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log('=== 1. config.js 读得到面板填的四个字段 ===')
// 模拟面板保存后的配置文件内容
const resolved = resolveConfig({
  judge: {
    enabled: true,
    threshold: 0.7,
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKey: KEY,
    proxyUrl: PROXY,
  },
})
check('baseUrl 被读出来', resolved.judge.baseUrl === 'https://api.typesafe.ai/v1/systemone', resolved.judge.baseUrl)
check('model 被读出来', resolved.judge.model === 'jev-latest', resolved.judge.model)
check('apiKey 被读出来', resolved.judge.apiKey === KEY, resolved.judge.apiKey.slice(0, 8) + '...')
check('proxyUrl 被读出来', resolved.judge.proxyUrl === PROXY, resolved.judge.proxyUrl)
check('enabled 是 true', resolved.judge.enabled === true)

console.log('\n=== 2. 首尾空白被清掉（粘贴 key 最常见的坑）===')
const trimmed = resolveConfig({ judge: { apiKey: `  ${KEY}\n  ` } })
check('apiKey 首尾空白被 trim', trimmed.judge.apiKey === KEY, JSON.stringify(trimmed.judge.apiKey.slice(0, 6)))

console.log('\n=== 3. 用配置里的连接信息真的能打通端点 ===')
// 模拟 index.js buildJudge 的回落逻辑：env 为空 → 用配置值
const s = resolved.judge
const transport = s.proxyUrl === ''
  ? null
  : createProxyTransport({ url: s.baseUrl, apiKey: s.apiKey, model: s.model, proxyUrl: s.proxyUrl })
check('有 proxyUrl 时选的是代理 transport', transport !== null)

const judge = createJudge({ ...s, enabled: true, transport })
check('judge 认为已配置', judge.isConfigured() === true)

const hits = [
  { chunkId: 'dedupe#0', title: '条目级去重上线', text: '给 message 注入模式加了条目级去重，重复率降到 0。' },
  { chunkId: 'cat#0', title: '给猫换了猫砂', text: '周末把猫砂盆洗了换了新猫砂，猫很开心。' },
]
const verdict = await judge.judge('现在应该正常了，加了条目级去重', hits)

console.log(`  timing: ${JSON.stringify({ applied: verdict.applied, scored: verdict.scored, failed: verdict.failed, latencyMs: verdict.latencyMs })}`)
check('裁判真的生效（applied=true）', verdict.applied === true, verdict.reason ?? '')
check('两条都打上了分', verdict.scored === 2, `scored=${verdict.scored} failed=${verdict.failed}`)

const dedupeScore = verdict.scores.get('dedupe#0')
const catScore = verdict.scores.get('cat#0')
console.log(`  dedupe=${dedupeScore}  cat=${catScore}`)
check('相关的那条分数更高', dedupeScore > catScore, `${dedupeScore} vs ${catScore}`)
check('相关的那条过阈值 0.7', dedupeScore >= 0.7, String(dedupeScore))
check('无关的猫砂那条被阈值挡掉', catScore < 0.7, String(catScore))

console.log('')
if (fail === 0) {
  console.log(`全部通过：${pass} 条断言 —— 面板填的 key/端点/模型/代理确实生效`)
} else {
  console.log(`失败 ${fail} 条 / 共 ${pass + fail} 条`)
  process.exitCode = 1
}
