/**
 * 阶段 3：apply() 集成测试（mock ctx）。
 *
 * 验证：通道注册、工具注册、RPC 路由、召回刷新全链路。
 *
 *   node test/smoke-stage3.mjs
 */

import { apply } from '../index.js'

/** 记录所有注册动作的 mock ctx。 */
function makeCtx() {
  const record = {
    sections: [],
    contexts: [],
    tools: [],
    routes: [],
    events: [],
    provided: {},
  }

  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    systemPrompt: {
      section: (options) => record.sections.push(options),
      context: (options) => record.contexts.push(options),
    },
    effect: (factory) => {
      const result = factory()
      // effect 约定：返回 disposer；工具数组不是 disposer，但要执行以完成注册
      return result
    },
    inject: (deps, fn) => {
      if (!deps.includes('tools')) return
      // 模拟 child context
      const child = {
        effect: (factory) => factory(),
        tools: {
          register: (tool) => {
            record.tools.push(tool)
            return () => {}
          },
        },
      }
      fn(child)
    },
    on: (event, handler) => record.events.push(event),
    provide: (key, value) => {
      record.provided[key] = value
    },
    get: (key) => (key === 'webServer' ? {
      register: (route) => {
        record.routes.push(route)
        return () => {}
      },
    } : undefined),
  }

  return { ctx, record }
}

const { ctx, record } = makeCtx()

const config = {
  embedding: { enabled: false },
  dataDir: 'C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/dev-plugins/dsh-vcprag/test/.tmp-stage3',
}

apply(ctx, config)

console.log('=== 通道注册 ===')
console.log('sections:', record.sections.map((s) => `${s.name}(order=${s.order})`).join(', ') || '(none)')
console.log('contexts:', record.contexts.map((s) => `${s.name}(order=${s.order})`).join(', ') || '(none)')

console.log('\n=== section 文本渲染（通道 1：runtime 常驻）===')
const runtimeSection = record.sections.find((s) => s.name === 'vcprag:runtime')
if (runtimeSection) {
  const text = typeof runtimeSection.text === 'function' ? runtimeSection.text({}) : runtimeSection.text
  console.log('长度:', text.length, '字符')
  console.log('--- 前 700 字 ---')
  console.log(text.slice(0, 700))
  console.log('---')
  // 关键验证：连续两次调用必须字节相同（缓存安全）
  const again = typeof runtimeSection.text === 'function' ? runtimeSection.text({}) : runtimeSection.text
  console.log('两次渲染完全一致（缓存安全）:', text === again)
} else {
  console.log('!! 未注册 runtime section')
}

console.log('\n=== 工具注册 ===')
console.log('数量:', record.tools.length)
for (const tool of record.tools) {
  const params = Object.keys(tool.parameters?.properties ?? {})
  console.log(`  ${tool.name}(${params.join(', ')})`)
}

console.log('\n=== RPC 路由 ===')
console.log('数量:', record.routes.length)
for (const route of record.routes) console.log(' ', route.path)

console.log('\n=== 事件订阅 ===')
console.log('events:', record.events.join(', ') || '(none)')

console.log('\n=== 提供的服务 ===')
console.log('keys:', Object.keys(record.provided))
const svc = record.provided.vcprag
console.log('svc 成员:', svc ? Object.keys(svc) : '(none)')

// ---- 等索引加载完成后再测召回 ----
if (svc) {
  await new Promise((resolve) => setTimeout(resolve, 800))

  // 注：召回不再由外部 `maybeRefresh` 推动，而是挂在
  // `system-prompt/assemble` waterfall 上自取。所以这里只验证：
  //   1) 占位 context 已注册且初始为空
  //   2) svc 上有可用的召回入口（runRecall）
  // 真正的「事件驱动 → 非空注入」链路由 test/smoke-recall-inject.mjs 覆盖
  // （它搭了完整的 assemble + waterfall 流水线）。
  console.log('\n=== 通道 3：召回 context 占位 ===')
  const contextEntry = record.contexts.find((s) => s.name === 'vcprag:recall')
  if (contextEntry) {
    const text = typeof contextEntry.text === 'function' ? contextEntry.text({}) : contextEntry.text
    console.log('初始渲染长度:', text.length, '（占位空串，真正内容由 waterfall 回填）')
  } else {
    console.log('!! 未注册召回 context')
  }

  console.log('svc.runRecall 可用:', typeof svc.runRecall === 'function')
  console.log('svc 上已移除 maybeRefresh:', svc.maybeRefresh === undefined)

  console.log('\n=== 工具实测：vcprag_status ===')
  const statusTool = record.tools.find((t) => t.name === 'vcprag_status')
  if (statusTool) {
    console.log(await statusTool.execute({}))
  }

  console.log('\n=== 工具实测：vcprag_list ===')
  const listTool = record.tools.find((t) => t.name === 'vcprag_list')
  if (listTool) {
    console.log((await listTool.execute({ limit: 5 })).slice(0, 900))
  }

  console.log('\n=== 工具实测：vcprag_search ===')
  const searchTool = record.tools.find((t) => t.name === 'vcprag_search')
  if (searchTool) {
    console.log((await searchTool.execute({ query: 'comfyui 工作流', limit: 2 })).slice(0, 700))
  }
}
