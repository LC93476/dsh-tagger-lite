// plan: 选项归一 —— 破甲档位解析（options.purgeLevel 覆盖 config.purge.level，不写回）、
// 以及 standards / syntax / maxTags / model / provider / maxTokens / 超时 的夹取与回落。
import { PURGE_LEVELS } from '../purge.js'
import { clampNumber, clampTimeout, isRecord } from './util.js'

export const DEFAULT_MAX_TOKENS = 4000
export const MAX_TOKEN_CEILING = 16000
export const DEFAULT_TEMPERATURE = 0.5
export const DEFAULT_STANDARDS = ['wd', 'camie']
export const MAX_POSITIVE_HARD_CAP = 200
export const PURGE_LEVEL_SET = new Set(PURGE_LEVELS)

/** 本次调用生效的破甲档：合法 options.purgeLevel 覆盖 config.purge.level，不写回 settings。 */
export function resolveLevel(cfg, override) {
  const wanted = typeof override === 'string' ? override.trim().toLowerCase() : ''
  if (PURGE_LEVEL_SET.has(wanted)) return wanted
  const base = typeof cfg.purge?.level === 'string' ? cfg.purge.level.trim().toLowerCase() : ''
  return PURGE_LEVEL_SET.has(base) ? base : 'full'
}

export function cfgForLevel(cfg, level) {
  const purge = isRecord(cfg.purge) ? cfg.purge : {}
  if (purge.level === level) return cfg
  return { ...cfg, purge: { ...purge, level } }
}

export function normalizeOptions(cfg, options) {
  const input = isRecord(options) ? options : {}
  const standardsRaw = Array.isArray(input.standards) ? input.standards : cfg.tags?.standards
  const standardsList = (Array.isArray(standardsRaw) ? standardsRaw : DEFAULT_STANDARDS)
    .map(v => String(v).toLowerCase())
    .filter(v => v === 'wd' || v === 'camie')
  const syntaxRaw = input.syntax ?? cfg.tags?.weightSyntax
  const syntax = syntaxRaw === 'plain' || syntaxRaw === 'a1111' || syntaxRaw === 'comfy' ? syntaxRaw : 'comfy'
  const maxTagsRaw = input.maxTags ?? cfg.tags?.maxTags
  const maxTags = clampNumber(maxTagsRaw, 8, MAX_POSITIVE_HARD_CAP, 40)
  return {
    standards: standardsList.length > 0 ? standardsList : DEFAULT_STANDARDS.slice(),
    syntax,
    maxTags: Math.round(maxTags),
    negative: typeof input.negative === 'string' ? input.negative.trim() : '',
    notes: typeof input.notes === 'string' ? input.notes.trim() : '',
    model: typeof input.model === 'string' && input.model.trim() !== '' ? input.model.trim() : String(cfg.llm?.model ?? 'deepseek-v4.1-flash'),
    provider: typeof input.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : String(cfg.llm?.provider ?? 'opencode-go'),
    maxTokens: Math.round(clampNumber(input.maxTokens ?? cfg.llm?.maxTokens, 256, 16000, DEFAULT_MAX_TOKENS)),
    temperature: clampNumber(input.temperature, 0, 2, DEFAULT_TEMPERATURE),
    reasoningEffort: typeof input.reasoningEffort === 'string' && input.reasoningEffort !== ''
      ? input.reasoningEffort
      : (typeof cfg.llm?.reasoningEffort === 'string' && cfg.llm.reasoningEffort !== '' ? cfg.llm.reasoningEffort : undefined),
    timeoutMs: clampTimeout(input.timeoutMs ?? cfg.llm?.timeoutMs),
    purgeLevel: resolveLevel(cfg, input.purgeLevel),
  }
}
