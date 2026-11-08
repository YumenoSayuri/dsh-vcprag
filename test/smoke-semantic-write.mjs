// 语义写入（正文里的结构化块）端到端验证。
//
// 这条通道的核心风险不是「写不进去」，而是**写错地方**：
//   - create 把正文首段吃进头部 → 写成一篇残篇
//   - update 的 target 太短 → 命中多处，替换变成随机破坏
//   - 同一次回复被投递两遍 → 同一件事落两篇
//
// 所以下面的断言大多在验证「不该发生的事没发生」。

import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractBlocks, parseBlock, validateBlock, stripBlocks, blockMarkers } from '../lib/diary-block.js'
import { writeDiaryDoc, replaceInDiaryDoc, listDiaryFiles, normaliseTitle, resolveTitle } from '../lib/diary-write.js'
import { createDiarySink, previewBlocks } from '../lib/diary-sink.js'
import { resolveConfig } from '../lib/config.js'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

// 临时日记目录，测完删掉
const root = mkdtempSync(join(tmpdir(), 'vcprag-semantic-'))
const config = resolveConfig({ corpusRoot: '', diaryRoot: root, dataDir: join(root, '.data') })

// 假的 indexer：只记录调用，不建真索引（向量化要联网）
const indexed = []
const indexer = {
  async addDocument(doc) {
    indexed.push(doc)
    return { vectorized: false, error: '测试环境不联网' }
  },
}
const logs = []
const sink = createDiarySink({ getConfig: () => config, indexer, log: (l, m) => logs.push(`${l}: ${m}`) })

const BLOCK = (inner) => `<<<DailyNoteStart>>>\n${inner}\n<<<DailyNoteEnd>>>`

try {
  // ---- 1. 块解析 ----
  console.log('=== 1. 解析 create 块 ===')
  const createText = `先说明一下情况。

${BLOCK(`command: create
title: 语义写入验证
folder: 测试分类
tags: 语义写入, 日记

[09:41] 这是一段正文，用来验证语义块能被正确解析并落盘。

第二段正文，检查多行是否完整保留。
Tag: 语义写入, 日记`)}

以上就是这次记录。`

  const blocks = extractBlocks(createText)
  check('抽到 1 个块', blocks.length === 1, `实际 ${blocks.length}`)
  check('命令识别为 create', blocks[0]?.parsed.command === 'create', blocks[0]?.parsed.command)
  check('title 解析正确', blocks[0]?.parsed.fields.title === '语义写入验证', blocks[0]?.parsed.fields.title)
  check('folder 解析正确', blocks[0]?.parsed.fields.folder === '测试分类', blocks[0]?.parsed.fields.folder)
  check('tags 解析正确', blocks[0]?.parsed.fields.tags === '语义写入, 日记', blocks[0]?.parsed.fields.tags)

  // 关键：头部之后必须恰好是正文，不能被吃掉一行
  const body = blocks[0]?.parsed.body ?? ''
  check('正文以 [09:41] 开头（没被头部吃掉）', body.trimStart().startsWith('[09:41]'), JSON.stringify(body.slice(0, 30)))
  check('正文保留了第二段', body.includes('第二段正文'), body.includes('第二段正文') ? '' : JSON.stringify(body))
  check('正文末行 Tag 保留', /Tag: 语义写入, 日记\s*$/.test(body), JSON.stringify(body.slice(-30)))

  // ---- 2. 头部误判防护 ----
  console.log('')
  console.log('=== 2. create 块漏空行 ===')
  const noBlank = BLOCK(`command: create
title: 漏空行
[09:41] 正文直接跟在标题后面`)
  const nb = extractBlocks(noBlank)[0]
  check('漏空行时有 problem 提示', nb.parsed.problems.length > 0, nb.parsed.problems.join(' / '))
  // 关键行为：正文仍然要求非空才算合法，避免把 title 当成正文写进去
  const nbCheck = validateBlock(nb.parsed, { minTarget: 15 })
  check(
    '漏空行时正文被识别为空或明确报错（不会静默写残篇）',
    nbCheck.ok === false || nb.parsed.body.trim() !== '',
    nbCheck.ok ? `body=${JSON.stringify(nb.parsed.body.slice(0, 40))}` : nbCheck.errors.join(' / '),
  )

  // ---- 3. update 块解析与安全阀 ----
  console.log('')
  console.log('=== 3. update 块与 target 安全阀 ===')
  const updateBlock = extractBlocks(BLOCK(`command: update
target: 这是一段要被替换掉的旧内容，长度足够
replace: 这是替换后的新内容`))[0]
  check('命令识别为 update', updateBlock.parsed.command === 'update', updateBlock.parsed.command)
  check('target/replace 解析正确',
    updateBlock.parsed.fields.target === '这是一段要被替换掉的旧内容，长度足够'
    && updateBlock.parsed.fields.replace === '这是替换后的新内容')

  const shortTarget = parseBlock(`command: update
target: 太短了
replace: 新内容`)
  const shortCheck = validateBlock(shortTarget, { minTarget: 15 })
  check('target 过短被拒绝', shortCheck.ok === false, shortCheck.errors.join(' / '))

  // 推断：没有 command 但有 target 时按 update 处理
  const inferred = parseBlock(`target: 这是一段要被替换掉的旧内容，长度足够
replace: 新内容`)
  check('缺 command 时按字段推断为 update', inferred.command === 'update', inferred.command)

  // ---- 4. 真正落盘 ----
  console.log('')
  console.log('=== 4. 执行 create：真的写进文件 ===')
  const first = await sink.consume(createText.trim(), { sessionId: 'test', turn: 1 })
  check('written = 1', first.written === 1, JSON.stringify({ w: first.written, f: first.failed, r: first.results }))
  check('failed = 0', first.failed === 0, JSON.stringify(first.results))

  const files = listDiaryFiles(config)
  check('确实产生 1 个文件', files.length === 1, `${files.length} 个：${files.map((f) => f.filename).join(', ')}`)
  check(
    '文件落在 folder 指定的子目录',
    files[0]?.relativePath?.includes('测试分类/') === true,
    files[0]?.relativePath,
  )

  const written = readFileSync(files[0].path, 'utf8')
  check('文件正文含 [09:41]', written.includes('[09:41]'))
  check('文件正文不含块标记', !written.includes('DailyNoteStart'))
  check('文件不含 command 头', !written.includes('command:'))
  check('文件末行是 Tag', /Tag: 语义写入, 日记\s*$/.test(written), JSON.stringify(written.slice(-40)))
  check('索引被调用一次', indexed.length === 1, `实际 ${indexed.length}`)
  check('索引收到的 title 正确', indexed[0]?.title === '语义写入验证', indexed[0]?.title)

  // ---- 5. 幂等 ----
  console.log('')
  console.log('=== 5. 同一次回复投递两遍 ===')
  const again = await sink.consume(createText.trim(), { sessionId: 'test', turn: 1 })
  check('第二次全部跳过', again.written === 0 && again.skipped === 1, JSON.stringify({ w: again.written, s: again.skipped }))
  check('没有产生第 2 个文件', listDiaryFiles(config).length === 1, `${listDiaryFiles(config).length} 个`)

  // ---- 6. 同标题不重复建篇 ----
  console.log('')
  console.log('=== 6. 换个标题测 update 定位替换 ===')
  const updateText = BLOCK(`command: update
target: 这是被替换掉的旧内容，原先写在这里
replace: 这是替换后的新内容，已经更新完毕`)
  // 先手动放一篇含 target 的日记
  const targetFile = join(root, '测试分类', '2026-11-06-update-target-deadbeef.txt')
  mkdirSync(join(root, '测试分类'), { recursive: true })
  writeFileSync(targetFile, '[10:00] 更新测试\n\n这是被替换掉的旧内容，原先写在这里\n\n保留这一段。\n\nTag: 更新测试\n', 'utf8')

  const upd = await sink.consume(updateText.trim(), { sessionId: 'test', turn: 2 })
  check('updated = 1', upd.updated === 1, JSON.stringify({ u: upd.updated, f: upd.failed, r: upd.results }))
  const after = readFileSync(targetFile, 'utf8')
  check('target 已被替换', after.includes('这是替换后的新内容，已经更新完毕'), after.includes('这是替换后的新内容') ? '' : JSON.stringify(after))
  check('旧 target 已消失', !after.includes('这是被替换掉的旧内容'), after.includes('这是被替换掉的旧内容') ? '仍在' : '')
  check('周边内容保留了', after.includes('保留这一段。'), after.includes('保留这一段。') ? '' : JSON.stringify(after))
  check('正文首行没被动过', after.startsWith('[10:00] 更新测试'), JSON.stringify(after.slice(0, 20)))

  // ---- 7. 找不到 target 时不改文件 ----
  console.log('')
  console.log('=== 7. target 匹配不到：宁失败不猜 ===')
  const before = readFileSync(targetFile, 'utf8')
  const missText = BLOCK(`command: update
target: 这段内容在日记里根本不存在，纯粹用来测试失败路径
replace: 不该被写进去`)
  const miss = await sink.consume(missText.trim(), { sessionId: 'test', turn: 3 })
  check('报告失败', miss.failed === 1, JSON.stringify({ f: miss.failed, r: miss.results }))
  check('文件一个字节都没变', readFileSync(targetFile, 'utf8') === before, '文件被改了')

  // ---- 8. 去空白匹配（跨换行差异） ----
  console.log('')
  console.log('=== 8. target 与原文空白不一致也能定位 ===')
  const spaced = await replaceInDiaryDoc({
    config,
    indexer,
    target: '保留这一段。\n\nTag: 更新测试',
    replace: '保留这一段（已改）。\n\nTag: 更新测试',
  })
  check('空白差异不影响定位', spaced.ok === true, spaced.error ?? '')
  check('替换生效', readFileSync(targetFile, 'utf8').includes('保留这一段（已改）。'), '')

  // ---- 9. 显示层剔除 ----
  console.log('')
  console.log('=== 9. 给用户看的正文里没有块 ===')
  check('stripBlocks 去掉了块', !stripBlocks(createText).includes('DailyNoteStart'))
  check('stripBlocks 保留了人话', stripBlocks(createText).includes('先说明一下情况'))
  check('连续空行被收敛', !/\n{3,}/.test(stripBlocks(createText)))

  // ---- 10. 配置关闭 ----
  console.log('')
  console.log('=== 10. 开关真的生效 ===')
  const offConfig = resolveConfig({
    corpusRoot: '', diaryRoot: root, dataDir: join(root, '.data'),
    diary: { semantic: { enabled: false } },
  })
  check('semantic.enabled 解析为 false', offConfig.diary.semantic.enabled === false)
  const offSink = createDiarySink({ getConfig: () => offConfig, indexer, log: () => {} })
  const offResult = await offSink.consume(createText.trim(), {})
  check('关闭后一个块都不处理', offResult.blocks === 0 && offResult.written === 0, JSON.stringify({ b: offResult.blocks, w: offResult.written }))

  // ---- 11. 块名可配 ----
  console.log('')
  console.log('=== 11. 自定义块名 ===')
  const custom = resolveConfig({
    corpusRoot: '', diaryRoot: root, dataDir: join(root, '.data'),
    diary: { semantic: { blockName: 'MyDiary' } },
  })
  check('块名解析正确', custom.diary.semantic.blockName === 'MyDiary', custom.diary.semantic.blockName)
  const customText = `<<<MyDiaryStart>>>\ncommand: create\ntitle: 自定义块名\n\n[11:00] 验证自定义块名\nTag: 块名\n<<<MyDiaryEnd>>>`
  check('能解析自定义块名', extractBlocks(customText, 'MyDiary').length === 1)
  check('默认块名解析不到它', extractBlocks(customText).length === 0)
  // 非法块名被清洗
  const dirty = resolveConfig({
    corpusRoot: '', diaryRoot: root, dataDir: join(root, '.data'),
    diary: { semantic: { blockName: 'bad<>name' } },
  })
  check('非法字符被清洗掉', dirty.diary.semantic.blockName === 'badname', dirty.diary.semantic.blockName)

  // ---- 12. 预览端点（不落盘） ----
  console.log('')
  console.log('=== 12. previewBlocks 只解析 ===')
  const previewRows = previewBlocks(createText, config.diary.semantic)
  check('预览出 1 条', previewRows.length === 1, `${previewRows.length}`)
  check('预览结果是合法的', previewRows[0]?.ok === true, JSON.stringify(previewRows[0]?.errors))
  check('预览含正文长度', previewRows[0]?.bodyChars > 0, String(previewRows[0]?.bodyChars))

  // ---- 13. 多块同一次回复 ----
  console.log('')
  console.log('=== 13. 一次回复里两个块 ===')
  const multi = `说明文字。\n\n${BLOCK(`command: create
title: 多块甲

[12:00] 第一篇
Tag: 甲`)}\n\n中间文字。\n\n${BLOCK(`command: create
title: 多块乙

[12:01] 第二篇
Tag: 乙`)}`
  const multiResult = await sink.consume(multi, { sessionId: 'test', turn: 4 })
  check('两个块都写了', multiResult.written === 2, JSON.stringify({ w: multiResult.written, r: multiResult.results }))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：\n  · ${failures.join('\n  · ')}`)
  process.exit(1)
}
console.log('✓ 语义写入通道正确：解析 / 落盘 / 定位替换 / 幂等 / 安全阀')
