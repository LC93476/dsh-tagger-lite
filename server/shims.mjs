// plan: 独立运行所需的最小宿主替身（llm / webServer / tools / ctx），不依赖 DSH 进程
/**
 * server/shims.mjs — 三件宿主替身 + 一个最小 ctx，让 lib/ 的核心在纯 node 里跑起来。
 *
 * 契约来源：index.js 的 createRuntime 只读 ctx.get('llm' | 'webServer' | 'tools')，
 * forge 调 llm.stream(...)，apply 调 webServer.register({ kind:'prefix', path, handler })，
 * handler 就是 (req, res) => Promise。形状对上，锻造 / 精修 / 标签 / ComfyUI / MCP 全都不用改。
 *
 * 两条硬线：
 *   1. 不偷偷联网：没 apiKey 或 baseUrl 时 llm.configured=false，stream 立刻回 no-llm。
 *   2. 不猜配置：地址、key、模型全部由调用方（CLI / 环境变量）传进来，这里没有默认值。
 */
import http from 'node:http'
import {
  chatCompletionsUrl,
  createContextAdapter,
  llmSettings,
  modelsUrl,
  normalizeBaseUrl,
} from '../lib/cordis/adapter.js'

const NO_LLM_HINT = '给 --base-url 与 --api-key（或设 DSH_TAGGER_BASE_URL / DSH_TAGGER_API_KEY）'
// 这些状态码多半是「服务端不认 stream:true」，退回非流式再试一次（只退一次）。
const RETRYABLE_STATUS = new Set([400, 404, 405, 415, 422, 501])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function finish(kind, failure) {
  return failure === undefined ? { type: 'finish', kind } : { type: 'finish', kind, failure }
}

// 端点拼接与超时收敛只有一份实现（lib/cordis/adapter.js）：这里按原名字转出，导出面不变。
export { chatCompletionsUrl, modelsUrl, normalizeBaseUrl }

/** 宿主的 messages 允许 [{type:'text',text}] 这种分段；OpenAI 兼容接口只认纯字符串。 */
export function flattenMessages(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message)) continue
    const role = str(message.role).trim() || 'user'
    const raw = message.content
    let content
    if (Array.isArray(raw)) content = raw.map(part => (typeof part === 'string' ? part : str(part?.text))).join('')
    else if (typeof raw === 'string') content = raw
    else if (raw === undefined || raw === null) content = ''
    else content = JSON.stringify(raw)
    if (content === '') continue
    out.push({ role, content })
  }
  return out
}

/** 统一读响应体：优先 getReader（fetch 的 web stream），退回异步迭代。 */
async function* bodyChunks(body) {
  if (body === null || body === undefined) return
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        if (step.value !== undefined) yield step.value
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // 已经关掉了，无所谓
      }
    }
    return
  }
  if (typeof body[Symbol.asyncIterator] === 'function') yield* body
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ''
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorOf(event) {
  if (!isRecord(event) || !isRecord(event.error)) return undefined
  return {
    code: str(event.error.type) || str(event.error.code) || 'llm-error',
    message: str(event.error.message) || '模型接口返回错误',
  }
}

/**
 * llm 替身：直连 OpenAI 兼容接口（POST {baseUrl}/v1/chat/completions）。
 *
 * 与宿主 llm 服务的形状一致：
 *   stream({ provider, model, system, messages, maxTokens, temperature, signal, stream })
 *     → 异步迭代 { type:'text-delta', index, text } / { type:'reasoning-delta', ... }
 *       / { type:'usage', usage } / { type:'finish', kind, failure? }
 */
export function createLlmShim(options = {}) {
  const logger = options.logger ?? {}
  /**
   * 每次调用现算一遍：面板把 baseUrl / apiKey 写进 settings.json 之后，
   * 下一次锻造就能用上新值，不用重启进程。options.resolve 是覆盖项（CLI / env）。
   */
  function live() {
    const extra = typeof options.resolve === 'function' ? options.resolve() : undefined
    const merged = isRecord(extra) ? { ...options, ...extra } : options
    // endpoint / apiKey / provider / model / timeoutMs / configured 由适配层算，这里不重复拼。
    const settings = llmSettings(merged)
    return {
      ...settings,
      sessionId: str(merged.sessionId).trim() || 'dsh-tagger',
      // 只有 OpenCode 系要这个头；forceSessionHeader 让测试能在本地假服务上验证它。
      sessionHeader: merged.forceSessionHeader === true || str(merged.baseUrl).includes('opencode.ai'),
    }
  }

  /**
   * OpenCode Go 要求每条请求带 x-opencode-session 才肯路由（不带直接 400 MissingSessionID），
   * 宿主里由 pi-ai 的 withOpenCodeSessionHeader 补，独立服务得自己补。
   */
  function headers(streaming, cfg) {
    const out = { 'Content-Type': 'application/json' }
    if (cfg.apiKey !== '') out.Authorization = 'Bearer ' + cfg.apiKey
    out.Accept = streaming === true ? 'text/event-stream' : 'application/json'
    if (cfg.sessionHeader === true) out['x-opencode-session'] = cfg.sessionId
    return out
  }

  function post(payload, signal, cfg) {
    return fetch(cfg.endpoint, {
      method: 'POST',
      headers: headers(payload.stream === true, cfg),
      body: JSON.stringify(payload),
      signal,
    })
  }

  /** 单条 SSE 事件 → chunk；解析不了的行当噪声丢掉，不打断整条流。 */
  function* sseEvent(event, state) {
    if (isRecord(event.usage)) state.usage = event.usage
    const failure = errorOf(event)
    if (failure !== undefined) {
      state.failure = failure
      return
    }
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined
    if (!isRecord(choice)) return
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined
    if (delta !== undefined) {
      const reasoning = str(delta.reasoning_content) || str(delta.reasoning)
      if (reasoning !== '') yield { type: 'reasoning-delta', index: 0, text: reasoning }
      const text = str(delta.content)
      if (text !== '') {
        state.text += text
        yield { type: 'text-delta', index: 0, text }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') state.finishReason = choice.finish_reason
  }

  /** 逐行读 SSE：数据行可能是 data: {...}，也可能是服务端直接吐的 JSON 行。 */
  async function* pumpSse(body, state) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of bodyChunks(body)) {
      buffer += decoder.decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), { stream: true })
      let cut = buffer.search(/\r?\n/)
      while (cut >= 0) {
        const line = buffer.slice(0, cut)
        const width = buffer[cut] === '\r' ? 2 : 1
        buffer = buffer.slice(cut + width)
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') return
          const parsed = tryJson(data)
          if (isRecord(parsed)) yield* sseEvent(parsed, state)
        } else if (trimmed.startsWith('{')) {
          // 少数服务忽略 event-stream 直接吐 JSON 行
          const parsed = tryJson(trimmed)
          if (isRecord(parsed)) yield* sseEvent(parsed, state)
        }
        cut = buffer.search(/\r?\n/)
      }
    }
    // 收尾：最后一段可能没有换行结尾
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data !== '' && data !== '[DONE]') {
        const parsed = tryJson(data)
        if (isRecord(parsed)) yield* sseEvent(parsed, state)
      }
    }
  }

  /** 非流式兜底：整包 JSON 一次吐成一条 text-delta（上层照样能拼）。 */
  async function* pumpJson(response, state) {
    let raw = ''
    try {
      raw = await response.text()
    } catch {
      raw = ''
    }
    const parsed = tryJson(raw)
    if (!isRecord(parsed)) {
      state.failure = { code: 'bad-response', message: '模型接口返回的不是 JSON：' + raw.slice(0, 300) }
      return
    }
    if (isRecord(parsed.usage)) state.usage = parsed.usage
    const failure = errorOf(parsed)
    if (failure !== undefined) {
      state.failure = failure
      return
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
    if (!isRecord(choice)) {
      state.failure = { code: 'bad-response', message: '模型接口的返回里没有 choices：' + raw.slice(0, 300) }
      return
    }
    const message = isRecord(choice.message) ? choice.message : undefined
    const text = message === undefined ? '' : str(message.content)
    if (text !== '') {
      state.text += text
      yield { type: 'text-delta', index: 0, text }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') state.finishReason = choice.finish_reason
  }

  async function* stream(args = {}) {
    const cfg = live()
    if (!cfg.configured) {
      yield finish('error', { code: 'no-llm', message: 'llm shim 没配置模型接口：' + NO_LLM_HINT })
      return
    }
    const messages = []
    const system = str(args.system)
    if (system !== '') messages.push({ role: 'system', content: system })
    messages.push(...flattenMessages(args.messages))
    if (messages.length === 0) {
      yield finish('error', { code: 'bad-request', message: 'llm.stream 需要 messages（或 system）。' })
      return
    }
    const payload = {
      model: str(args.model).trim() || cfg.model,
      messages,
      stream: args.stream !== false,
    }
    if (payload.model === '') {
      yield finish('error', { code: 'no-model', message: '没指定模型：给 --model 或设 DSH_TAGGER_MODEL。' })
      return
    }
    const maxTokens = Number.parseInt(String(args.maxTokens ?? ''), 10)
    if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens
    if (typeof args.temperature === 'number' && Number.isFinite(args.temperature)) payload.temperature = args.temperature
    if (typeof args.topP === 'number' && Number.isFinite(args.topP)) payload.top_p = args.topP

    const controller = new AbortController()
    const outer = args.signal
    const onAbort = () => controller.abort()
    if (outer !== undefined && outer !== null && typeof outer.addEventListener === 'function') {
      if (outer.aborted === true) {
        yield finish('aborted')
        return
      }
      outer.addEventListener('abort', onAbort, { once: true })
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, cfg.timeoutMs)
    const state = { usage: undefined, finishReason: '', text: '', failure: undefined }

    try {
      let response
      let fetchError
      try {
        response = await post(payload, controller.signal, cfg)
      } catch (error) {
        fetchError = error
      }

      // 有的服务直接拒 stream:true：退回非流式一次，别让用户自己猜。
      if (response !== undefined && !response.ok && payload.stream === true && RETRYABLE_STATUS.has(response.status)) {
        const detail = await safeText(response)
        logger.info?.('[tagger] 模型接口不接受流式（' + response.status + '），退回非流式重试一次：' + detail.slice(0, 120))
        payload.stream = false
        try {
          response = await post(payload, controller.signal, cfg)
          fetchError = undefined
        } catch (error) {
          fetchError = error
          response = undefined
        }
      }

      if (fetchError !== undefined) {
        state.failure = controller.signal.aborted
          ? { code: timedOut ? 'timeout' : 'aborted', message: timedOut ? '模型超时（' + cfg.timeoutMs + 'ms）' : '已取消。' }
          : { code: 'llm-error', message: msgOf(fetchError) }
      } else if (response === undefined || !response.ok) {
        const status = response === undefined ? 0 : response.status
        state.failure = { code: 'http-' + status, message: '模型接口返回 ' + status + '：' + (await safeText(response)) }
      } else {
        const contentType = str(response.headers.get('content-type')).toLowerCase()
        if (payload.stream === true && contentType.includes('text/event-stream')) yield* pumpSse(response.body, state)
        else yield* pumpJson(response, state)
      }
    } finally {
      clearTimeout(timer)
      if (outer !== undefined && outer !== null && typeof outer.removeEventListener === 'function') {
        outer.removeEventListener('abort', onAbort)
      }
    }

    if (timedOut) {
      yield finish('error', { code: 'timeout', message: '模型超时（' + cfg.timeoutMs + 'ms）' })
      return
    }
    if (controller.signal.aborted) {
      yield finish('aborted', state.failure)
      return
    }
    if (state.failure !== undefined) {
      yield finish('error', state.failure)
      return
    }
    if (isRecord(state.usage)) yield { type: 'usage', usage: state.usage }
    if (state.finishReason === 'length') yield finish('max-tokens')
    else yield finish('stop')
  }

  /** GET /models：拿不到就回空数组（面板上的模型下拉不至于炸）。 */
  async function listModels() {
    const cfg = live()
    if (!cfg.configured || cfg.modelsEndpoint === '') return []
    try {
      const response = await fetch(cfg.modelsEndpoint, {
        headers: { Authorization: 'Bearer ' + cfg.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 15000)),
      })
      if (!response.ok) return []
      const parsed = tryJson(await response.text())
      const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
      return rows
        .map(row => {
          const id = str(row?.id) || str(row?.name)
          return id === '' ? undefined : { id, label: id }
        })
        .filter(row => row !== undefined)
    } catch {
      return []
    }
  }

  const api = {
    kind: 'shim',
    stream,
    listModels,
    listProviders: async () => [{ id: live().provider, label: live().provider }],
    describe() {
      const cfg = live()
      return {
        kind: 'shim',
        configured: cfg.configured,
        provider: cfg.provider,
        model: cfg.model,
        endpoint: cfg.endpoint,
        baseUrl: cfg.baseUrl,
        timeoutMs: cfg.timeoutMs,
        hint: cfg.configured ? undefined : NO_LLM_HINT,
      }
    },
  }
  // 这几个是「当前生效值」，用 getter 而不是快照：面板改完立刻反映到 /health 上。
  for (const key of ['provider', 'model', 'configured', 'baseUrl', 'endpoint', 'timeoutMs']) {
    Object.defineProperty(api, key, { enumerable: true, get: () => live()[key] })
  }
  Object.defineProperty(api, 'ready', { enumerable: true, get: () => live().configured })
  return api
}

/**
 * @typedef {object} ShimLogger
 * @property {(...args: any[]) => void} [info]
 * @property {(...args: any[]) => void} [warn]
 * @property {(...args: any[]) => void} [error]
 */

/**
 * @typedef {object} WebServerShimOptions
 * @property {string} [host]
 * @property {number} [port]
 * @property {ShimLogger} [logger]
 */

/**
 * webServer 替身：node:http + 一张前缀/精确路由表。
 *
 * 与 DSH 的 webServer 服务同形：register({ kind:'prefix'|'exact', path, handler }) → dispose。
 * 重复注册同 kind + path 会抛错（消息里带 "duplicate prefix route"，与 index.js 的容错分支对得上）。
 */
export function createWebServerShim(options = {}) {
  const { host = '127.0.0.1', port = 0, logger } = options
  /** @type {ShimLogger} */
  const log = logger ?? {}
  const entries = []
  const sockets = new Set()
  let server = null
  let bound = null

  function normalizePath(value) {
    const text = str(value).trim() || '/'
    if (text === '/') return '/'
    return text.replace(/\/+$/, '')
  }

  function matches(entry, pathname) {
    if (entry.kind === 'exact') return pathname === entry.path
    return pathname === entry.path || pathname.startsWith(entry.path + '/')
  }

  function pick(pathname) {
    let best
    for (const entry of entries) {
      if (!matches(entry, pathname)) continue
      if (best === undefined || entry.path.length > best.path.length) best = entry
    }
    return best
  }

  function sendJson(res, status, payload) {
    if (res.headersSent === true) {
      res.end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  /**
   * 原始路径：只切掉 ?query 与 #hash，绝不做 '..' 折叠。
   * 静态资源（/public/*）要靠原始路径判断路径穿越——new URL() 会把 '/public/../index.js'
   * 规范化成 '/index.js'，防护就白做了。
   */
  function rawPathOf(rawUrl) {
    const text = str(rawUrl) || '/'
    const cut = text.search(/[?#]/)
    const kept = cut >= 0 ? text.slice(0, cut) : text
    return kept === '' ? '/' : kept
  }

  async function handle(req, res) {
    const pathname = rawPathOf(req.url)
    const entry = pick(pathname)
    if (entry === undefined) {
      sendJson(res, 404, {
        ok: false,
        error: 'not-found',
        message: '没有这个路径：' + pathname,
        hint: '插件接口在 /tagger/api 下；根路径 / 是 web 版入口。',
      })
      return
    }
    try {
      await entry.handler(req, res)
    } catch (error) {
      log.warn?.('[tagger] ' + pathname + ' 失败：' + msgOf(error))
      if (res.headersSent === true) res.destroy()
      else sendJson(res, 500, { ok: false, error: 'internal', message: msgOf(error) })
    }
  }

  function register(spec = {}) {
    const kind = spec.kind === 'exact' ? 'exact' : 'prefix'
    const routePath = normalizePath(spec.path)
    if (typeof spec.handler !== 'function') throw new Error('register 需要 handler 函数：' + routePath)
    if (entries.some(entry => entry.kind === kind && entry.path === routePath)) {
      throw new Error('duplicate prefix route：' + routePath + '（' + kind + '）')
    }
    const entry = { kind, path: routePath, handler: spec.handler }
    entries.push(entry)
    return () => {
      const index = entries.indexOf(entry)
      if (index >= 0) entries.splice(index, 1)
    }
  }

  function address() {
    const boundHost = bound === null || bound === undefined ? host : bound.address
    const boundPort = bound === null || bound === undefined ? port : bound.port
    return { host: boundHost, port: boundPort, url: 'http://' + boundHost + ':' + boundPort }
  }

  function listen() {
    if (server === null) {
      server = http.createServer((req, res) => {
        handle(req, res)
      })
      server.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      server.on('clientError', (_error, socket) => {
        try {
          socket.destroy()
        } catch {
          // 已经断了
        }
      })
    }
    const current = server
    return new Promise((resolve, reject) => {
      const onError = error => reject(error)
      current.once('error', onError)
      current.listen(port, host, () => {
        current.removeListener('error', onError)
        bound = current.address()
        resolve(address())
      })
    })
  }

  function close() {
    return new Promise(resolve => {
      if (server === null) {
        resolve()
        return
      }
      const current = server
      server = null
      bound = null
      try {
        current.closeIdleConnections?.()
      } catch {
        // 老 node 没有这个方法
      }
      current.close(() => resolve())
      // keep-alive 连接会把 close 吊住：进程本来就要退，直接断开
      for (const socket of [...sockets]) {
        try {
          socket.destroy()
        } catch {
          // 已经断了
        }
      }
      sockets.clear()
      const timer = setTimeout(resolve, 2000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  return {
    kind: 'shim',
    register,
    unregisterAll() {
      entries.length = 0
    },
    routes() {
      return entries.map(entry => ({ kind: entry.kind, path: entry.path }))
    },
    listen,
    close,
    address,
    get listening() {
      return server !== null && server.listening === true
    },
  }
}

/**
 * tools 替身：只记账。
 *
 * standalone 不往宿主注册模型工具（那是 apply 干的事），但 createRuntime / 未来的
 * 扩展代码可能会问 ctx.get('tools')，所以给一个同形的最小实现，register 返回 dispose。
 */
export function createToolsShim() {
  const specs = []
  return {
    kind: 'shim',
    register(spec) {
      if (!isRecord(spec) || typeof spec.name !== 'string' || spec.name === '') {
        throw new Error('tools.register 需要带 name 的工具定义')
      }
      if (specs.some(item => item.name === spec.name)) throw new Error('duplicate tool：' + spec.name)
      specs.push(spec)
      return () => {
        const index = specs.indexOf(spec)
        if (index >= 0) specs.splice(index, 1)
      }
    },
    list() {
      return [...specs]
    },
    names() {
      return specs.map(item => item.name)
    },
  }
}

/**
 * @typedef {object} ContextServices
 * @property {any} [llm]
 * @property {any} [webServer]
 * @property {any} [tools]
 * @property {Record<string, any>} [extra]
 */

/**
 * 最小 ctx：createRuntime 只需要 get()，apply 还会用 effect()。
 * @param {ContextServices} [deps]
 */
export function createContext(deps = {}) {
  // 服务表 + 反序卸载的语义与插件模式共用一份，实现在 lib/cordis/adapter.js。
  return createContextAdapter(deps)
}
