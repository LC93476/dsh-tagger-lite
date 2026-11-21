// plan: 模型类接口 —— 锻造 / 精修 / 模型清单 / 连通性探针，只跟 llm 与 forge 打交道

/**
 * lib/cordis/handlers/llm.js — /refine /models /llm/probe /probe /forge。
 * 这几条要么调 llm.stream，要么读 rt.forge，与 ComfyUI、姿势库无关。
 */
import { apiUrl } from '../adapter.js'
import { PROBE_CHUNK_LIMIT, PROBE_TIMEOUT_MS, sameOrigin, summarizeChunk } from './shared.js'

/** 模型类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function llmRoutes(rt) {
  return [
    {
      path: '/refine',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.refine.refine({
          positive: typeof body?.positive === 'string' ? body.positive : '',
          negative: typeof body?.negative === 'string' ? body.negative : '',
          instruction: typeof body?.instruction === 'string' ? body.instruction : typeof body?.text === 'string' ? body.text : '',
          mode: typeof body?.mode === 'string' ? body.mode : undefined,
          // 数组也是 object：options 传 [] 会让下游按 .xxx 取值的分支拿到 undefined 而不是默认空对象
          options: body?.options !== null && typeof body.options === 'object' && Array.isArray(body.options) === false ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
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
        // 跨源探测不借用已保存的 key：别把用户填的 key 送去一个陌生地址；只有同源才回落
        const reuseKey = sameOrigin(baseUrl, rt.config.llm.baseUrl)
        const apiKey = rawKey !== '' ? rawKey : reuseKey ? rt.config.llm.apiKey : ''
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
        // 探针不能把宿主拖死：整条流 30s 上限，chunk 数上限 256
        args.signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
        const chunks = []
        let capped = false
        try {
          for await (const chunk of llm.stream(args)) {
            if (chunks.length >= PROBE_CHUNK_LIMIT) {
              capped = true
              break
            }
            chunks.push(summarizeChunk(chunk))
          }
        } catch (error) {
          return { status: 500, json: { ok: false, error: 'threw', message: String(error?.message ?? error), chunks, capped } }
        }
        return { status: 200, json: { ok: true, args: { provider: args.provider, model: args.model, shape }, chunks, capped } }
      },
    },
    {
      path: '/forge',
      methods: ['POST'],
      handler: async ({ body }) => {
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        if (text === '') return { status: 400, json: { ok: false, error: 'empty-text', message: '先写点什么。' } }
        const result = await rt.forge.generate({
          text,
          // 同上：options 传 [] 不算有效选项，按空对象处理
          options: body?.options !== null && typeof body?.options === 'object' && Array.isArray(body.options) === false ? body.options : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
  ]
}
