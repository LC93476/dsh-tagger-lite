// plan: 精修差分的解析与归一 —— 小工具（tag/权重/去重/保序）+ 与 forge 同思路的 JSON 容错解析，纯函数，无状态。
import {
  DEFAULT_TIMEOUT_MS,
  MIN_WEIGHT,
  MAX_WEIGHT,
} from './consts.js'

// ---------------------------------------------------------------- 小工具

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
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

/** 从 '(tag:1.2)' / 'tag::1.2' / '{{tag}}' / 'tag' 里拆出 tag 与权重。 */
export function splitWeight(raw) {
  let text = String(raw ?? '').trim()
  let weight
  const paren = text.match(/^\((.+):([0-9]*\.?[0-9]+)\)$/)
  if (paren !== null) {
    text = paren[1]
    weight = Number.parseFloat(paren[2])
  } else {
    const colon = text.match(/^(.+?)::([0-9]*\.?[0-9]+)$/)
    if (colon !== null) {
      text = colon[1]
      weight = Number.parseFloat(colon[2])
    } else {
      const braces = text.match(/^\{\{(.+)\}\}$/)
      if (braces !== null) {
        text = braces[1]
        weight = 1.1
      }
    }
  }
  return { tag: cleanTag(text), weight: Number.isFinite(weight) ? weight : undefined }
}

/** 比较用的归一化键：大小写、空格 / 下划线、首尾括号都不敏感。 */
export function tagKey(raw) {
  const text = cleanTag(String(raw ?? '')).toLowerCase()
  return text.replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '')
}

/** 单个 tag 的最终写法（与 forge 的 formatEntry 一致）。 */
export function formatEntry(tag, weight, syntax) {
  if (syntax === 'plain') return tag
  const w = clampNumber(weight, MIN_WEIGHT, MAX_WEIGHT, 1)
  if (Math.abs(w - 1) < 0.005) return tag
  return '(' + tag + ':' + trimNumber(w) + ')'
}

export function emptyDelta() {
  return { added: [], removed: [], weighted: [] }
}

export function pushWarn(list, message) {
  const text = String(message ?? '').trim()
  if (text === '' || list.includes(text)) return
  list.push(text)
}

/** 数组 / 单个字符串 / {tag} 对象都能吃成字符串列表。 */
export function toTagList(value) {
  const out = []
  const push = item => {
    if (typeof item === 'string') {
      out.push(item)
      return
    }
    if (!isRecord(item)) return
    const raw = item.tag ?? item.name ?? item.word
    if (typeof raw === 'string') out.push(raw)
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (typeof value === 'string') value.split(/[,\n]/).forEach(push)
  else if (isRecord(value)) Object.keys(value).forEach(push)
  return out
}

/** weights 允许 [{tag, weight}] / ['(smile:1.2)'] / {"smile": 1.2} 三种写法。 */
export function toWeightList(value) {
  const rows = []
  const push = item => {
    if (typeof item === 'string') {
      const split = splitWeight(item)
      if (split.tag !== '' && split.weight !== undefined) rows.push({ tag: split.tag, weight: split.weight })
      return
    }
    if (!isRecord(item)) return
    const raw = item.tag ?? item.name ?? item.word
    if (typeof raw !== 'string') return
    const rawWeight = item.weight ?? item.w ?? item.to ?? item.value
    const weight = typeof rawWeight === 'number' ? rawWeight : Number.parseFloat(String(rawWeight ?? ''))
    if (!Number.isFinite(weight)) return
    const split = splitWeight(raw)
    rows.push({ tag: split.tag === '' ? cleanTag(raw) : split.tag, weight })
  }
  if (Array.isArray(value)) value.forEach(push)
  else if (isRecord(value)) {
    for (const [tag, weight] of Object.entries(value)) push({ tag, weight })
  }
  return rows
}

/** 去重（按 tagKey），保留首次出现的原写法。 */
export function dedupeStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const text = cleanTag(item)
    const key = tagKey(text)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

/** 按模型给的 order 重排（只认能对上的，剩下的按原顺序接在末尾）。 */
export function reorderRows(rows, order) {
  const byKey = new Map()
  for (const row of rows) {
    const key = tagKey(row.tag)
    if (!byKey.has(key)) byKey.set(key, row)
  }
  const used = new Set()
  const out = []
  for (const raw of order) {
    const key = tagKey(raw)
    const row = byKey.get(key)
    if (row === undefined || used.has(key)) continue
    used.add(key)
    out.push(row)
  }
  for (const row of rows) {
    const key = tagKey(row.tag)
    if (used.has(key)) continue
    used.add(key)
    out.push(row)
  }
  return out
}

export function fallbackParseList(text) {
  const out = []
  for (const piece of String(text ?? '').split(',')) {
    const parsed = splitWeight(piece)
    if (parsed.tag !== '') out.push(parsed)
  }
  return out
}

// ---------------------------------------------------------------- JSON 容错（与 forge 同一套思路）

export function extractFenced(raw) {
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

export function firstBrace(text) {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (objStart >= 0 && arrStart >= 0) return Math.min(objStart, arrStart)
  return Math.max(objStart, arrStart)
}

export function trimToLastJson(text) {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end < 0) return text
  return text.slice(0, end + 1)
}

export function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: msgOf(error) }
  }
}

export function closeUnbalanced(input) {
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

export function repairJsonText(input) {
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

/** 剥围栏 → 直解 → 去前后废话 → 结构性修复一次。 */
export function parseRefineJson(raw) {
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

export function pickNotes(value) {
  if (!isRecord(value)) return undefined
  const raw = value.notes ?? value.note ?? value.comment
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text.slice(0, 500)
}

export function mergeUsage(target, usage) {
  if (!isRecord(usage)) return
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
  if (typeof input === 'number' && Number.isFinite(input)) target.inputTokens = input
  if (typeof output === 'number' && Number.isFinite(output)) target.outputTokens = output
}


