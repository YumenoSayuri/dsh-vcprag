// 验证「配置文件 → 解析后的 config」这条链路真的走得通。
//
// 这个测试针对一类真实事故：插件加载成功、19 个 RPC 端点都在、
// 日志也没有任何 error，但 config 里全是默认值 —— UI 显示
// 「文档 0 篇 / no-index」。根因有两层：
//
//   1. profile 的 patch 条目写了 `name`，与 bundle 层注册的 name 不等，
//      DSH 直接 skip 整条记录（连 config 一起丢）。
//   2. UI 保存时把全量默认值写进 overlay（优先级高于 patch），
//      把好配置覆盖成空。
//
// 静态检查完全抓不到。这里用真实的 profile 文件 + 真实的 resolveConfig
// 走一遍，断言最终生效的路径是对的。

import { readFileSync, existsSync } from 'node:fs'
import { resolveConfig, runtimeFilePath, diaryWriteDir } from '../lib/config.js'

const PROFILE = 'C:/Users/Lenovo/.dsh/profiles/desktop'
const EXPECT_DIARY = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-diaries'
const EXPECT_DATA = 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-vcprag-memory'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// ---- 1. profile patch 里的 vcprag 条目不能写 name ----
console.log('=== 1. profile patch 条目结构 ===')
const patchLines = readFileSync(`${PROFILE}/cordis.patch.yml`, 'utf8').split(/\r?\n/)
let start = patchLines.findIndex((line) => /^-\s+id:\s*vcprag\s*$/.test(line))
check('找到 vcprag 条目', start >= 0, `line ${start + 1}`)

if (start >= 0) {
  const block = []
  for (let i = start + 1; i < patchLines.length; i += 1) {
    if (/^-\s+id:/.test(patchLines[i])) break
    block.push(patchLines[i])
  }
  // 只看非注释行里的 name
  const realNameLines = block.filter((line) => /^\s+name:/.test(line))
  check(
    '条目里没有 name 键（有的话 DSH 会因 mismatch 整条 skip）',
    realNameLines.length === 0,
    realNameLines.join(' / ') || '(无)',
  )
  check('条目里有 config 段', block.some((line) => /^\s+config:/.test(line)))
  check(
    '条目里有 diaryRoot',
    block.some((line) => /^\s+diaryRoot:/.test(line)),
  )
}

// ---- 2. 不能存在「全空」的 config.json 覆盖层 ----
console.log('')
console.log('=== 2. overlay 覆盖层 ===')
const overlayPath = `${PROFILE}/.vcprag/config.json`
if (!existsSync(overlayPath)) {
  check('没有可疑 overlay（无文件是正常的）', true, '(不存在)')
} else {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  const emptyDiary = overlay.diaryRoot === ''
  const emptyCorpus = overlay.corpusRoot === ''
  check(
    'overlay 没有把 diaryRoot 写成空串',
    !emptyDiary,
    JSON.stringify(overlay.diaryRoot),
  )
  check(
    'overlay 没有把 corpusRoot 写成空串',
    !emptyCorpus,
    JSON.stringify(overlay.corpusRoot),
  )
  console.log('  overlay 键：', Object.keys(overlay).join(', '))
}

// ---- 3. 用 patch 里的值跑 resolveConfig，看最终路径 ----
console.log('')
console.log('=== 3. resolveConfig 最终结果 ===')
// 手工模拟 patch 里的 config（等价于 DSH 解析 YAML 后传进来的对象）
const patchConfig = {
  diaryRoot: EXPECT_DIARY,
  corpusRoot: '',
  dataDir: EXPECT_DATA,
  diary: {
    enabled: true,
    format: 'txt',
    folder: '',
    templateEnabled: true,
    templateOrder: 130,
    templateText: '',
    requireTag: true,
    timePrefix: true,
    runtimeFile: 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/installed-plugins/dsh-mnemon-memory/runtime/memories.json',
  },
  embedding: {
    enabled: true,
    baseUrl: 'https://ai.huibaolinks.com/v1',
    model: 'google/gemini-embedding-2-preview',
    dimensions: 3072,
  },
}

const config = resolveConfig(patchConfig)
console.log('  corpusRoot =', JSON.stringify(config.corpusRoot))
console.log('  diaryRoot  =', config.diaryRoot)
console.log('  dataDir    =', config.dataDir)
console.log('  runtimeFile=', runtimeFilePath(config))
console.log('  写入目录    =', diaryWriteDir(config))
console.log('  model      =', config.embedding.model)

check('corpusRoot 是空串（只用日记）', config.corpusRoot === '', JSON.stringify(config.corpusRoot))
check('diaryRoot 指向真实日记目录', config.diaryRoot.replace(/\\/g, '/') === EXPECT_DIARY, config.diaryRoot)
check('dataDir 指向生产索引目录', config.dataDir.replace(/\\/g, '/') === EXPECT_DATA, config.dataDir)
check('日记目录真实存在', existsSync(config.diaryRoot), config.diaryRoot)
check('索引目录真实存在', existsSync(config.dataDir), config.dataDir)
check(
  'runtimeFile 指向 mnemon 老位置',
  runtimeFilePath(config).includes('dsh-mnemon-memory'),
  runtimeFilePath(config),
)
check('model 带 -preview 后缀', config.embedding.model === 'google/gemini-embedding-2-preview', config.embedding.model)

// ---- 4. 默认值不能被误当成「显式置空」 ----
console.log('')
console.log('=== 4. 空串语义 ===')
const withDefault = resolveConfig({})
const withEmpty = resolveConfig({ corpusRoot: '' })
console.log('  {}            → corpusRoot =', JSON.stringify(withDefault.corpusRoot))
console.log("  {corpusRoot:''} → corpusRoot =", JSON.stringify(withEmpty.corpusRoot))
check(
  '缺键时回退默认值',
  withDefault.corpusRoot !== '',
  withDefault.corpusRoot,
)
check(
  '显式空串则保持空（可用它关闭 .md 层）',
  withEmpty.corpusRoot === '',
  JSON.stringify(withEmpty.corpusRoot),
)

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 配置链路正确：patch → resolveConfig → 真实路径')
