// plan: lib/tags/text.js 抽出标签文本基础件（kind 归一 / 查表键 / 转义 / 中文主名 / 权重写法）
/**
 * lib/tags/text.js — 标签文本的基础件，被 loader 与 matcher 共同依赖。
 *
 * 这里只放「不碰数据、不碰状态」的纯函数与常量，所以谁都能引，不会绕成环。
 */

export const KINDS = ['general', 'character', 'copyright', 'artist']

export const KIND_ALIAS = {
  general: 'general',
  tag: 'general',
  tags: 'general',
  character: 'character',
  characters: 'character',
  char: 'character',
  chars: 'character',
  copyright: 'copyright',
  copyrights: 'copyright',
  series: 'copyright',
  work: 'copyright',
  artist: 'artist',
  artists: 'artist',
  art: 'artist',
}

/** 文件名 → kind。只认这些名字，别的 jsonl 不读（避免把无关文件读进索引）。 */
export const FILE_KINDS = {
  general: 'general',
  generals: 'general',
  character: 'character',
  characters: 'character',
  char: 'character',
  copyright: 'copyright',
  copyrights: 'copyright',
  series: 'copyright',
  artist: 'artist',
  artists: 'artist',
}

export const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/
export const KANA_RE = /[\u3040-\u30ff]/
export const ESCAPED_RE = /\\([()[\]{}\\_])/g

export function normalizeKind(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return KIND_ALIAS[text] ?? (KINDS.includes(text) ? text : 'general')
}

export function normalizeKinds(value) {
  if (value === undefined || value === null) return null
  const list = Array.isArray(value) ? value : [value]
  const set = new Set()
  for (const item of list) {
    if (typeof item === 'string' && item.trim() !== '') set.add(normalizeKind(item))
  }
  return set.size > 0 ? set : null
}

export function kindAllowed(entry, set) {
  return set === null || set.has(entry.kind)
}

export function standardsFor(kind) {
  // Camie（tagger）出的是画面内容 tag；画师名只在 WD 体系里稳定存在。
  return kind === 'artist' ? ['wd'] : ['wd', 'camie']
}

/** 查表键：小写、空格并成下划线。'Long Hair' → 'long_hair'。 */
export function normKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

export function unescapeTag(value) {
  return String(value ?? '').replace(ESCAPED_RE, '$1')
}

export function escapeParens(value) {
  return String(value ?? '').replace(/[()]/g, ch => '\\' + ch)
}

/** 中文主名：优先汉字，其次假名；都没有返回 ''（画师多为假名/英文）。 */
export function primaryChineseName(names) {
  if (!Array.isArray(names)) return ''
  for (const name of names) if (typeof name === 'string' && HAN_RE.test(name)) return name
  for (const name of names) if (typeof name === 'string' && KANA_RE.test(name)) return name
  return ''
}

export function formatWeight(weight) {
  return String(Math.round(weight * 100) / 100)
}

export function pickStandard(standards) {
  const list = Array.isArray(standards) ? standards : typeof standards === 'string' ? [standards] : []
  const hasCamie = list.some(item => String(item).toLowerCase() === 'camie')
  const hasWd = list.some(item => String(item).toLowerCase() === 'wd')
  return hasCamie && !hasWd ? 'camie' : 'wd'
}
