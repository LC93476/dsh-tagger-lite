// plan: 系统类接口 —— 身份 / 语言包 / 状态 / 配置 / 破甲 / MCP，不碰模型也不碰 ComfyUI 业务

/**
 * lib/cordis/handlers/system.js — 服务自身的接口：/spi /locale /health /state /profiles /config /purge /mcp。
 * 共同点：只读运行时、写配置、转发 MCP，不参与锻造与出图。
 */
import { readFile } from 'node:fs/promises'
import { PLUGIN, VERSION } from '../config.js'
import { readConfig, saveConfig } from '../../spi.js'
import { listProfiles, profileState } from '../../model-profiles.js'

/** 语言包白名单：只认包根 locale/ 下这两门语言，别的一律退回 zh。 */
const LOCALE_LANGS = ['zh', 'en']
const LOCALE_DEFAULT = 'zh'

/** 系统类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function systemRoutes(rt) {
  return [
    {
      path: '/spi',
      methods: ['GET'],
      handler: async () => ({ json: { ok: true, spi: rt.spi.describe() } }),
    },
    {
      // 多语言词典：面板与宿主共用同一份 locale/<lang>.json，前端自己按 key 取。
      path: '/locale',
      methods: ['GET'],
      handler: async ({ url }) => {
        const asked = (url.searchParams.get('lang') ?? '').trim().toLowerCase()
        const lang = LOCALE_LANGS.includes(asked) ? asked : LOCALE_DEFAULT
        try {
          // 本模块在 lib/cordis/handlers/ 下，包根的 locale/ 要退三级
          const raw = await readFile(new URL('../../../locale/' + lang + '.json', import.meta.url), 'utf8')
          const dict = JSON.parse(raw)
          if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) throw new Error('语言包不是对象')
          return { json: { ok: true, locale: lang, langs: [...LOCALE_LANGS], dict } }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { status: 500, json: { ok: false, error: 'no-locale', message: '读不到语言包 locale/' + lang + '.json：' + message } }
        }
      },
    },
    {
      path: '/health',
      methods: ['GET'],
      handler: async () => {
        // llmReady 给前端药丸用：插件模式没有独立版那份 describeHealth()，这里补一个同义字段，
        // 免得 studio 的 refreshState() 在插件下永远拿不到 llmReady、只能保留 applyState 的猜测值。
        const llmInfo = typeof rt.llm?.describe === 'function' ? rt.llm.describe() : {
          configured: rt.config?.llm?.apiKey !== '' && rt.config?.llm?.baseUrl !== '',
          provider: rt.config?.llm?.provider,
          model: rt.config?.llm?.model,
          baseUrl: rt.config?.llm?.baseUrl,
        }
        return {
          json: {
            plugin: PLUGIN,
            version: VERSION,
            dataDir: rt.dir,
            llmReady: llmInfo.configured === true,
            llm: { provider: llmInfo.provider, model: llmInfo.model, baseUrl: llmInfo.baseUrl },
          },
        }
      },
    },
    {
      path: '/state',
      methods: ['GET'],
      handler: async () => {
        const [comfy, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            config: readConfig(rt),
            purge: rt.forge.purgeState(),
            comfy,
            workflows: workflows.ok ? workflows.workflows : [],
            workflowsError: workflows.ok ? undefined : workflows.message,
            history: rt.forge.history(),
          },
        }
      },
    },
    {
      // 模型档案：一份可选清单 + 当前档案的生效值（custom 时生效值来自配置本身）
      path: '/profiles',
      methods: ['GET'],
      handler: async () => ({ json: { profiles: listProfiles(), current: profileState(rt.config) } }),
    },
    {
      path: '/config',
      methods: ['GET', 'POST'],
      handler: async ({ method, body }) => {
        if (method === 'POST') {
          saveConfig(rt, body?.patch ?? body ?? {})
          // 破甲指令会拼进系统提示词并缓存；配置一改就得让缓存失效，否则下一轮还是旧的
          if (rt.forge !== null && typeof rt.forge?.refreshPurge === 'function') rt.forge.refreshPurge()
        }
        return { json: { config: readConfig(rt) } }
      },
    },
    {
      path: '/purge',
      methods: ['GET', 'POST'],
      handler: async ({ method, body }) => {
        if (method === 'POST') {
          saveConfig(rt, { purge: body?.purge ?? body ?? {} })
          rt.forge.refreshPurge?.()
        }
        return {
          json: { purge: rt.forge.purgeState(), preview: rt.forge.systemPrompt({ preview: true }).slice(0, 4000) },
        }
      },
    },
    {
      path: '/mcp',
      methods: ['POST', 'GET'],
      handler: async ({ body }) => {
        const reply = await rt.mcp.handle(body)
        // 通知（无 id）回空响应；批量请求原样回数组，不能包 { ok:true }。
        if (reply === null || reply === undefined) return { status: 204 }
        return { raw: reply }
      },
    },
  ]
}
