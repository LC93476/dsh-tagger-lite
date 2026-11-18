// plan: 锻造器的共用小工具 —— 类型判断、数据目录、超时/数值夹取、数字裁剪、tag 清洗、去重、usage 合并。
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_TIMEOUT_MS = 120000

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function fallbackDir() {
  return path.join(os.homedir(), '.dsh-tagger')
}

export function clampTimeout(value) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.min(600000, Math.max(100, n))
}

export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function trimNumber(value) {
  const rounded = Math.round(value * 100) / 100
  if (Number.isInteger(rounded)) return String(rounded)
  return String(rounded).replace(/0+$/, '').replace(/\.$/, '')
}

export function cleanTag(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''
  text = text.replace(/^[-+*•\s]+/, '')
  text = text.replace(/^["'`]+|["'`]+$/g, '')
  text = text.replace(/[,\s]+$/, '')
  text = text.replace(/\s+/g, ' ')
  return text.trim()
}

/** 按 tag 小写去重，保留首次出现的行。 */
export function dedupe(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const key = row.tag.toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

export function mergeUsage(target, usage) {
  if (!isRecord(usage)) return
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
  if (typeof input === 'number' && Number.isFinite(input)) target.inputTokens = input
  if (typeof output === 'number' && Number.isFinite(output)) target.outputTokens = output
}
