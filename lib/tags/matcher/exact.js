// plan: lib/tags/matcher/exact.js 放精确/别名词条查找（toRow / lowerBound / queryVariants / lookup / suggest）
/**
 * lib/tags/matcher/exact.js — 词条直查与近邻起点。
 *
 * 只碰 state 上的 maps（tags / lower / lowerKeys / aliases），不做排序也不打分：
 * toRow 出对外行形状，lookup 走 精确 → 小写 → 别名 三级，suggest 给「前缀最近的词表位置」当近邻起点。
 */
import { normKey } from '../text.js'

/**
 * 造一组直接查表的函数。
 * @param {object} state 标签索引状态
 * @returns {{ toRow: (entry: any) => any, lowerBound: (keys: string[], value: string) => number, queryVariants: (value: string) => string[], lookup: (value: string) => any, suggest: (value: string) => string }}
 */
export function createExact(state) {
  function toRow(entry) {
    return {
      tag: entry.tag,
      kind: entry.kind,
      cn: entry.cn ?? '',
      postCount: entry.postCount,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice(0, 8) : [],
      standards: Array.isArray(entry.standards) ? entry.standards.slice() : ['wd'],
      note: entry.note ?? '',
    }
  }

  function lowerBound(keys, value) {
    let lo = 0
    let hi = keys.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (keys[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function queryVariants(value) {
    const base = String(value ?? '').trim().toLowerCase()
    if (base === '') return []
    const set = new Set([base, base.replace(/\s+/g, '_'), base.replace(/_/g, ' ')])
    set.add(base.replace(/[\s_]+/g, ' ').trim())
    return [...set].filter(item => item !== '')
  }

  function lookup(value) {
    for (const variant of queryVariants(value)) {
      const key = normKey(variant)
      if (key === '') continue
      const byTag = state.entries.get(key)
      if (byTag !== undefined) return byTag
      const byAlias = state.aliases.get(key)
      if (byAlias !== undefined) return byAlias
    }
    return undefined
  }

  function suggest(value) {
    const key = normKey(value)
    if (key === '') return ''
    let best = null
    for (let i = lowerBound(state.tagKeys, key); i < state.tagKeys.length; i++) {
      const candidate = state.tagKeys[i]
      if (!candidate.startsWith(key)) break
      const entry = state.entries.get(candidate)
      if (entry !== undefined && (best === null || entry.postCount > best.postCount)) best = entry
    }
    if (best === null) return ''
    return best.cn === '' ? best.tag : best.tag + '（' + best.cn + '）'
  }

  return { toRow, lowerBound, queryVariants, lookup, suggest }
}
