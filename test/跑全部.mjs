/** 临时跑全部 smoke，输出 PASS/FAIL 汇总。跑完删掉。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

// 这两个是「真实环境」测试的必要输入：
//   VCPRAG_DIARY_DIR      没有它 stage1/2 找不到日记，会判「没有可用文档」而失败
//   VCPRAG_EMBEDDING_KEY  Windows 的 process.env 是启动快照，shell 里 set 不进
//                         已在运行的进程，必须从注册表读 User 级变量
const DIARY_DIR =
  'C:\\Users\\Lenovo\\Documents\\deepseek-harness\\default-workspace\\installed-plugins\\dsh-vcprag-diaries'
const childEnv = { ...process.env, VCPRAG_DIARY_DIR: DIARY_DIR }
try {
  const key = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('VCPRAG_EMBEDDING_KEY','User')"],
    { encoding: 'utf8' },
  ).trim()
  if (key !== '') childEnv.VCPRAG_EMBEDDING_KEY = key
} catch {
  /* 读不到就只跑降级路径 */
}

const files = readdirSync('test')
  .filter((f) => f.startsWith('smoke-') && f.endsWith('.mjs'))
  .sort()

const rows = []
for (const f of files) {
  const r = spawnSync(process.execPath, [`test/${f}`], { encoding: 'utf8', timeout: 180000, env: childEnv })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const ok = r.status === 0
  const last = out.trim().split('\n').filter((l) => l.includes('通过') || l.includes('失败') || l.includes('❌'))
  rows.push({ f, ok, code: r.status, tail: last.slice(-2).join(' | ').slice(0, 120) })
}

let fail = 0
for (const r of rows) {
  if (!r.ok) fail += 1
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.f.padEnd(28)} ${r.tail}`)
}
console.log('')
console.log(`${rows.length - fail}/${rows.length} 绿`)
process.exitCode = fail === 0 ? 0 : 1
