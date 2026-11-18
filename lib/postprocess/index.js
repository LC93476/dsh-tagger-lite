// plan: 流程层 —— 归一化/去重/上下位降权/补人数/裁剪/分桶排序/格式化，createPostProcessor 在此组装。
/**
 * lib/postprocess/index.js — 锻造结果的确定性后处理（流程实现）。
 *
 * 数据（13 段桶表、上下位对、同义组、性别与人数词表）在 lib/postprocess/rules.js；
 * 这里只有逻辑。真实管线顺序（apply 内部）：
 *   normalizeRows → dedupeRows → mergeSupersets → fillSubject → trimRows → orderRows
 * 顺序不能换：先归一化再去重（否则同一 tag 的两种写法各占一个位置）；先去重再合上下位
 * （否则同义词会被降两次权）；先补人数再裁剪（否则刚补上的 1girl 可能被裁掉）；
 * 裁剪之后才排序（裁完的集合才有稳定词序）。
 *
 * 处理原则（重要）：**不删用户可能想要的构图信息**。
 *   - 上位词（lying / standing / from_behind / sex…）只降到 SUPERSET_WEIGHT，仍留在串里；
 *   - 只有**真同义**（from_side / profile 这类同一个意思的两种写法）才删掉弱的那个。
 *
 * 纯函数：不联网、不调 LLM、不读文件；rows 进、rows 出，同样输入跑两遍结果一样（幂等）。
 * 不 import lib/purge.js（避免循环依赖），13 段桶表由 rules.js 提供，与 purge 的「词序」章节一一对应。
 */

import {
  BUCKETS,
  BUCKET_INDEX,
  SUPERSET_PAIRS,
  SYNONYM_GROUPS,
  SUPERSET_WEIGHT,
  COUNT_WORDS,
  COUNT_RE,
  FEMALE_RE,
  MALE_RE,
  MALE_FALSE_POSITIVE_RE,
  EXACT_BUCKET,
  TOKEN_RULES,
} from './rules.js'

// 对外导出面与拆分前完全一致：这里只 re-export 拆分前就是 public 的那些名字，
// COUNT_RE / FEMALE_RE / MALE_RE / MALE_FALSE_POSITIVE_RE 仍是模块内部实现细节。
export {
  BUCKETS,
  BUCKET_INDEX,
  SUPERSET_PAIRS,
  SYNONYM_GROUPS,
  SUPERSET_WEIGHT,
  COUNT_WORDS,
  EXACT_BUCKET,
  TOKEN_RULES,
} from './rules.js'
/** 权重保留两位小数，避免浮点噪声进 prompt。 */
export function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

/** 权重夹到 0.1–2.5（与 lib/forge.js 的 keep() 一致）。 */
export function clampWeight(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 1
  if (num < 0.1) return 0.1
  if (num > 2.5) return 2.5
  return round2(num)
}

/** tag 规范化：去权重后缀、去括号、小写、空格转下划线、压缩下划线。 */
export function normTag(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  // 先剥括号：外层括号把权重后缀包住了，(tag:1.2) 要靠这一步才能露出冒号
  for (let guard = 0; guard < 3; guard += 1) {
    if (text.length > 1 && text[0] === '(' && text[text.length - 1] === ')') text = text.slice(1, -1).trim()
    else break
  }
  // 冒号权重后缀：tag:1.2 / tag::0.8
  const weightMatch = /^(.+?):+:?(-?[0-9]+([.][0-9]+)?)$/.exec(text)
  if (weightMatch) text = weightMatch[1]
  // 反斜杠转义的括号还原（name_\(series\) -> name_(series)）
  text = text.split('\\').join('')
  text = text.toLowerCase()
  text = text.split(' ').join('_')
  text = text.replace(/_+/g, '_')
  text = text.replace(/^_+/, '').replace(/_+$/, '')
  text = text.replace(/^,+|,+$/g, '')
  // 纯数字不是 Danbooru 词（权重残渣 / 噪声），直接判空
  if (/^[0-9]+$/.test(text)) return ''
  return text
}

/** prompt 里的括号必须转义，否则会被当成权重语法。 */
export function escapeParens(text) {
  return String(text == null ? '' : text).split('(').join('\\(').split(')').join('\\)')
}

/** 单行解析：字符串或对象都收，统一成行对象。 */
export function parseRow(input) {
  if (input == null) return null
  if (typeof input === 'string' || typeof input === 'number') {
    const tag = normTag(input)
    if (!tag) return null
    const weightMatch = /^(.+?):(-?[0-9]+([.][0-9]+)?)$/.exec(String(input).trim())
    const weight = weightMatch ? clampWeight(weightMatch[2]) : 1
    return { tag, weight }
  }
  if (typeof input !== 'object') return null
  const rawTag = input.tag != null ? input.tag : input.raw
  const tag = normTag(rawTag)
  if (!tag) return null
  const weightMatch = /^(.+?):(-?[0-9]+([.][0-9]+)?)$/.exec(String(rawTag == null ? '' : rawTag).trim())
  const weight = clampWeight(input.weight != null ? input.weight : (weightMatch ? weightMatch[2] : 1))
  const row = { tag, weight }
  if (input.kind != null) row.kind = input.kind
  if (input.cn != null && input.cn !== '') row.cn = input.cn
  if (typeof input.matched === 'boolean') row.matched = input.matched
  if (input.source != null) row.source = input.source
  return row
}

/** 规则表左列允许正则或纯字符串：统一判定，结果与 re.test(key) 一致。 */
function testRule(re, key) {
  if (re instanceof RegExp) return re.test(key)
  const needle = typeof re === 'string' ? re : String(re)
  return needle !== '' && String(key).indexOf(needle) >= 0
}

/** 桶归类：精确表 -> 词根规则 -> other。 */
export function classifyBucket(tag) {
  const key = normTag(tag)
  if (!key) return 'other'
  if (Object.prototype.hasOwnProperty.call(EXACT_BUCKET, key)) return EXACT_BUCKET[key]
  for (const [re, bucket] of TOKEN_RULES) {
    if (testRule(re, key)) return bucket
  }
  return 'other'
}

/** 桶的中文名，报告里用。 */
export function bucketLabel(key) {
  const found = BUCKETS.find(function (bucket) { return bucket.key === key })
  return found ? found.label : key
}

/** 行规范化：吞字符串 / 对象，丢掉空行与明确 unmatched 的行。 */
export function normalizeRows(input) {
  const list = Array.isArray(input) ? input : []
  const rows = []
  const changes = []
  for (const item of list) {
    const row = parseRow(item)
    if (!row) continue
    // matched === false 表示锻造阶段就没在库里命中；留着只会污染 prompt
    if (row.matched === false) {
      changes.push({ kind: 'dedupe', tag: row.tag, reason: 'unmatched', detail: 'not-in-library' })
      continue
    }
    rows.push(row)
  }
  return { rows, changes }
}

/** 同 tag 去重：保留最大权重，顺带补 cn。 */
export function dedupeRows(rows) {
  const seen = new Map()
  const out = []
  const changes = []
  for (const row of rows) {
    const prev = seen.get(row.tag)
    if (!prev) {
      seen.set(row.tag, row)
      out.push(row)
      continue
    }
    const weight = Math.max(prev.weight, row.weight)
    changes.push({ kind: 'dedupe', tag: row.tag, reason: 'duplicate', weight: round2(weight) })
    if (weight > prev.weight) prev.weight = weight
    if (!prev.cn && row.cn) prev.cn = row.cn
  }
  return { rows: out, changes }
}

/**
 * 上下位合并 + 真同义去重。
 * 上位词只降权到 SUPERSET_WEIGHT（用 min 不用乘法，跑两遍不会再掉），下位词原样留下。
 */
export function mergeSupersets(rows) {
  const byTag = new Map()
  for (const row of rows) byTag.set(row.tag, row)
  const changes = []
  const removed = new Set()

  for (const pair of SUPERSET_PAIRS) {
    const general = byTag.get(pair[0])
    const specific = byTag.get(pair[1])
    if (!general || !specific) continue
    const target = round2(Math.min(general.weight, SUPERSET_WEIGHT))
    if (target < general.weight) {
      changes.push({
        kind: 'superset',
        tag: general.tag,
        reason: 'general-term',
        detail: specific.tag,
        weight: target,
      })
      general.weight = target
    }
  }

  for (const group of SYNONYM_GROUPS) {
    const keeperTag = group[0]
    const keeper = byTag.get(keeperTag)
    for (let i = 1; i < group.length; i++) {
      const dup = byTag.get(group[i])
      if (!dup || removed.has(dup.tag)) continue
      if (keeper) {
        keeper.weight = Math.max(keeper.weight, dup.weight)
        if (!keeper.cn && dup.cn) keeper.cn = dup.cn
      }
      removed.add(dup.tag)
      changes.push({ kind: 'dedupe', tag: dup.tag, reason: 'synonym', detail: keeperTag })
    }
  }

  if (!removed.size) return { rows, changes }
  return { rows: rows.filter(function (row) { return !removed.has(row.tag) }), changes }
}

/** 从白话里读性别与「多人」线索。先剔掉「其他 / 其它 / 吉他」里的「他」，免得误判成男性。 */
export function detectGender(described) {
  const text = String(described == null ? '' : described)
  if (!text.trim()) return { female: false, male: false, multiple: false }
  const maleText = text.replace(MALE_FALSE_POSITIVE_RE, '')
  return {
    female: FEMALE_RE.test(text),
    male: MALE_RE.test(maleText),
    multiple: /两个|两位|俩人|三人|三个|四位|多人|一群|双人|情侣|群像|多女|多男/.test(text),
  }
}

/**
 * 补人数：只补 1girl / 1boy，且只在「一个人数词都没有」时补。
 * 出现 hetero / 2girls / multiple / solo 等任何人数词一律不动 —— 人数已经被表达过，
 * 再塞一个 1girl 就会和自己打架（真机事故就是这么来的）。
 */
export function fillSubject(rows, described, options) {
  const config = options || {}
  const changes = []
  const hasCount = rows.some(function (row) {
    return COUNT_WORDS.has(row.tag) || COUNT_RE.test(row.tag)
  })
  if (hasCount) return { rows, changes, skipped: 'count-present' }

  const explicit = config.subject == null ? '' : String(config.subject)
  const genders = detectGender(described)
  const wanted = []
  if (explicit) {
    for (const part of explicit.split(/[,，\s]+/)) {
      const tag = normTag(part)
      if (tag) wanted.push(tag)
    }
  } else if (genders.multiple) {
    return { rows, changes, skipped: 'multiple' }
  } else {
    if (genders.female) wanted.push('1girl')
    if (genders.male) wanted.push('1boy')
  }
  if (!wanted.length) return { rows, changes, skipped: 'no-cue' }

  const filled = []
  for (const tag of wanted) {
    const row = { tag, weight: 1.2, kind: 'count', source: 'fill' }
    filled.push(row)
    changes.push({
      kind: 'fill',
      tag,
      reason: explicit ? 'explicit' : 'gender-cue',
      detail: explicit || described || '',
    })
  }
  return { rows: filled.concat(rows), changes, skipped: null }
}

/** 13 段稳定排序：同段内保持原顺序，服装必然排在镜头之前。 */
export function orderRows(rows) {
  const decorated = rows.map(function (row, index) {
    return { row, index, bucket: BUCKET_INDEX[classifyBucket(row.tag)] }
  })
  decorated.sort(function (a, b) {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    return a.index - b.index
  })
  const out = decorated.map(function (item) { return item.row })
  const changes = []
  const before = rows.map(function (row) { return row.tag }).join(',')
  const after = out.map(function (row) { return row.tag }).join(',')
  if (before !== after) {
    const counts = {}
    for (const item of decorated) {
      const key = BUCKETS[item.bucket].key
      counts[key] = (counts[key] || 0) + 1
    }
    changes.push({ kind: 'order', tag: '', reason: 'bucket-order', detail: after })
    changes.push({ kind: 'buckets', tag: '', reason: 'summary', counts })
  }
  return { rows: out, changes }
}

/** 超上限裁剪：按（段优先, 权重降序, 原序）挑，留下原相对顺序。 */
export function trimRows(rows, maxTags) {
  const limit = Number(maxTags)
  if (!Number.isFinite(limit) || limit <= 0 || rows.length <= limit) return { rows, changes: [] }
  const ranked = rows.map(function (row, index) {
    return { row, index, bucket: BUCKET_INDEX[classifyBucket(row.tag)] }
  })
  ranked.sort(function (a, b) {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    if (b.row.weight !== a.row.weight) return b.row.weight - a.row.weight
    return a.index - b.index
  })
  const keep = new Set()
  for (let i = 0; i < limit; i += 1) keep.add(ranked[i].index)
  const out = []
  const changes = []
  rows.forEach(function (row, index) {
    if (keep.has(index)) out.push(row)
    else changes.push({ kind: 'trim', tag: row.tag, reason: 'over-limit', detail: 'maxTags=' + limit })
  })
  return { rows: out, changes }
}

/** 拼成 prompt 串：优先用 tags.formatTagString，失败时落回本地实现（永不抛）。 */
export function formatRows(rows, options) {
  const config = options || {}
  const syntax = config.syntax || 'comfy'
  const tagIndex = config.tags
  if (tagIndex && typeof tagIndex.formatTagString === 'function') {
    try {
      const text = tagIndex.formatTagString(rows, { syntax, standards: config.standards })
      if (typeof text === 'string') return text
    } catch (err) {
      // lib/tags.js 的格式器挂了也不能把整条管线带崩，落回本地实现
    }
  }
  const parts = []
  for (const row of rows) {
    const tag = escapeParens(row.tag)
    if (syntax === 'plain' || row.weight === 1) parts.push(tag)
    else parts.push('(' + tag + ':' + round2(row.weight) + ')')
  }
  return parts.join(', ')
}

/**
 * 造一个后处理器。
 * @param {{ tags?: object, logger?: object, maxTags?: number }} options tags 是 createTagIndex() 的实例，用于格式化
 * @returns {{ apply: Function, classify: Function, detectGender: Function, fillSubject: Function, orderRows: Function, trimRows: Function, format: Function, buckets: Array<{ key: string, label: string }> }}
 */
export function createPostProcessor(options) {
  const config = options || {}
  const tags = config.tags || null
  const logger = config.logger || null

  function apply(inputRows, opts) {
    const callOpts = opts || {}
    const changes = []
    const normalized = normalizeRows(inputRows)
    changes.push.apply(changes, normalized.changes)
    let rows = normalized.rows

    const deduped = dedupeRows(rows)
    rows = deduped.rows
    changes.push.apply(changes, deduped.changes)

    const merged = mergeSupersets(rows)
    rows = merged.rows
    changes.push.apply(changes, merged.changes)

    const filled = fillSubject(rows, callOpts.described, { subject: callOpts.subject })
    rows = filled.rows
    changes.push.apply(changes, filled.changes)

    const limit = callOpts.maxTags != null ? callOpts.maxTags : config.maxTags
    const trimmed = trimRows(rows, limit)
    rows = trimmed.rows
    changes.push.apply(changes, trimmed.changes)

    const ordered = orderRows(rows)
    rows = ordered.rows
    changes.push.apply(changes, ordered.changes)

    const positive = formatRows(rows, {
      syntax: callOpts.syntax,
      standards: callOpts.standards,
      tags,
    })

    if (logger && typeof logger.debug === 'function' && changes.length) {
      logger.debug('[postprocess] ' + changes.length + ' change(s): ' + changes.map(function (item) { return item.kind }).join(',') + ' | ' + positive)
    }
    return { rows, changes, positive }
  }

  return {
    apply,
    classify: classifyBucket,
    detectGender,
    fillSubject,
    orderRows,
    trimRows,
    format: formatRows,
    buckets: BUCKETS,
  }
}

export default createPostProcessor
