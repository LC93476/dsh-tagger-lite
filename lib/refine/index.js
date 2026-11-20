// plan: createRefiner 主体 —— 组装 cfg/日志/提示词/套用器，跑一次模型流、归一错误（llm-error/http-400/timeout/bad-json/no-llm/empty-*），挂 SPI 钩子并拼最终结果。
import {
  MODES,
  DEFAULT_MODEL,
  MIN_WEIGHT,
  MAX_WEIGHT,
} from './consts.js'
import {
  isRecord,
  msgOf,
  clampNumber,
  cleanTag,
  tagKey,
  emptyDelta,
  pushWarn,
  toTagList,
  toTagStrings,
  toWeightList,
  dedupeStrings,
  reorderRows,
  parseRefineJson,
  pickNotes,
  mergeUsage,
} from './diff.js'
import {
  makePrompt,
} from './prompt.js'
import {
  makeApply,
} from './apply.js'

/**
 * 二次精修的依赖：配置、宿主 llm、标签索引、日志、SPI 钩子。全可选，缺谁降级谁。
 * @typedef {object} RefinerDeps
 * @property {object} [config] 配置对象（cfg）；缺省当 {}
 * @property {object} [llm] 宿主 llm，需要 stream() 返回异步可迭代流
 * @property {object} [tags] createTagIndex() 的实例
 * @property {object} [logger] 日志器（info/warn/error）
 * @property {object} [spi] 可选 SPI 钩子，缺省不挂
 */

/**
 * 造一个二次精修器。
 * @param {RefinerDeps} [deps] 见 RefinerDeps
 */
export function createRefiner({ config, llm, tags, logger, spi } = {}) {
  const cfg = isRecord(config) ? config : {}
  const log = isRecord(logger) ? logger : { info() {}, warn() {}, error() {} }
  const promptKit = makePrompt({ cfg, tags, log })
  const applyKit = makeApply({ cfg, tags, log, syntaxOf: promptKit.syntaxOf })
  const { syntaxOf, resolveMode, resolveLevel, systemPrompt, normalizeOptions, buildUserPrompt } = promptKit
  const { indexReady, canonicalizeAdd, parseBaseList, formatRows, enrich } = applyKit

  /** 拉一次 llm.stream：拼 text-delta，AbortController + timeoutMs 兜底，finish kind=error 透出 failure.code。 */
  async function collect(streamFn, options) {
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
    // 这个 promise 只喂 Promise.race，没人 await 的 rejection 会变成 unhandledRejection。
    aborted.catch(() => {})

    let iterator
    try {
      const iterable = streamFn({
        provider: options.provider,
        model: options.model,
        ...options.sessionId === undefined || options.sessionId === '' ? {} : { sessionId: options.sessionId },
        system: options.system,
        messages: options.messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
        signal: controller.signal,
      })
      if (iterable === null || typeof iterable !== 'object') {
        clearTimeout(timer)
        return { text: '', error: 'bad-llm', message: 'llm.stream 没有返回可迭代的流。' }
      }
      iterator = typeof iterable[Symbol.asyncIterator] === 'function'
        ? iterable[Symbol.asyncIterator]()
        : typeof iterable[Symbol.iterator] === 'function' ? iterable[Symbol.iterator]() : undefined
      if (iterator === undefined) {
        clearTimeout(timer)
        return { text: '', error: 'bad-llm', message: 'llm.stream 的返回值不可迭代。' }
      }

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
          if (kind === 'error' || kind === 'aborted') {
            failure = fail ?? { code: kind, message: '模型调用失败（' + kind + '）。' }
          } else if (kind === 'max-tokens' || kind === 'length') truncated = true
          else if (fail !== undefined) failure = fail
          break
        }
      }
    } catch (error) {
      const coded = /** @type {Error & { code?: string }} */ (error)
      const code = error instanceof Error && typeof coded.code === 'string' ? coded.code : undefined
      const name = error instanceof Error ? error.name : undefined
      if (timedOut || cancelled || code === 'aborted' || name === 'AbortError') {
        // 超时 / 外部取消 / 底层流自己抛的原生 AbortError（只有 name 没有 code）都走这里，下面统一翻译。
        if (timedOut === false && cancelled === false && failure === undefined) {
          failure = { code: 'aborted', message: '模型流被中断（' + (name ?? 'AbortError') + '）。' }
        }
      } else {
        clearTimeout(timer)
        if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
        return { text: parts.join(''), error: 'llm-error', message: msgOf(error), usage }
      }
    } finally {
      clearTimeout(timer)
      if (options.signal !== undefined && options.signal !== null) options.signal.removeEventListener('abort', onOuterAbort)
      if (iterator !== undefined && typeof iterator.return === 'function' && (timedOut || cancelled)) {
        // 关流最多等 250ms：return() 先完成时要把定时器清掉（不然事件循环白等 250ms）。
        let closeTimer
        try {
          await Promise.race([
            iterator.return(),
            new Promise(resolve => {
              closeTimer = setTimeout(resolve, 250)
              if (typeof closeTimer.unref === 'function') closeTimer.unref()
            }),
          ])
        } catch {
          // 关流失败不影响结果
        } finally {
          if (closeTimer !== undefined) clearTimeout(closeTimer)
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

  /** 一次精修的全部业务逻辑；外面统一兜异常 + SPI 出口。 */
  async function runOnce(request, startedAt) {
    const warnings = []
    const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : ''
    const mode = resolveMode(request.mode)
    const opts = normalizeOptions(request.options, mode)
    const basePositive = typeof request.positive === 'string' ? request.positive.trim() : ''
    const baseNegative = typeof request.negative === 'string' ? request.negative.trim() : ''

    const base = {
      ok: false,
      positive: basePositive,
      negative: baseNegative,
      mode,
      tags: [],
      delta: emptyDelta(),
      ops: 0,
      notes: '',
      ms: 0,
      model: opts.model,
      provider: opts.provider,
      purgeLevel: opts.purgeLevel,
      warnings,
    }
    const fail = (error, message, extra) => ({
      ...base,
      ...extra ?? {},
      ok: false,
      error,
      message,
      ms: Date.now() - startedAt,
      warnings,
    })

    if (instruction === '') return fail('empty-instruction', '写一句想加/想改什么。')
    // add / edit 允许空串起步；prune / weights 没有原串就没有可操作对象。
    if (basePositive === '' && mode !== 'add' && mode !== 'edit') {
      return fail('empty-positive', '先有标签串才能二次精修。')
    }

    const streamFn = llm !== undefined && llm !== null && typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined
    if (streamFn === undefined) {
      return fail('no-llm', '宿主没有 llm 服务，检查 provider 配置（settings.json 里的 llm.provider / llm.model）。')
    }

    const payload = { positive: basePositive, negative: baseNegative, instruction, mode, options: opts.raw }
    if (spi !== undefined && spi !== null && typeof spi.emit === 'function') {
      try {
        await spi.emit('beforeRefine', payload, { mode })
      } catch (error) {
        log.warn('[tagger] beforeRefine 钩子失败（已忽略）：' + msgOf(error))
      }
    }
    const positiveText = typeof payload.positive === 'string' ? payload.positive.trim() : basePositive
    const instructionText = typeof payload.instruction === 'string' && payload.instruction.trim() !== '' ? payload.instruction.trim() : instruction
    // 钩子可能改 negative：后面 prompt 与结果都用读回来的这份，别再用入参。
    const negativeText = typeof payload.negative === 'string' ? payload.negative.trim() : baseNegative

    const baseRows = parseBaseList(positiveText)
    const baseKeys = new Map()
    for (const row of baseRows) {
      const key = tagKey(row.tag)
      if (key !== '' && baseKeys.has(key) === false) baseKeys.set(key, row)
    }

    const collected = await collect(streamFn, {
      provider: opts.provider,
      model: opts.model,
      sessionId: opts.sessionId,
      system: systemPrompt(opts.purgeLevel),
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: buildUserPrompt({ positiveText, negativeText, instruction: instructionText, mode, opts }) }],
      }],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      signal: request.signal,
    })

    const usage = collected.usage !== undefined && Object.keys(collected.usage).length > 0 ? collected.usage : undefined
    if (collected.error !== undefined) {
      log.warn('[tagger] refine 模型调用失败（' + collected.error + '）：' + (collected.message ?? ''))
      return fail(collected.error, collected.message ?? '模型调用失败。', {
        raw: collected.text,
        ...usage === undefined ? {} : { usage },
      })
    }

    const raw = collected.text
    const parsed = parseRefineJson(raw)
    if (parsed.value === undefined) {
      log.warn('[tagger] refine JSON 修复后仍失败：' + (parsed.error ?? 'unknown'))
      return fail('bad-json', '模型没给出可解析的 JSON（已尝试修复一次）：' + (parsed.error ?? ''), {
        raw,
        repaired: true,
        ...usage === undefined ? {} : { usage },
      })
    }
    const diff = isRecord(parsed.value) ? parsed.value : undefined
    if (diff === undefined) {
      return fail('bad-json', '模型给的 JSON 不是对象（要 {"add":[],"remove":[],"weights":[]}）。', {
        raw,
        repaired: parsed.repaired,
        ...usage === undefined ? {} : { usage },
      })
    }

    const rawAdd = toTagList(diff.add)
    const rawRemove = toTagStrings(diff.remove)
    const rawWeights = toWeightList(diff.weights)

    if ((mode === 'prune' || mode === 'weights') && rawAdd.length > 0) {
      pushWarn(warnings, mode + ' 模式不新增，已忽略 ' + rawAdd.length + ' 条 add')
    }
    if ((mode === 'add' || mode === 'weights') && rawRemove.length > 0) {
      pushWarn(warnings, mode + ' 模式不删标签，已忽略 ' + rawRemove.length + ' 条 remove')
    }
    if ((mode === 'add' || mode === 'prune') && rawWeights.length > 0) {
      pushWarn(warnings, mode + ' 模式不改权重，已忽略 ' + rawWeights.length + ' 条 weights')
    }

    // 1) remove：只删原串里真有的
    const removedRows = []
    const removedKeys = new Set()
    if (mode === 'edit' || mode === 'prune') {
      for (const raw of dedupeStrings(rawRemove)) {
        const key = tagKey(raw)
        const hit = baseKeys.get(key)
        if (hit === undefined || removedKeys.has(key)) {
          pushWarn(warnings, '要删的 ' + cleanTag(raw) + ' 不在现有串里，已跳过')
          continue
        }
        removedKeys.add(key)
        removedRows.push(hit)
      }
    }

    // 2) add：必须过标签库；库里没有的一律丢弃
    const addedRows = []
    if (mode === 'add' || mode === 'edit') {
      const wanted = []
      const takenKeys = new Set(baseKeys.keys())
      for (const entry of rawAdd) {
        const text = cleanTag(entry.tag)
        const key = tagKey(text)
        if (key === '' || takenKeys.has(key)) continue
        takenKeys.add(key)
        // add 条目自带的显式权重留着（之后被标签库校对过的权重才是兜底），别在清洗里丢掉。
        wanted.push({ raw: text, key, weight: entry.weight })
      }
      if (wanted.length > 0) {
        const canonRows = await canonicalizeAdd(wanted.map(item => item.raw), warnings)
        for (let i = 0; i < wanted.length; i += 1) {
          const hit = isRecord(canonRows[i]) ? canonRows[i] : undefined
          const rawText = wanted[i].raw
          const wantedWeight = wanted[i].weight
          if (hit === undefined) continue
          if (hit.matched === false) {
            pushWarn(warnings, rawText + ' 不在库里，已丢弃')
            continue
          }
          const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? hit.tag.trim() : rawText
          const key = tagKey(tag)
          if (key === '' || baseKeys.has(key) || addedRows.some(row => tagKey(row.tag) === key)) continue
          addedRows.push({
            tag,
            // 模型给 add 写了显式权重（'(smile:1.2)' / {tag,weight}）就用它，其次标签库，最后 1。
            weight: clampNumber(wantedWeight ?? hit.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1),
            cn: typeof hit.cn === 'string' ? hit.cn : '',
            ...typeof hit.kind === 'string' ? { kind: hit.kind } : {},
          })
        }
      }
      if (addedRows.length > opts.maxNewTags) {
        pushWarn(warnings, '新增 ' + addedRows.length + ' 条超过上限 maxNewTags(' + opts.maxNewTags + ')，已截到 ' + opts.maxNewTags + ' 条')
        addedRows.length = opts.maxNewTags
      }
    }

    // 3) weights：只调原串（或本次新增）里真有的
    const weightedRows = []
    if (mode === 'edit' || mode === 'weights') {
      const touched = new Set()
      for (const item of rawWeights) {
        const key = tagKey(item.tag)
        if (key === '' || touched.has(key)) continue
        // 同一个词既在 remove 又在 weights：以删除为准，别往 delta.weighted 里塞一个已经不在的标签。
        if (removedKeys.has(key)) continue
        const target = baseKeys.get(key) ?? addedRows.find(row => tagKey(row.tag) === key)
        if (target === undefined) {
          pushWarn(warnings, '要调权重的 ' + cleanTag(item.tag) + ' 不在现有串里，已跳过')
          continue
        }
        const from = clampNumber(target.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1)
        const to = clampNumber(item.weight, MIN_WEIGHT, MAX_WEIGHT, from)
        if (Math.abs(to - from) < 0.005) continue
        touched.add(key)
        target.weight = to
        weightedRows.push({ tag: target.tag, from, to })
      }
    }

    // 4) 装配：keepOrder 时原有顺序一字不动，新标签追加到尾部
    let rows = []
    for (const row of baseRows) {
      if (removedKeys.has(tagKey(row.tag))) continue
      rows.push({ tag: row.tag, weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1) })
    }
    for (const row of addedRows) {
      if (removedKeys.has(tagKey(row.tag))) continue
      rows.push({ tag: row.tag, weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1), cn: row.cn })
    }
    if (opts.keepOrder === false) {
      const order = dedupeStrings(toTagStrings(diff.order))
      if (order.length > 0) rows = reorderRows(rows, order)
    }
    await enrich(rows)

    const resultTags = rows.map(row => ({
      tag: row.tag,
      weight: clampNumber(row.weight ?? 1, MIN_WEIGHT, MAX_WEIGHT, 1),
      cn: typeof row.cn === 'string' ? row.cn : '',
      ...typeof row.kind === 'string' ? { kind: row.kind } : {},
    }))
    const positive = formatRows(resultTags, opts.syntax)
    const delta = {
      added: addedRows.map(row => row.tag),
      removed: removedRows.map(row => row.tag),
      weighted: weightedRows.map(row => ({ tag: row.tag, from: row.from, to: row.to })),
    }
    const ops = delta.added.length + delta.removed.length + delta.weighted.length

    log.info('[tagger] refine ' + mode + '：+' + delta.added.length + ' -' + delta.removed.length
      + ' ~' + delta.weighted.length + '，' + (Date.now() - startedAt) + 'ms')

    return {
      ok: true,
      positive,
      negative: negativeText,
      mode,
      tags: resultTags,
      delta,
      ops,
      notes: pickNotes(diff) ?? '',
      ms: Date.now() - startedAt,
      model: opts.model,
      provider: opts.provider,
      purgeLevel: opts.purgeLevel,
      raw,
      repaired: parsed.repaired,
      warnings,
      ...usage === undefined ? {} : { usage },
    }
  }

  /** 兜底结果：连 runOnce 都炸了也要给调用方一个形状完整的结果。 */
  function crashResult(request, startedAt, error) {
    const mode = resolveMode(request?.mode)
    return {
      ok: false,
      error: 'internal',
      message: '精修过程抛错（已兜住）：' + msgOf(error),
      mode,
      positive: typeof request?.positive === 'string' ? request.positive.trim() : '',
      negative: typeof request?.negative === 'string' ? request.negative.trim() : '',
      tags: [],
      delta: emptyDelta(),
      ops: 0,
      notes: '',
      ms: Date.now() - startedAt,
      model: typeof cfg.llm?.model === 'string' ? cfg.llm.model : DEFAULT_MODEL,
      purgeLevel: resolveLevel(),
      warnings: [],
    }
  }

  return {
    modes: MODES.slice(),

    async refine(input) {
      const startedAt = Date.now()
      const request = isRecord(input) ? input : {}
      let result
      try {
        result = await runOnce({ ...request, signal: request.signal }, startedAt)
      } catch (error) {
        log.warn('[tagger] refine 内部异常：' + msgOf(error))
        result = crashResult(request, startedAt, error)
      }

      // 成功的整串结果先过 postProcessors（外部可以改格式 / 追加字段）
      if (result.ok === true && spi !== undefined && spi !== null && typeof spi.applyPostProcessors === 'function') {
        try {
          const next = await spi.applyPostProcessors(result, { mode: result.mode, phase: 'refine' })
          if (isRecord(next)) result = next
        } catch (error) {
          log.warn('[tagger] refine postProcessors 失败（已忽略）：' + msgOf(error))
        }
      }
      // 出口钩子：成功失败都通知，方便外部记账
      if (spi !== undefined && spi !== null && typeof spi.emit === 'function') {
        try {
          await spi.emit('afterRefine', result, { mode: result.mode, ok: result.ok === true })
        } catch (error) {
          log.warn('[tagger] afterRefine 钩子失败（已忽略）：' + msgOf(error))
        }
      }
      return result
    },
  }
}

