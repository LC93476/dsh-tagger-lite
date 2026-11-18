// 归一与格式化纯函数：把服务端 payload / 用户输入折成面板能直接渲染的形状。
import { LEVELS } from './constants.js'
export function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 单条 tag → 文本：weight 为 1 就不带括号，别把 (tag:1) 糊进 CLIPTextEncode。 */
export function formatTag(item) {
  const tag = String(item?.tag ?? '').trim()
  if (tag === '') return ''
  const weight = Number(item?.weight)
  if (!Number.isFinite(weight) || Math.abs(weight - 1) < 1e-6) return tag
  return '(' + tag + ':' + Math.round(weight * 100) / 100 + ')'
}

export function formatTagLine(list) {
  return (Array.isArray(list) ? list : []).map(formatTag).filter(tag => tag !== '').join(', ')
}

export function normalizeTags(list) {
  return (Array.isArray(list) ? list : [])
    .map(item => {
      const source = typeof item === 'string' ? { tag: item } : item ?? {}
      const weight = Number(source.weight)
      return {
        tag: String(source.tag ?? '').trim(),
        weight: Number.isFinite(weight) ? weight : 1,
        kind: typeof source.kind === 'string' ? source.kind : '',
        cn: typeof source.cn === 'string' ? source.cn : '',
      }
    })
    .filter(item => item.tag !== '')
}

/** 本地三道处理的痕迹：老服务端没有 pipeline 字段，缺了就是空数组，面板不显示这一块。 */
export function normalizePipeline(value) {
  const list = key => (Array.isArray(value?.[key]) ? value[key] : [])
  return {
    repairs: list('repairs')
      .map(item => ({ from: String(item?.from ?? ''), to: String(item?.to ?? ''), how: String(item?.how ?? '') }))
      .filter(item => item.from !== '' && item.to !== ''),
    poseHints: list('poseHints').map(item => ({ tag: String(item?.tag ?? ''), hit: String(item?.hit ?? '') })).filter(item => item.tag !== ''),
    changes: list('changes')
      .map(item => ({ kind: String(item?.kind ?? ''), tag: String(item?.tag ?? ''), reason: String(item?.reason ?? '') }))
      .filter(item => item.tag !== ''),
  }
}

/** 破甲灯只认服务端给的状态；字段缺了按「全开」兜底，不猜模块。 */
export function normalizePurge(value) {
  const level = LEVELS.includes(value?.level) ? value.level : 'full'
  const chars = Number(value?.chars)
  return {
    level,
    enabled: value?.enabled !== false && level !== 'off',
    modules: Array.isArray(value?.modules) ? value.modules.map(item => String(item)) : [],
    chars: Number.isFinite(chars) && chars > 0 ? chars : 0,
  }
}

/** delta 只有三种形状：新增 tag 名、删除 tag 名、调权 {tag, from, to}；形状不对就当空。 */
export function normalizeDelta(value) {
  const text = item => String(item ?? '').trim()
  const num = item => {
    const n = Number(item)
    if (!Number.isFinite(n)) return '?'
    return String(Math.round(n * 100) / 100)
  }
  const names = list => (Array.isArray(list) ? list : [])
    .map(item => (typeof item === 'string' ? item : item?.tag))
    .map(text)
    .filter(item => item !== '')
  const weighted = (Array.isArray(value?.weighted) ? value.weighted : [])
    .map(item => ({ tag: text(item?.tag), from: num(item?.from), to: num(item?.to) }))
    .filter(item => item.tag !== '')
  return { added: names(value?.added), removed: names(value?.removed), weighted }
}

export function chosenStandards(flags) {
  const out = []
  if (flags.wd) out.push('wd')
  if (flags.camie) out.push('camie')
  return out.length > 0 ? out : ['wd', 'camie']
}
