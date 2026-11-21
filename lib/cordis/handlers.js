// plan: 路由表入口 —— 实现已按分组拆到 lib/cordis/handlers/，这里只留 createHandlers 的对外导出

/**
 * lib/cordis/handlers.js — 历史入口，保留薄门面。
 *
 * 为什么还留着这一层：宿主插件、测试与文档都按 lib/cordis/handlers.js 找 createHandlers。
 * 实现按分组拆到同目录的 handlers/{system,llm,comfy,poses,refs,tags}.js，导出面与每条路由的
 * 入参 / 响应字段都没变 —— 拆分只决定代码住在哪个文件。
 */
export { createHandlers } from './handlers/index.js'
