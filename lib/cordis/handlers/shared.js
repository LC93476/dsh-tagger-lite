// plan: 路由表共用的适配层 —— 冷启动等库、标签中文校对、动态 import、参考库 id 校验

/**
 * lib/cordis/handlers/shared.js — 各分组模块共用的小工具。
 *
 * 为什么单独一层：这些函数被三四个分组同时用（中文校对 / 冷启动 / 动态 import），
 * 留在任何一个分组里都会让别的分组反向依赖它。它们只收 rt 与纯数据，不缓存路由状态。
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'

/** /probe 一次最多回这么多 chunk：模型一直吐也不能让探针无限攒内存。 */
const PROBE_CHUNK_LIMIT = 256
/** /probe 整条流的等待上限。 */
const PROBE_TIMEOUT_MS = 30000
/** 标签库冷启动最多等这么久，超时就先用手上有的索引回答。 */
const TAGS_READY_WAIT_MS = 3000
/** 导入工作流时 body.path 允许的最大文件大小。 */
const IMPORT_MAX_BYTES = 10 * 1024 * 1024
/** 参考库 id 口径：与 lib/refs.js 的 ID_RE 同一套语义（那边不导出，这里按同一条规则校验）。 */
export const REF_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

/**
 * 一个路由项。handler 的入参由 lib/routes.js 组装：精确路由给 url/method/body/req，
 * 通配路由（path 以 /* 结尾）额外给 params.rest；测试会直接调 handler 并自带 params，所以四个都标可选。
 * @typedef {{ path: string, methods: string[], handler: (args: { url?: any, method?: any, body?: any, req?: any, params?: any }) => any }} Route
 */

/**
 * 等标签库「建好 + 词表是最新的」：ready() 不存在就不等，ensureFresh 抛错也放过去。
 * 顺序不能反：先 ready 再 ensureFresh，否则 ensureFresh 拿到的是半成品索引。
 * @param {any} rt @returns {Promise<boolean>} 是否真的就绪
 */
export async function ensureTagsReady(rt) {
  const tags = rt?.tags
  if (tags === undefined || tags === null) return false
  const ready = await waitTagsReady(tags)
  if (typeof tags.ensureFresh === 'function') {
    try {
      await tags.ensureFresh()
    } catch {
      // 词表刚改成坏的也不该把请求打成 500：用旧索引回答比报错有用
    }
  }
  return ready
}

/** 把流式 chunk 压成可读摘要（/probe 诊断用，别把整个 chunk 打出去）。 */
export function summarizeChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return { raw: String(chunk).slice(0, 120) }
  const out = { type: chunk.type }
  if (typeof chunk.kind === 'string') out.kind = chunk.kind
  if (chunk.reason !== undefined && chunk.reason !== null) out.reason = chunk.reason
  if (typeof chunk.text === 'string') out.text = chunk.text.slice(0, 120)
  if (typeof chunk.delta === 'string') out.delta = chunk.delta.slice(0, 120)
  if (chunk.failure !== undefined) out.failure = chunk.failure
  if (chunk.usage !== undefined) out.usage = chunk.usage
  out.keys = Object.keys(chunk)
  return out
}

/** 两个地址是不是同一个源（协议 + 主机 + 端口）。解析不了就当不同源。 */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * 等标签库把索引建好：ready() 不存在就不等，抛错或超时也放过去 ——
 * 查询顶多查不到词，不能让一个 /tags 把接口拖死。
 * @param {any} tags @param {number} [waitMs] @returns {Promise<boolean>} 是否真的就绪
 */
export async function waitTagsReady(tags, waitMs = TAGS_READY_WAIT_MS) {
  if (typeof tags?.ready !== 'function') return false
  let timer
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(resolve, waitMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return await Promise.race([Promise.resolve(tags.ready()).then(() => true), timeout.then(() => false)])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * body.path 指向的文件能不能当工作流 JSON 读：后缀 .json（不分大小写）、必须是普通文件、不超过 10MB。
 * 这三关都过不了就直接回 400，别拿任意路径去 readFile。
 * @param {string} file
 */
export async function jsonFileInfo(file) {
  if (path.extname(file).toLowerCase() !== '.json') {
    return { ok: false, json: { ok: false, error: 'bad-path', message: '只能导入 .json 工作流文件：' + file } }
  }
  let info
  try {
    info = await stat(file)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, json: { ok: false, error: 'no-file', message: '读不了这个文件：' + file + '（' + why + '）' } }
  }
  if (info.isFile() !== true) {
    return { ok: false, json: { ok: false, error: 'no-file', message: '这不是一个普通文件：' + file } }
  }
  if (info.size > IMPORT_MAX_BYTES) {
    return { ok: false, json: { ok: false, error: 'too-large', message: '工作流文件超过 10MB，先精简一下：' + file } }
  }
  return { ok: true }
}

/** 三个可选模块的缓存：找不到就留 null（失败不缓存，文件后补上还能用）。 */
let poseTagsModule
let stylesModule
let refTagsModule

export { PROBE_CHUNK_LIMIT, PROBE_TIMEOUT_MS, TAGS_READY_WAIT_MS, IMPORT_MAX_BYTES }

export async function importPoseTags() {
  if (poseTagsModule !== undefined) return poseTagsModule
  let mod = null
  try {
    mod = await import('../../pose-tags.js')
  } catch {
    return null
  }
  poseTagsModule = typeof mod?.tagsForPose === 'function' ? mod : null
  return poseTagsModule
}

/** 调一次映射函数；它自己炸了也只回空映射，不把请求变成 500。 */
export function callTagsForPose(mod, input) {
  try {
    const out = mod.tagsForPose(input)
    return out !== null && typeof out === 'object' ? out : { pose: [], camera: [], reasons: [] }
  } catch {
    return { pose: [], camera: [], reasons: [] }
  }
}

/** 用标签库校对映射结果：每项 { tag, cn, matched }（索引没就绪时 cn 空、matched false）。 */
export async function enrichPoseTags(rt, mapped) {
  const pickList = list => (Array.isArray(list) ? list.filter(tag => typeof tag === 'string' && tag !== '') : [])
  const pose = pickList(mapped?.pose)
  const camera = pickList(mapped?.camera)
  const reasons = Array.isArray(mapped?.reasons) ? mapped.reasons.map(item => String(item)) : []
  const merged = [...new Set([...pose, ...camera])]
  let rows = []
  if (merged.length > 0 && rt.tags !== undefined && rt.tags !== null && typeof rt.tags.canonicalizeMany === 'function') {
    // 冷启动：索引可能还在建、词表也可能刚改过 —— 先等 ready 再 ensureFresh，否则别名归化的中文名查不到
    await ensureTagsReady(rt)
    try {
      rows = (await rt.tags.canonicalizeMany(merged, { syntax: rt.config?.tags?.weightSyntax ?? 'comfy' })) ?? []
    } catch { rows = [] }
  }
  const byTag = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.tag === 'string' && row.tag !== '') byTag.set(row.tag, row)
    // canonicalizeMany 的 row.raw 是入参原写法：别名归化后 row.tag 会变，面板拿原词回查也得命中
    if (typeof row.raw === 'string' && row.raw !== '') byTag.set(row.raw, row)
  }
  const enrich = list => list.map(tag => {
    const row = byTag.get(tag)
    return {
      tag,
      cn: row !== undefined && typeof row.cn === 'string' ? row.cn : '',
      matched: row !== undefined && row.matched !== false,
    }
  })
  const poseTags = enrich(pose)
  const cameraTags = enrich(camera)
  return { pose: poseTags, camera: cameraTags, tags: [...poseTags, ...cameraTags], reasons }
}

export async function importStyles() {
  if (stylesModule !== undefined) return stylesModule
  let mod = null
  try {
    mod = await import('../../styles.js')
  } catch {
    return null
  }
  stylesModule = typeof mod?.listStyles === 'function' && typeof mod?.styleById === 'function' ? mod : null
  return stylesModule
}

export async function importRefTags() {
  if (refTagsModule !== undefined) return refTagsModule
  let mod = null
  try {
    // 文件没到位时这里要静默退成 501，不能把 handlers 带崩；到位后下一次请求即可用（失败不缓存）。
    mod = await import('../../ref-tags.js')
  } catch {
    return null
  }
  refTagsModule = typeof mod?.tagsForCostume === 'function' && typeof mod?.tagsForPortrait === 'function' ? mod : null
  return refTagsModule
}

/** 调一次参考库映射；它自己炸了也只回空映射，不把请求变成 500。 */
export function callRefTags(mod, key, item) {
  try {
    const out = key === 'portrait' ? mod.tagsForPortrait(item) : mod.tagsForCostume(item)
    return out !== null && typeof out === 'object' ? out : {}
  } catch {
    return {}
  }
}

/** 一条样式补上 cn：与 tags 等长、词库里对不上的位置留空串。 */
export function withChinese(style, cnMap) {
  const raw = Array.isArray(style?.tags) ? style.tags : []
  const tags = raw.filter(tag => typeof tag === 'string' && tag !== '')
  return {
    id: typeof style?.id === 'string' ? style.id : '',
    title: typeof style?.title === 'string' ? style.title : '',
    group: typeof style?.group === 'string' ? style.group : '',
    tags,
    note: typeof style?.note === 'string' ? style.note : '',
    accent: typeof style?.accent === 'string' ? style.accent : '',
    cn: tags.map(tag => cnMap.get(tag) ?? ''),
  }
}

/** 一次把整批 tag 交给标签库取中文名：索引没就绪时整批留空，不把接口拖死。 */
export async function chineseMap(rt, tags) {
  const out = new Map()
  const unique = [...new Set(tags.filter(tag => typeof tag === 'string' && tag !== ''))]
  if (unique.length === 0) return out
  if (rt.tags === undefined || rt.tags === null || typeof rt.tags.canonicalizeMany !== 'function') return out
  await ensureTagsReady(rt)
  let rows = []
  try {
    rows = (await rt.tags.canonicalizeMany(unique, { syntax: rt.config?.tags?.weightSyntax ?? 'comfy' })) ?? []
  } catch {
    rows = []
  }
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const cn = typeof row.cn === 'string' ? row.cn : ''
    if (typeof row.tag === 'string' && row.tag !== '') out.set(row.tag, cn)
    // 入参原写法同样建一条：别名被归化后（full body 变 full_body 之类）前端拿原词也查得到中文
    if (typeof row.raw === 'string' && row.raw !== '') out.set(row.raw, cn)
  }
  return out
}

/** ?q= 模糊匹配：id / title / note / tags / cn 里任一处包含就算命中（大小写不敏感）。 */
export function styleMatchesQuery(style, needle) {
  const fields = [style.id, style.title, style.note, ...style.tags, ...style.cn]
  return fields.some(field => (typeof field === 'string' ? field.toLowerCase().includes(needle) : false))
}
