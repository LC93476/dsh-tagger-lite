// plan: lib/tags/matcher/format.js 放写法（parseTagString / formatTagString / toStandard）
/**
 * lib/tags/matcher/format.js — 标签串的三种写法与格式互转。
 *
 * comfy 语法 (tag:1.2)、a1111 语法、plain 就这一层；WD（下划线小写）/ Camie（空格小写）的
 * 标准写法也在这里，输入输出都不碰索引状态。
 */
import { escapeParens, formatWeight, unescapeTag } from '../text.js'
import { parseTerm, splitTopLevel } from './parse.js'

export function parseTagString(text) {
  return splitTopLevel(String(text ?? ''))
    .map(part => {
      const parsed = parseTerm(part)
      return { tag: parsed.tag, weight: parsed.weight }
    })
    .filter(item => item.tag !== '')
}

export function formatTagString(list, options = {}) {
  const syntax = options.syntax === 'plain' || options.syntax === 'a1111' ? options.syntax : 'comfy'
  const items = Array.isArray(list)
    ? list
    : typeof list === 'string'
      ? parseTagString(list)
      : []
  const out = []
  for (const item of items) {
    if (item === null || item === undefined) continue
    let tag = ''
    let weight = 1
    if (typeof item === 'string') {
      const parsed = parseTerm(item)
      tag = parsed.tag
      weight = parsed.weight
    } else if (typeof item === 'object') {
      tag = unescapeTag(String(item.tag ?? '')).trim()
      weight = Number(item.weight)
      if (!Number.isFinite(weight)) weight = 1
    }
    if (tag === '') continue
    const text = escapeParens(tag)
    if (syntax === 'plain' || Math.abs(weight - 1) < 0.005) out.push(text)
    else out.push('(' + text + ':' + formatWeight(weight) + ')')
  }
  return out.join(', ')
}

export function toStandard(tag, standard = 'wd') {
  const mode = standard === 'camie' ? 'camie' : 'wd'
  let text = unescapeTag(String(tag ?? '')).trim().toLowerCase()
  if (text === '') return ''
  if (mode === 'camie') text = text.replace(/_/g, ' ').replace(/\s+/g, ' ')
  else text = text.replace(/\s+/g, '_').replace(/_+/g, '_')
  return escapeParens(text)
}
