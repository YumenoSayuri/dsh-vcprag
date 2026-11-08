/**
 * smoke-tokenizer —— 分词器：jieba 可选加载 / 自动降级 / 强制 gram。
 *
 * 这套断言的目的是锁住「可选依赖」的承诺：
 *
 *   **jieba 装不上时，插件必须还能跑，而且行为要等于纯 1-gram 模式。**
 *
 * 因为这是「降到 gram」而不是「抛错」，没法靠 mock 让 require 失败
 * （模块加载在 Node 里不是可注入的），所以分两条路验证：
 *
 *   1. 真的加载一次 jieba，看它在本机是否可用 —— 可用则验证分词质量。
 *   2. 强制 mode='gram'，验证不依赖 jieba 也能完整分词 ——
 *      这就是 jieba 缺失时的实际代码路径。
 *
 * 跑法：node test/smoke-tokenizer.mjs
 */

import { tokenize, resolveEngine, jiebaLoadError } from '../lib/tokenize.js'

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label + (detail ? ` — ${detail}` : ''))
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('=== 1. 引擎探测 ===')
const autoEngine = resolveEngine('auto')
const gramEngine = resolveEngine('gram')
console.log(`  auto → ${autoEngine}`)
console.log(`  gram → ${gramEngine}`)
if (autoEngine === 'gram') {
  console.log(`  （本机没有可用的 jieba，降级原因：${jiebaLoadError()}）`)
}

check('resolveEngine("gram") 恒为 gram', gramEngine === 'gram')
check('resolveEngine("auto") 返回合法值', autoEngine === 'jieba' || autoEngine === 'gram')

console.log('')
console.log('=== 2. gram 模式（= jieba 缺失时的真实代码路径）===')
const gramText = '上下文折叠策略'
const gramTokens = tokenize(gramText, null, { mode: 'gram' })
console.log('  ' + JSON.stringify(gramTokens))
// 注意：「上」「下」在 STOPWORDS 里，本来就会被丢弃（高频虚词方向词）。
// 所以拿「文」「折」这种实词来断言 1-gram，不要拿「上」。
check('gram 模式切出 1-gram', gramTokens.includes('文') && gramTokens.includes('折'))
check('gram 模式切出 2-gram', gramTokens.includes('下文') && gramTokens.includes('折叠'))
check('gram 模式产出非空', gramTokens.length > 0)
check('停止词「上」在 gram 模式下被丢弃', !gramTokens.includes('上'))

console.log('')
console.log('=== 3. 拉丁词与停止词 ===')
const latinTokens = tokenize('BM25 和 RRF 融合', null, { mode: 'gram' })
console.log('  ' + JSON.stringify(latinTokens))
check('拉丁词整取', latinTokens.includes('bm25') && latinTokens.includes('rrf'))
check('停止词被丢弃（「和」）', !latinTokens.includes('和'))
check('单字母不产出', tokenize('a b c', null, { mode: 'gram' }).length === 0)

console.log('')
console.log('=== 4. 标点与空白不产出 token ===')
const punct = tokenize('召回刷新（first-turn）：6 条 / 4102 字', null, { mode: 'gram' })
console.log('  ' + JSON.stringify(punct))
check('不含括号', !punct.includes('（') && !punct.includes('）'))
check('不含斜杠', !punct.includes('/'))
check('含纯数字 token', punct.includes('4102'))

console.log('')
console.log('=== 5. 别名组扩展 ===')
const aliases = { BM25: ['关键词检索', '词法检索'] }
const withAlias = tokenize('我们用关键词检索', aliases, { mode: 'gram' })
const withoutAlias = tokenize('我们用关键词检索', null, { mode: 'gram' })
console.log(`  无别名 ${withoutAlias.length} token / 有别名 ${withAlias.length} token`)
check('别名扩展增加了 token', withAlias.length > withoutAlias.length)
check('别名注入了规范名', withAlias.includes('bm25'))
check('别名注入了组内其他词', withAlias.includes('词法') && withAlias.includes('检索'))

console.log('')
console.log('=== 6. 未命中别名时不扩展 ===')
const noHit = tokenize('完全无关的一句话', aliases, { mode: 'gram' })
check('未触发别名扩展', !noHit.includes('bm25'))

console.log('')
console.log('=== 7. 防御性输入 ===')
check('null 返回空数组', tokenize(null, null, { mode: 'gram' }).length === 0)
check('空串返回空数组', tokenize('', null, { mode: 'gram' }).length === 0)
check('数字返回空数组', tokenize(123, null, { mode: 'gram' }).length === 0)
check('无 options 不抛错', tokenize('测试', null).length >= 0)

if (autoEngine === 'jieba') {
  console.log('')
  console.log('=== 8. jieba 可用时的分词质量 ===')
  const cases = [
    { text: '我只是调高了对话消息召回的上限', mustInclude: ['对话', '消息', '召回', '上限'] },
    { text: '前缀缓存命中率怎么提高', mustInclude: ['前缀', '缓存', '命中率'] },
    { text: 'AI 消息撤回是怎么实现的', mustInclude: ['消息', '撤回', '实现'] },
  ]
  for (const c of cases) {
    const tokens = tokenize(c.text, null, { mode: 'auto' })
    const hit = c.mustInclude.filter((w) => tokens.includes(w))
    console.log(`  ${c.text}`)
    console.log(`    → ${JSON.stringify(tokens)}`)
    check(`  整词被切出（${c.mustInclude.join('/')}）`, hit.length === c.mustInclude.length,
      `命中 ${hit.join('/') || '无'}`)
  }

  // jieba 的核心收益：不再把每个汉字都当 token
  const jiebaLen = tokenize('我只是调高了对话消息召回的上限', null, { mode: 'auto' }).length
  const gramLen = tokenize('我只是调高了对话消息召回的上限', null, { mode: 'gram' }).length
  console.log(`  token 数：jieba ${jiebaLen} / gram ${gramLen}`)
  check('jieba 产出的 token 明显少于 gram', jiebaLen < gramLen,
    `jieba=${jiebaLen} gram=${gramLen}`)

  console.log('')
  console.log('=== 9. 强制 jieba 而实际不可用时静默降级 ===')
  // 这条路径在装了 jieba 的机器上测不到「不可用」，但能测到
  // 「mode=jieba 不抛错且结果与 auto 一致」—— 即没有隐藏的强制逻辑。
  const forced = tokenize('上下文折叠策略', null, { mode: 'jieba' })
  const auto = tokenize('上下文折叠策略', null, { mode: 'auto' })
  check('mode=jieba 与 auto 结果一致', JSON.stringify(forced) === JSON.stringify(auto))
}

console.log('')
console.log(`通过了 ${pass} 项断言`)
if (fail > 0) {
  console.log(`❌ ${fail} 项失败：`)
  for (const f of failures) console.log('   - ' + f)
  process.exitCode = 1
} else {
  console.log('✅ 通过')
}
