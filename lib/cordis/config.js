// plan: 配置投影：面板要看的 configView（apiKey 只给尾号）与写回配置补丁的唯一入口

/**
 * lib/cordis/config.js — 配置的读视图与写回。
 *
 * 两个动机：
 *   1. apiKey 绝不能回给前端，只给「有没有配」与尾号，面板据此显示 ●●●●；
 *   2. 写配置只有一个入口（persistPatch）：先落 settings.json，再就地归一化运行时配置，
 *      免得每个路由自己抄一遍 writePersistedPatch + resolveConfig。
 */

import { resolveConfig, writePersistedPatch } from '../config.js'

/** 插件标识与版本：/health 与 index.js 的导出共用这一处，别让两个地方各写一遍。 */
export const PLUGIN = 'dsh-tagger'
export const VERSION = '0.2.0'

/**
 * 面板与 /state 看的那份配置：脱敏 + 附带本地索引规模。
 * @param {any} rt createRuntime 的产物
 */
export function configView(rt) {
  const { apiKey, ...llmRest } = rt.config.llm
  const key = typeof apiKey === 'string' ? apiKey : ''
  return {
    llm: {
      ...llmRest,
      apiKeySet: key !== '',
      apiKeyHint: key.length > 4 ? '…' + key.slice(-4) : '',
      hasLlmService: typeof rt.llm?.stream === 'function',
    },
    purge: { ...rt.config.purge },
    tags: { ...rt.config.tags, index: rt.tags.stats() },
    forge: { ...rt.config.forge },
    refine: { ...rt.config.refine },
    comfy: { ...rt.config.comfy },
    ui: { ...rt.config.ui },
    dataDir: rt.dir,
  }
}

/**
 * 写回配置补丁：落盘 + 就地归一化，返回新的读视图。
 * @param {any} rt
 * @param {unknown} patch
 */
export function persistPatch(rt, patch) {
  const body = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  writePersistedPatch(body)
  Object.assign(rt.config, resolveConfig(rt.config))
  return configView(rt)
}
