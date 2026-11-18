/**
 * backend-common —— comfy.js（HTTP 到 ComfyUI）与 forge.js（宿主 llm 流）共用的通信层。
 *
 * 这两个后端原来各写一套同样的脚手架：各有一份超时计时器、一份 try/catch 翻译、
 * 一份"连不上"文案、一份"模型输出不是 JSON"的修复流程。抽到这里之后：
 *   - 超时与取消统一走 AbortSignal（createDeadline），不再各自 setTimeout + 手动 clear；
 *   - 失败统一成 BackendError（带 code），对外文案走 describeError → 面板与 MCP 读到同一套 code；
 *   - 重试策略只有一处：幂等 GET 遇到 network / 5xx 退避重试一次，POST 不重试；
 *   - JSON 容错（剥围栏、尾逗号、截断补齐）只维护一份。
 *
 * 零依赖：只用 node:http / node:https / node:fs。
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

/** 对外暴露的失败分类。面板与 MCP 只该看到这几种 code。 */
export const ERROR_CODES = ['network', 'timeout', 'bad-request', 'not-found', 'upstream', 'queue-timeout']

const HINTS = {
  network: '没启动或端口不对',
  timeout: '太久没响应（超时）',
  'bad-request': '拒收了这个请求（参数不对）',
  'not-found': '找不到要的东西',
  upstream: '返回了错误',
  'queue-timeout': '排队等太久没轮上',
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH',
  'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT',
])
const NETWORK_TEXT = /socket hang up|connect ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network error|other side closed|socket disconnected/i
const TIMEOUT_TEXT = /超时|timeout|ETIMEDOUT/i
const CANCEL_TEXT = /已取消|cancelled|canceled|aborted/i

export class BackendError extends Error {
  constructor(code, message, extra = {}) {
    super(message === undefined ? String(code) : String(message))
    this.name = 'BackendError'
    this.code = ERROR_CODES.includes(code) ? code : 'upstream'
    if (extra.status !== undefined) this.status = extra.status
    if (extra.url !== undefined) this.url = extra.url
    if (extra.cause !== undefined) this.cause = extra.cause
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function msgOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 取整并 clamp 到 [min,max]，非法值走 fallback。 */
export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 浮点 clamp（不取整），非法值走 fallback。 */
export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 权重等数值转文本：最多两位小数，去掉末尾 0。 */
export function trimNumber(value) {
  const rounded = Math.round(value * 100) / 100
  if (Number.isInteger(rounded)) return String(rounded)
  return String(rounded).replace(/0+$/, '').replace(/\.$/, '')
}

/** 睡眠；signal 已取消时立刻返回（不抛，由调用方判 cancelled）。 */
export function sleep(ms, signal) {
  return new Promise(resolve => {
    let timer = null
    const finish = () => {
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', finish)
      resolve()
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      resolve()
      return
    }
    timer = setTimeout(finish, Math.max(0, ms))
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', finish, { once: true })
  })
}

/** reject 一个 code='aborted' 的 Error；与流式读取的 next() 赛跑用。 */
export function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted === true) {
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
      return
    }
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
    }, { once: true })
  })
}

/**
 * 一次性超时/取消信号：到点 abort，外层 signal 取消也 abort。
 * timedOut / cancelled 区分"谁动的手"，方便上层选错误码（timeout vs 用户取消）。
 */
export function createDeadline(timeoutMs, outerSignal) {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(0, timeoutMs))
  const onOuter = () => {
    cancelled = true
    controller.abort()
  }
  if (outerSignal !== undefined && outerSignal !== null) {
    if (outerSignal.aborted === true) {
      cancelled = true
      controller.abort()
    } else {
      outerSignal.addEventListener('abort', onOuter, { once: true })
    }
  }
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    get cancelled() { return cancelled },
    dispose() {
      clearTimeout(timer)
      if (outerSignal !== undefined && outerSignal !== null) outerSignal.removeEventListener('abort', onOuter)
    },
  }
}

/** 把任意异常翻成带 code 的 BackendError。 */
export function normalizeError(error, extra = {}) {
  if (error instanceof BackendError) return error
  const message = msgOf(error)
  const code = isRecord(error) ? String(error.code ?? '') : ''
  const status = extra.status ?? (isRecord(error) ? error.status : undefined)
  const opts = { url: extra.url, status, cause: error }
  if (CANCEL_TEXT.test(message) === true) return new BackendError('network', message === '' ? '请求被取消' : message, opts)
  if (code === 'ETIMEDOUT' || TIMEOUT_TEXT.test(message) === true) return new BackendError('timeout', message === '' ? '请求超时' : message, opts)
  if (NETWORK_CODES.has(code) === true || NETWORK_TEXT.test(message) === true) return new BackendError('network', message, opts)
  if (status === 400 || status === 422) return new BackendError('bad-request', message, opts)
  if (status === 404) return new BackendError('not-found', message, opts)
  return new BackendError('upstream', message, opts)
}

/**
 * 面向人的一句话：谁 + 为什么 + code + 在哪（+ 原始 message）。
 * 例：ComfyUI 没启动或端口不对（network）：http://127.0.0.1:8188。connect ECONNREFUSED
 */
export function describeError(error, { scope = '后端', target = '' } = {}) {
  const err = normalizeError(error)
  const hint = HINTS[err.code] ?? HINTS.upstream
  const at = target === '' ? '' : '：' + target
  const tail = err.message === '' ? '' : '。' + err.message
  return scope + ' ' + hint + '（' + err.code + '）' + at + tail
}

/** 单次 HTTP 往返，收全 Buffer。不做重试，重试在 request()。 */
function send(target, { method, body, headers, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(target)
    } catch (error) {
      reject(new BackendError('bad-request', 'URL 不合法：' + target, { url: target, cause: error }))
      return
    }
    const lib = url.protocol === 'https:' ? https : http
    const jsonBody = body !== undefined && body !== null && typeof body === 'object' && Buffer.isBuffer(body) === false
    const payload = body === undefined || body === null
      ? null
      : (Buffer.isBuffer(body) ? body : Buffer.from(jsonBody ? JSON.stringify(body) : String(body)))
    const finalHeaders = { ...(headers ?? {}) }
    if (jsonBody) {
      const hasType = Object.keys(finalHeaders).some(key => key.toLowerCase() === 'content-type')
      if (hasType === false) finalHeaders['Content-Type'] = 'application/json; charset=utf-8'
    }
    if (payload !== null) {
      const hasLength = Object.keys(finalHeaders).some(key => key.toLowerCase() === 'content-length')
      if (hasLength === false) finalHeaders['Content-Length'] = String(payload.length)
    }
    let settled = false
    let timer = null
    let req = null
    const done = (fn, value) => {
      if (settled === true) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      const err = new BackendError('network', '请求已取消：' + method + ' ' + target, { url: target })
      if (req !== null) req.destroy(err)
      done(reject, err)
    }
    timer = setTimeout(() => {
      const err = new BackendError('timeout', '请求超时（' + timeoutMs + 'ms）：' + method + ' ' + target, { url: target })
      if (req !== null) req.destroy(err)
      done(reject, err)
    }, Math.max(1, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : url.port,
        path: url.pathname + url.search,
        method,
        headers: finalHeaders,
        agent: false,
      }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          done(resolve, { status: res.statusCode ?? 0, headers: res.headers, buffer: Buffer.concat(chunks), url: target })
        })
        res.on('error', error => done(reject, normalizeError(error, { url: target })))
      })
    } catch (error) {
      done(reject, normalizeError(error, { url: target }))
      return
    }
    req.on('error', error => done(reject, normalizeError(error, { url: target })))
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/**
 * HTTP 请求（带重试）：幂等 GET 遇到 network 失败或 5xx 退避重试，默认 1 次；POST 不重试。
 * 返回 {status, headers, buffer, url}。非 2xx 不抛，由调用方判 status（保住各自的错误文案）。
 */
export async function request(target, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'HEAD'
  const attempts = 1 + Math.max(0, clampInt(options.retries, 0, 5, idempotent ? 1 : 0))
  const delay = clampInt(options.retryDelayMs, 0, 30000, 150)
  const timeoutMs = clampInt(options.timeoutMs, 1, 600000, 15000)
  const logger = options.logger
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await send(target, { method, body: options.body, headers: options.headers, timeoutMs, signal: options.signal })
      if (res.status >= 500 && attempt + 1 < attempts) {
        last = new BackendError('upstream', method + ' ' + target + ' 返回 HTTP ' + res.status, { status: res.status, url: target })
      } else {
        return res
      }
    } catch (error) {
      last = normalizeError(error, { url: target })
      if (last.code !== 'network' || attempt + 1 >= attempts) throw last
    }
    if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
      logger.warn('重试 ' + method + ' ' + target + '：' + last.message)
    }
    await sleep(delay, options.signal)
  }
  throw last ?? new BackendError('network', method + ' ' + target + ' 没有响应', { url: target })
}

/** request + 把响应体当 JSON 解析（坏 JSON → data 为 null）。 */
export async function httpJson(target, options = {}) {
  const res = await request(target, options)
  return { status: res.status, headers: res.headers, buffer: res.buffer, url: res.url, data: parseJson(res.buffer) }
}

/** 容错 JSON.parse：空/坏 → null。 */
export function parseJson(raw) {
  if (raw === undefined || raw === null) return null
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** 响应体预览：压空白 + 截断，用于错误文案。 */
export function bodyPreview(raw, limit = 300) {
  if (raw === undefined || raw === null) return ''
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** 读一个 JSON 文件：io 失败与 JSON 坏分开报，调用方各自套文案。 */
export function readJsonFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, kind: 'io', error: msgOf(error) }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, kind: 'json', error: 'JSON 解析失败：' + msgOf(error) }
  }
}

export function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64')
}

/** data-url / 裸 base64 / Buffer 统一转 Buffer；空输入 → 空 Buffer。 */
export function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  const text = String(data ?? '').replace(/^data:[^,]*,/, '').trim()
  if (text === '') return Buffer.alloc(0)
  return Buffer.from(text, 'base64')
}

/**
 * 轮询到 shouldStop 为真或超时。先立刻跑一次，再判超时（保证至少一次结果）。
 * 返回 {ok, last, polls, waitedMs, timedOut, cancelled}；ok 表示"被 shouldStop 认可"。
 * @param {{ fn?: () => any, timeoutMs?: number, intervalMs?: number, shouldStop?: (last?: any) => boolean, signal?: AbortSignal }} [options]
 */
export async function pollUntil({ fn, timeoutMs = 30000, intervalMs = 1000, shouldStop, signal } = {}) {
  const started = Date.now()
  const stop = typeof shouldStop === 'function' ? shouldStop : () => false
  const interval = Math.max(0, intervalMs)
  const limit = Math.max(0, timeoutMs)
  let last
  let polls = 0
  for (;;) {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, last, polls, waitedMs: Date.now() - started, timedOut: false, cancelled: true }
    }
    last = await fn()
    polls += 1
    if (stop(last) === true) {
      return { ok: true, last, polls, waitedMs: Date.now() - started, timedOut: false, cancelled: false }
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, last, polls, waitedMs: Date.now() - started, timedOut: false, cancelled: true }
    }
    if (Date.now() - started + interval >= limit) {
      return { ok: false, last, polls, waitedMs: Date.now() - started, timedOut: true, cancelled: false }
    }
    await sleep(interval, signal)
  }
}

/* ── 模型输出 → JSON 的容错族（原 forge.js 内私有，两个后端共用一份） ───────── */

function extractFenced(raw) {
  const source = String(raw ?? '').trim()
  if (source === '') return { text: source, repaired: false }
  const fence = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  if (fence !== null) {
    const inner = fence[1].trim()
    if (inner !== '') return { text: inner, repaired: true }
  }
  const stripped = source.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim()
  if (stripped !== source) return { text: stripped, repaired: true }
  return { text: source, repaired: false }
}

function firstBrace(text) {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (objStart >= 0 && arrStart >= 0) return Math.min(objStart, arrStart)
  return Math.max(objStart, arrStart)
}

function trimToLastJson(text) {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end < 0) return text
  return text.slice(0, end + 1)
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: msgOf(error) }
  }
}

/** 补齐没闭合的引号 / 括号（模型偶尔被截断）。 */
function closeUnbalanced(input) {
  const stack = []
  let inString = false
  let escape = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '['
      if (stack.length > 0 && stack[stack.length - 1] === want) stack.pop()
    }
  }
  let out = input
  if (inString) out += '"'
  out = out.replace(/,\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']'
  return out
}

/** 结构性修复：注释、尾逗号、单引号、裸键、控制字符、截断。 */
function repairJsonText(input) {
  let text = String(input ?? '')
  text = text.replace(/^\uFEFF/, '')
  text = text.replace(/\/\*[\s\S]*?\*\//g, '')
  text = text.replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  text = text.replace(/,\s*([}\]])/g, '$1')
  text = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
  text = text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
  return closeUnbalanced(text)
}

/**
 * 解析模型输出：剥围栏 → 直解 → 去前后废话 → 结构性修复一次 → 仍失败返回 {value:undefined}。
 * repaired 表示"不是原样 JSON.parse 成功的"（剥围栏也算）。
 */
export function parseJsonText(raw) {
  const fenced = extractFenced(raw)
  const source = fenced.text
  if (source === '') return { value: undefined, repaired: fenced.repaired, error: '输出为空' }

  const direct = tryParse(source)
  if (direct.ok === true) return { value: direct.value, repaired: fenced.repaired, error: undefined }

  const start = firstBrace(source)
  const fromBrace = start > 0 ? source.slice(start) : source
  const trimmed = trimToLastJson(fromBrace)
  const candidates = []
  for (const candidate of [fromBrace, trimmed]) {
    if (candidate !== '' && candidates.includes(candidate) === false) candidates.push(candidate)
  }
  for (const candidate of candidates) {
    const hit = tryParse(candidate)
    if (hit.ok === true) return { value: hit.value, repaired: true, error: undefined }
  }
  let message = direct.message
  for (const candidate of candidates) {
    const hit = tryParse(repairJsonText(candidate))
    if (hit.ok === true) return { value: hit.value, repaired: true, error: undefined }
    message = hit.message
  }
  return { value: undefined, repaired: true, error: message }
}
