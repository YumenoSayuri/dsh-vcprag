/**
 * 校验「开发目录」与「installed-plugins」的文件哈希是否一致。
 *
 * 为什么需要它：deploy.mjs 只同步白名单里的路径，漏一个文件（比如新加的
 * lib/xxx.js 忘了加进 files 数组）不会有任何报错 —— 运行时才会以
 * ERR_MODULE_NOT_FOUND 或「某个功能静默不生效」的形式炸出来，
 * 而那时你已经在查别的地方了。
 *
 * 跑法：node test/校验部署一致性.mjs
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const DEV = process.cwd()
const INSTALLED =
  'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag'

// deploy.mjs 同步的白名单
const ENTRIES = ['index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'lib', 'ui']

/** 递归收集相对路径（跳过 node_modules）。 */
function collect(root, entry) {
  const full = join(root, entry)
  let st
  try {
    st = statSync(full)
  } catch {
    return []
  }
  if (st.isFile()) return [entry]
  const out = []
  for (const name of readdirSync(full)) {
    if (name === 'node_modules') continue
    out.push(...collect(root, join(entry, name)))
  }
  return out
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)

let same = 0
const missing = []
const different = []

for (const entry of ENTRIES) {
  for (const rel of collect(DEV, entry)) {
    const devFile = join(DEV, rel)
    const insFile = join(INSTALLED, rel)
    let insHash
    try {
      insHash = sha(insFile)
    } catch {
      missing.push(rel)
      continue
    }
    const devHash = sha(devFile)
    if (devHash === insHash) same += 1
    else different.push(`${rel}  dev=${devHash} ins=${insHash}`)
  }
}

console.log(`一致 ${same} 个文件`)

if (missing.length > 0) {
  console.log(`\n未部署（${missing.length}）：`)
  for (const f of missing) console.log(`  - ${f}`)
}
if (different.length > 0) {
  console.log(`\n内容不一致（${different.length}）：`)
  for (const f of different) console.log(`  - ${f}`)
}

// 反向检查：装到 installed 里但开发目录没有的（通常是残留）
const orphans = []
for (const entry of ENTRIES) {
  for (const rel of collect(INSTALLED, entry)) {
    try {
      statSync(join(DEV, rel))
    } catch {
      orphans.push(rel)
    }
  }
}
if (orphans.length > 0) {
  console.log(`\ninstalled 有、开发目录没有（${orphans.length}）：`)
  for (const f of orphans) console.log(`  - ${f}`)
}

const bad = missing.length + different.length
console.log('')
if (bad === 0) {
  console.log(`一致性校验通过（${same} 个文件逐一比对）`)
} else {
  console.log(`校验失败：${missing.length} 个缺失，${different.length} 个不一致`)
  process.exitCode = 1
}
