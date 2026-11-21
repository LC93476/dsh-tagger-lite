// plan: 服装 / 人像两个只读参考库：读 ai-pose-gallery-zh 的 catalog.csv，出画廊、出图、出单条

/**
 * lib/refs.js — 服装 / 人像两个只读参考库。
 *
 * 只回答三件事：有哪些参考图可选（画廊 + 分面）、某张图在盘上哪儿（refImage）、
 * 某条记录长什么样（refItem，给 /ref-tags 与面板详情用）。
 * 数据来自 ComfyUI 自制节点 ai-pose-gallery-zh 的 skills/<库>/references/catalog.csv，
 * 根目录与 lib/poses.js 的 poseRoots 同源（comfy.launchDir）—— 换库不用重启，按文件 mtime 重读。
 *
 * 缓存键用「文件 + mtimeMs + size」：只认 mtime 时，同一毫秒内追加内容（或粗粒度文件系统）会读到旧表。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 参考库所在的自制节点目录名（与 lib/poses.js 的 poseRoots 一致）。 */
const NODE_DIR = 'ai-pose-gallery-zh'
/** 每个库的目录清单文件（相对 skills/<库>/）。 */
const CATALOG = path.join('references', 'catalog.csv')
/** 一页默认给多少条、最多多少条。 */
const GALLERY_LIMIT = 120
const GALLERY_LIMIT_MAX = 400
/** id 只允许这些字符：既挡住路径穿越，也挡住 URL 里的花活（真 id 是 SPR-0001 / f71f980dde3）。 */
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/** 参考库错误：带 code，接口层直接映射成 400 / 404 的错码。 */
export class RefError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'RefError'
    this.code = code
  }
}

/**
 * 画廊返回值：成功与失败两个分支形状一致（失败也带 sets/categories/hairs/items 空数组），
 * 调用方（handlers、面板）不用先判 div 再取字段；error / message 只在失败时出现。
 * @typedef {object} RefGallery
 * @property {boolean} ok
 * @property {string} [error] bad-kind / no-ref-library
 * @property {string} [message] 给人看的原因
 * @property {string} kind
 * @property {number} total 过滤后的总数
 * @property {number} shown 本页条数
 * @property {number} offset
 * @property {{ key: string, label: string, count: number }[]} sets 分面：首项恒 all
 * @property {{ key: string, count: number }[]} categories 分类 / 分区分面
 * @property {{ key: string, count: number }[]} hairs 发长分面（服装库空）
 * @property {any[]} items 本页记录
 */

/**
 * @typedef {{ key: string, dir: string }} RefSet 一个库目录（skills/<dir>）
 * @typedef {object} RefKind
 * @property {string} label 中文名
 * @property {RefSet[]} sets 目录清单（服装两个库合并成一个画廊）
 * @property {string} thumb 缩略图目录（相对库根，人像库没有缩略图给空串）
 * @property {string} image 原图目录（相对库根）
 * @property {string} mediaType 图片 MIME
 */

/** 两个只读库的目录布局。key 就是接口里的 kind 值。 @type {Record<string, RefKind>} */
export const REF_KINDS = {
  costume: {
    label: '服装参考',
    sets: [
      { key: 'costume', dir: 'costume-reference' },
      { key: 'sexy', dir: 'costume-reference-sexy' },
    ],
    thumb: 'thumbs/costume',
    image: 'img/costume',
    mediaType: 'image/webp',
  },
  portrait: {
    label: '人像参考',
    sets: [{ key: 'portrait', dir: 'portrait-reference' }],
    thumb: '',
    image: 'img/portrait',
    mediaType: 'image/webp',
  },
}

/** 参考库根目录（<launchDir>/custom_nodes/ai-pose-gallery-zh）；launchDir 没配给空串。 */
export function refRoot(launchDir) {
  const base = typeof launchDir === 'string' ? launchDir.trim() : ''
  if (base === '') return ''
  return path.join(base, 'custom_nodes', NODE_DIR)
}

/**
 * kind 归一：只认 costume / portrait，大小写与首尾空格容错。
 * @param {any} kind
 * @returns {string} 归一后的 key，认不出给空串
 */
export function refKind(kind) {
  const key = typeof kind === 'string' ? kind.trim().toLowerCase() : ''
  if (key === '') return ''
  return Object.prototype.hasOwnProperty.call(REF_KINDS, key) === true ? key : ''
}

/* ---------- CSV ---------- */

/** 拆一行 CSV（支持双引号包裹与转义的双引号），与 lib/poses.js 同一实现。 */
function splitCsv(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1 } else quoted = false
      } else cur += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(text => text.trim())
}

/** 读一个 CSV 成 [{列名: 值}]；容忍 BOM / CRLF / 空行，读不到给空数组（库不在盘上是常态，不是错误）。 */
function readRows(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  /** @type {Record<string, any>[]} */
  const rows = []
  let head = null
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const cells = splitCsv(line)
    if (head === null) { head = cells; continue }
    /** @type {Record<string, string>} */
    const row = {}
    cells.forEach((cell, index) => { row[head[index] ?? String(index)] = cell })
    rows.push(row)
  }
  return rows
}

/** 服装 catalog → 归一记录（两批库合并按 id 去重，先到先赢；中文标签拆成 cn 数组）。 */
function costumeRows(files) {
  /** @type {Record<string, any>[]} */
  const out = []
  // 同一个 id 在两个库里都出现时只留第一条（先读到的目录赢）：否则 total 与分面都会重复计数
  const seen = new Set()
  for (const file of files) {
    for (const row of readRows(file)) {
      const id = String(row.id ?? '').trim()
      if (id === '' || seen.has(id) === true) continue
      seen.add(id)
      out.push({
        id,
        name: String(row['服装名称'] ?? '').trim(),
        category: String(row['分类'] ?? '').trim(),
        cn: String(row['标签'] ?? '').split(/\s+/).filter(tag => tag !== ''),
        keywords: String(row['英文关键词'] ?? '').trim(),
      })
    }
  }
  return out
}

/** 人像 catalog → 归一记录（热门列是「是」或空）。 */
function portraitRows(files) {
  /** @type {Record<string, any>[]} */
  const out = []
  for (const file of files) {
    for (const row of readRows(file)) {
      const id = String(row.id ?? '').trim()
      if (id === '') continue
      const hot = String(row['热门'] ?? '').trim()
      out.push({
        id,
        partition: String(row['分区'] ?? '').trim(),
        hair: String(row['发长'] ?? '').trim(),
        style: String(row['发型名称'] ?? '').trim(),
        title: String(row['标题'] ?? '').trim(),
        popular: hot === '是' || hot === '1' || hot.toLowerCase() === 'true',
      })
    }
  }
  return out
}

/* ---------- 读盘 + 缓存 ---------- */

/** 缓存键：文件 + mtime + size（库换了 / 加了行，下一次请求就重读）。 */
function catalogKey(files) {
  return files.map(file => {
    try {
      const st = fs.statSync(file)
      return file + ':' + st.mtimeMs + ':' + st.size
    } catch { return file + ':0:0' }
  }).join('|')
}

/** 缓存最多留几个槽（根 × kind）：够覆盖「同时开着两个库目录」，又不会让长跑的进程越吃越多。 */
const CACHE_MAX = 8

/**
 * @typedef {object} RefCacheEntry
 * @property {string} key 文件 + mtime + size 指纹
 * @property {Record<string, any>[]} rows 归一后的全量记录
 * @property {Map<string, Record<string, any>>} byId 单条查找（refItem 走这里，O(1)）
 */

/** @type {Map<string, RefCacheEntry>} */
const cache = new Map()

/** 缓存槽：绝对根 + kind（用 NUL 分隔，路径里不可能出现它）。切库目录不再互相顶掉同一个槽。 */
function slotOf(root, key) {
  return path.resolve(root) + '\u0000' + key
}

/** 按 kind 读全量记录（带缓存）；库目录不在盘上给空数组。 */
function loadRows(root, key) {
  return entryOf(root, key).rows
}

/**
 * 取缓存条目（顺带重建 byId 与淘汰）。
 * Map 的迭代顺序就是插入顺序，超上限时删的第一条正是最早插入的那条。
 */
function entryOf(root, key) {
  const kind = REF_KINDS[key]
  const files = kind.sets.map(set => path.join(root, 'skills', set.dir, CATALOG))
  const next = catalogKey(files)
  const slot = slotOf(root, key)
  const hit = cache.get(slot)
  if (hit !== undefined && hit.key === next) return hit
  const rows = key === 'portrait' ? portraitRows(files) : costumeRows(files)
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map()
  for (const row of rows) if (byId.has(row.id) === false) byId.set(row.id, row)
  /** @type {RefCacheEntry} */
  const entry = { key: next, rows, byId }
  cache.set(slot, entry)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return entry
}

/** 扔掉缓存（测试与 reload 用；库里换了文件其实不用手动清）。 */
export function resetRefCache() {
  cache.clear()
}

/* ---------- 归一化小工具 ---------- */

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function limitOf(value) {
  const num = Number(value)
  if (Number.isFinite(num) === false || num <= 0) return GALLERY_LIMIT
  return Math.min(GALLERY_LIMIT_MAX, Math.floor(num))
}

function offsetOf(value) {
  const num = Number(value)
  if (Number.isFinite(num) === false || num <= 0) return 0
  return Math.floor(num)
}

/** popular 只认这些写着「是」的取值；空 / 0 / false 一律当不要过滤。 */
function boolOf(value) {
  if (value === true) return true
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === '1' || text === 'true' || text === 'yes' || text === '是'
}

/** 查询命中：id / 名称 / 标题 / 发型 / 分类 / 分区 / 英文关键词 / 中文标签，忽略大小写。 */
function matchesQuery(row, needle) {
  if (needle === '') return true
  const parts = [row.id, row.name, row.title, row.style, row.hair, row.category, row.partition, row.keywords]
  for (const part of parts) {
    if (typeof part === 'string' && part.toLowerCase().includes(needle) === true) return true
  }
  // row.cn 是数组（服装「标签」列拆出来的），上面那圈只认字符串 —— 不单列出来，中文标签就搜不到
  if (Array.isArray(row.cn) === true) {
    for (const tag of row.cn) {
      if (typeof tag === 'string' && tag.toLowerCase().includes(needle) === true) return true
    }
  }
  return false
}

/** 分面计数：按数量降序，同数量按 key 升序（面板下拉的顺序不会跳）。 */
function countBy(rows, pick) {
  const map = new Map()
  for (const row of rows) {
    const key = pick(row)
    if (typeof key !== 'string' || key === '') continue
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(entry => ({ key: entry[0], count: entry[1] }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/* ---------- 对外条目 ---------- */

/** 服装条目（坐标是相对 /ref-image 的地址，面板直接塞 img src）。 */
function costumeItem(row) {
  const id = encodeURIComponent(row.id)
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    cn: row.cn,
    keywords: row.keywords,
    thumb: '/ref-image?kind=costume&id=' + id,
    image: '/ref-image?kind=costume&id=' + id + '&size=full',
  }
}

/** 人像条目（没有缩略图，image 直接就是原图）。 */
function portraitItem(row) {
  return {
    id: row.id,
    partition: row.partition,
    hair: row.hair,
    style: row.style,
    title: row.title,
    popular: row.popular === true,
    image: '/ref-image?kind=portrait&id=' + encodeURIComponent(row.id),
  }
}

function itemOf(key, row) {
  return key === 'portrait' ? portraitItem(row) : costumeItem(row)
}

function facetOfRow(key, row) {
  return key === 'portrait' ? row.partition : row.category
}

/* ---------- 画廊 ---------- */

/**
 * 参考库画廊：分面 + 过滤 + 分页。
 * 过滤顺序：q（+ popular）→ 分面计数 → set / hair → 分页。
 * sets 首项恒 { key:'all', label:'全部', count }，其余是分面（服装按分类，人像按分区）；
 * categories 与 sets 去掉 all 后等价（面板只画一个下拉时用 sets 就够）。
 * hairs 只有人像库有内容（服装库恒空数组）：它只跟 q / popular 走，换发长不缩自己的选项。
 * 库不在盘上时回 { ok:false, error:'no-ref-library' }，形状仍完整，调用方不用判空。
 *
 * @param {any} launchDir
 * @param {any} kind
 * @param {any} [options]
 * @returns {RefGallery}
 */
export function refGallery(launchDir, kind, options = {}) {
  const key = refKind(kind)
  const opts = options ?? {}
  const offset = offsetOf(opts.offset)
  const limit = limitOf(opts.limit)
  const shell = { kind: key, total: 0, shown: 0, offset, sets: [], categories: [], hairs: [], items: [] }
  if (key === '') {
    return { ok: false, error: 'bad-kind', message: '不认识的参考库：' + String(kind ?? '') + '（只认 costume / portrait）', ...shell }
  }
  const root = refRoot(launchDir)
  const rows = root === '' ? [] : loadRows(root, key)
  if (rows.length === 0) {
    const where = root === '' ? 'comfy.launchDir 没配' : path.join(root, 'skills')
    return { ok: false, error: 'no-ref-library', message: '参考库读不到：' + where, ...shell }
  }

  const q = textOf(opts.q).toLowerCase()
  const setKey = textOf(opts.set).toLowerCase()
  const hair = textOf(opts.hair)
  const onlyPopular = boolOf(opts.popular)

  let pool = rows.filter(row => matchesQuery(row, q) === true)
  if (key === 'portrait' && onlyPopular) pool = pool.filter(row => row.popular === true)

  const facets = countBy(pool, row => facetOfRow(key, row))
  const sets = [{ key: 'all', label: '全部', count: pool.length }]
  for (const facet of facets) sets.push({ key: facet.key, label: facet.key, count: facet.count })

  let filtered = setKey === '' || setKey === 'all'
    ? pool
    : pool.filter(row => String(facetOfRow(key, row)).toLowerCase() === setKey)
  if (key === 'portrait' && hair !== '') filtered = filtered.filter(row => row.hair === hair)

  const items = filtered.slice(offset, offset + limit).map(row => itemOf(key, row))
  const hairs = key === 'portrait' ? countBy(pool, row => row.hair) : []
  return { ok: true, kind: key, total: filtered.length, shown: items.length, offset, sets, categories: facets, hairs, items }
}

/**
 * 单条记录（/ref-tags 与面板详情用）：id 不合法 / 库里没有都给 null。
 * @param {any} launchDir
 * @param {any} kind
 * @param {any} id
 */
export function refItem(launchDir, kind, id) {
  const key = refKind(kind)
  if (key === '') return null
  const text = textOf(id)
  if (ID_RE.test(text) === false) return null
  const root = refRoot(launchDir)
  if (root === '') return null
  const row = entryOf(root, key).byId.get(text)
  if (row === undefined) return null
  return itemOf(key, row)
}

/* ---------- 出图 ---------- */

/** 解析后的文件必须在库根之内（id 已经白名单过，这层是兜底）。 */
function inside(root, file) {
  const base = path.resolve(root)
  const target = path.resolve(file)
  return target === base || target.startsWith(base + path.sep)
}

/**
 * 参考图在盘上的位置：服装缩略图优先 thumbs/costume，缺了退回原图；人像只有原图。
 * 找不到抛 RefError（code: bad-kind / bad-id / no-ref-library / no-ref-image）。
 * @param {any} launchDir
 * @param {any} kind
 * @param {any} id
 * @param {any} [size] 'full' 直接给原图，其余按缩略图优先
 * @returns {{ file: string, mediaType: string }}
 */
export function refImage(launchDir, kind, id, size) {
  const key = refKind(kind)
  if (key === '') throw new RefError('bad-kind', '不认识的参考库：' + String(kind ?? '') + '（只认 costume / portrait）')
  const text = textOf(id)
  if (ID_RE.test(text) === false) throw new RefError('bad-id', '参考图 id 不合法：' + text)
  const root = refRoot(launchDir)
  if (root === '') throw new RefError('no-ref-library', 'comfy.launchDir 没配，找不到参考库')
  // 库目录整个不在（还是空库）跟「这张图没了」是两件事：前端提示完全不同，错码必须分开报
  if (loadRows(root, key).length === 0) throw new RefError('no-ref-library', '参考库读不到：' + path.join(root, 'skills'))

  const layout = REF_KINDS[key]
  const name = text + '.webp'
  const full = textOf(size).toLowerCase() === 'full'
  /** @type {string[]} */
  const candidates = []
  if (full === false && layout.thumb !== '') candidates.push(path.join(root, layout.thumb, name))
  candidates.push(path.join(root, layout.image, name))

  for (const file of candidates) {
    if (inside(root, file) === false) continue
    try {
      // 必须用 lstat：statSync 会跟到链接目标，库里塞一个指向根外的软链就能把任意 .webp 读出去
      // （inside() 只看链接自身的路径，拦不住真实目标）。链接与非普通文件一律跳过，继续试下一个候选。
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink() === true || st.isFile() !== true) continue
      return { file, mediaType: layout.mediaType }
    } catch { /* 试下一个 */ }
  }
  throw new RefError('no-ref-image', '没有这张参考图：' + key + '/' + text)
}
