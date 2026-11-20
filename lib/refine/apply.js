// plan: 把模型差分落到标签串上 —— 标签库校对（canonicalizeMany）、权重夹取、四模式语义过滤、keepOrder 保序与格式化。
import {
  MIN_WEIGHT,
  MAX_WEIGHT,
  INDEX_WAIT_MS,
  INDEX_WAIT_TIMEOUT,
  COLD_INDEX_WARNING,
} from './consts.js'
import {
  isRecord,
  msgOf,
  clampNumber,
  cleanTag,
  formatEntry,
  pushWarn,
  fallbackParseList,
} from './diff.js'

export function makeApply({ cfg, tags, log, syntaxOf }) {
  /** 索引 ready() 是异步的：等最多 INDEX_WAIT_MS，没就绪只记一条 warning，绝不拖死精修。 */
  async function indexReady(warnings) {
    if (tags === undefined || tags === null) return false
    if (typeof tags.ready !== 'function') return true
    try {
      const stats = typeof tags.stats === 'function' ? tags.stats() : undefined
      if (isRecord(stats) && stats.ready === true) {
        if (typeof tags.ensureFresh === 'function') {
          const reloaded = await tags.ensureFresh()
          if (reloaded) log.info('[tagger] 词表有变动，已热重载标签索引')
        }
        return true
      }
      // 计时器用完就取消：否则每次精修都留一个 3s timer 陪跑（真超时由 INDEX_WAIT_TIMEOUT 说话）。
      const wait = indexWaitHandle()
      let state
      try {
        state = await Promise.race([Promise.resolve(tags.ready()), wait.promise])
      } finally {
        wait.cancel()
      }
      if (state === INDEX_WAIT_TIMEOUT) {
        log.warn('[tagger] 标签库 ' + INDEX_WAIT_MS + 'ms 内未构建完，本次按现有索引校对')
        return true
      }
      if (state === false) {
        pushWarn(warnings, COLD_INDEX_WARNING)
        return false
      }
      return true
    } catch (error) {
      log.warn('[tagger] 标签库 ready() 失败：' + msgOf(error))
      pushWarn(warnings, COLD_INDEX_WARNING)
      return false
    }
  }

  /** add 增量走标签库校验；库不可用时原样保留并记账（否则精修在冷启动阶段等于废掉）。 */
  async function canonicalizeAdd(list, warnings) {
    const passthrough = () => list.map(raw => ({ raw, tag: cleanTag(raw), weight: 1, matched: undefined, cn: '' }))
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') {
      pushWarn(warnings, '标签库不可用，新增标签未校对')
      return passthrough()
    }
    const ready = await indexReady(warnings)
    if (ready === false) return passthrough()
    let canon
    try {
      canon = await tags.canonicalizeMany(list, { syntax: syntaxOf() })
    } catch (error) {
      log.warn('[tagger] 标签库校对失败：' + msgOf(error))
      pushWarn(warnings, COLD_INDEX_WARNING)
      return passthrough()
    }
    if (!Array.isArray(canon)) return passthrough()
    return list.map((raw, index) => {
      const hit = isRecord(canon[index]) ? canon[index] : undefined
      if (hit === undefined) return { raw, tag: cleanTag(raw), weight: 1, matched: undefined, cn: '' }
      const tag = typeof hit.tag === 'string' && hit.tag.trim() !== '' ? String(hit.tag).trim() : cleanTag(raw)
      return {
        raw,
        tag,
        weight: typeof hit.weight === 'number' && Number.isFinite(hit.weight) ? hit.weight : 1,
        matched: hit.matched,
        cn: typeof hit.cn === 'string' ? hit.cn : '',
      }
    })
  }

  /** 原串解析：优先用标签库的 parseTagString（认全 (tag:1.2) / tag::1.2 / {{tag}}）。 */
  function parseBaseList(text) {
    if (String(text ?? '').trim() === '') return []
    let rows
    if (tags !== undefined && tags !== null && typeof tags.parseTagString === 'function') {
      try {
        rows = tags.parseTagString(String(text))
      } catch (error) {
        log.warn('[tagger] parseTagString 失败，回退内置解析：' + msgOf(error))
        rows = undefined
      }
    }
    if (!Array.isArray(rows)) rows = fallbackParseList(text)
    const out = []
    for (const row of rows) {
      const tag = cleanTag(row?.tag)
      if (tag === '') continue
      const weight = typeof row?.weight === 'number' && Number.isFinite(row.weight) ? row.weight : 1
      out.push({ tag, weight: clampNumber(weight, MIN_WEIGHT, MAX_WEIGHT, 1) })
    }
    return out
  }


  function formatRows(rows, syntax) {
    if (rows.length === 0) return ''
    if (tags !== undefined && tags !== null && typeof tags.formatTagString === 'function') {
      try {
        const out = tags.formatTagString(rows.map(row => ({ tag: row.tag, weight: row.weight ?? 1 })), { syntax })
        if (typeof out === 'string' && out.trim() !== '') return out.trim()
      } catch (error) {
        log.warn('[tagger] formatTagString 失败，回退内置格式化：' + msgOf(error))
      }
    }
    return rows.map(row => formatEntry(row.tag, row.weight ?? 1, syntax)).join(', ')
  }

  /** 结果补中文名 / 词性（只读，不改用户已有写法）。 */
  async function enrich(rows) {
    if (rows.length === 0) return
    if (tags === undefined || tags === null || typeof tags.canonicalizeMany !== 'function') return
    // 冷启动：索引没建完时 canonicalizeMany 只会回空 cn —— 先等 ready（最多 INDEX_WAIT_MS），prune / weights 不经过 canonicalizeAdd，别漏这一步。
    await indexReady([])
    try {
      const canon = await tags.canonicalizeMany(rows.map(row => row.tag), { syntax: syntaxOf() })
      if (!Array.isArray(canon)) return
      for (let i = 0; i < rows.length; i += 1) {
        const hit = isRecord(canon[i]) ? canon[i] : undefined
        if (hit === undefined) continue
        if (typeof hit.cn === 'string' && hit.cn !== '') rows[i].cn = hit.cn
        if (typeof hit.kind === 'string' && hit.kind !== '' && hit.kind !== 'unknown') rows[i].kind = hit.kind
      }
    } catch (error) {
      log.warn('[tagger] 结果补中文名失败：' + msgOf(error))
    }
  }


  /** 计时器句柄：promise 到点回 INDEX_WAIT_TIMEOUT，cancel 用于 race 先结束时清掉。 */
  function indexWaitHandle() {
    /** @type {any} */
    let timer
    const promise = new Promise(resolve => {
      timer = setTimeout(() => resolve(INDEX_WAIT_TIMEOUT), INDEX_WAIT_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
    const cancel = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
    return { promise, cancel }
  }

  /** 老签名（只给外部要 promise 的地方用），内部一律走 indexWaitHandle 以便取消。 */
  function indexWait() {
    return indexWaitHandle().promise
  }


  return { indexReady, canonicalizeAdd, parseBaseList, formatRows, enrich, indexWait }
}

