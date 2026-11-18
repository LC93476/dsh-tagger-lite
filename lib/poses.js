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
    const key = roots.map(root => {
      try { return root.file + ':' + fs.statSync(root.file).mtimeMs } catch { return root.file + ':0' }
    }).join('|')
    if (key === cache.key) return cache.poses
    const poses = []
    const at = new Map()
    for (const root of roots) {
      for (const pose of parseCatalog(root.file, root.set)) {
        const index = at.get(pose.id)
        if (index === undefined) { at.set(pose.id, poses.length); poses.push(pose); continue }
        // 同一个 id 会同时出现在 all / standard / sexy 里：留更具体的那个体系
        if (poses[index].set === 'all' && pose.set !== 'all') poses[index] = pose
      }
    }
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
