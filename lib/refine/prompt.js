// plan: 精修提示词与选项归一 —— 系统提示词（复用 purge 破甲档位）、user prompt 拼装、options 覆盖与回落。
import {
  buildRefineSystemPrompt,
} from '../purge.js'
import {
  MODE_SET,
  PURGE_LEVEL_SET,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_NEW_TAGS,
  MAX_NEW_CEILING,
  MAX_TOKEN_CEILING,
  MODE_RULES,
} from './consts.js'
import {
  isRecord,
  clampTimeout,
  clampNumber,
} from './diff.js'

export function makePrompt({ cfg, tags, log }) {
  const promptCache = new Map()

  function syntaxOf() {
    const syntax = cfg.tags?.weightSyntax
    return syntax === 'plain' || syntax === 'a1111' || syntax === 'comfy' ? syntax : 'comfy'
  }


  function resolveMode(value) {
    const wanted = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (MODE_SET.has(wanted)) return wanted
    const base = typeof cfg.refine?.mode === 'string' ? cfg.refine.mode.trim().toLowerCase() : ''
    return MODE_SET.has(base) ? base : 'add'
  }

  /** 本次生效的破甲档：合法 options.purgeLevel 覆盖 config.purge.level，不写回 settings。 */
  function resolveLevel(override) {
    const wanted = typeof override === 'string' ? override.trim().toLowerCase() : ''
    if (PURGE_LEVEL_SET.has(wanted)) return wanted
    const base = typeof cfg.purge?.level === 'string' ? cfg.purge.level.trim().toLowerCase() : ''
    return PURGE_LEVEL_SET.has(base) ? base : 'full'
  }

  /** system 提示词按档位缓存（反复精修不用每次重建几千字）。 */
  function systemPrompt(level) {
    const key = JSON.stringify([cfg.purge ?? null, cfg.tags ?? null, level])
    const hit = promptCache.get(key)
    if (hit !== undefined) return hit
    const purge = isRecord(cfg.purge) ? cfg.purge : {}
    const text = buildRefineSystemPrompt({ ...cfg, purge: { ...purge, level } })
    promptCache.set(key, text)
    if (promptCache.size > 8) promptCache.delete(promptCache.keys().next().value)
    return text
  }


  function normalizeOptions(options, mode) {
    const input = isRecord(options) ? options : {}
    const refineCfg = isRecord(cfg.refine) ? cfg.refine : {}
    return {
      mode,
      syntax: syntaxOf(),
      maxNewTags: Math.round(clampNumber(input.maxNewTags ?? refineCfg.maxNewTags, 1, MAX_NEW_CEILING, DEFAULT_MAX_NEW_TAGS)),
      temperature: clampNumber(input.temperature ?? refineCfg.temperature, 0, 2, DEFAULT_TEMPERATURE),
      maxTokens: Math.round(clampNumber(input.maxTokens ?? refineCfg.maxTokens, 256, MAX_TOKEN_CEILING, DEFAULT_MAX_TOKENS)),
      timeoutMs: clampTimeout(input.timeoutMs ?? refineCfg.timeoutMs),
      keepOrder: (input.keepOrder ?? refineCfg.keepOrder) !== false,
      model: typeof cfg.llm?.model === 'string' && cfg.llm.model.trim() !== '' ? String(cfg.llm.model) : DEFAULT_MODEL,
      provider: typeof cfg.llm?.provider === 'string' && cfg.llm.provider.trim() !== '' ? String(cfg.llm.provider) : DEFAULT_PROVIDER,
      reasoningEffort: typeof cfg.llm?.reasoningEffort === 'string' && cfg.llm.reasoningEffort !== '' ? cfg.llm.reasoningEffort : undefined,
      sessionId: typeof cfg.llm?.sessionId === 'string' && cfg.llm.sessionId !== '' ? cfg.llm.sessionId : 'dsh-tagger',
      purgeLevel: resolveLevel(input.purgeLevel),
      raw: input,
    }
  }


  function buildUserPrompt({ positiveText, negativeText, instruction, mode, opts }) {
    const lines = [
      '【现有正向标签串】',
      positiveText === '' ? '（空串 —— 按描述补出画面需要的标签）' : positiveText,
      '',
      '【现有负向标签串】',
      negativeText === '' ? '（无）' : negativeText,
      '',
      '【精修模式】' + mode + ' —— ' + MODE_RULES[mode],
      '【新增上限】本次最多新增 ' + opts.maxNewTags + ' 条',
      '【权重语法】' + opts.syntax,
    ]
    if (mode === 'add') lines.push('【注意】add 里不要出现已经在串里的词（含同义 / 下划线变体）。')
    if (mode === 'weights') lines.push('【注意】weights 里的 tag 必须与现有串里的写法一致。')
    if (opts.keepOrder === false) lines.push('【顺序】允许重排：需要换序时用 order 数组给出最终词序。')
    else lines.push('【顺序】保持现有标签顺序，新标签追加到末尾。')
    lines.push('', '【本次要求】', instruction, '', '只输出 JSON 差分对象。')
    return lines.join('\n')
  }


  return { syntaxOf, resolveMode, resolveLevel, systemPrompt, normalizeOptions, buildUserPrompt }
}

