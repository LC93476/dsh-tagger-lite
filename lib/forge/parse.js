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

/** 尾部那个字符串是不是"键位"（前面是 { 或 ,）：是就返回切点，不是返回 undefined。 */
function trailingKeyCut(out) {
  const match = out.match(/"(?:[^"\\]|\\.)*"$/)
  if (match === null) return undefined
  let at = match.index
  while (at > 0 && ' \t\r\n'.includes(out[at - 1])) at -= 1
  if (at === 0) return undefined
  const prev = out[at - 1]
  if (prev === ',') return at - 1
  if (prev === '{') return at
  return undefined
}

/**
 * 补括号之前先清尾巴：孤立逗号、悬空冒号（,"notes":）、没有值的截断键名（,"not）。
 * 只动对象层（open === '{'）—— 数组里最后一个字符串是真 tag，不能当键名摘掉。
 */
function trimDanglingTail(out, open) {
  let text = out
  for (let guard = 0; guard < 16; guard += 1) {
    const before = text
    text = text.replace(/[ \t\r\n]+$/, '').replace(/,$/, '').replace(/[ \t\r\n]+$/, '')
    if (open === '{') {
      if (text.endsWith(':')) text = text.slice(0, -1).replace(/[ \t\r\n]+$/, '')
      // 值位置的字符串（前面是冒号）不动；键位置的（前面是 { 或 ,）整段摘掉。
      const cut = trailingKeyCut(text)
      if (cut !== undefined) text = text.slice(0, cut)
    }
    text = text.replace(/[ \t\r\n]+$/, '').replace(/,$/, '').replace(/[ \t\r\n]+$/, '')
    if (text === before) break
  }
  return text
}

/** 补齐没闭合的引号 / 括号（模型偶尔被截断）：先清尾部悬空片段，再按栈逆序闭合。 */
export function closeUnbalanced(input) {
  const source = String(input ?? '')
  const stack = []
  let inString = false
  let escape = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
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
  let out = source
  if (inString) out += '"'
  out = trimDanglingTail(out, stack.length > 0 ? stack[stack.length - 1] : undefined)
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === '{' ? '}' : ']'
  return out
}

/** JSON 字符串里不允许裸控制字符：补成转义，其余原样。 */
function escapeControl(ch) {
  const code = ch.charCodeAt(0)
  if (code === 9) return '\\t'
  if (code === 10) return '\\n'
  if (code === 13) return '\\r'
  if (code < 32) return '\\u' + code.toString(16).padStart(4, '0')
  return ch
}

/** 双引号字符串：内部原样透传（撇号、冒号、斜杠、// 都不碰），只给裸控制字符补转义。 */
function copyDoubleQuoted(source, start, out) {
  out.push('"')
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      out.push(ch)
      if (i + 1 < source.length) out.push(source[i + 1])
      i += 2
      continue
    }
    if (ch === '"') {
      out.push('"')
      return i + 1
    }
    out.push(escapeControl(ch))
    i += 1
  }
  return i
}

/** 单引号字符串 → 双引号字符串（内容不动，只转义必需字符）。 */
function copySingleQuoted(source, start, out) {
  out.push('"')
  let i = start + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      const next = source[i + 1]
      if (next === "'") {
        out.push("'")
        i += 2
        continue
      }
      out.push('\\')
      if (next !== undefined) out.push(next)
      i += 2
      continue
    }
    if (ch === "'") {
      out.push('"')
      return i + 1
    }
    if (ch === '"') {
      out.push('\\"')
      i += 1
      continue
    }
    out.push(escapeControl(ch))
    i += 1
  }
  return i
}

/**
 * 结构性修复：字符串状态机扫描。
 * 双引号字符串内部原样透传；只在字符串外部处理注释、裸控制字符、尾逗号、单引号字符串、裸键。
 */
export function repairJsonText(input) {
  const source = String(input ?? '').replace(/^\uFEFF/, '')
  const out = []
  const stack = []
  let lastSig = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"') {
      i = copyDoubleQuoted(source, i, out)
      lastSig = '"'
      continue
    }
    if (ch === "'") {
      i = copySingleQuoted(source, i, out)
      lastSig = '"'
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      let end = i + 2
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1
      i = end
      continue
    }
    const code = source.charCodeAt(i)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      i += 1
      continue
    }
    if (ch === '}') {
      if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop()
      out.push(ch)
      lastSig = ch
      i += 1
      continue
    }
    if (ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop()
      out.push(ch)
      lastSig = ch
      i += 1
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      out.push(ch)
      lastSig = ch
      i += 1
      continue
    }
    if (ch === ',') {
      let next = i + 1
      while (next < source.length && ' \t\r\n'.includes(source[next])) next += 1
      if (source[next] === '}' || source[next] === ']') {
        i += 1
        continue
      }
      out.push(',')
      lastSig = ','
      i += 1
      continue
    }
    // 裸键：对象里紧跟 { 或 , 的标识符，且后面确实跟着冒号。
    const keySlot = stack.length > 0 && stack[stack.length - 1] === '{' && (lastSig === '{' || lastSig === ',')
    if (keySlot && /[A-Za-z_$]/.test(ch)) {
      let end = i
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1
      let next = end
      while (next < source.length && ' \t\r\n'.includes(source[next])) next += 1
      if (source[next] === ':') {
        out.push('"' + source.slice(i, end) + '"')
        lastSig = '"'
        i = end
        continue
      }
    }
    out.push(ch)
    if (' \t\r\n'.includes(ch) === false) lastSig = ch
    i += 1
  }
  return closeUnbalanced(out.join(''))
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
