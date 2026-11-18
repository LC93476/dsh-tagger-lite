// plan: Cordis 宿主适配器：logger / 连接配置 / 最小 ctx，插件模式与 standalone 模式共用同一份

/**
 * lib/cordis/adapter.js — 三件「宿主能力」的适配层，两种运行模式共用。
 *
 * 为什么单独一份：index.js 的 createRuntime 只读 ctx.get('llm' | 'webServer' | 'tools')，
 * standalone 需要自己造这些服务，插件模式由 Cordis 给。差别只在「谁提供」——
 * 不该出现两份 ctx、两份端点拼接、两份 logger，所以收敛到这里：
 *
 *   1. createLogger          日志（接宿主 Logger 或直接打 stdout，签名一致）
 *   2. llmSettings           连接配置（baseUrl / apiKey / model / 端点 / 超时，规则只写一遍）
 *   3. createContextAdapter  最小 ctx（get / provide / effect / disposeAll）
 *
 * 硬线：不藏默认值 —— 地址与 key 只来自调用方传进来的那份配置，没配就是 configured:false。
 */

const DEFAULT_LLM_TIMEOUT_MS = 120000

/** @param {unknown} value @returns {string} */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @returns {string} */
function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * @typedef {object} LoggerLike
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/**
 * @typedef {object} LoggerOptions
 * @property {string} [prefix]
 * @property {(level: 'info' | 'warn' | 'error', line: string) => void} [write]
 */

/**
 * 日志适配器：插件模式把宿主的 Logger 直接传进来即可（info / warn / error 同签名）；
 * standalone 用默认实现打到 stdout / stderr。给了 write 就用调用方的落点，前缀由这里拼。
 * @param {LoggerOptions} [options]
 * @returns {LoggerLike & { prefix: string }}
 */
export function createLogger(options = {}) {
  const prefix = str(options.prefix) || '[tagger] '
  const write = typeof options.write === 'function' ? options.write : undefined
  /**
   * @param {'info' | 'warn' | 'error'} level
   * @param {unknown[]} args
   */
  const emit = (level, args) => {
    const text = prefix + args.map(item => (typeof item === 'string' ? item : safeJson(item))).join(' ')
    if (write !== undefined) write(level, text)
    else if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  }
  return {
    prefix,
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  }
}

/** @param {unknown} value @returns {string} 去掉尾部斜杠；空串原样返回（调用方据此判断「没配」）。 */
export function normalizeBaseUrl(value) {
  return str(value).trim().replace(/\/+$/, '')
}

/**
 * 拼接口地址：baseUrl 已经带 /vN 就不再重复拼版本段。
 * chat 与 models 两个端点都从这里出，规则只写一遍。
 * @param {unknown} baseUrl
 * @param {unknown} suffix
 * @param {string} [version]
 * @returns {string}
 */
export function apiUrl(baseUrl, suffix, version = '/v1') {
  const base = normalizeBaseUrl(baseUrl)
  if (base === '') return ''
  const tail = str(suffix)
  return /\/v\d+$/.test(base) ? base + tail : base + version + tail
}

/** @param {unknown} baseUrl @returns {string} POST {baseUrl}/vN/chat/completions */
export function chatCompletionsUrl(baseUrl) {
  return apiUrl(baseUrl, '/chat/completions')
}

/** @param {unknown} baseUrl @returns {string} GET {baseUrl}/vN/models */
export function modelsUrl(baseUrl) {
  return apiUrl(baseUrl, '/models')
}

/** @param {unknown} value @returns {number} 超时钳制在 1s..10min；给不出数字就落默认值。 */
export function clampTimeout(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_LLM_TIMEOUT_MS
  return Math.min(600000, Math.max(1000, n))
}

/**
 * @typedef {object} LlmSettings
 * @property {string} provider
 * @property {string} model
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} endpoint
 * @property {string} modelsEndpoint
 * @property {number} timeoutMs
 * @property {boolean} configured
 */

/**
 * 连接配置适配器：把「一份可能是 settings.json / CLI / 宿主配置」的 llm 段解释成实际连接参数。
 * standalone 的 llm 替身与 /llm/probe 都走这里 —— 谁也不许自己再拼一遍端点。
 * @param {unknown} [raw]
 * @returns {LlmSettings}
 */
export function llmSettings(raw = {}) {
  const source = isRecord(raw) ? raw : {}
  const baseUrl = normalizeBaseUrl(source.baseUrl)
  const apiKey = str(source.apiKey).trim()
  const endpoint = chatCompletionsUrl(baseUrl)
  return {
    provider: str(source.provider).trim() || 'openai-compatible',
    model: str(source.model).trim(),
    baseUrl,
    apiKey,
    endpoint,
    modelsEndpoint: modelsUrl(baseUrl),
    timeoutMs: clampTimeout(source.timeoutMs),
    configured: endpoint !== '' && apiKey !== '',
  }
}

/**
 * @typedef {object} ContextDeps
 * @property {any} [llm]
 * @property {any} [webServer]
 * @property {any} [tools]
 * @property {Record<string, any>} [extra]
 * @property {string} [kind]
 */

/**
 * 最小 ctx 适配器：createRuntime 只读 get()，apply 还会用 effect()。
 *
 * 插件模式下 ctx 由 Cordis 给（不经过这里）；standalone 用这一份。
 * 语义只有两条：服务表（get / provide）与反序卸载（effect 登记、disposeAll 倒着跑）。
 * @param {ContextDeps} [deps]
 */
export function createContextAdapter(deps = {}) {
  const { llm, webServer, tools, extra } = deps
  const kind = str(deps.kind) || 'shim'
  const services = new Map()
  if (llm !== undefined) services.set('llm', llm)
  if (webServer !== undefined) services.set('webServer', webServer)
  if (tools !== undefined) services.set('tools', tools)
  if (isRecord(extra)) {
    for (const [key, value] of Object.entries(extra)) services.set(key, value)
  }
  const disposers = []
  return {
    kind,
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return value
    },
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push({ dispose, label: str(label) })
      return dispose
    },
    async disposeAll() {
      while (disposers.length > 0) {
        const entry = disposers.pop()
        try {
          await entry.dispose()
        } catch {
          // 单个卸载失败不影响其它
        }
      }
    },
  }
}
