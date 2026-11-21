// plan: 姿势类接口 —— 姿势清单、缩略图、分页画廊、姿势标签映射

/**
 * lib/cordis/handlers/poses.js — /poses /pose-thumb /pose-gallery /pose-tags。
 * 全部只读姿势库（catalog.csv 在 ai-pose-gallery-zh 下），写操作一个都没有。
 */
import { readFile } from 'node:fs/promises'
import { poseGallery, poseImage } from '../../poses.js'
import { importPoseTags, callTagsForPose, enrichPoseTags } from './shared.js'

/** /pose-tags 先用 base 精确检索，兜底才整库扫；两个数都会被动到库的 limit 上限夹住，别写更大的数。 */
const POSE_LOOKUP_LIMIT = 50
const POSE_SCAN_LIMIT = 400

/** 姿势类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function posesRoutes(rt) {
  return [
    {
      path: '/poses',
      methods: ['GET'],
      handler: async ({ url }) => {
        const result = rt.poses.list({
          set: url.searchParams.get('set') ?? '',
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
        })
        return { json: result }
      },
    },
    {
      path: '/pose-thumb',
      // 面板会用 <img> 直接取图，浏览器/代理偶尔发 HEAD 探尺寸；只给 GET 会让人以为图裂了
      methods: ['GET', 'HEAD'],
      handler: async ({ url }) => {
        const id = url.searchParams.get('id') ?? ''
        const hit = poseImage(rt.config?.comfy?.launchDir ?? '', id)
        if (hit === null) return { status: 404, json: { ok: false, error: 'pose-image', message: '没有这张姿势图：' + id } }
        // 索引里有、盘上没了（用户删了图 / 换了目录）：404，不是 500 抛栈
        let raw
        try {
          raw = await readFile(hit.file)
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error)
          return { status: 404, json: { ok: false, error: 'pose-image', message: '读不到这张姿势图：' + hit.file + '（' + why + '）' } }
        }
        return { binary: raw, contentType: hit.contentType }
      },
    },
    {
      path: '/pose-gallery',
      methods: ['GET'],
      handler: async ({ url }) => {
        const gallery = poseGallery({
          launchDir: rt.config?.comfy?.launchDir ?? '',
          set: url.searchParams.get('set') ?? '',
          category: url.searchParams.get('category') ?? '',
          angle: url.searchParams.get('angle') ?? '',
          q: url.searchParams.get('q') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
          offset: Number(url.searchParams.get('offset') ?? 0),
        })
        return { json: gallery }
      },
    },
    {
      path: '/pose-tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const base = (url.searchParams.get('base') ?? '').trim()
        if (base === '') {
          return { status: 400, json: { ok: false, error: 'bad-base', message: '要带 base（姿势组编号，如 full_single_P041）' } }
        }
        const angle = (url.searchParams.get('angle') ?? '').trim() || '正面'
        const ids = (url.searchParams.get('ids') ?? '').split(',').map(item => item.trim()).filter(item => item !== '')
        const launchDir = rt.config?.comfy?.launchDir ?? ''
        // 先按 base 精确检索：matchQuery 的 hay 含 group.base，命中的组一定在返回集里，不会被 limit 截掉。
        // 检索不到再退回整库扫描（poseGallery 的 limit 上限就是 POSE_SCAN_LIMIT，再大也会被夹住）。
        let group = poseGallery({ launchDir, q: base, limit: POSE_LOOKUP_LIMIT }).groups.find(item => item.base === base)
        if (group === undefined) {
          group = poseGallery({ launchDir, limit: POSE_SCAN_LIMIT }).groups.find(item => item.base === base)
        }
        if (group === undefined) {
          return { status: 404, json: { ok: false, error: 'no-pose', message: '姿势库里没有这个姿势：' + base } }
        }
        const picked = ids.length > 0
          ? group.variants.filter(variant => ids.includes(variant.id))
          : group.variants.filter(variant => variant.angle === angle)
        if (picked.length === 0) {
          return {
            status: 404,
            json: {
              ok: false,
              error: 'no-variant',
              message: '这个姿势没有 ' + (ids.length > 0 ? ids.join(' / ') : angle) + ' 这一张',
              angles: group.variants.map(variant => variant.angle),
            },
          }
        }
        const mod = await importPoseTags()
        if (mod === null) {
          return { status: 501, json: { ok: false, error: 'pose-tags-unavailable', message: '姿势标签映射还没就绪（lib/pose-tags.js）' } }
        }
        const items = []
        for (const variant of picked) {
          const mapped = callTagsForPose(mod, {
            base: group.base,
            code: group.code,
            name: group.name,
            category: group.category,
            angle: variant.angle,
            set: group.set,
          })
          const enriched = await enrichPoseTags(rt, mapped)
          items.push({
            id: variant.id,
            angle: variant.angle,
            pose: enriched.pose,
            camera: enriched.camera,
            tags: enriched.tags,
            reasons: enriched.reasons,
          })
        }
        const first = items[0]
        return {
          json: {
            ok: true,
            base,
            angle: first.angle,
            set: group.set,
            setLabel: group.setLabel,
            category: group.category,
            name: group.name,
            pose: first.pose,
            camera: first.camera,
            tags: first.tags,
            reasons: first.reasons,
            items,
          },
        }
      },
    },
  ]
}
