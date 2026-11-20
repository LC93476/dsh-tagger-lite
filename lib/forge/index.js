// plan: 锻造器主体 —— createForge：llm.stream 调用（截断自动翻倍重试）、标签库校对（异步 ready + 词表热重载）、
// 三道本地后处理接线（见 ./pipeline.js）、结果对象拼装、history.json 落盘。
//
// 铁律：generate 永远返回 ForgeResult 对象，不抛。调用方（HTTP / MCP / 面板）只需要看 ok 与 error。
import path from 'node:path'
import {
  PURGE_LEVELS,
  agentDirective as purgeAgentDirective,
  buildForgeSystemPrompt,
  purgeState as purgeStateOf,
} from '../purge.js'
import { selectCandidates } from '../zh-intent.js'
import { createHistoryStore } from './history.js'
import {
  MAX_POSITIVE_HARD_CAP,
  MAX_TOKEN_CEILING,
  cfgForLevel,
  normalizeOptions,
  resolveLevel,
} from './options.js'
import { normalizeEntry, normalizeList, parseForgeJson, pickNotes, pickPositive } from './parse.js'
import { createPipelineRunner, stripQuality } from './pipeline.js'
import { buildUserPrompt, formatEntry } from './prompt.js'
import { collect } from './stream.js'
import { clampNumber, dedupe, fallbackDir, isRecord } from './util.js'

const COLD_INDEX_WARNING = '标签库未就绪，未校对'
const INDEX_WAIT_MS = 3000
const INDEX_WAIT_TIMEOUT = '\u0000index-wait'

/** 同一条提示只记一次：一次锻造里冷索引判定会被问好几遍，别在面板上刷重复行。 */
function pushOnce(warnings, text) {
  if (Array.isArray(warnings) === false) return
  if (warnings.includes(text) === false) warnings.push(text)
}

/**
 * 等索引就绪的计时器。返回 { promise, cancel }：Promise.race 结束后必须 cancel()，
 * 否则每次锻造都留一个 3s 的 setTimeout 挂在事件循环里（unref 过也不该攒着）。
 */
function indexWait() {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const promise = new Promise(resolve => {
    timer = setTimeout(() => resolve(INDEX_WAIT_TIMEOUT), INDEX_WAIT_MS)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  })
  const cancel = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  return { promise, cancel }
}

/**
 * @param {{ config?: object, llm?: object, tags?: object, logger?: object, dir?: string }} deps
 */
export function createForge({ config, llm, tags, logger, dir } = {}) {
  const cfg = isRecord(config) ? config : {}
  const log = isRecord(logger) ? logger : { info() {}, warn() {}, error() {} }
  const dataDir = typeof dir === 'string' && dir !== '' ? dir : fallbackDir()
  const historyFile = path.join(dataDir, 'history.json')

  const promptCache = new Map()
  const historyStore = createHistoryStore({ file: historyFile, dir: dataDir, keepCount, log })
  // 三道本地后处理（词形修复 / 中文姿势意图 / 去重合序）都靠标签索引，懒建一次就够。
  const pipelineRunner = createPipelineRunner({ cfg, log, tags, canonicalizeAll })

  function keepCount() {
    const raw = cfg.ui?.keepHistory
    const n = Number.parseInt(String(raw ?? 20), 10)
    if (!Number.isFinite(n)) return 20
    return Math.min(200, Math.max(0, n))
  }

  /** system 提示词按档位缓存（面板反复点不同档位不用重建）。 */
  function promptPair(level) {
    const key = JSON.stringify([cfg.purge ?? null, cfg.tags ?? null, level])
    const hit = promptCache.get(key)
    if (hit !== undefined) return hit
    const scoped = cfgForLevel(cfg, level)
    const pair = {
      prompt: buildForgeSystemPrompt(scoped),
      preview: buildForgeSystemPrompt(scoped, { examples: false }),
    }
    promptCache.set(key, pair)
    if (promptCache.size > 16) promptCache.delete(promptCache.keys().next().value)
    return pair
  }

  function fullPrompt(level) {
    return promptPair(resolveLevel(cfg, level)).prompt
  }

  /**
   * 索引 ready() 是异步的（首次构建可能要几秒）：等最多 INDEX_WAIT_MS，
   * 没就绪/抛错都当"未校对"，只记一条 warning，绝不拖死锻造。
   */
  async function indexReady(warnings) {
    if (tags === undefined || tags === null) return false
    if (typeof tags.ready !== 'function') return true
    try {
      const stats = typeof tags.stats === 'function' ? tags.stats() : undefined
      if (isRecord(stats) && stats.ready === true) {
        // 词表是纯文本，改完不该让人重启整个 app：指纹变了就在这里重建一次（一次 stat，便宜）。
        if (typeof tags.ensureFresh === 'function') {
          const reloaded = await tags.ensureFresh()
          if (reloaded) log.info('词表有变动，已热重载标签索引')
        }
        return true
      }
      const wait = indexWait()
      let state
      try {
        state = await Promise.race([Promise.resolve(tags.ready()), wait.promise])
      } finally {
        wait.cancel()
      }
      if (state === INDEX_WAIT_TIMEOUT) {
        log.warn('标签库 ' + INDEX_WAIT_MS + 'ms 内未构建完，本次按现有（seed）索引校对')
        return true
      }
      if (state === false) {
        pushOnce(warnings, COLD_INDEX_WARNING)
        return false
      }
      return true
    } catch (error) {
      log.warn('标签库 ready() 失败：' + (error instanceof Error ? error.message : String(error)))
      pushOnce(warnings, COLD_INDEX_WARNING)
      return false
    }
  }

  /** 标签库校对：能拿到索引就校对，拿不到就当未知（matched=undefined，不误报"不在库里"）。 */
  async function canonicalizeAll(list, warnings) {
    const rawList = list.map(row => row.tag)
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') {
      return list.map(row => ({ ...row, matched: undefined }))
    }
    const ready = await indexReady(warnings)
    if (ready === false) return list.map(row => ({ ...row, matched: undefined }))
    let canon
    try {
      canon = await tags.canonicalizeMany(rawList, { syntax: cfg.tags?.weightSyntax ?? 'comfy' })
    } catch (error) {
      log.warn('标签库校对失败：' + (error instanceof Error ? error.message : String(error)))
      pushOnce(warnings, COLD_INDEX_WARNING)
      return list.map(row => ({ ...row, matched: undefined }))
    }
    if (!Array.isArray(canon)) return list.map(row => ({ ...row, matched: undefined }))
    return list.map((row, index) => {
      const hit = isRecord(canon[index]) ? canon[index] : undefined
      if (hit === undefined) return { ...row, matched: undefined }
      const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? String(hit.tag).trim() : row.tag
      const weight = row.weight ?? (typeof hit.weight === 'number' ? hit.weight : undefined)
      return {
        raw: row.tag,
        tag,
        weight,
        matched: hit.matched,
        kind: typeof hit.kind === 'string' ? hit.kind : undefined,
        cn: typeof hit.cn === 'string' ? hit.cn : undefined,
      }
    })
  }

  function formatRows(rows, syntax) {
    if (rows.length === 0) return ''
    if (tags !== undefined && tags !== null && typeof tags.formatTagString === 'function') {
      try {
        const out = tags.formatTagString(rows.map(row => ({ tag: row.tag, weight: row.weight ?? 1 })), { syntax })
        if (typeof out === 'string' && out.trim() !== '') return out.trim()
      } catch (error) {
        log.warn('formatTagString 失败，回退内置格式化：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    return rows.map(row => formatEntry(row.tag, row.weight ?? 1, syntax)).join(', ')
  }

  async function generate(input) {
    const startedAt = Date.now()
    const request = isRecord(input) ? input : {}
    const opts = normalizeOptions(cfg, request.options)
    const warnings = []
    const base = {
      ok: false,
      positive: '',
      negative: '',
      tags: [],
      negativeTags: [],
      standards: opts.standards,
      raw: '',
      repaired: false,
      model: opts.model,
      provider: opts.provider,
      ms: 0,
      warnings,
    }
    const fail = (error, message, extra) => ({ ...base, ...extra, ok: false, error, message, ms: Date.now() - startedAt })

    const described = typeof request.text === 'string' ? request.text.trim() : ''
    if (described === '') return fail('empty-text', '先写点什么。')

    const forgeCfg = isRecord(cfg.forge) ? cfg.forge : {}
    // 白话里点到姿势/视角时，先从本地词库捞一批"真存在的词"喂给模型（省它自己猜拼写）。
    let candidates = []
    if (forgeCfg.candidates !== false && tags !== undefined && tags !== null) {
      try {
        candidates = await selectCandidates({ described, tags, limit: forgeCfg.candidateLimit ?? 18 })
      } catch (error) {
        log.warn('候选检索失败，按无候选继续：' + (error instanceof Error ? error.message : String(error)))
        candidates = []
      }
    }

    const streamFn = llm !== undefined && llm !== null && typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined
    if (streamFn === undefined) {
      return fail('no-llm', '宿主没有 llm 服务，检查 provider 配置（settings.json 里的 llm.provider / llm.model）。')
    }

    const callOnce = budget => collect(streamFn, {
      provider: opts.provider,
      model: opts.model,
      sessionId: typeof cfg.llm?.sessionId === 'string' && cfg.llm.sessionId !== '' ? cfg.llm.sessionId : 'dsh-tagger',
      system: fullPrompt(opts.purgeLevel),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(described, opts, candidates) }] }],
      maxTokens: budget,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      timeoutMs: opts.timeoutMs,
      signal: request.signal,
    })

    // 长描述（尤其 NSFW 细描写）会让模型推理吃掉输出预算而被截断：截断时自动把上限翻倍重试一次，
    // 别让用户对着「模型输出被截断」自己猜该调多大。
    let collected = await callOnce(opts.maxTokens)
    if (collected.error === 'max-tokens' && opts.maxTokens < MAX_TOKEN_CEILING) {
      const retryBudget = Math.min(MAX_TOKEN_CEILING, Math.round(opts.maxTokens * 2))
      log.warn('输出被 maxTokens(' + opts.maxTokens + ') 截断，用 ' + retryBudget + ' 重试一次')
      collected = await callOnce(retryBudget)
      // 只有重试真的成功了才说「重试成功」：第二次要是又截断/超时/报错，下面按真实错误返回，别粉饰。
      if (collected.error === undefined) {
        warnings.push('输出被截断过，已把上限提到 ' + retryBudget + ' 重试成功')
      }
    }

    const usage = collected.usage !== undefined && Object.keys(collected.usage).length > 0 ? collected.usage : undefined
    if (collected.error !== undefined) {
      return fail(collected.error, collected.message ?? '模型调用失败。', { raw: collected.text, usage })
    }

    const raw = collected.text
    const parsed = parseForgeJson(raw)
    if (parsed.value === undefined) {
      log.warn('JSON 修复后仍失败：' + (parsed.error ?? 'unknown'))
      return fail('bad-json', '模型没给出可解析的 JSON（已尝试修复一次）：' + (parsed.error ?? ''), { raw, repaired: true, usage })
    }

    // 负向一律交给 ComfyUI 工作流内置：模型给的 negative 直接丢掉，只保留调用方显式传入的额外负向。
    // 质量词反过来 —— 库里真有的评分词留着，由后处理统一置顶（config.forge.quality，默认开）。
    const cleaned = stripQuality(normalizeList(pickPositive(parsed.value)).slice(0, MAX_POSITIVE_HARD_CAP), described)
    const positiveRaw = cleaned.rows
    if (cleaned.dropped.length > 0) {
      warnings.push('去掉现编的画质词：' + cleaned.dropped.join(', '))
    }
    const negativeRaw = []
    if (opts.negative !== '') {
      for (const piece of opts.negative.split(/[,\n]/)) {
        const row = normalizeEntry(piece)
        // 保持调用方写的顺序（unshift 会把 "lowres, censored" 变成 "censored, lowres"）
        if (row !== undefined) negativeRaw.push(row)
      }
    }
    if (positiveRaw.length === 0) {
      return fail('empty-tags', '模型没给出正向 tag。', { raw, repaired: parsed.repaired, usage })
    }

    const warnOnce = text => pushOnce(warnings, text)

    // 三道本地处理（① 词形修复 ② 姿势/视角意图 ③ 去重合序）见 ./pipeline.js：
    // 顺序固定，任何一道失败只记一条 warning，不打断锻造。
    const canonicalRows = await canonicalizeAll(positiveRaw, warnings)
    const piped = await pipelineRunner.run({
      rows: canonicalRows,
      described,
      opts,
      forgeCfg,
      warnings,
      warnOnce,
      quality: {
        enabled: forgeCfg.quality !== false,
        tags: Array.isArray(cfg.tags?.qualityTags) ? cfg.tags.qualityTags : undefined,
      },
    })
    const pipelineInfo = piped.info
    const positiveRows = piped.rows

    let negativeRows = dedupe(await canonicalizeAll(negativeRaw, warnings))

    if (positiveRows.length > opts.maxTags) {
      warnOnce('正向 ' + positiveRows.length + ' 条超过上限，已截到 ' + opts.maxTags + ' 条')
      positiveRows.length = opts.maxTags
    }

    for (const row of negativeRows) {
      if (row.matched === false) warnOnce((row.raw ?? row.tag) + ' 不在库里')
    }

    // 索引没就绪时 canonicalize 会全判"没匹上"，这里补一句人话解释，别让面板看到一片红。
    try {
      const stats = tags !== undefined && tags !== null && typeof tags.stats === 'function' ? tags.stats() : undefined
      // 已经记过「未校对」（indexReady 的主判定）就不再补第二条同义提示：面板一行就够。
      if (isRecord(stats) && stats.ready === false && warnings.includes(COLD_INDEX_WARNING) === false) {
        warnOnce('标签库尚未就绪，本条未做全量校对')
      }
    } catch {
      // stats() 炸了不影响锻造结果
    }

    const keep = row => ({ tag: row.tag, weight: clampNumber(row.weight ?? 1, 0.1, 2.5, 1), ...row.kind === undefined ? {} : { kind: row.kind }, ...row.cn === undefined ? {} : { cn: row.cn } })
    const resultTags = positiveRows.map(keep)
    const resultNegative = negativeRows.map(keep)

    const positive = formatRows(resultTags, opts.syntax)
    const negative = formatRows(resultNegative, opts.syntax)
    const notes = pickNotes(parsed.value)

    const result = {
      ok: true,
      positive,
      negative,
      tags: resultTags,
      negativeTags: resultNegative,
      standards: opts.standards,
      purgeLevel: opts.purgeLevel,
      raw,
      repaired: parsed.repaired,
      model: opts.model,
      provider: opts.provider,
      ms: Date.now() - startedAt,
      warnings,
      pipeline: pipelineInfo,
      ...usage === undefined ? {} : { usage },
      ...notes === undefined ? {} : { notes },
    }

    historyStore.push({
      id: 'f' + startedAt.toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date(startedAt).toISOString(),
      text: described,
      positive,
      negative,
      ms: result.ms,
      model: opts.model,
      ok: true,
    })

    return result
  }

  async function models(provider) {
    if (llm === undefined || llm === null || typeof llm.listModels !== 'function') return []
    const target = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : String(cfg.llm?.provider ?? 'opencode-go')
    try {
      const rows = await llm.listModels(target)
      if (!Array.isArray(rows)) return []
      return rows
        .map(row => {
          const id = isRecord(row) && typeof row.id === 'string' ? row.id : undefined
          if (id === undefined || id === '') return undefined
          const label = isRecord(row) && typeof row.name === 'string' && row.name !== '' ? row.name : undefined
          return label === undefined ? { id } : { id, label }
        })
        .filter(row => row !== undefined)
    } catch (error) {
      log.warn('listModels(' + target + ') 失败：' + (error instanceof Error ? error.message : String(error)))
      return []
    }
  }

  function systemPrompt(options) {
    const pair = promptPair(resolveLevel(cfg))
    const preview = isRecord(options) && options.preview === true
    return preview ? pair.preview : pair.prompt
  }

  function agentDirective() {
    return purgeAgentDirective(cfg)
  }

  function purgeState() {
    return purgeStateOf(cfg)
  }

  function history() {
    return historyStore.load().slice()
  }

  function refreshPurge() {
    promptCache.clear()
  }

  return {
    generate,
    models,
    systemPrompt,
    agentDirective,
    purgeState,
    history,
    refreshPurge,
    /** 供内部/测试用：当前生效配置的快照。 */
    config: cfg,
    levels: PURGE_LEVELS.slice(),
  }
}
