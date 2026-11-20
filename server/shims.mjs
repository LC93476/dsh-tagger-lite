// plan: Cordis 生命周期门面 —— 只留 ctx 装配与卸载，传输层实现已搬去 lib/cordis/host.js

/**
 * server/shims.mjs — 独立入口与 DSH 之间的唯一垫片，只管「生命周期」。
 *
 * 为什么只剩这么点：宿主替身（llm / webServer）是传输实现，2.4 起集中到
 * lib/cordis/host.js 维护；服务表装配与配置读写收拢到 lib/spi.js。这里保留稳定门面，
 * server/standalone.mjs 与 tests/shim.test.mjs 的 import 一行都不用改。
 *
 * 搬运对照（旧位置 → 新位置），每段都是整段搬、函数体未改：
 *   llm 替身（SSE 逐行解析 / 非流式兜底 / 端点拼装）  → lib/cordis/host.js: createLlmShim
 *   webServer 替身（前缀路由表 / listen / close）      → lib/cordis/host.js: createWebServerShim
 *   flattenMessages                                   → lib/cordis/host.js: flattenMessages
 *   baseUrl 归一与端点拼装                            → lib/cordis/adapter.js: normalizeBaseUrl / apiUrl
 *   服务表装配（rt 的 llm/comfy/tags/forge/... 进 ctx） → lib/spi.js: servicesOf / bindServices
 *   配置读取与落盘（configView / persistPatch）        → lib/spi.js: readConfig / saveConfig
 */

import { createContextAdapter } from '../lib/cordis/adapter.js'

// 传输层原样再导出：导出名、签名、返回形状一律不变，调用方无感。
export {
  chatCompletionsUrl,
  createLlmShim,
  createWebServerShim,
  flattenMessages,
  modelsUrl,
  normalizeBaseUrl,
} from '../lib/cordis/host.js'

/**
 * @typedef {object} ContextServices
 * @property {any} [llm]
 * @property {any} [webServer]
 * @property {Record<string, any>} [extra]
 */

/**
 * 最小 ctx：createRuntime 只要 get()，收尾还要 effect() / disposeAll()。
 * 服务表与「反序卸载」的生命周期语义在 lib/cordis/adapter.js。
 * @param {ContextServices} [deps]
 */
export function createContext(deps = {}) {
  return createContextAdapter(deps)
}
