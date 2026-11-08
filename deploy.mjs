/**
 * 把 dev-plugins 里的公开版本同步到 installed-plugins 的个人运行版本。
 *
 * 两个版本的差异只有一个文件：`cordis.personal.yml`。
 * 代码本体（index.js / lib / ui / package.json）完全一致 ——
 * 公开版里的所有默认值都是空串或环境变量，个人配置通过 profile 的
 * cordis.patch.yml 注入，源码不需要分叉。
 *
 * 用法：node deploy.mjs
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TARGET = resolve(HERE, '..', '..', 'installed-plugins', 'dsh-vcprag')

if (!existsSync(TARGET)) {
  mkdirSync(TARGET, { recursive: true })
}

// 只同步代码本体。test/ 与迁移脚本留在 dev-plugins：
// 它们依赖开发机上的具体路径，不属于任何可分发的内容。
const INCLUDE = ['index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'lib', 'ui']
const SKIP_FILES = new Set(['.tmp-index', '.tmp-stage3'])

function copyRecursive(src, dst) {
  if (statSync(src).isDirectory()) {
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src)) {
      if (SKIP_FILES.has(entry)) continue
      copyRecursive(join(src, entry), join(dst, entry))
    }
    return
  }
  copyFileSync(src, dst)
}

const deployed = []
for (const name of INCLUDE) {
  const src = join(HERE, name)
  if (!existsSync(src)) {
    console.warn(`  跳过（不存在）：${name}`)
    continue
  }
  copyRecursive(src, join(TARGET, name))
  deployed.push(name)
}

console.log(`已部署到 ${TARGET}`)
console.log(`  同步：${deployed.join(', ')}`)
console.log('')
console.log('个人配置（日记目录 / embedding 端点 / 密钥）在 profile 的 cordis.patch.yml 里，')
console.log('不在这个目录 —— 所以升级代码不会覆盖你的路径设置。')
