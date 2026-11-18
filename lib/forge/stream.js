// plan: llm 流读取 —— 拼 text-delta、合并 usage、AbortController + timeoutMs 兜底、finish 失败翻译。
import { isRecord, mergeUsage } from './util.js'

/**
 * 拉一次 llm.stream：拼 text-delta，abortController + timeoutMs 兜底，
 * finish kind=error 时把 failure.code 当 error。
 */
export async function collect(streamFn, options) {
  const controller = new AbortController()
  const parts = []
  const usage = {}
  let failure
  let timedOut = false
  let cancelled = false
  let truncated = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onOuterAbort = () => {
    cancelled = true
    controller.abort()
  }
  if (options.signal !== undefined && options.signal !== null) {
    if (options.signal.aborted === true) {
      clearTimeout(timer)
      return { text: '', error: 'aborted', message: '已取消。' }
    }
    options.signal.addEventListener('abort', onOuterAbort, { once: true })
  }

  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      const error = /** @type {Error & { code?: string }} */ (new Error('aborted'))
      error.code = 'aborted'
      reject(error)
    }, { once: true })
  })

  let iterator
  try {
    const iterable = streamFn({
      provider: options.provider,
      model: options.model,
      // 宿主 provider 需要路由会话 id（opencode-go 少这个头会 400 MissingSessionID）
      ...options.sessionId === undefined || options.sessionId === '' ? {} : { sessionId: options.sessionId },
      system: options.system,
      messages: options.messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      signal: controller.signal,
    })
    if (iterable === null || typeof iterable !== 'object') {
      return { text: '', error: 'bad-llm', message: 'llm.stream 没有返回可迭代的流。' }
    }
    iterator = typeof iterable[Symbol.asyncIterator] === 'function'
      ? iterable[Symbol.asyncIterator]()
      : typeof iterable[Symbol.iterator] === 'function' ? iterable[Symbol.iterator]() : undefined
    if (iterator === undefined) return { text: '', error: 'bad-llm', message: 'llm.stream 的返回值不可迭代。' }

    for (;;) {
      const step = await Promise.race([iterator.next(), aborted])
      if (step === null || step === undefined) break
      if (step.done === true) break
      const chunk = step.value
      if (!isRecord(chunk)) continue
      const type = chunk.type
      if (type === 'text-delta') {
        if (typeof chunk.text === 'string' && chunk.text !== '') parts.push(chunk.text)
        continue
      }
      if (type === 'usage') {
        mergeUsage(usage, chunk.usage ?? chunk)
        continue
      }
      if (isRecord(chunk.usage)) mergeUsage(usage, chunk.usage)
      if (type === 'finish') {
        // 宿主两种 finish 形状都要认：{kind, failure} 和 {reason:{kind, failure}}。
        const reason = isRecord(chunk.reason) ? chunk.reason : chunk
        const kind = typeof reason.kind === 'string' ? reason.kind : undefined
        const fail = isRecord(reason.failure) ? reason.failure : isRecord(chunk.failure) ? chunk.failure : undefined
        if (kind === 'error' || kind === 'aborted') failure = fail ?? { code: kind, message: '模型调用失败（' + kind + '）。' }
        else if (kind === 'max-tokens' || kind === 'length') truncated = true
        else if (fail !== undefined) failure = fail
        break
      }
    }
  } catch (error) {
    const coded = /** @type {Error & { code?: string }} */ (error)
    const code = error instanceof Error && typeof coded.code === 'string' ? coded.code : undefined
    if (code === 'aborted') {
      // 超时 / 外部取消都会走到这里，下面统一翻译。
    } else {
      clearTimeout(timer)
      if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
      return {
        text: parts.join(''),
        error: 'llm-error',
        message: error instanceof Error ? error.message : String(error),
        usage,
      }
    }
  } finally {
    clearTimeout(timer)
    if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
    if (iterator !== undefined && typeof iterator.return === 'function' && (timedOut || cancelled)) {
      try {
        await Promise.race([iterator.return(), new Promise(resolve => setTimeout(resolve, 250))])
      } catch {
        // 关流失败不影响结果
      }
    }
  }

  const text = parts.join('')
  if (timedOut) {
    return {
      text,
      error: 'timeout',
      message: '模型超时（' + options.timeoutMs + 'ms）' + (failure?.code ? '：' + failure.code : ''),
      usage,
    }
  }
  if (cancelled) return { text, error: 'aborted', message: '已取消。', usage }
  if (failure !== undefined) {
    return {
      text,
      error: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'llm-error',
      message: typeof failure.message === 'string' && failure.message !== '' ? failure.message : '模型调用失败。',
      usage,
    }
  }
  if (truncated) return { text, error: 'max-tokens', message: '模型输出被 maxTokens 截断（' + options.maxTokens + '）。', usage }
  if (text.trim() === '') return { text, error: 'empty-output', message: '模型没有返回任何内容。', usage }
  return { text, usage }
}
