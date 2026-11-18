// plan: 模型回流解析 —— 权重拆解、行列归一、JSON 抽取（剥围栏/定位括号/结构修复一次）、正负向字段拾取。
import { cleanTag, isRecord } from './util.js'

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

/** positive / negative 数组的元素可以是字符串，也可以是 {tag, weight} 这类对象。 */
export function normalizeEntry(item) {
  if (typeof item === 'string') {
    const split = splitWeight(item)
    if (split.tag === '') return undefined
    return { tag: split.tag, weight: split.weight }
  }
  if (!isRecord(item)) return undefined
  const rawTag = item.tag ?? item.name ?? item.word ?? item.text ?? item.value
  if (typeof rawTag !== 'string') return undefined
  const split = splitWeight(rawTag)
  if (split.tag === '') return undefined
  const rawWeight = item.weight ?? item.w ?? item.score ?? item.strength ?? split.weight
  const weight = typeof rawWeight === 'number' ? rawWeight : Number.parseFloat(String(rawWeight ?? ''))
  return { tag: split.tag, weight: Number.isFinite(weight) ? weight : undefined }
}

export function normalizeList(value) {
  const rows = []
  const push = item => {
    const row = normalizeEntry(item)
    if (row !== undefined) rows.push(row)
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
    return rows
  }
  if (typeof value === 'string') {
    for (const piece of value.split(/[,\n]/)) push(piece)
    return rows
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) push(item)
    return rows
  }
  return rows
}

/** 剥掉 markdown 围栏（模型爱在外面包一层 ```json）。 */
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

/** 第一个 { 或 [ 的下标，找不到返回 -1。 */
export function firstBrace(text) {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (objStart >= 0 && arrStart >= 0) return Math.min(objStart, arrStart)
  return Math.max(objStart, arrStart)
}

/** 切到最后一个 } 或 ] 之后（去掉"希望有帮助"这类尾巴）。 */
export function trimToLastJson(text) {
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (end < 0) return text
  return text.slice(0, end + 1)
}

export function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 补齐没闭合的引号 / 括号（模型偶尔被截断）。 */
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

/** 结构性修复：注释、尾逗号、单引号、裸键、控制字符、截断。 */
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

/**
 * 解析模型输出：剥围栏 → 直解 → 去前后废话 → **结构性修复一次** → 仍失败返回 undefined。
 * repaired 表示"不是原样 JSON.parse 成功的"（剥围栏也算）。
 * 截断场景优先用"从第一个括号到结尾"的候选，否则尾部 tag 会被丢掉。
 */
export function parseForgeJson(raw) {
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

export function pickPositive(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value
  if (!isRecord(value)) return []
  const candidates = [value.positive, value.positive_tags, value.positive_tag, value.tags, value.prompt, value.p]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return []
}

export function pickNegative(value) {
  if (!isRecord(value)) return []
  const candidates = [value.negative, value.negative_tags, value.negative_prompt, value.n]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return []
}

export function pickNotes(value) {
  if (!isRecord(value)) return undefined
  const raw = value.notes ?? value.note ?? value.comment
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text.slice(0, 500)
}
