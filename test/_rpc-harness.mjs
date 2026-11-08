// 把 rpc.js 里的纯函数取出来给测试用。
//
// 为什么不直接 export：buildOverlay / mergeForSave 是内部实现细节，
// 导出去就等于承诺它们是对外 API，以后重构会被这些承诺绑住。
//
// 这里用「读源码 + 拼接求值」的方式拿到它们。好处是：
//   - 测的是**真实源码**，不是复制品，不会出现「测试绿了代码却坏了」
//   - 源码里改了白名单，测试立刻能感知到
// 代价是依赖函数名，所以下面每个名字都写清用途，改名前先看这里。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'rpc.js'), 'utf8')

/**
 * 从源码里切出一个顶层 const / function 声明（按大括号配平）。
 *
 * @param {string} header 声明开头，如 'function buildOverlay('
 * @returns {string}
 */
function sliceDeclaration(header) {
  const start = source.indexOf(header)
  if (start < 0) throw new Error(`rpc.js 里找不到声明：${header}`)

  // 从声明处往后数大括号，找到配平点
  let depth = 0
  let seen = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') {
      depth += 1
      seen = true
    } else if (ch === '}') {
      depth -= 1
      if (seen && depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`声明未闭合：${header}`)
}

/** 取出一个顶层 const 数组/对象字面量（按方括号或大括号配平，到分号为止）。 */
function sliceConst(name) {
  const header = `const ${name} = `
  const start = source.indexOf(header)
  if (start < 0) throw new Error(`rpc.js 里找不到常量：${name}`)
  const bodyStart = start + header.length
  const open = source[bodyStart]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`常量未闭合：${name}`)
}

// 这几个名字与 rpc.js 中保持一致
const pieces = [
  sliceConst('SCALAR_KEYS'),
  sliceConst('SECTION_KEYS'),
  sliceConst('EMBEDDING_KEYS'),
  sliceConst('MASKED_DIARY_KEYS'),
  sliceDeclaration('function stripMaskedDiary('),
  // buildOverlay / mergeForSave 都依赖它判断「掩码 = 没改动」。
  // 漏掉这一片，harness 会在运行时抛 isMaskedSecret is not defined ——
  // 而真实代码里它是顶层函数，正常导出时不会出事。
  sliceDeclaration('function isMaskedSecret('),
  sliceDeclaration('function readPath('),
  sliceDeclaration('function ensurePath('),
  sliceDeclaration('function buildOverlay('),
  sliceDeclaration('function mergeForSave('),
]

// structuredClone 是 node 全局，直接用
const factory = new Function(`${pieces.join('\n\n')}\n\nreturn { stripMaskedDiary, buildOverlay, mergeForSave }`)

const internals = factory()

/**
 * 模拟 /settings/save 的 overlay 构造：
 * 先前端快照 → 剥掩码占位 → delta 过滤。
 *
 * @param {object} patch 前端提交的 config
 * @param {object} current 当前生效配置
 */
export function readConfigOverlayForTest(dataDir) {
  return readConfigOverlay(dataDir)
}

export function buildOverlayForTest(patch, current) {
  return internals.buildOverlay(internals.stripMaskedDiary(patch), current)
}

/**
 * 模拟 /diary/template/save 的 overlay 构造：**不**剥掩码。
 *
 * @param {object} patch
 * @param {object} current
 */
export function buildTemplateOverlayForTest(patch, current) {
  return internals.buildOverlay(patch, current)
}

/**
 * 暴露剥离函数本身。
 *
 * 用于复现 onSettingsSave 的真实调用顺序：
 *   raw snapshot → stripMaskedDiary → mergeForSave / buildOverlay
 * 少了这一步，「改设置会不会清空模板」就测不出来。
 */
export function stripMaskedDiaryForTest(patch) {
  return internals.stripMaskedDiary(patch)
}

/** 暴露给测试断言「合并后模板还在」。 */
export function mergeForSaveForTest(current, patch) {
  return internals.mergeForSave(current, patch)
}
