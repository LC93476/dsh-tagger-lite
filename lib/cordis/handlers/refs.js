// plan: 参考类接口 —— 画风样式清单与详情、服装 / 人像参考库浏览与取图、参考库标签映射

/**
 * lib/cordis/handlers/refs.js — /styles /styles/* /refs /ref-image /ref-tags。
 * 样式（lib/styles.js）与参考库（lib/refs.js）都只读；标签映射走动态 import，文件缺席回 501。
 */
import { readFile } from 'node:fs/promises'
import { RefError, refGallery, refImage, refItem, refKind } from '../../refs.js'
import { importStyles, importRefTags, callRefTags, withChinese, chineseMap, styleMatchesQuery, REF_ID_RE } from './shared.js'

/** 参考类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function refsRoutes(rt) {
  return [
    {
      // 参考样式预设：/studio 中栏的卡片清单。groups 恒全量，styles 可按 group / q 过滤。
      // 每条 style 多带一个 cn：与 tags 等长、词库里对不上的位置是空串。
      path: '/styles',
      methods: ['GET'],
      handler: async ({ url }) => {
        const mod = await importStyles()
        if (mod === null) {
          return { status: 503, json: { ok: false, error: 'styles-unavailable', message: 'lib/styles.js 还没就位，样式预设暂时读不到' } }
        }
        const listed = mod.listStyles() ?? {}
        const groups = Array.isArray(listed.groups) ? listed.groups : []
        const raw = Array.isArray(listed.styles) ? listed.styles : []
        const pool = raw.flatMap(style => (Array.isArray(style?.tags) ? style.tags : []))
        const cnMap = await chineseMap(rt, pool)
        const group = (url.searchParams.get('group') ?? '').trim().toLowerCase()
        const needle = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        let styles = raw.map(style => withChinese(style, cnMap))
        if (group !== '') styles = styles.filter(style => style.group.toLowerCase() === group)
        if (needle !== '') styles = styles.filter(style => styleMatchesQuery(style, needle))
        return { json: { ok: true, groups, styles, total: styles.length } }
      },
    },
    {
      // /styles/:id —— 精确表放不下参数，用通配路由拿 params.rest（去掉 /styles/ 之后的部分）
      path: '/styles/*',
      methods: ['GET'],
      handler: async ({ params }) => {
        const mod = await importStyles()
        if (mod === null) {
          return { status: 503, json: { ok: false, error: 'styles-unavailable', message: 'lib/styles.js 还没就位，样式预设暂时读不到' } }
        }
        let id = typeof params?.rest === 'string' ? params.rest.replace(/\/+$/, '') : ''
        try {
          id = decodeURIComponent(id)
        } catch {
          id = ''
        }
        const found = id === '' ? null : mod.styleById(id)
        if (found === null || found === undefined) {
          return { status: 404, json: { ok: false, error: 'no-style', message: '没有这个样式：' + id } }
        }
        const tags = Array.isArray(found.tags) ? found.tags : []
        const cnMap = await chineseMap(rt, tags)
        return { json: { ok: true, style: withChinese(found, cnMap) } }
      },
    },
    {
      // 参考库画廊：服装 / 人像两个只读库。sets 首项恒 all（标签「全部」），hairs 只有人像库有内容。
      // 错码：bad-kind 400 / no-ref-library 404 —— 分派层原样带出去，面板按 error 提示。
      path: '/refs',
      methods: ['GET'],
      handler: async ({ url }) => {
        const gallery = refGallery(rt.config?.comfy?.launchDir ?? '', url.searchParams.get('kind') ?? '', {
          q: url.searchParams.get('q') ?? '',
          set: url.searchParams.get('set') ?? '',
          hair: url.searchParams.get('hair') ?? '',
          popular: url.searchParams.get('popular') ?? '',
          limit: Number(url.searchParams.get('limit') ?? 0),
          offset: Number(url.searchParams.get('offset') ?? 0),
        })
        if (gallery.ok !== true) {
          return {
            status: gallery.error === 'bad-kind' ? 400 : 404,
            json: { ok: false, error: gallery.error, message: gallery.message },
          }
        }
        return { json: gallery }
      },
    },
    {
      // 参考图：服装缩略图优先 thumbs/costume（size=full 直接给原图），人像只有原图。
      // 只收 GET / HEAD：别的动词在分派层就被 405 挡掉（allow 文案由 methods 生成）。
      path: '/ref-image',
      methods: ['GET', 'HEAD'],
      handler: async ({ url }) => {
        let hit
        try {
          hit = refImage(
            rt.config?.comfy?.launchDir ?? '',
            url.searchParams.get('kind') ?? '',
            url.searchParams.get('id') ?? '',
            url.searchParams.get('size') ?? '',
          )
        } catch (error) {
          const code = error instanceof RefError ? error.code : 'no-ref-image'
          const why = error instanceof Error ? error.message : String(error)
          return {
            status: code === 'bad-kind' || code === 'bad-id' ? 400 : 404,
            json: { ok: false, error: code, message: why },
          }
        }
        let raw
        try {
          raw = await readFile(hit.file)
        } catch (error) {
          // 索引里有、盘上没了（用户删了图 / 换了目录）：404，不是 500 抛栈
          const why = error instanceof Error ? error.message : String(error)
          return { status: 404, json: { ok: false, error: 'no-ref-image', message: '读不到这张参考图：' + hit.file + '（' + why + '）' } }
        }
        return { binary: raw, contentType: hit.mediaType }
      },
    },
    {
      // 参考库标签：动态 import lib/ref-tags.js，只做映射 + 词表校对，不在这里编标签。
      path: '/ref-tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const kind = url.searchParams.get('kind') ?? ''
        const key = refKind(kind)
        if (key === '') {
          return { status: 400, json: { ok: false, error: 'bad-kind', message: '不认识的参考库：' + kind + '（只认 costume / portrait）' } }
        }
        const asked = url.searchParams.get('id') ?? ''
        // 口径与 /ref-image 对齐：先看 id 形状（400），再看库在不在（404），最后才看有没有这条（404）
        if (REF_ID_RE.test(asked) === false) {
          return { status: 400, json: { ok: false, error: 'bad-id', message: '参考库 id 只能由字母、数字、下划线、连字符组成，且不超过 40 字：' + asked } }
        }
        const launchDir = rt.config?.comfy?.launchDir ?? ''
        const listed = refGallery(launchDir, key, { limit: 1 })
        if (listed.ok === false && listed.error === 'no-ref-library') {
          return { status: 404, json: { ok: false, error: 'no-ref-library', message: listed.message } }
        }
        const item = refItem(launchDir, key, asked)
        if (item === null) {
          return { status: 404, json: { ok: false, error: 'no-ref', message: '参考库里没有这一条：' + asked } }
        }
        const mod = await importRefTags()
        if (mod === null) {
          return { status: 501, json: { ok: false, error: 'ref-tags-unavailable', message: '参考库标签映射还没就绪（lib/ref-tags.js）' } }
        }
        const mapped = callRefTags(mod, key, item)
        // lib/ref-tags.js 的实际契约是 { tags: [{ tag, cn }], reasons }（cn 它自己带好了）；
        // 也兼容 early 版本的 { positive, negative } 字符串数组 —— 两条线在并行写，接口层不要被形状绑死。
        const pairs = value => (Array.isArray(value) ? value : []).map(entry => {
          if (typeof entry === 'string') return { tag: entry, cn: '' }
          const tag = typeof entry?.tag === 'string' ? entry.tag : ''
          const cn = typeof entry?.cn === 'string' ? entry.cn : ''
          return { tag, cn }
        }).filter(pair => pair.tag !== '')
        const nullish = value => (Array.isArray(value) ? value.map(String) : [])
        const fromTags = Array.isArray(mapped?.tags) ? pairs(mapped.tags) : null
        const positive = fromTags !== null ? fromTags : pairs(mapped?.positive)
        const negative = fromTags !== null ? [] : pairs(mapped?.negative)
        // 模块自带 cn 就不查词表；只在 old shape 时才补，省一次索引往返
        const bare = [...positive, ...negative].filter(pair => pair.cn === '').map(pair => pair.tag)
        const cnMap = bare.length === 0 ? new Map() : await chineseMap(rt, bare)
        const enrich = list => list.map(pair => ({ tag: pair.tag, cn: pair.cn !== '' ? pair.cn : (cnMap.get(pair.tag) ?? '') }))
        return {
          json: {
            ok: true,
            kind: key,
            id: item.id,
            item,
            positive: enrich(positive),
            negative: enrich(negative),
            notes: nullish(mapped?.notes),
            reasons: nullish(mapped?.reasons),
          },
        }
      },
    },
  ]
}
