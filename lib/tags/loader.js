// plan: lib/tags/loader.js 负责数据源探测、jsonl 流式读取、overlay 合并、seed 与指纹
/**
 * lib/tags/loader.js — 数据这一层：找目录、流式读 jsonl、合并 overlay、装 seed、算指纹。
 *
 * 索引对象（lib/tags/index.js）只关心「拿一份 entries + meta」，这里不认识查询逻辑，
 * 也不持有任何实例状态：每次 loadTagEntries() 都新建一张 Map，方便热重载时整体换掉。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  FILE_KINDS,
  KINDS,
  normalizeKind,
  normKey,
  primaryChineseName,
  standardsFor,
} from './text.js'

/**
 * 日志口子：宿主 logger 与测试里的静默 logger 都长这样。
 * @typedef {object} Logger
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 */

/**
 * 数据源配置：createTagIndex / discoverDataDir / loadTagEntries 共用同一份形状。
 * index.js 用 import("./loader.js").TagIndexOptions 交叉引用，别各写一套。
 * @typedef {object} TagIndexOptions
 * @property {string} [dir] 插件数据目录（其下的 tags/*.jsonl 作为第二数据源）
 * @property {string|string[]} [dataDirs] 显式数据目录（优先）
 * @property {boolean} [probeDefaults] 是否探测默认路径（测试要关掉）
 * @property {Logger|null} [logger] 日志口子；null 表示不记
 */

/**
 * 读词条时的开关：在数据源配置上再加「要不要装 seed」「要不要叠 overlay」。
 * @typedef {TagIndexOptions & { includeSeed?: boolean, overlay?: boolean }} LoadTagEntriesOptions
 */

/** 插件根目录。本文件在 lib/tags/ 下，所以要退两级。 */
export function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function buildCandidates({ dir, dataDirs, probeDefaults }) {
  const out = []
  const push = value => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed)
  }
  const explicit = dataDirs === undefined || dataDirs === null ? [] : Array.isArray(dataDirs) ? dataDirs : [dataDirs]
  for (const value of explicit) push(value)
  if (probeDefaults) {
    const home = os.homedir()
    push(process.env.DSH_DANBOORU_DIR)
    push(process.env.DSH_COMFYUI_DATA_DIR)
    push(path.join(home, '.dsh-comfyui-workbench', 'data', 'danbooru'))
    push(path.join(home, '.dsh-comfyui-workbench', 'data'))
    // 便携包自带的词表快照（scripts/release/pack.mjs 打进去的 data/danbooru/*.jsonl）——
    // 换台机器解开就能用全量 99470 词，不必再跑 build-tags。
    push(path.join(pluginRoot(), 'data', 'danbooru'))
    const root = path.resolve(pluginRoot(), '..')
    push(path.join(root, 'dsh-comfyui-workbench', 'data', 'danbooru'))
    push(path.join(root, 'dsh-comfyui-workbench', 'data'))
    push(path.join(process.cwd(), 'dsh-comfyui-workbench', 'data', 'danbooru'))
    push('D:/QUARK/dsh-comfyui-workbench/data/danbooru')
  }
  // 插件自己的归一化副本（scripts/tags/build-tags.mjs 生成）
  if (dir) push(path.join(dir, 'tags'))
  return out
}

export function expandCandidate(value) {
  const base = path.basename(value).toLowerCase()
  if (base === 'danbooru' || base === 'tags') return [value]
  return [value, path.join(value, 'danbooru')]
}

export function fileKindOf(file) {
  const base = path.basename(file).toLowerCase().replace(/\.jsonl$/, '')
  if (FILE_KINDS[base] !== undefined) return FILE_KINDS[base]
  const tokens = base.split(/[^a-z]+/).filter(Boolean)
  for (const token of tokens) if (FILE_KINDS[token] !== undefined) return FILE_KINDS[token]
  return undefined
}

export async function listJsonlFiles(directory) {
  let names
  try {
    names = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files = names
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.jsonl'))
    .map(item => path.join(directory, item.name))
    .filter(file => {
      const base = path.basename(file).toLowerCase()
      return fileKindOf(file) !== undefined || base.includes('danbooru')
    })
  files.sort((a, b) => {
    const ka = fileKindOf(a)
    const kb = fileKindOf(b)
    const ra = ka === undefined ? KINDS.length : KINDS.indexOf(ka)
    const rb = kb === undefined ? KINDS.length : KINDS.indexOf(kb)
    if (ra !== rb) return ra - rb
    return a.localeCompare(b)
  })
  return files
}

/**
 * overlay 目录：插件自带的 data/tags（包内词表）与 <dataDir>/tags（用户补丁）。
 *
 * 为什么要单独一层：discoverDataDir 只取「第一个命中」的目录，本机命中 workbench 的
 * danbooru 数据后，插件自己的 tags/*.jsonl 就再也读不到 —— 补的词条全丢。overlay
 * 无条件叠加在主流之后，merge 规则走 addRecord（只升 postCount、补中文、补别名）。
 */
export function overlayDirs(dir) {
  const out = []
  const push = value => {
    if (typeof value !== 'string' || value.trim() === '') return
    const resolved = path.resolve(value)
    if (!out.includes(resolved)) out.push(resolved)
  }
  push(path.join(pluginRoot(), 'data', 'tags'))
  if (dir) push(path.join(dir, 'tags'))
  return out
}

/** overlay 不限文件名：用户自己起的名字也要能读到。 */
export async function listAllJsonlFiles(directory) {
  let names
  try {
    names = await fsp.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return names
    .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.jsonl'))
    .map(item => path.join(directory, item.name))
    .sort((a, b) => a.localeCompare(b))
}

export async function isFile(target) {
  try {
    const stat = await fsp.stat(target)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * 按契约顺序找数据：显式 dataDirs → 本机 workbench → <dir>/tags → seed。
 * 返回 { dir, files, candidates }；都没有时 dir 为 ''。
 * @param {TagIndexOptions} [options]
 */
export async function discoverDataDir({ dir, dataDirs, probeDefaults = true } = {}) {
  const candidates = buildCandidates({ dir, dataDirs, probeDefaults })
  for (const candidate of candidates) {
    for (const trial of expandCandidate(candidate)) {
      if (/\.jsonl$/i.test(trial)) {
        if (await isFile(trial)) return { dir: path.dirname(trial), files: [trial], candidates }
        continue
      }
      const files = await listJsonlFiles(trial)
      if (files.length > 0) return { dir: trial, files, candidates }
    }
  }
  return { dir: '', files: [], candidates }
}

// ---------------------------------------------------------------- jsonl 读取

export async function readJsonl(file, onRecord) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  let lines = 0
  let bad = 0
  let first = true
  try {
    for await (const line of reader) {
      lines++
      const text = first ? line.replace(/^\uFEFF/, '') : line
      first = false
      if (text.trim() === '') continue
      let record
      try {
        record = JSON.parse(text)
      } catch {
        bad++
        continue
      }
      if (onRecord(record) !== true) bad++
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return { lines, bad }
}

export function addRecord(entries, record, fileKind) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false
  const rawTag = typeof record.tag === 'string' ? record.tag : typeof record.name === 'string' ? record.name : ''
  const key = normKey(rawTag)
  if (key === '') return false
  const kind = normalizeKind(record.kind ?? fileKind)
  const postCount = Number.isFinite(record.postCount)
    ? record.postCount
    : Number.isFinite(record.count)
      ? record.count
      : 0
  const names = []
  const pushName = value => {
    if (typeof value === 'string' && value.trim() !== '') names.push(value.trim())
  }
  if (Array.isArray(record.names)) record.names.forEach(pushName)
  else if (Array.isArray(record.aliases)) record.aliases.forEach(pushName)
  const cnValue = typeof record.cn === 'string'
    ? record.cn.trim()
    : typeof record.chinese === 'string'
      ? record.chinese.trim()
      : ''
  pushName(record.cn)
  pushName(record.chinese)
  const note = typeof record.note === 'string'
    ? record.note
    : typeof record.description === 'string'
      ? record.description
      : ''
  let entry = entries.get(key)
  if (entry === undefined) {
    entry = { tag: key, kind, postCount, names: [], note, cn: cnValue, standards: standardsFor(kind) }
    entries.set(key, entry)
  } else {
    if (postCount > entry.postCount) entry.postCount = postCount
    if (cnValue !== '' && (entry.cn === undefined || entry.cn === '')) entry.cn = cnValue
    if (entry.note === '' && note !== '') entry.note = note
    if (kind !== 'general' && entry.kind === 'general') entry.kind = kind
  }
  for (const name of names) if (!entry.names.includes(name)) entry.names.push(name)
  return true
}

/**
 * 读一组目录里的 jsonl，得到未 finalize 的 entries（names 还在）。
 * @param {LoadTagEntriesOptions} [options]
 */
export async function loadTagEntries({ dir, dataDirs, probeDefaults = true, includeSeed = false, overlay = true, logger } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {} }
  const discovery = await discoverDataDir({ dir, dataDirs, probeDefaults })
  const entries = new Map()
  let badLines = 0
  let parsedLines = 0
  const sourceFiles = []
  for (const file of discovery.files) {
    const fileKind = fileKindOf(file)
    try {
      const result = await readJsonl(file, record => addRecord(entries, record, fileKind))
      badLines += result.bad
      parsedLines += result.lines
      sourceFiles.push(file)
    } catch (error) {
      badLines++
      log.warn('读不动 ' + file + '：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const overlayFiles = []
  if (overlay !== false) {
    const primary = discovery.dir === '' ? '' : path.resolve(discovery.dir)
    for (const candidate of overlayDirs(dir)) {
      if (candidate === primary) continue
      for (const file of await listAllJsonlFiles(candidate)) {
        if (sourceFiles.includes(file)) continue
        try {
          const result = await readJsonl(file, record => addRecord(entries, record, fileKindOf(file)))
          badLines += result.bad
          parsedLines += result.lines
          sourceFiles.push(file)
          overlayFiles.push(file)
        } catch (error) {
          badLines++
          log.warn('读不动 overlay ' + file + '：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
  }
  if (includeSeed) {
    for (const [key, entry] of buildSeedEntries()) if (!entries.has(key)) entries.set(key, entry)
  }
  return {
    entries,
    primaryFiles: discovery.files.slice(),
    sourceFiles,
    overlayFiles,
    dataDir: discovery.dir,
    badLines,
    parsedLines,
    candidates: discovery.candidates,
  }
}

// ---------------------------------------------------------------- seed

/**
 * 内置 seed 词表目录（data/tags/seed/*.jsonl）。
 * 单独一层子目录而不是直接放 data/tags：那层是「overlay 补词」（无条件叠加、会计入 overlayFiles），
 * seed 是「没有大词库时的兜底」（includeSeed 开关、命中的词条要带 seed 标记），两者语义不同 ——
 * 混在同一层会让 seed 词条按 overlay 规则并进真实词库，替换掉现在「只补空位、不覆盖」的行为。
 */
export const SEED_TAG_DIR = path.join(pluginRoot(), 'data', 'tags', 'seed')

let seedRowsCache = null

/** seed 词表文件，按文件名排序（文件名带序号，排序即词条原始顺序）。 */
export function seedTagFiles() {
  let names = []
  try {
    names = fs.readdirSync(SEED_TAG_DIR).filter(name => name.toLowerCase().endsWith('.jsonl'))
  } catch {
    return []
  }
  names.sort((a, b) => a.localeCompare(b))
  return names.map(name => path.join(SEED_TAG_DIR, name))
}

/**
 * 同步读 seed jsonl，得到 [tag, 中文名, postCount, kind, 别名[]] 元组（与抽取前的内置数组逐行同形）。
 * 为什么同步：createTagIndex() 是同步且便宜的，stats() 立刻要有 seed 条数 —— 这里只读 387 行、
 * 模块级缓存一次，不值得为它引入 await。缺目录/坏行都安静跳过，兜底词表不该让索引构造失败。
 * @returns {Array<[string, string, number, string, string[]]>}
 */
export function loadSeedRows() {
  if (seedRowsCache !== null) return seedRowsCache
  /** @type {Array<[string, string, number, string, string[]]>} */
  const rows = []
  for (const file of seedTagFiles()) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const fileKind = fileKindOf(file)
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const raw = line.trim()
      if (raw === '') continue
      let record
      try {
        record = JSON.parse(raw)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
      const tag = typeof record.tag === 'string' ? record.tag : ''
      if (tag.trim() === '') continue
      const cn = typeof record.cn === 'string' ? record.cn : ''
      const postCount = Number.isFinite(record.postCount) ? record.postCount : Number.isFinite(record.count) ? record.count : 0
      const kind = normalizeKind(record.kind ?? fileKind)
      const aliases = /** @type {string[]} */ (Array.isArray(record.aliases) ? record.aliases.filter(item => typeof item === 'string') : [])
      rows.push([tag, cn, postCount, kind, aliases])
    }
  }
  seedRowsCache = rows
  return rows
}

export function buildSeedEntries() {
  const entries = new Map()
  for (const row of loadSeedRows()) {
    if (!Array.isArray(row) || row.length < 2) continue
    const [tag, cn, postCount, kind, aliases] = row
    const key = normKey(tag)
    if (key === '') continue
    const entryKind = normalizeKind(kind)
    const entry = {
      tag: key,
      kind: entryKind,
      postCount: Number.isFinite(postCount) ? postCount : 0,
      cn: typeof cn === 'string' ? cn.trim() : '',
      note: '',
      names: [],
      seed: true,
      standards: standardsFor(entryKind),
    }
    if (typeof cn === 'string' && cn.trim() !== '') entry.names.push(cn.trim())
    if (Array.isArray(aliases)) {
      for (const alias of aliases) if (typeof alias === 'string' && alias.trim() !== '') entry.names.push(alias.trim())
    }
    entries.set(key, entry)
  }
  return entries
}

// ---------------------------------------------------------------- 索引装配

/**
 * 把 entries 拍平成索引要用的几张表，写进 state。
 * 由 lib/tags/index.js 调用；单独抽出来是为了热重载时整块替换，不必重写对象。
 */
export function applyEntries(state, entries, meta) {
  const aliases = new Map()
  const counts = { general: 0, character: 0, copyright: 0, artist: 0 }
  for (const entry of entries.values()) {
    entry.kind = normalizeKind(entry.kind)
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    if (Array.isArray(entry.names)) {
      const cn = entry.cn !== undefined && entry.cn !== '' ? entry.cn : primaryChineseName(entry.names)
      entry.cn = cn
      const rest = []
      for (const name of entry.names) {
        if (name === cn || rest.includes(name)) continue
        rest.push(name)
      }
      entry.aliases = rest
      delete entry.names
      for (const name of cn === '' ? rest : [cn, ...rest]) {
        const key = normKey(name)
        if (key === '' || key === entry.tag) continue
        const prev = aliases.get(key)
        if (prev === undefined || prev.postCount < entry.postCount) aliases.set(key, entry)
      }
    } else if (!Array.isArray(entry.aliases)) {
      entry.aliases = []
    }
    if (!Array.isArray(entry.standards) || entry.standards.length === 0) entry.standards = standardsFor(entry.kind)
  }
  state.entries = entries
  state.aliases = aliases
  state.tagKeys = [...entries.keys()].sort()
  state.byCount = [...entries.values()].sort((a, b) => b.postCount - a.postCount)
  state.counts = counts
  state.sourceFiles = meta.sourceFiles ?? []
  state.primaryFiles = meta.primaryFiles ?? []
  state.overlayFiles = meta.overlayFiles ?? []
  state.dataDir = meta.dataDir ?? ''
  // overlay 只补词，不算「有真实数据」——seed 兜底判定看主流文件
  state.seedOnly = state.primaryFiles.length === 0
  state.builtAt = meta.builtAt ?? new Date().toISOString()
  state.buildMs = meta.buildMs ?? 0
  state.totals = { parsed: meta.parsedLines ?? 0, bad: meta.badLines ?? 0 }
}

/**
 * overlay 词表（data/tags/*.jsonl 与 <dataDir>/tags/*.jsonl）的指纹：文件名 + 大小 + mtime。
 * 词表是纯文本配置，改完没理由让用户重启整个 app。
 */
export function overlaySignature(dir) {
  const parts = []
  for (const candidate of overlayDirs(dir)) {
    let names = []
    try {
      names = fs.readdirSync(candidate).filter(name => name.toLowerCase().endsWith('.jsonl')).sort()
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(candidate, name))
        parts.push(name + ':' + stat.size + ':' + Math.round(stat.mtimeMs))
      } catch {
        // 文件刚好被删/正在写，下一轮再说
      }
    }
  }
  return parts.join('|')
}
