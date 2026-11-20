/**
 * 姿势库目录：读 ComfyUI 自制节点 ai-pose-gallery-zh 的 catalog.csv。
 * 只做「有哪些姿势可选」这件事 —— 选中的 id 写进工作流的 image_id，其余交给 ComfyUI。
 */
import fs from 'node:fs'
import path from 'node:path'

const CATALOG = 'references/catalog.csv'

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

function parseCatalog(file, set) {
  const rows = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return rows }
  const lines = text.split(/\r?\n/)
  let head = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const cells = splitCsv(line)
    if (head === null) { head = cells; continue }
    const row = {}
    cells.forEach((cell, index) => { row[head[index] ?? String(index)] = cell })
    const id = String(row.id ?? '')
    if (id === '') continue
    rows.push({
      id,
      set,
      system: String(row.体系 ?? ''),
      category: String(row.分类 ?? ''),
      code: String(row.姿势编号 ?? ''),
      name: String(row.姿势名称 ?? ''),
      angle: String(row.角度 ?? ''),
      // 图片列原样留着：画廊组里要把它带出去（路径相对 catalog，前端自己拼）
      image: String(row.图片 ?? ''),
    })
  }
  return rows
}

export function poseRoots(launchDir) {
  const base = typeof launchDir === 'string' ? launchDir.trim() : ''
  if (base === '') return []
  const skills = path.join(base, 'custom_nodes', 'ai-pose-gallery-zh', 'skills')
  let names = []
  try { names = fs.readdirSync(skills) } catch { return [] }
  return names
    .filter(name => name.startsWith('pose-reference'))
    .map(name => ({ set: name.replace('pose-reference-', ''), file: path.join(skills, name, CATALOG) }))
}


/** 缓存键：文件 + mtime + size。只认 mtime 时，同一毫秒内追加内容（或粗粒度文件系统）会读到旧表。 */
function catalogKey(roots) {
  return roots.map(root => {
    try {
      const st = fs.statSync(root.file)
      return root.file + ':' + st.mtimeMs + ':' + st.size
    } catch { return root.file + ':0' }
  }).join('|')
}

/** 读全部体系并按 id 去重：同一个 id 会同时出现在 all / standard / sexy 里，留更具体的那个体系。 */
function collectPoses(roots) {
  const poses = []
  const at = new Map()
  for (const root of roots) {
    for (const pose of parseCatalog(root.file, root.set)) {
      const index = at.get(pose.id)
      if (index === undefined) { at.set(pose.id, poses.length); poses.push(pose); continue }
      if (poses[index].set === 'all' && pose.set !== 'all') poses[index] = pose
    }
  }
  return poses
}
/**
 * @typedef {object} PoseCatalogOptions
 * @property {{ comfy?: { launchDir?: string } }} [config] 宿主配置（只需要 comfy.launchDir）
 * @property {{ info?: (...args: any[]) => void }} [logger] 日志口子，可缺
 */

/** 姿势目录：按需读盘 + 按文件 mtime 缓存，姿势库换了不用重启。
 * @param {PoseCatalogOptions} [options]
 */
export function createPoseCatalog({ config, logger } = {}) {
  let cache = { key: '', poses: [] }

  function load() {
    const launchDir = config?.comfy?.launchDir ?? ''
    const roots = poseRoots(launchDir)
    const key = catalogKey(roots)
    if (key === cache.key) return cache.poses
    const poses = collectPoses(roots)
    cache = { key, poses }
    if (logger !== undefined && poses.length > 0) logger.info?.('姿势目录：' + poses.length + ' 条')
    return poses
  }

  function list(options = {}) {
    const all = load()
    const set = typeof options.set === 'string' ? options.set.trim() : ''
    const q = typeof options.q === 'string' ? options.q.trim().toLowerCase() : ''
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 0
    let poses = all
    if (set !== '') poses = poses.filter(pose => pose.set === set)
    if (q !== '') {
      poses = poses.filter(pose =>
        pose.id.toLowerCase().includes(q) || pose.name.toLowerCase().includes(q) || pose.category.toLowerCase().includes(q))
    }
    const sets = [...new Set(all.map(pose => pose.set))].sort()
    return {
      ok: true,
      total: all.length,
      sets,
      poses: limit > 0 ? poses.slice(0, limit) : poses,
      launchDir: config?.comfy?.launchDir ?? '',
    }
  }

  return { list, reload() { cache = { key: '', poses: [] }; return load().length } }
}

/** 姿势图：优先 img/thumbs/<id>.jpg（220px 缩略图），没有就退回 img/<id>.png。 */
export function poseImage(launchDir, id) {
  const base = typeof launchDir === 'string' ? launchDir.trim() : ''
  if (base === '' || typeof id !== 'string' || /^[A-Za-z0-9_-]{1,80}$/.test(id) === false) return null
  const imgDir = path.join(base, 'custom_nodes', 'ai-pose-gallery-zh', 'img')
  const candidates = [
    { file: path.join(imgDir, 'thumbs', id + '.jpg'), contentType: 'image/jpeg' },
    { file: path.join(imgDir, id + '.png'), contentType: 'image/png' },
  ]
  for (const item of candidates) {
    try {
      if (fs.statSync(item.file).isFile()) return item
    } catch { /* 试下一个 */ }
  }
  return null
}

/* ---------- 画廊聚合：把 catalog 行按「同一个姿势的不同角度」聚成组（面板的姿势选择器用） ---------- */

/** id 末尾的角度后缀 → 中文角度。catalog 的「角度」列就是这套词。 */
export const ANGLE_SUFFIX = { _front: '正面', _diag: '斜侧', _side: '侧面', _high: '俯视', _low: '仰视' }

/** 体系（pose-reference-<set>）→ 面板显示名。 */
export const SET_LABELS = {
  standard: '全身单人·标准系',
  sexy: '全身单人·性感系',
  upper: '上半身单人',
  couple: '双人缠绵',
}

const OTHER_SET = 'other'
const OTHER_SET_LABEL = '其他'
/** 一页默认给多少组、最多多少组。 */
const GALLERY_LIMIT = 120
const GALLERY_LIMIT_MAX = 400
/** 角度固定顺序：正面打头，面板按这个顺序画角度切换。 */
const GALLERY_ANGLES = Object.values(ANGLE_SUFFIX)

/**
 * id 前缀 → 体系。按前缀判，不按目录判：pose-reference-all 里混着所有体系。
 * 真 catalog 的前缀是 upper80v2 / full_single / full_sexy / pair60；full_standard、full_couple 是历史写法，一并认。
 */
const SET_PREFIXES = [
  { re: /^upper/i, set: 'upper' },
  { re: /^full_single/i, set: 'standard' },
  { re: /^full_standard/i, set: 'standard' },
  { re: /^full_sexy/i, set: 'sexy' },
  { re: /^full_couple/i, set: 'couple' },
  { re: /^pair\d*/i, set: 'couple' },
]

/** id → 体系 key（认不出的给 'other'）。 */
export function setOfId(id) {
  const text = typeof id === 'string' ? id : ''
  if (text === '') return OTHER_SET
  for (const entry of SET_PREFIXES) if (entry.re.test(text) === true) return entry.set
  return OTHER_SET
}

/** id 去掉角度后缀 → 组 key（full_sexy_P016_side → full_sexy_P016）。 */
export function baseOfId(id) {
  const text = typeof id === 'string' ? id : ''
  if (text === '') return ''
  for (const suffix of Object.keys(ANGLE_SUFFIX)) {
    if (text.endsWith(suffix) === true) return text.slice(0, -suffix.length)
  }
  return text
}

function labelOf(set) {
  return SET_LABELS[set] ?? OTHER_SET_LABEL
}

function angleRank(angle) {
  const index = GALLERY_ANGLES.indexOf(angle)
  return index === -1 ? GALLERY_ANGLES.length : index
}

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

/** 把 catalog 行聚成组；组内 variant 按 正面 → 斜侧 → 侧面 → 俯视 → 仰视 排（catalog 行序不可靠）。 */
function groupPoses(poses) {
  const map = new Map()
  for (const pose of poses) {
    const base = baseOfId(pose.id)
    let group = map.get(base)
    if (group === undefined) {
      const set = setOfId(pose.id)
      group = { base, code: pose.code, name: pose.name, set, setLabel: labelOf(set), category: pose.category, variants: [] }
      map.set(base, group)
    }
    group.variants.push({
      id: pose.id,
      angle: pose.angle,
      thumb: '/tagger/api/pose-thumb?id=' + encodeURIComponent(pose.id),
      image: pose.image ?? '',
    })
  }
  const groups = [...map.values()]
  for (const group of groups) group.variants.sort((a, b) => angleRank(a.angle) - angleRank(b.angle))
  return groups
}

function matchSet(group, setKey) {
  return setKey === '' || setKey === 'all' || group.set === setKey
}

function matchCategory(group, category) {
  return category === '' || group.category === category
}

function matchAngle(group, angle) {
  if (angle === '') return true
  return group.variants.some(variant => variant.angle === angle)
}

function matchQuery(group, q) {
  if (q === '') return true
  const hay = [group.name, group.code, group.base, group.category].join('\n').toLowerCase()
  if (hay.includes(q) === true) return true
  return group.variants.some(variant => variant.id.toLowerCase().includes(q) === true)
}

function countCategories(groups) {
  const map = new Map()
  for (const group of groups) map.set(group.category, (map.get(group.category) ?? 0) + 1)
  return [...map.entries()]
    .map(entry => ({ key: entry[0], count: entry[1] }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 画廊缓存：与 createPoseCatalog 同一种键（文件 + mtime + size），换了姿势库下一次就重读。 */
let galleryCache = { key: '', poses: [] }

function galleryPoses(launchDir) {
  const roots = poseRoots(launchDir)
  const key = catalogKey(roots)
  if (key === galleryCache.key) return galleryCache.poses
  const poses = collectPoses(roots)
  galleryCache = { key, poses }
  return poses
}

/**
 * 姿势画廊（面板用）：分组 + 过滤 + 分页。
 * 过滤顺序：set → category → angle（组里只留这个角度的 variant）→ q → 分页。
 * sets 的 count 一律是「组数」，all 永远排第一；categories 按组数降序。
 * @param {{ set?: string, q?: string, category?: string, angle?: string, limit?: number, offset?: number, launchDir?: string }} [options]
 * @returns {{ total: number, shown: number, offset: number, sets: object[], categories: object[], angles: string[], groups: object[] }}
 *   groups[i] = { base, code, name, set, setLabel, category, count, variants: [{ id, angle, thumb, image }] }
 */
export function poseGallery(options = {}) {
  const launchDir = textOf(options.launchDir)
  const all = groupPoses(galleryPoses(launchDir))
  const setKey = textOf(options.set)
  const category = textOf(options.category)
  const angle = textOf(options.angle)
  const q = textOf(options.q).toLowerCase()
  const limit = limitOf(options.limit)
  const offset = offsetOf(options.offset)

  // sets 在 category / angle / q 之后、set 之前算：切换体系时各档数字不跟着跳
  const counted = all.filter(group => matchCategory(group, category) === true
    && matchAngle(group, angle) === true
    && matchQuery(group, q) === true)
  const sets = [{ key: 'all', label: '全部', count: counted.length }]
  for (const key of Object.keys(SET_LABELS)) {
    const count = counted.filter(group => group.set === key).length
    if (count > 0) sets.push({ key, label: SET_LABELS[key], count })
  }
  const otherCount = counted.filter(group => group.set === OTHER_SET).length
  if (otherCount > 0) sets.push({ key: OTHER_SET, label: OTHER_SET_LABEL, count: otherCount })

  // categories 在 set 之后、category 之前算：分类下拉跟着当前体系走
  const categories = countCategories(all.filter(group => matchSet(group, setKey) === true))

  const filtered = counted.filter(group => matchSet(group, setKey) === true)
  const groups = filtered.slice(offset, offset + limit).map(group => {
    const variants = angle === '' ? group.variants : group.variants.filter(variant => variant.angle === angle)
    return {
      base: group.base,
      code: group.code,
      name: group.name,
      set: group.set,
      setLabel: group.setLabel,
      category: group.category,
      count: variants.length,
      variants,
    }
  })

  return { total: filtered.length, shown: groups.length, offset, sets, categories, angles: [...GALLERY_ANGLES], groups }
}
