// 验证「UI 保存配置」这条路径不会毁掉用户已有配置。
//
// 这个测试覆盖两个真实踩过的静默数据损坏：
//
//   1. SECTION_KEYS.diary 白名单漏了 templateText
//      → /diary/template/save 返回 ok:true，但 buildOverlay 里根本没有
//        这个 key，写盘结果是 {}，模板永远存不进去。用户看到「已保存」
//        却什么都没变。
//
//   2. publicConfig() 把 diary.templateText 回传成空串占位
//      → 前端保存任意别的设置时，会把整份快照（含那个空串）回传。
//        delta 过滤会认为「有内容 → 空串」是一次真实改动，
//        于是把用户的日记模板悄悄清空。
//
// 两者都是「接口回 ok、日志无错、功能静默失效」，静态检查抓不到。

import {
  buildOverlayForTest,
  buildTemplateOverlayForTest,
  mergeForSaveForTest,
  stripMaskedDiaryForTest as internalsStrip,
} from './_rpc-harness.mjs'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// 模拟「用户已经写了一份自定义模板」的当前生效配置
const current = {
  corpusRoot: '',
  diaryRoot: 'C:/diaries',
  dataDir: 'C:/data',
  chunkSize: 800,
  chunkOverlap: 120,
  includeArchived: false,
  panelEnabled: true,
  diary: {
    enabled: true,
    format: 'txt',
    folder: '',
    templateEnabled: true,
    templateOrder: 130,
    templateText: '## 我精心写的模板\n\n别把我清空。',
    requireTag: true,
    timePrefix: true,
    runtimeFile: '',
  },
  embedding: { enabled: true, baseUrl: '', model: '', dimensions: 3072, apiKey: '' },
  recall: { lexicalLimit: 30, semanticLimit: 30, kBase: 5, kMin: 3, kMax: 10, tagWeight: 0.4, maxChars: 4000 },
  timeDecay: { enabled: true, halfLifeDays: 180, floor: 0.55 },
  freeze: { onUserMessage: true, onTodoCheck: true },
  runtime: { inject: true, order: 120, title: 't', intro: 'i', criticalTitle: 'c', normalTitle: 'n', toolGuidance: true },
  inject: { enabled: true, order: 125, blockName: 'b', header: 'h', disclaimer: 'd', itemPrefix: 'p' },
  tools: { enabled: true, writeEnabled: true, forgetEnabled: true },
}

// ---- 1. 模板能存进去 ----
console.log('=== 1. /diary/template/save 真的落盘 ===')
// 这个端点**不走** stripMaskedDiary —— 它就是专门改 templateText 的
const tplSave = buildTemplateOverlayForTest({ diary: { templateText: '## 新模板' } }, current)
check(
  'overlay 里带上了 templateText',
  tplSave?.diary?.templateText === '## 新模板',
  JSON.stringify(tplSave),
)

const tplClear = buildTemplateOverlayForTest({ diary: { templateText: '' } }, current)
check(
  '传空串 = 明确回退内置模板，也要落盘',
  tplClear?.diary?.templateText === '',
  JSON.stringify(tplClear),
)

const tplSame = buildTemplateOverlayForTest({ diary: { templateText: current.diary.templateText } }, current)
check(
  '内容没变时不写 overlay（保持 delta 语义）',
  tplSame?.diary?.templateText === undefined,
  JSON.stringify(tplSame),
)

// 反向验证：如果这个端点误用了剥离版，模板就永远存不进去
const tplIfStripped = buildOverlayForTest({ diary: { templateText: '## 新模板' } }, current)
check(
  '若误用剥离版则 overlay 为空 —— 证明两条路径必须分开',
  tplIfStripped?.diary?.templateText === undefined,
  JSON.stringify(tplIfStripped),
)

// ---- 2. 保存别的设置不会清空模板 ----
console.log('')
console.log('=== 2. 保存其它设置不会把模板清空 ===')
// 前端提交的是 publicConfig 快照：templateText 恒为空串占位
const snapshot = {
  corpusRoot: '',
  diaryRoot: 'C:/diaries',
  dataDir: 'C:/data',
  chunkSize: 400, // ← 用户这次真的改了这个
  diary: {
    enabled: true,
    format: 'txt',
    folder: '',
    templateEnabled: true,
    templateOrder: 130,
    templateText: '', // ← 这是占位，不是「清空」指令
    requireTag: true,
    timePrefix: true,
    runtimeFile: '',
  },
}

const stripped = buildOverlayForTest(snapshot, current)
check(
  'overlay 不含 diary.templateText',
  stripped?.diary?.templateText === undefined,
  JSON.stringify(stripped?.diary),
)
check('真正的改动仍然被记录（chunkSize）', stripped?.chunkSize === 400, JSON.stringify(stripped))

// 注意：onSettingsSave 传进 mergeForSave 的是**已剥离**的 patch，
// 不是原始快照。这里必须复现那个真实调用顺序。
const merged = mergeForSaveForTest(current, internalsStrip(snapshot))
check(
  'mergeForSave 后模板还在',
  merged.diary.templateText === current.diary.templateText,
  JSON.stringify(merged.diary.templateText),
)
check('mergeForSave 后 chunkSize 已更新', merged.chunkSize === 400, `实际 ${merged.chunkSize}`)

// ---- 3. 全部默认值的快照不应产生空 overlay ----
console.log('')
console.log('=== 3. 「点保存但什么都没改」不写盘 ===')
const noop = buildOverlayForTest(
  {
    corpusRoot: '',
    diaryRoot: 'C:/diaries',
    dataDir: 'C:/data',
    chunkSize: 800,
    diary: { enabled: true, format: 'txt', folder: '', templateEnabled: true, templateOrder: 130, templateText: '', requireTag: true, timePrefix: true, runtimeFile: '' },
  },
  current,
)
check('delta 过滤后 overlay 为空对象', Object.keys(noop).length === 0, JSON.stringify(noop))

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 配置保存路径安全：模板能存、不会被误清、空提交不落盘')
