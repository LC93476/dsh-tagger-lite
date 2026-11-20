// plan: 全部 HTTP 接口（面板与 /tagger/api 的整套路由表集中在这里，出问题只看这一个文件）

/**
 * lib/cordis/handlers.js — 面板的全部接口，一张表：[{ path, methods, handler }]。
 *
 * 为什么集中：每个接口的方法、入参、返回都在同一处；分派本身在 lib/routes.js。
 * 这里只做「校验入参 → 调运行时 → 定状态码」，业务逻辑都在 lib/ 下的各个模块里。
 */

import { readFile } from 'node:fs/promises'
import { poseImage } from '../poses.js'
import { resolveLaunch } from '../launch.js'
import { apiUrl } from './adapter.js'
import { resolveWorkflowDir } from '../comfy-workflow.js'
import { importWorkflow } from '../workflow-import.js'
import { PLUGIN, VERSION } from './config.js'
// 配置读取与落盘统一走 lib/spi.js 的入口（与别处同一份实现，不在这里各拼一遍）
import { readConfig, saveConfig } from '../spi.js'

/** 把流式 chunk 压成可读摘要（/probe 诊断用，别把整个 chunk 打出去）。 */
function summarizeChunk(chunk) {
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

/** 语言包白名单：只认包根 locale/ 下这两门语言，别的一律退回 zh。 */
const LOCALE_LANGS = ['zh', 'en']
const LOCALE_DEFAULT = 'zh'

/**
 * 一个路由项。handler 的入参由 lib/routes.js 组装：精确路由给 url/method/body/req，
 * 通配路由（path 以 /* 结尾）额外给 params.rest；测试会直接调 handler 并自带 params，所以四个都标可选。
 * @typedef {{ path: string, methods: string[], handler: (args: { url?: any, method?: any, body?: any, req?: any, params?: any }) => any }} Route
 */

/** 全部 HTTP 接口。返回 [{ path, methods, handler }]，逐条见 docs/API.md。 */
/** @returns {Route[]} */
export function createHandlers(rt) {
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
          // handlers.js 在 lib/cordis/ 下，包根的 locale/ 要退两级
          const raw = await readFile(new URL('../../locale/' + lang + '.json', import.meta.url), 'utf8')
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
      path: '/refine',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.refine.refine({
          positive: typeof body?.positive === 'string' ? body.positive : '',
          negative: typeof body?.negative === 'string' ? body.negative : '',
          instruction: typeof body?.instruction === 'string' ? body.instruction : typeof body?.text === 'string' ? body.text : '',
          mode: typeof body?.mode === 'string' ? body.mode : undefined,
          options: body?.options !== null && typeof body.options === 'object' ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/health',
      methods: ['GET'],
      handler: async () => ({ json: { plugin: PLUGIN, version: VERSION, dataDir: rt.dir } }),
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
      path: '/config',
      methods: ['GET', 'POST'],
      handler: async ({ method, body }) => {
        if (method === 'POST') {
          saveConfig(rt, body?.patch ?? body ?? {})
        }
        return { json: { config: readConfig(rt) } }
      },
    },
    {
      path: '/models',
      methods: ['GET'],
      handler: async ({ url }) => {
        const provider = url.searchParams.get('provider') ?? rt.config.llm.provider
        const models = await rt.forge.models(provider)
        return { json: { provider, models } }
      },
    },
    {
      // web 版 / 独立服务专用：拿面板填的地址与 key 去打一次 /models，验证连通性。
      // 不写配置、不落盘 —— 只报能不能连上和看得到哪些模型。
      path: '/llm/probe',
      methods: ['POST'],
      handler: async ({ body }) => {
        const rawBase = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
        const rawKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        const baseUrl = rawBase !== '' ? rawBase : rt.config.llm.baseUrl
        const apiKey = rawKey !== '' ? rawKey : rt.config.llm.apiKey
        const endpoint = apiUrl(baseUrl, '/models')
        if (endpoint === '') {
          return { status: 400, json: { ok: false, error: 'no-base-url', message: '先填接口地址，例如 https://api.openai.com/v1' } }
        }
        if (apiKey === '') {
          return { status: 400, json: { ok: false, error: 'no-api-key', endpoint, message: '先填 API Key' } }
        }
        const started = Date.now()
        let response
        try {
          response = await fetch(endpoint, {
            headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { status: 502, json: { ok: false, error: 'unreachable', endpoint, message } }
        }
        const raw = await response.text().catch(() => '')
        if (!response.ok) {
          return {
            status: 502,
            json: { ok: false, error: 'http-' + response.status, endpoint, status: response.status, message: raw.slice(0, 300) },
          }
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = undefined
        }
        const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
        const models = rows.map(row => (typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : '')).filter(id => id !== '')
        return {
          json: {
            ok: true,
            endpoint,
            ms: Date.now() - started,
            count: models.length,
            models: models.slice(0, 40),
            message:
              models.length > 0
                ? '连上了，可见 ' + models.length + ' 个模型'
                : '连上了，但 /models 没列模型（有的服务不支持，不影响锻造）',
          },
        }
      },
    },
    {
      path: '/probe',
      methods: ['POST'],
      handler: async ({ body }) => {
        const llm = rt.llm
        if (typeof llm?.stream !== 'function') {
          return { status: 502, json: { ok: false, error: 'no-llm', message: '宿主没有 llm 服务。' } }
        }
        const text = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text.trim() : 'ping'
        const shape = body?.shape === 'string' ? body.shape : 'array'
        const message = shape === 'string'
          ? { role: 'user', content: text }
          : { role: 'user', content: [{ type: 'text', text }] }
        const args = {
          provider: typeof body?.provider === 'string' && body.provider !== '' ? body.provider : rt.config.llm.provider,
          model: typeof body?.model === 'string' && body.model !== '' ? body.model : rt.config.llm.model,
          sessionId: typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : 'dsh-tagger-probe',
          messages: [message],
          maxTokens: 64,
        }
        if (typeof body?.system === 'string' && body.system !== '') args.system = body.system
        if (typeof body?.messages === 'string' && body.messages !== '') {
          try {
            args.messages = JSON.parse(body.messages)
          } catch {
            return { status: 400, json: { ok: false, error: 'bad-json', message: 'messages 不是合法 JSON。' } }
          }
        }
        const chunks = []
        try {
          for await (const chunk of llm.stream(args)) chunks.push(summarizeChunk(chunk))
        } catch (error) {
          return { status: 500, json: { ok: false, error: 'threw', message: String(error?.message ?? error), chunks } }
        }
        return { status: 200, json: { ok: true, args: { provider: args.provider, model: args.model, shape }, chunks } }
      },
    },
    {
      path: '/comfy',
      methods: ['GET'],
      handler: async () => {
        const [ping, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            status: ping,
            launch: resolveLaunch(rt.config),
            workflows: workflows.ok ? workflows.workflows.map(item => ({ id: item.id, title: item.title })) : [],
          },
        }
      },
    },
    {
      path: '/comfy/launch',
      methods: ['POST'],
      handler: async ({ body }) => {
        // 已经在跑就直接认账 —— 别把用户的第二个 ComfyUI 实例也拉起来抢显存。
        const before = await rt.comfy.ping()
        if (before.ok) return { json: { ok: true, state: 'online', alreadyRunning: true, status: before } }
        const launched = await rt.launch()
        if (!launched.ok) return { status: 500, json: { ok: false, error: 'launch-failed', message: launched.message, launch: launched } }
        const waitMs = Math.min(Math.max(Number(body?.waitMs ?? 45000) || 45000, 5000), 120000)
        const deadline = Date.now() + waitMs
        let status = await rt.comfy.ping()
        while (!status.ok && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1500))
          status = await rt.comfy.ping()
        }
        return {
          json: {
            ok: status.ok,
            state: status.ok ? 'online' : 'starting',
            pid: launched.pid,
            command: launched.command,
            dir: launched.dir,
            status,
            message: status.ok ? undefined : '进程已拉起（pid ' + launched.pid + '），' + Math.round(waitMs / 1000) + ' 秒内还没开始监听 —— 首次加载模型可能更久，等一会儿再点「检测」。',
          },
        }
      },
    },
    {
      path: '/workflows',
      methods: ['GET'],
      handler: async () => {
        const result = await rt.comfy.listWorkflows()
        if (!result.ok) return { status: 502, json: { ok: false, error: 'workflows', message: result.message } }
        return { json: { workflows: result.workflows, dir: result.dir } }
      },
    },
    {
      // 导入自定义工作流：面板选文件 / 贴 JSON（可选一份 schema），落到 comfy.workflowDir。
      // body.path 是给本地独立服务用的：浏览器不方便选文件时可以直接给磁盘路径。
      path: '/workflows/import',
      methods: ['POST'],
      handler: async ({ body }) => {
        const configured = typeof rt.config?.comfy?.workflowDir === 'string' ? rt.config.comfy.workflowDir.trim() : ''
        const dir = configured !== '' ? configured : resolveWorkflowDir(rt.config)
        let workflow = body?.workflow
        const fromPath = typeof body?.path === 'string' ? body.path.trim() : ''
        if (workflow === undefined && fromPath !== '') {
          try {
            workflow = await readFile(fromPath, 'utf8')
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            return { status: 400, json: { ok: false, error: 'no-file', message: '读不了这个文件：' + fromPath + '（' + why + '）' } }
          }
        }
        const result = importWorkflow({
          dir,
          name: body?.name,
          workflow,
          schema: body?.schema,
          overwrite: body?.overwrite === true,
          config: rt.config,
        })
        if (result.ok !== true) return { status: result.error === 'exists' ? 409 : 400, json: result }
        const list = await rt.comfy.listWorkflows()
        return {
          json: {
            ...result,
            workflows: list.ok ? list.workflows.map(item => ({ id: item.id, title: item.title, vars: item.vars })) : [],
          },
        }
      },
    },
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
      methods: ['GET'],
      handler: async ({ url }) => {
        const id = url.searchParams.get('id') ?? ''
        const hit = poseImage(rt.config?.comfy?.launchDir ?? '', id)
        if (hit === null) return { status: 404, json: { ok: false, error: 'pose-image', message: '没有这张姿势图：' + id } }
        const raw = await readFile(hit.file)
        return { binary: raw, contentType: hit.contentType }
      },
    },
    {
      path: '/forge',
      methods: ['POST'],
      handler: async ({ body }) => {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return { status: 400, json: { ok: false, error: 'empty-text', message: '先写点什么。' } }
        const result = await rt.forge.generate({
          text,
          options: body.options !== null && typeof body.options === 'object' ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/upload',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.upload({
          filename: typeof body.filename === 'string' ? body.filename : '',
          data: typeof body.data === 'string' ? body.data : '',
          // subfolder 透传：不给就只能落 input 根，LoadImage 拿不到 refs/ 这类子目录前缀。
          subfolder: typeof body.subfolder === 'string' ? body.subfolder : '',
        })
        return { status: result.ok ? 200 : 400, json: result }
      },
    },
    {
      path: '/run',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.submit({
          workflowId: typeof body.workflowId === 'string' ? body.workflowId : '',
          positive: typeof body.positive === 'string' ? body.positive : '',
          negative: typeof body.negative === 'string' ? body.negative : '',
          vars: body.vars !== null && typeof body.vars === 'object' ? body.vars : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/job',
      methods: ['GET'],
      handler: async ({ url }) => {
        const promptId = url.searchParams.get('id') ?? ''
        const result = await rt.comfy.status(promptId)
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/image',
      methods: ['GET'],
      handler: async ({ url }) => {
        const filename = url.searchParams.get('filename') ?? ''
        const subfolder = url.searchParams.get('subfolder') ?? ''
        const type = url.searchParams.get('type') ?? 'output'
        const got = await rt.comfy.image({ filename, subfolder, type })
        if (!got.ok) return { status: 404, json: { ok: false, error: 'image', message: got.message } }
        return { binary: got.buffer, contentType: got.contentType }
      },
    },
    {
      path: '/tags',
      methods: ['GET'],
      handler: async ({ url }) => {
        const query = url.searchParams.get('q') ?? ''
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20
        // 词表刚改过就先重建索引，别让面板看到旧结果
        if (typeof rt.tags.ensureFresh === 'function') await rt.tags.ensureFresh()
        return { json: { rows: rt.tags.search(query, { limit }), stats: rt.tags.stats() } }
      },
    },
    {
      path: '/tags/canonicalize',
      methods: ['POST'],
      handler: async ({ body }) => {
        const list = Array.isArray(body.tags) ? body.tags.map(String) : []
        if (typeof rt.tags.ensureFresh === 'function') await rt.tags.ensureFresh()
        return { json: { rows: rt.tags.canonicalizeMany(list, { syntax: rt.config.tags.weightSyntax }) } }
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
