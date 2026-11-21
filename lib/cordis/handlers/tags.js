// plan: 标签库接口 —— 搜索与词表校对，两条都先等索引就绪再查

/** lib/cordis/handlers/tags.js — /tags 与 /tags/canonicalize。 */
import { ensureTagsReady } from './shared.js'

/** 标签类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function tagsRoutes(rt) {
  return [
    {
      path: '/tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const query = url.searchParams.get('q') ?? ''
        // limit 钳在 1..200：别让 ?limit=999999 把索引拖死，也别让 0 / 负数漏进查询
        const asked = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
        const limit = Math.min(200, Math.max(1, Number.isFinite(asked) ? asked : 20))
        // 冷启动先等索引建好（最多 3s），再看「词表刚改过要不要重建」
        await ensureTagsReady(rt)
        return { json: { rows: rt.tags.search(query, { limit }), stats: rt.tags.stats() } }
      },
    },
    {
      path: '/tags/canonicalize',
      methods: ['POST'],
      handler: async ({ body }) => {
        const list = Array.isArray(body?.tags) ? body.tags.map(String) : []
        await ensureTagsReady(rt)
        return { json: { rows: rt.tags.canonicalizeMany(list, { syntax: rt.config.tags.weightSyntax }) } }
      },
    },
  ]
}
