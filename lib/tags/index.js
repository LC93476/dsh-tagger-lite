// plan: lib/tags/index.js 组装索引对象（懒加载、单例缓存、按 overlay 指纹热重载）
/**
 * lib/tags/index.js — 对外那个索引对象：装载、懒加载、单例、热重载。
 *
 * 分工：loader.js 只管把 jsonl 读成 entries，matcher.js 只管查询与写法，
 * 这里负责把两者接起来、维护 state、并按创建参数做进程内单例。
 *
 * 单例为什么必要：本机 danbooru 数据 9.9 万条 / 20MB，每建一次索引要读 20MB 文本
 * 并扫一遍全部词条。面板、MCP 工具、HTTP 路由、内置 repair 管线都可能各要一份，
 * 参数相同就没理由重建第二份 —— 一次 Map 常驻，谁都用同一张表。
 * 词表（overlay）改动靠 overlaySignature（文件名 + 大小 + mtime）判定，ensureFresh()
 * 发现指纹变了只重建一份，所有拿到同一实例的调用方一起看到新词。
 */
import path from 'node:path'
import { applyEntries, buildSeedEntries, loadTagEntries, overlaySignature } from './loader.js'
import { createMatcher, parseTerm } from './matcher.js'

/** @type {import('./loader.js').Logger} */
const NOOP_LOG = { info() {}, warn() {}, error() {} }

/** 同一个索引实例的 logger 可以被后来的调用方换掉（单例命中时）。 */
const loggerSetters = new WeakMap()

function makeState() {
  return {
    entries: new Map(),
    aliases: new Map(),
    tagKeys: [],
    byCount: [],
    counts: { general: 0, character: 0, copyright: 0, artist: 0 },
    sourceFiles: [],
    primaryFiles: [],
    overlayFiles: [],
    totals: { parsed: 0, bad: 0 },
    builtAt: '',
    buildMs: 0,
    dataDir: '',
    ready: false,
    seedOnly: true,
    loadPromise: null,
    kicked: false,
    signature: '',
    log: NOOP_LOG,
  }
}

/**
 * @param {import('./loader.js').TagIndexOptions} [options] 数据源配置（形状见 loader.js 的同名 typedef）
 */
function createIndex({ dir, logger, dataDirs, probeDefaults = true } = {}) {
  const state = makeState()
  state.log = logger ?? NOOP_LOG

  /** 单例命中时把 logger 换给已有实例：日志归属跟着最新调用方走。 */
  function setLogger(next) {
    if (next) state.log = next
  }

  // 先装 seed：构造是同步且便宜的，面板第一次请求就有结果。
  applyEntries(state, buildSeedEntries(), {
    sourceFiles: [],
    dataDir: '',
    builtAt: new Date().toISOString(),
    buildMs: 0,
  })

  const matcher = createMatcher(state, kick)

  function kick() {
    if (state.kicked) return
    state.kicked = true
    const timer = setTimeout(() => {
      void ready()
    }, 0)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function runLoad() {
    const started = Date.now()
    try {
      const built = await loadTagEntries({ dir, dataDirs, probeDefaults, includeSeed: true, logger: state.log })
      applyEntries(state, built.entries, {
        sourceFiles: built.sourceFiles,
        primaryFiles: built.primaryFiles,
        overlayFiles: built.overlayFiles,
        dataDir: built.dataDir,
        parsedLines: built.parsedLines,
        badLines: built.badLines,
        buildMs: Date.now() - started,
        builtAt: new Date().toISOString(),
      })
      state.ready = true
      state.signature = overlaySignature(dir)
      state.log.info(
        '标签索引就绪：' + state.entries.size + ' 条（general ' + state.counts.general
        + ' / character ' + state.counts.character + ' / copyright ' + state.counts.copyright
        + ' / artist ' + state.counts.artist + '），来自 '
        + (state.seedOnly ? '内置 seed' : state.dataDir)
        + (state.overlayFiles.length > 0 ? ' + overlay ' + state.overlayFiles.length + ' 个文件' : '')
        + '，' + state.buildMs + 'ms',
      )
      if (state.seedOnly) {
        state.log.warn('没找到 danbooru jsonl，用内置 seed（' + state.entries.size + ' 条）兜底；'
          + '跑 scripts/tags/build-tags.mjs 可把数据归一化到 ' + path.join(dir ?? '', 'tags'))
      }
      if (state.totals.bad > 0) state.log.warn('jsonl 有 ' + state.totals.bad + ' 行解析失败，已跳过。')
    } catch (error) {
      state.ready = true
      state.buildMs = Date.now() - started
      state.log.warn('标签索引构建失败，保留内置 seed：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  function ready() {
    if (state.loadPromise === null) state.loadPromise = runLoad()
    return state.loadPromise
  }

  async function reload() {
    state.loadPromise = null
    state.ready = false
    state.kicked = true
    return ready()
  }

  /** 词表有变动就重建一次索引；没变直接返回 false（一次 stat，成本可忽略）。 */
  async function ensureFresh() {
    const signature = overlaySignature(dir)
    if (signature === state.signature) return false
    if (state.ready === false && state.loadPromise === null) {
      // 首轮构建马上会自己读一遍，不必重复
      return false
    }
    await reload()
    return true
  }

  const api = {
    stats: matcher.stats,
    ready,
    search: matcher.search,
    suggestTags: matcher.suggestTags,
    get: matcher.get,
    canonicalize: matcher.canonicalize,
    canonicalizeMany: matcher.canonicalizeMany,
    parseTagString: matcher.parseTagString,
    formatTagString: matcher.formatTagString,
    toStandard: matcher.toStandard,
    reload,
    ensureFresh,
    parseTerm,
    /** 内部诊断用：当前索引是否只用 seed。 */
    isSeedOnly: () => state.seedOnly,
  }

  loggerSetters.set(api, setLogger)
  kick()
  return api
}

/** 最近创建（或命中）的索引实例，给模块级 suggestTags 复用，避免再建一份 99k 的索引。 */
let lastIndex = null

/** 单例缓存：key 由「数据从哪来」决定，参数一致就复用同一份 Map。 */
const cache = new Map()
/** 最多留几份索引（一份约 10 万条词）；改数据源配置时才可能变多。 */
const CACHE_LIMIT = 4

function toAbs(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? '' : path.resolve(text)
}

/**
 * @param {import('./loader.js').TagIndexOptions} key
 * @returns {string}
 */
function cacheKey({ dir, dataDirs, probeDefaults }) {
  const list = dataDirs === undefined || dataDirs === null ? [] : Array.isArray(dataDirs) ? dataDirs : [dataDirs]
  return JSON.stringify({
    dir: toAbs(dir),
    dataDirs: list.map(toAbs).filter(Boolean),
    probeDefaults: probeDefaults !== false,
  })
}

/**
 * 建（或复用）一个标签索引。
 * 同一个 {dir, dataDirs, probeDefaults} 组合在进程内只有一份表；logger 会跟着最新调用方。
 * @param {import('./loader.js').TagIndexOptions} [options]
 */
export function createTagIndex({ dir, logger, dataDirs, probeDefaults = true } = {}) {
  const key = cacheKey({ dir, dataDirs, probeDefaults })
  const cached = cache.get(key)
  if (cached !== undefined) {
    loggerSetters.get(cached)?.(logger)
    lastIndex = cached
    return cached
  }
  const index = createIndex({ dir, logger, dataDirs, probeDefaults })
  cache.set(key, index)
  // 数据源配置被改过几次时不至于攒下一堆 99k 的表：只留最近 4 份。
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined || oldest === key) break
    cache.delete(oldest)
  }
  lastIndex = index
  return index
}

/**
 * 清空单例缓存（测试与「用户改了数据源配置」时用）。
 * 已经拿到手的实例不受影响，只是下一次 createTagIndex 会重新建一份。
 */
export function resetTagIndexCache() {
  cache.clear()
  lastIndex = null
}

/**
 * 便捷导出：不用先拿实例也能查近邻真词。
 * 复用最近一次 createTagIndex() 建好的索引；还没有实例时才自己建一个（懒加载）。
 * 已经有实例的调用方应优先用 index.suggestTags(raw, limit) —— 免得多建一份索引。
 * @param {string} raw 写歪的/未收录的词
 * @param {number} [limit]
 * @param {{ tags?: object }} [opts] tags 显式指定索引
 */
export function suggestTags(raw, limit = 5, opts = {}) {
  const index = opts.tags ?? lastIndex ?? createTagIndex({ logger: null })
  if (!index || typeof index.suggestTags !== 'function') return []
  return index.suggestTags(raw, limit, opts)
}

export default createTagIndex
