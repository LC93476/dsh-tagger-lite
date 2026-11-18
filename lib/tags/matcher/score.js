// plan: lib/tags/matcher/score.js 放打分（检索命中分、多词名次分、近邻建议的候选分）
/**
 * lib/tags/matcher/score.js — 权重与评分。
 *
 * 两块分数都在这：检索结果的分（base + 热度对数）与近邻建议的候选分（分隔符/词序/单复数/包含/编辑距离）。
 * 纯函数，只吃 entry 不吃 state，方便单独调参。
 */
import { unescapeTag } from '../text.js'

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
/** 近邻建议的歧义阈值：前两名分差小于它就不给建议（宁可不说）。 */
export const SUGGEST_GAP = 8
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
export function sealForSuggest(value) {
  return unescapeTag(String(value ?? ''))
    .replace(/[\u2018\u2019\u02bc\u2032\u0060\u00b4]/g, "'")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 一个词的单复数候选（含原形，去重）。 */
export function tokenPlurals(token) {
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

export function isPluralToken(token) {
  return token.length >= 3 && token.endsWith('s') && token.endsWith('ss') === false
}

/** run 内所有词的形态组合（用于整词精确查表），上限 cap 个。 */
export function joinForms(tokens, cap) {
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
export function isTokenSubsequence(small, big) {
  let i = 0
  for (const token of big) {
    if (i < small.length && small[i] === token) i += 1
  }
  return i === small.length
}

export function sameMultiset(a, b) {
  if (a.length !== b.length) return false
  const left = a.slice().sort()
  const right = b.slice().sort()
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

/** 逐词比较，允许单复数等价（leg_up ↔ legs_up）。 */
export function looseTokensMatch(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (tokenPlurals(b[i]).includes(a[i]) || tokenPlurals(a[i]).includes(b[i])) continue
    return false
  }
  return true
}

export function isPluralPair(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (tokenPlurals(b[i]).includes(a[i]) === false) return false
  }
  return true
}

export function editDistance(a, b, max) {
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
export function pluralityHint(tokens) {
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
export function scoreSuggestCandidate(key, keyTokens, entry, hint) {
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

/** 检索命中分：词表位置分（base）加上热度对数，热度不压词表位置。 */
export function queryHitScore(base, postCount) {
  return base + Math.log10(postCount + 1) * 1000
}
/** 多词检索里第 index 个词的名次分：越靠前的词越重。 */
export function rankScore(index) {
  return 1 / (index + 1)
}