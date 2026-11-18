// plan: lib/tags/matcher/parse.js 放解析与切分（wrapsWhole / splitTopLevel / parseTerm），纯文本、无状态
/**
 * lib/tags/matcher/parse.js — 标签串的解析与顶层切分。
 *
 * 纯函数层：不读索引状态，也不碰 IO。matcher 的其余子模块与 format.js 都从这里取词。
 */
import { unescapeTag } from '../text.js'

/** 括号/花括号是否把整串包住（跳过转义）。 */
export function wrapsWhole(text, open, close) {
  if (open.length === 2) {
    return text.length > 3 && text.startsWith(open) && text.endsWith(close) && !text.startsWith(open[0] + open)
  }
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0 && i !== text.length - 1) return false
    }
  }
  return depth === 0
}

/** 顶层切分：只在括号/花括号外面、且不在转义里的逗号、换行、分号算分隔符。 */
export function splitTopLevel(text) {
  const parts = []
  let buffer = ''
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      buffer += ch + text[i + 1]
      i++
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === '\n' || ch === ';') && depth === 0) {
      if (buffer.trim() !== '') parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim() !== '') parts.push(buffer)
  return parts
}

/**
 * 解析单个词：包装 → 权重 → 去转义。
 *   (smile:1.2) → 1.2      ((smile)) → 1.21     [blush] → 0.91
 *   {{long_hair}} → 1.1    solo::0.8 → 0.8      fate_(series) 的转义写法 → fate_(series)
 * 显式权重是绝对值（覆盖括号倍数），符合 ComfyUI 的直觉。
 */
export function parseTerm(raw) {
  let term = String(raw ?? '').trim()
  if (term === '') return { tag: '', weight: 1 }
  let weight = 1
  let explicit = null
  let guard = 0
  while (guard++ < 16 && term.length > 1) {
    if (term.startsWith('{{') && term.endsWith('}}') && wrapsWhole(term, '{{', '}}')) {
      weight *= 1.05 * 1.05
      term = term.slice(2, -2).trim()
      continue
    }
    if (term.startsWith('{') && term.endsWith('}') && wrapsWhole(term, '{', '}')) {
      weight *= 1.05
      term = term.slice(1, -1).trim()
      continue
    }
    if (term.startsWith('(') && term.endsWith(')') && wrapsWhole(term, '(', ')')) {
      weight *= 1.1
      term = term.slice(1, -1).trim()
      continue
    }
    if (term.startsWith('[') && term.endsWith(']') && wrapsWhole(term, '[', ']')) {
      weight /= 1.1
      term = term.slice(1, -1).trim()
      continue
    }
    break
  }
  const double = /^(.*)::(-?\d+(?:\.\d+)?)$/s.exec(term)
  const single = double === null ? /^(.*):(-?\d+(?:\.\d+)?)$/s.exec(term) : null
  const match = double ?? single
  if (match !== null && match[1].trim() !== '') {
    const candidate = Number(match[2])
    const tagPart = match[1].trim()
    // 16:9 / 4:3 这类是 tag，不是权重。
    const aspect = /^\d+$/.test(tagPart) && Number.isInteger(candidate) && candidate >= 1 && candidate <= 16
    const inWeightRange = Number.isFinite(candidate) && Math.abs(candidate) >= 0.05 && Math.abs(candidate) < 3
    if (double !== null || (!aspect && inWeightRange)) {
      explicit = Number.isFinite(candidate) ? candidate : null
      term = tagPart
    }
  }
  if (explicit !== null) weight = explicit
  return { tag: unescapeTag(term).trim(), weight: Math.round(weight * 100) / 100 }
}
