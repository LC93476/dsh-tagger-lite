// plan: 未收录词修复器 —— 连字符/撇号/空格/单复数/词序/近邻兜底，只动 matched=false，幂等
//
// 背景：forge 的 canonicalizeAll 只做「精确 + 别名 + 空格归一」，LLM 常写出
//   top-down_bottom_up（库里是 top-down_bottom-up）、worm's-eye_view（库里带下划线）、
//   one_leg_up（库里是 leg_up）这类「差一点就对」的词。它们变成面板 warning、用户手动删词。
// 本模块在 canonicalize 之后、dedupe 之前把这类行就地修成库内真词，并把改不动的留给 warning。
//
// 接线（由 Lead 负责，本文件不碰 forge）：
//   import { createRepairer } from './repair.js'
//   const repairer = createRepairer({ tags, logger })
//   const { rows, fixes, warnings } = await repairer.fix(rows, { described, limit })
//
// 设计原则：
//   1) 只改动 matched === false 的行（或 matched 缺省且库里查不到的行），命中行一律原样传下去；
//   2) 确定性：候选按固定阶梯生成、固定顺序试，先少改动后多改动，同一输入永远同一输出；
//   3) 严格：修不上就原样保留并给 warning，绝不硬猜（ass 不会变成 assault）；
//   4) 幂等：修过的行 matched=true，再跑一次 fixes 必为空；
//   5) 不修改入参 rows（浅拷贝出新对象），weight 及其它字段原样带过去。
// 不联网、不叫 LLM、无第三方依赖。

const APOSTROPHE_RE = /[\u2018\u2019\u02bc\u2032`\u00b4]/g

/** 弹出二进制里 1 的个数，用于「翻最少的分隔符优先」。 */
function bitCount(value) {
  let n = value
  let c = 0
  while (n > 0) {
    n &= n - 1
    c += 1
  }
  return c
}

/** 一个词的单复数形态（含原形，原形排第一）。 */
function tokenForms(token) {
  const out = [token]
  const add = value => {
    if (value.length >= 2 && out.includes(value) === false) out.push(value)
  }
  if (token.length >= 4 && token.endsWith('ies')) add(token.slice(0, -3) + 'y')
  else if (token.length >= 4 && token.endsWith('es')) add(token.slice(0, -2))
  if (token.length >= 3 && token.endsWith('s') && token.endsWith('ss') === false) add(token.slice(0, -1))
  if (token.endsWith('s') === false) add(token + 's')
  if (token.length >= 4 && token.endsWith('y')) add(token.slice(0, -1) + 'ies')
  return out
}

/**
 * 造一个修复器。
 * @param {{ tags?: object, logger?: object }} [options] tags 是 createTagIndex() 的返回值
 * @returns {{ fix: (rows: object[], opts?: object) => Promise<{ rows: object[], fixes: object[], warnings: string[] }> }}
 */
export function createRepairer({ tags, logger } = {}) {
  if (!tags || typeof tags.get !== 'function') {
    throw new Error('createRepairer 需要 tags（createTagIndex 的返回值）')
  }
  const log = logger ?? {}
  const say = (level, ...args) => {
    const fn = log[level]
    if (typeof fn === 'function') {
      try {
        fn.call(log, ...args)
      } catch {
        /* 日志失败不影响修复 */
      }
    }
  }

  // 近邻兜底的置信度下限：52 = 恰好收录「只差单复数」（52）及以上，
  // 「编辑距离 1~2 的手滑」（near，40~50）一律不自动改 —— 宁可不改。
  const MIN_SUGGEST_SCORE = 52
  // 单个词最多枚举多少个候选，防组合爆炸。
  const MAX_COMBOS = 32
  // 一次 fix 默认最多改多少行（剩下的留 warning，用户可调 limit）。
  const DEFAULT_LIMIT = 40

  /** 查库：entries + 别名，返回 entry 或 undefined。 */
  function resolve(value) {
    if (typeof value !== 'string') return undefined
    const text = value.trim()
    if (text === '') return undefined
    const hit = tags.get(text)
    return hit === undefined || hit === null ? undefined : hit
  }

  /** 统一撇号形态（弯引号/希腊撇/重音号 → ASCII '）。 */
  function seal(tag) {
    return String(tag ?? '').trim().replace(APOSTROPHE_RE, "'")
  }

  /** 阶梯 1：连字符 ↔ 下划线。枚举要翻转的分隔符组合，翻得最少的排前面。 */
  function hyphenVariants(tag) {
    const out = []
    const positions = []
    for (let i = 0; i < tag.length; i++) {
      const ch = tag[i]
      if (ch === '_' || ch === '-') positions.push(i)
    }
    if (positions.length === 0 || positions.length > 8) return out
    const masks = []
    const maxMask = 1 << positions.length
    for (let mask = 1; mask < maxMask; mask++) masks.push(mask)
    masks.sort((a, b) => bitCount(a) - bitCount(b) || a - b)
    const seen = new Set([tag])
    for (const mask of masks.slice(0, MAX_COMBOS)) {
      const chars = tag.split('')
      for (let k = 0; k < positions.length; k++) {
        if ((mask & (1 << k)) === 0) continue
        const at = positions[k]
        chars[at] = chars[at] === '_' ? '-' : '_'
      }
      const value = chars.join('')
      if (seen.has(value)) continue
      seen.add(value)
      out.push({ value, how: 'hyphen' })
    }
    return out
  }

  /** 阶梯 2：撇号形态（去掉 / 补上 / 当分隔符）。 */
  function apostropheVariants(tag) {
    const out = []
    const seen = new Set([tag])
    const push = value => {
      if (!value || value === tag || seen.has(value)) return
      seen.add(value)
      out.push({ value, how: 'apostrophe' })
    }
    push(tag.replace(/'/g, '')) // worm's_eye → worms_eye
    push(tag.replace(/'/g, '_')) // worm's_eye → worm_s_eye
    push(tag.replace(/'s(?=_|$)/g, '')) // worm's_eye_view → worm_eye_view
    push(
      tag
        .split('_')
        .map(token => (token.length > 2 && token.endsWith('s') && token.includes("'") === false
          ? token.slice(0, -1) + "'s"
          : token))
        .join('_'),
    ) // worm_s_eye_view / worns_eye_view → worm's_eye_view
    return out
  }

  /** 阶梯 3：空白与多余分隔符归一。 */
  function spacingVariants(tag) {
    const out = []
    const seen = new Set([tag])
    const push = value => {
      if (!value || value === tag || seen.has(value)) return
      seen.add(value)
      out.push({ value, how: 'spacing' })
    }
    push(tag.replace(/[\s.\/\\]+/g, '_')) // 'blue eyes' → blue_eyes
    push(tag.replace(/[\s\-]+/g, '_')) // 空格与连字符都当下划线
    push(tag.replace(/_+/g, '_').replace(/^_+|_+$/g, '')) // 挤掉重复/首尾下划线
    push(tag.replace(/_/g, '')) // blue_eyes → blueeyes（极少命中，留个兜底）
    return out
  }

  /** 阶梯 4：单复数（逐词替换，再兜一次整体替换）。 */
  function pluralVariants(tag) {
    const out = []
    const tokens = tag.split('_').filter(Boolean)
    if (tokens.length === 0 || tokens.length > 8) return out
    const seen = new Set([tag])
    const push = value => {
      if (!value || value === tag || seen.has(value)) return
      seen.add(value)
      out.push({ value, how: 'plural' })
    }
    for (let i = 0; i < tokens.length && out.length < MAX_COMBOS; i++) {
      for (const form of tokenForms(tokens[i])) {
        if (form === tokens[i]) continue
        const next = tokens.slice()
        next[i] = form
        push(next.join('_'))
      }
    }
    // 整个词当单复数处理（leg_up → legs_up 这种把 up 也带上 s 的写法不做，只做首词）
    return out
  }

  /** 阶梯 5：词序（倒序 / 按词长 / 相邻互换）。 */
  function swapVariants(tag) {
    const tokens = tag.split('_').filter(Boolean)
    if (tokens.length < 2 || tokens.length > 4) return []
    const out = []
    const seen = new Set([tag])
    const push = list => {
      const value = list.join('_')
      if (!value || value === tag || seen.has(value)) return
      seen.add(value)
      out.push({ value, how: 'swap' })
    }
    push(tokens.slice().reverse())
    push(tokens.slice().sort((a, b) => b.length - a.length || (a < b ? -1 : 1)))
    for (let i = 0; i + 1 < tokens.length; i++) {
      const next = tokens.slice()
      const tmp = next[i]
      next[i] = next[i + 1]
      next[i + 1] = tmp
      push(next)
    }
    return out
  }

  // 固定阶梯：越靠前的越局部、越可信，命中即停。
  const LADDER = [hyphenVariants, apostropheVariants, spacingVariants, pluralVariants, swapVariants]

  /**
   * 给一个未收录词找一个库内真词。
   * @returns {{ entry: object, how: string } | null}
   */
  function repairOne(tag, opts = {}) {
    const base = seal(tag)
    if (base === '') return null
    for (const gen of LADDER) {
      for (const cand of gen(base)) {
        const entry = resolve(cand.value)
        if (entry !== undefined) return { entry, how: cand.how }
      }
    }
    // 兜底：近邻建议（one_leg_up → leg_up）。阈值严格，且 suggestTags 自己会拒绝歧义。
    if (typeof tags.suggestTags === 'function') {
      const near = tags.suggestTags(base, 2, { described: opts.described })
      const top = Array.isArray(near) ? near[0] : undefined
      if (top && Number(top.score) >= MIN_SUGGEST_SCORE) {
        const entry = resolve(top.tag)
        if (entry !== undefined) return { entry, how: 'suggest' }
      }
    }
    return null
  }

  /** 这一行是否「需要修」：matched === false，或 matched 缺省且库里查不到。 */
  function needsRepair(row) {
    if (row === null || typeof row !== 'object') return false
    const tag = row.tag ?? row.raw
    if (typeof tag !== 'string' || tag.trim() === '') return false
    if (row.matched === false) return true
    if (row.matched === undefined) return resolve(tag) === undefined
    return false
  }

  /**
   * 批量修复。rows 是 canonicalizeAll 之后的行 [{ tag, weight, matched, kind, cn, raw, note }]。
   * @param {object[]} rows
   * @param {{ described?: string, limit?: number }} [opts] limit 是本次最多改几行（默认 40，0 = 只看不改）
   * @returns {Promise<{ rows: object[], fixes: {from:string,to:string,how:string}[], warnings: string[] }>}
   */
  async function fix(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : []
    const rawLimit = Number(opts.limit)
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_LIMIT
    const out = []
    const fixes = []
    const warnings = []
    let applied = 0

    for (const row of list) {
      if (needsRepair(row) === false) {
        out.push(row)
        continue
      }
      const tag = String(row.tag ?? row.raw).trim()
      const shown = String(row.raw ?? tag)
      if (applied >= limit) {
        warnings.push(`${shown} 未收录，已原样保留（已达本次修复上限 ${limit}）`)
        out.push(row)
        continue
      }
      const found = repairOne(tag, opts)
      if (found === null) {
        warnings.push(`${shown} 未收录，已原样保留`)
        out.push(row)
        continue
      }
      const entry = found.entry
      out.push({
        ...row,
        tag: entry.tag,
        matched: true,
        kind: entry.kind,
        cn: entry.cn,
        note: entry.note,
        raw: row.raw ?? tag,
      })
      fixes.push({ from: tag, to: entry.tag, how: found.how })
      applied += 1
      say('info', '[repair]', tag, '→', entry.tag, '(' + found.how + ')')
    }

    return { rows: out, fixes, warnings }
  }

  return { fix }
}

export default createRepairer
