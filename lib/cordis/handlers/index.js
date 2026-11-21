// plan: 把六个分组的路由表拼成 createHandlers 的那一张表（顺序即分组顺序，通配路由只有一个）

/**
 * lib/cordis/handlers/index.js — 路由总装。
 *
 * 拆分只影响文件在哪，路由本身一条没加、没删、没改顺序语义：
 * 精确路径走 Map 查表（与顺序无关），通配路由只有 /styles/* 一条。
 */
import { systemRoutes } from './system.js'
import { llmRoutes } from './llm.js'
import { comfyRoutes } from './comfy.js'
import { posesRoutes } from './poses.js'
import { refsRoutes } from './refs.js'
import { tagsRoutes } from './tags.js'

/** 全部 HTTP 接口。返回 [{ path, methods, handler }]，逐条见 docs/API.md。 */
/** @param {any} rt @returns {import('./shared.js').Route[]} */
export function createHandlers(rt) {
  return [
    ...systemRoutes(rt),
    ...llmRoutes(rt),
    ...comfyRoutes(rt),
    ...posesRoutes(rt),
    ...refsRoutes(rt),
    ...tagsRoutes(rt),
  ]
}
