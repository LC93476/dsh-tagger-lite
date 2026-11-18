// plan: lib/tags/matcher/index.js 编排 createMatcher（检索/归一/写法/统计/近邻建议）
/**
 * lib/tags/matcher/index.js — matcher 的编排层。
 *
 * 对外只出 createMatcher(state, kick)；查表在 exact.js、打分在 score.js、合并去重在 filter.js、
 * 写法在 format.js、解析在 parse.js。这里只管状态、缓存与流程，热路径不做深拷贝。
 */
import { escapeParens, formatWeight, kindAllowed, normalizeKinds, normKey, pickStandard, unescapeTag } from '../text.js'
import { parseTerm, splitTopLevel } from './parse.js'
import { createExact } from './exact.js'
import {
  SUGGEST_GAP,
  joinForms,
  pluralityHint,
  queryHitScore,
  scoreSuggestCandidate,
  sealForSuggest,
} from './score.js'
import { finalizeHits, finalizeMerged, mergeRanked, pickHit } from './filter.js'
import { formatTagString, parseTagString, toStandard } from './format.js'

/**
 * 造一个标签索引的查询器。state 由 loader 建好，kick 负责「首次使用时把加载跑起来」。
 * @param {object} state 标签索引状态（tags/aliases/lower/byCount…）
 * @param {() => void} kick 触发懒加载
 * @returns {object} { toRow, lookup, suggest, runQuery, search, canonicalize, canonicalizeMany, parseTagString, formatTagString, toStandard, stats, get, suggestTags }
 */
export function createMatcher(state, kick) {
  const exact = createExact(state)
  const { toRow, lowerBound, queryVariants, lookup, suggest } = exact

  function runQuery(query, limit, kinds) {
    if (query === '') {
      const rows = []
      for (const entry of state.byCount) {
        if (!kindAllowed(entry, kinds)) continue
        rows.push(toRow(entry))
        if (rows.length >= limit) break
      }
      return rows
    }
    const keys = queryVariants(query).map(normKey).filter(Boolean)
    const hits = new Map()
    const consider = (entry, base) => {
      if (entry === undefined || !kindAllowed(entry, kinds)) return
      pickHit(hits, entry, queryHitScore(base, entry.postCount))
    }

    for (const key of keys) {
      consider(state.entries.get(key), 100000)
      consider(state.aliases.get(key), 80000)
    }

    // tag 前缀（二分命中一段，段内按热度取舍）
    for (const key of keys) {
      let taken = 0
      for (let i = lowerBound(state.tagKeys, key); i < state.tagKeys.length; i++) {
        const candidate = state.tagKeys[i]
        if (!candidate.startsWith(key)) break
        consider(state.entries.get(candidate), 50000)
        if (++taken >= 500) break
      }
    }

    // tag 包含（结果还不够时才全表扫；顺序按字母，所以只当兜底）
    if (hits.size < limit && keys.length > 0) {
      const needle = keys[0]
      for (const key of state.tagKeys) {
        if (key.includes(needle)) consider(state.entries.get(key), 20000)
        if (hits.size >= limit * 8) break
      }
    }

    // 别名前缀 / 包含（中文与罗马字走这里）
    const skipAliasScan = keys[0].length < 2 && /^[\x00-\x7f]+$/.test(keys[0])
    if (!skipAliasScan) {
      let aliasHits = 0
      for (const [alias, entry] of state.aliases) {
        if (alias.startsWith(keys[0])) {
          consider(entry, 30000)
          if (++aliasHits >= 300) break
        }
      }
      if (hits.size < limit) {
        let containsHits = 0
        for (const [alias, entry] of state.aliases) {
          if (alias.includes(keys[0])) {
            consider(entry, 10000)
            if (++containsHits >= 200) break
          }
        }
      }
    }

    return finalizeHits(hits, limit, toRow)
  }

  /**
   * 查询入口：空格/逗号分隔的多词按"命中词数优先、命中位置其次、热度最后"合并。
   * 面板里用户会打「大胸 泳装」这种，逐词查再合并比整串当 tag 查准得多。
   */
  function search(raw, options = {}) {
    kick()
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 20))
    const kinds = normalizeKinds(options.kinds)
    const query = parseTerm(String(raw ?? '')).tag
    if (query === '') return runQuery('', limit, kinds)
    const parts = query.split(/[\s,]+/).map(part => part.trim()).filter(Boolean)
    if (parts.length <= 1) return runQuery(query, limit, kinds)
    const merged = new Map()
    for (const part of parts) {
      const rows = runQuery(part, Math.min(200, Math.max(limit * 3, 30)), kinds)
      rows.forEach((row, index) => mergeRanked(merged, row, index))
    }
    return finalizeMerged(merged, limit)
  }

  function canonicalize(raw, options = {}) {
    kick()
    const standard = pickStandard(options.standards)
    const parsed = parseTerm(String(raw ?? ''))
    if (parsed.tag === '') {
      return { tag: '', weight: parsed.weight, matched: false, kind: 'unknown', cn: '', note: '空标签' }
    }
    const entry = lookup(parsed.tag)
    if (entry === undefined) {
      const hint = suggest(parsed.tag)
      return {
        tag: toStandard(parsed.tag, standard),
        weight: parsed.weight,
        matched: false,
        kind: 'unknown',
        cn: '',
        note: hint === '' ? '未收录，已原样保留' : '未收录，相近标签：' + hint,
      }
    }
    return {
      tag: toStandard(entry.tag, standard),
      weight: parsed.weight,
      matched: true,
      kind: entry.kind,
      cn: entry.cn ?? '',
      note: entry.note ?? '',
    }
  }

  function canonicalizeMany(list, options = {}) {
    kick()
    const input = Array.isArray(list) ? list : typeof list === 'string' ? splitTopLevel(list) : []
    const rows = []
    for (const item of input) {
      const raw = typeof item === 'string' ? item : item !== null && typeof item === 'object' && typeof item.tag === 'string' ? item.tag : ''
      if (String(raw).trim() === '') continue
      const result = canonicalize(raw, { standards: options.standards, syntax: options.syntax })
      rows.push({ raw: String(raw).trim(), tag: result.tag, weight: result.weight, matched: result.matched, kind: result.kind, cn: result.cn, note: result.note })
    }
    return rows
  }

  function stats() {
    return {
      loaded: state.entries.size,
      ready: state.ready,
      general: state.counts.general,
      character: state.counts.character,
      copyright: state.counts.copyright,
      artist: state.counts.artist,
      total: state.entries.size,
      sourceFiles: state.sourceFiles.slice(),
      primaryFiles: state.primaryFiles.slice(),
      overlayFiles: state.overlayFiles.slice(),
      dataDir: state.dataDir,
      seedOnly: state.seedOnly,
      builtAt: state.builtAt,
      buildMs: state.buildMs,
      badLines: state.totals.bad,
      parsedLines: state.totals.parsed,
      aliasCount: state.aliases.size,
    }
  }

  function get(raw) {
    const entry = lookup(String(raw ?? ''))
    return entry === undefined ? undefined : toRow(entry)
  }

  function suggestTags(raw, limit = 5, opts = {}) {
    kick()
    const max = Math.min(20, Math.max(1, Number(limit) || 5))
    const key = sealForSuggest(raw)
    if (key === '') return []
    if (lookup(String(raw ?? '')) !== undefined) return [] // 原词本身就能查到，不需要建议
    const keyTokens = key.split('_').filter(Boolean)
    if (keyTokens.length === 0) return []
    const hint = pluralityHint(keyTokens)
    const pool = new Map()
    const consider = entry => {
      const scored = scoreSuggestCandidate(key, keyTokens, entry, hint)
      if (scored === null) return
      const prev = pool.get(scored.entry.tag)
      if (prev === undefined || prev.score < scored.score) pool.set(scored.entry.tag, scored)
    }

    // 1) 整词窗口：原词的每一段连续词（含单复数形态）精确查表，最准也最省
    for (let start = 0; start < keyTokens.length; start++) {
      for (let end = start + 1; end <= keyTokens.length; end++) {
        for (const form of joinForms(keyTokens.slice(start, end), 24)) {
          consider(state.entries.get(form))
          consider(state.aliases.get(form))
        }
      }
    }

    // 2) 词序互换：倒序 / 按词长排序各查一次（只对短词做，避免组合爆炸）
    if (keyTokens.length >= 2 && keyTokens.length <= 4) {
      const reversed = keyTokens.slice().reverse()
      for (const form of joinForms(reversed, 8)) consider(state.entries.get(form))
      const byLength = keyTokens.slice().sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      for (const form of joinForms(byLength, 8)) consider(state.entries.get(form))
    }

    // 3) 首几个词的前缀池：兜住拼写接近与「多了个限定词」
    for (const token of keyTokens.slice(0, 3)) {
      let taken = 0
      for (let i = lowerBound(state.tagKeys, token); i < state.tagKeys.length; i++) {
        const candidate = state.tagKeys[i]
        if (candidate.startsWith(token) === false) break
        consider(state.entries.get(candidate))
        if (++taken >= 400) break
      }
    }

    // 4) 热度前 2000：兜住第一个词就拼错的（siver_hair → silver_hair）
    const top = Math.min(state.byCount.length, 2000)
    for (let i = 0; i < top; i++) consider(state.byCount[i])

    const ranked = [...pool.values()].sort((a, b) => b.score - a.score
      || (b.entry.postCount ?? 0) - (a.entry.postCount ?? 0)
      || (a.entry.tag < b.entry.tag ? -1 : 1))
    if (ranked.length === 0) return []
    if (ranked.length > 1 && ranked[0].score - ranked[1].score < SUGGEST_GAP) return []
    return ranked.slice(0, max).map(item => ({
      tag: item.entry.tag,
      cn: item.entry.cn ?? '',
      matched: true,
      kind: item.entry.kind,
      postCount: item.entry.postCount ?? 0,
      score: item.score,
      how: item.how,
    }))
  }

  return {
    toRow,
    lookup,
    suggest,
    runQuery,
    search,
    canonicalize,
    canonicalizeMany,
    parseTagString,
    formatTagString,
    toStandard,
    stats,
    get,
    suggestTags,
  }
}
