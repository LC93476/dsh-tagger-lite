// plan: lib/tags/matcher.js 放查询与写法（canonicalize / search / parse / format / toStandard / suggestTags）
/**
 * lib/tags/matcher.js — 查询与写法这一层：解析、查找、排序、格式化、近邻建议。
 *
 * 只读 state（entries / aliases / tagKeys / byCount / counts），不负责装载数据，
 * 也不创建实例；state 被 loader 整体换掉后，这里的闭包照旧读最新的几张表。
 */
import {
  escapeParens,
  formatWeight,
  kindAllowed,
  normalizeKinds,
  normKey,
  pickStandard,
  unescapeTag,
} from './text.js'

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

// ─────────────────────────────────────────────────────────────────────────────
// 近邻建议（lib/repair.js 的兜底）：未收录词 → 标签库里真有的近邻词。
//
// 只做「高置信」替换，宁可不改。关系与基础分：
//   separator 只差分隔符（worm's-eye_view → worm's_eye_view）      80
//   run       去掉修饰语的整词后缀（one_leg_up → leg_up）            60
//   swap      只差词序（hair_long → long_hair）                      55
//   plural    只差单复数（blue_eye → blue_eyes）                     52
//   contain   多一个限定词、字符差 ≤4                                45
//   near      编辑距离 ≤2 且长度差 ≤2（手滑拼错）                    50-10*d
// 单复数提示（one_ / two_ …）给 ±6 修正，让 one_leg_up 落到 leg_up 而不是 legs_up。
// 第一名领先第二名不足 SUGGEST_GAP 时返回空数组：两个都说得通就不改。
// 只收 general / character / copyright —— 画师名最容易和普通词撞形。

const SUGGEST_MIN_POST = 100
const SUGGEST_MIN_LEN = 4
const SUGGEST_DROP_MAX = 4
const SUGGEST_GAP = 8
// 分数下限：低于它的候选直接丢掉（编辑距离 2 的 near 只有 30 分，纯噪声，别拿来诱惑用户改词）。
const SUGGEST_FLOOR = 40
const SUGGEST_KINDS = new Set(['general', 'character', 'copyright'])
const SUGGEST_SINGULAR = new Set(['one', 'a', 'an', 'single'])
const SUGGEST_PLURAL = new Set(['two', 'three', 'four', 'both', 'many', 'several', 'multiple'])
// 允许从原词前缀裁掉、且不改变语义的词（one_leg_up → leg_up）。
// 只收限定词、数量词、通用修饰语与姿态动词；实词（leg / hair / eyes）绝不在此列，
// 否则会出现 leg_over_shoulder → over_shoulder 这种把主语丢掉的误改。
const SUGGEST_POSTURE_WORDS = new Set([
  'lying', 'laying', 'sitting', 'standing', 'kneeling', 'crouching', 'leaning', 'resting',
])
const SUGGEST_DROP_WORDS = new Set([
  ...SUGGEST_SINGULAR, ...SUGGEST_PLURAL, ...SUGGEST_POSTURE_WORDS,
  'the', 'one', 'both', 'his', 'her', 'their', 'my', 'your', 'its',
  'short', 'long', 'small', 'big', 'large', 'huge', 'tiny', 'full', 'half', 'upper', 'lower',
  'front', 'back', 'left', 'right', 'side', 'closed', 'open', 'slightly', 'very', 'extremely',
  'heavily', 'deep', 'light', 'dark', 'pale', 'bare', 'all', 'more', 'most', 'only', 'just',
])
// 允许裁掉的前缀字符数上限：姿态动词本身较长（sitting_ = 8），单独放宽。
const SUGGEST_DROP_CHAR = 8

/** 匹配用的封印键：撇号统一、分隔符（空格/连字符/下划线）一律折叠成单个下划线。 */
function sealForSuggest(value) {
  return unescapeTag(String(value ?? ''))
    .replace(/[\u2018\u2019\u02bc\u2032\u0060\u00b4]/g, "'")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 一个词的单复数候选（含原形，去重）。 */
function tokenPlurals(token) {
  const out = [token]
  const add = value => {
    if (value.length >= 2 && out.includes(value) === false) out.push(value)
  }
  if (token.length >= 4 && token.endsWith('ies')) add(token.slice(0, -3) + 'y')
  else if (token.length >= 4 && token.endsWith('es')) add(token.slice(0, -2))
  if (token.length >= 3 && token.endsWith('s') && token.endsWith('ss') === false) add(token.slice(0, -1))
  if (token.endsWith('s') === false) add(token + 's')
  return out
}

function isPluralToken(token) {
  return token.length >= 3 && token.endsWith('s') && token.endsWith('ss') === false
}

/** run 内所有词的形态组合（用于整词精确查表），上限 cap 个。 */
function joinForms(tokens, cap) {
  let forms = ['']
  for (const token of tokens) {
    const next = []
    for (const form of forms) {
      for (const variant of tokenPlurals(token)) {
        next.push(form === '' ? variant : form + '_' + variant)
        if (next.length >= cap) break
      }
      if (next.length >= cap) break
    }
    forms = next
  }
  return forms
}

/** small 是否按顺序出现在 big 里（整词比较，不做字符级包含）。 */
function isTokenSubsequence(small, big) {
  let i = 0
  for (const token of big) {
    if (i < small.length && small[i] === token) i += 1
  }
  return i === small.length
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false
  const left = a.slice().sort()
  const right = b.slice().sort()
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

/** 逐词比较，允许单复数等价（leg_up ↔ legs_up）。 */
function looseTokensMatch(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (tokenPlurals(b[i]).includes(a[i]) || tokenPlurals(a[i]).includes(b[i])) continue
    return false
  }
  return true
}

function isPluralPair(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (tokenPlurals(b[i]).includes(a[i]) === false) return false
  }
  return true
}

function editDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1)
    cur[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** 原词里的单复数倾向：one_leg_up → singular，two_leg_up → plural，冲突则为空。 */
function pluralityHint(tokens) {
  let single = false
  let plural = false
  for (const token of tokens) {
    if (SUGGEST_SINGULAR.has(token)) single = true
    if (SUGGEST_PLURAL.has(token)) plural = true
  }
  if (single === plural) return ''
  return plural ? 'plural' : 'singular'
}

/** 给单个候选打分；不像就直接 null。 */
function scoreSuggestCandidate(key, keyTokens, entry, hint) {
  if (entry === undefined || entry === null) return null
  if (SUGGEST_KINDS.has(entry.kind) === false) return null
  if ((entry.postCount ?? 0) < SUGGEST_MIN_POST) return null
  const candKey = sealForSuggest(entry.tag)
  if (candKey === '') return null
  if (candKey === key) return { entry, score: 80, how: 'separator' }
  if (candKey.length < SUGGEST_MIN_LEN) return null
  const candTokens = candKey.split('_').filter(Boolean)
  if (candTokens.length === 0) return null
  const charDiff = key.length - candKey.length
  let base = 0
  let how = ''
  // 前缀裁剪：候选是原词的「尾巴」，被裁掉的词必须整词在白名单里，
  // 且单复数视为等价（two_leg_up 的尾巴 legs_up / leg_up 都算 run）。
  const drops = keyTokens.length - candTokens.length
  if (drops > 0 && drops <= 2 && looseTokensMatch(candTokens, keyTokens.slice(drops))) {
    const dropped = keyTokens.slice(0, drops)
    const dropChars = dropped.join('_').length + 1
    if (dropped.every(token => SUGGEST_DROP_WORDS.has(token)) && dropChars <= SUGGEST_DROP_CHAR) {
      base = dropped.some(token => SUGGEST_POSTURE_WORDS.has(token)) ? 58 : 60
      how = 'run'
    }
  }
  if (how === '' && candTokens.length === keyTokens.length && sameMultiset(candTokens, keyTokens)) {
    base = 55
    how = 'swap'
  }
  if (how === '' && isPluralPair(candTokens, keyTokens)) {
    base = 52
    how = 'plural'
  }
  if (how === '' && charDiff < 0 && -charDiff <= SUGGEST_DROP_MAX && isTokenSubsequence(keyTokens, candTokens)) {
    base = 45
    how = 'contain'
  }
  if (how === '' && Math.abs(charDiff) <= 2 && candKey[0] === key[0]) {
    const dist = editDistance(candKey, key, 2)
    if (dist <= 2) {
      base = 50 - dist * 10
      how = 'near'
    }
  }
  if (how === '') return null
  // 单复数提示：one_leg_up 该落到 leg_up，two_leg_up 该落到 legs_up
  let score = base
  if (hint !== '') {
    const wantsPlural = hint === 'plural'
    const candidatePlural = candTokens.some(isPluralToken)
    score += candidatePlural === wantsPlural ? 6 : -6
  }
  if (score < SUGGEST_FLOOR) return null
  return { entry, score, how }
}

/**
 * @param {object} state 索引状态（loader.applyEntries 维护）
 * @param {Function} kick 懒加载触发（第一次查询就把真实数据读起来）
 */
export function createMatcher(state, kick) {
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

  /** 单段查询的排序实现（多词查询由 search 合并）。 */
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
      const score = base + Math.log10(entry.postCount + 1) * 1000
      const prev = hits.get(entry.tag)
      if (prev === undefined || prev.score < score) hits.set(entry.tag, { entry, score })
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

    return [...hits.values()]
      .sort((a, b) => b.score - a.score || b.entry.postCount - a.entry.postCount)
      .slice(0, limit)
      .map(item => toRow(item.entry))
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
      rows.forEach((row, index) => {
        // 名次分：第 1 名 1 分、第 2 名 1/2 分……与"该词命中数"无关，避免词太泛就压过精确命中。
        const rank = 1 / (index + 1)
        const prev = merged.get(row.tag)
        if (prev === undefined) {
          merged.set(row.tag, { row, tokens: 1, score: rank })
          return
        }
        prev.tokens += 1
        prev.score += rank
        if (row.postCount > prev.row.postCount) prev.row = row
      })
    }
    return [...merged.values()]
      .sort((a, b) => b.tokens - a.tokens || b.score - a.score || b.row.postCount - a.row.postCount)
      .slice(0, limit)
      .map(item => item.row)
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

  function parseTagString(text) {
    return splitTopLevel(String(text ?? ''))
      .map(part => {
        const parsed = parseTerm(part)
        return { tag: parsed.tag, weight: parsed.weight }
      })
      .filter(item => item.tag !== '')
  }

  function formatTagString(list, options = {}) {
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

  function toStandard(tag, standard = 'wd') {
    const mode = standard === 'camie' ? 'camie' : 'wd'
    let text = unescapeTag(String(tag ?? '')).trim().toLowerCase()
    if (text === '') return ''
    if (mode === 'camie') text = text.replace(/_/g, ' ').replace(/\s+/g, ' ')
    else text = text.replace(/\s+/g, '_').replace(/_+/g, '_')
    return escapeParens(text)
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

  /**
   * 近邻建议：给一个未收录（或写歪了）的词，返回标签库里高置信的近邻真词。
   * 返回 [{ tag, cn, matched, kind, postCount, score, how }]，最像的排第一；
   * 候选歧义（前两名分差不足）时返回 []——宁可不改。
   */
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
