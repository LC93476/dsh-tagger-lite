/**
 * dsh-tagger 宿主入口（从 dsh-prompt-forge 派生，桌面端优先）。
 *
 * 一条 entry 做四件事：
 *   1. 把 HTTP 前缀 /prompt-forge/api 挂到宿主 webServer 上（面板的全部接口）；
 *   2. 建共享运行时：标签索引 / 锻造器（宿主 llm 服务）/ ComfyUI 客户端 / MCP 处理器；
 *   3. 注册三个模型工具（prompt_forge、prompt_forge_run、prompt_forge_status）；
 *   4. 需要时把「标签写法」注入智能体系统提示词（默认关）。
 *
 * 面板本身在 client.js；宿主只负责数据与投递，两边的操作逻辑共用同一批方法。
 */
import { readFile } from 'node:fs/promises'
import { dataDir, resolveConfig, writePersistedPatch } from './lib/config.js'
import { createTagIndex } from './lib/tags.js'
import { createForge } from './lib/forge.js'
import { createComfyClient } from './lib/comfy.js'
import { createPoseCatalog, poseImage } from './lib/poses.js'
import { createMcpHandler } from './lib/mcp.js'
import { launchComfy, resolveLaunch } from './lib/launch.js'
import { createRefiner } from './lib/refine.js'
import { createRegistry } from './lib/spi.js'
import { createDispatch, LEGACY_PREFIX, PREFIX } from './lib/routes.js'

export const name = 'dsh-tagger'

/** webServer 必须注入：前缀注册要它。llm / tools 走可选读取，缺席时面板仍可用（模板拼接模式）。 */
export const inject = ['webServer']

function makeLogger() {
  const prefix = '[tagger] '
  return {
    info: (...args) => console.log(prefix + args.join(' ')),
    warn: (...args) => console.warn(prefix + args.join(' ')),
    error: (...args) => console.error(prefix + args.join(' ')),
  }
}

/** 组装运行时；导出是为了测试能不起宿主直接验接口。 */
export function createRuntime(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = makeLogger()
  const dir = dataDir()
  const tags = createTagIndex({ dir, logger: log })
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  const forge = createForge({ config, llm, tags, logger: log })
  const comfy = createComfyClient({ config, logger: log })
  const poses = createPoseCatalog({ config, logger: log })
  // SPI：以后接别的插件 / web 版都从这里插，核心不直接 import 外部实现。
  const spi = createRegistry({ logger: log, config })
  const refine = createRefiner({ config, llm, tags, logger: log, spi })
  const mcp = createMcpHandler({ forge, comfy, tags, config, logger: log, refine })
  return {
    ctx,
    config,
    log,
    dir,
    tags,
    llm,
    forge,
    refine,
    spi,
    comfy,
    poses,
    mcp,
    launch: () => launchComfy({ config, logger: log }),
  }
}

/** OpenAI 兼容接口的地址拼接：baseUrl 已经带 /v1 就不再重复拼（与 server/shims.mjs 同规则）。 */
function llmUrl(baseUrl, suffix) {
  const base = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (base === '') return ''
  return /\/v\d+$/.test(base) ? base + suffix : base + '/v1' + suffix
}

function configView(rt) {
  // apiKey 绝不回给前端：只给「有没有配」与尾号，面板据此显示 ●●●●。
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

/** 全部 HTTP 接口。返回 [{ path, methods, handler }]。 */
/** 面板子模块文件名白名单：只认 client/ 下一层的 `小写字母数字连字符.js`。 */
const MODULE_NAME = /^client\/[a-z0-9][a-z0-9-]*\.js$/

export function createHandlers(rt) {
  return [
    {
      // 面板子模块：宿主的 __ModuleLoader__ 只加载包根的 client.js，子文件得走这条路由取。
      // 返回 text/javascript，客户端用动态 import() 拼装（React 由门面显式传进去，子模块不碰裸 import）。
      path: '/_mod/*',
      methods: ['GET', 'HEAD'],
      handler: async ({ params }) => {
        const rest = typeof params?.rest === 'string' ? params.rest : ''
        if (MODULE_NAME.test(rest) === false) {
          return { status: 400, json: { ok: false, error: 'bad-module', message: '模块名不合法：' + rest } }
        }
        const fileName = rest.slice('client/'.length)
        try {
          const source = await readFile(new URL('./client/' + fileName, import.meta.url), 'utf8')
          return { text: source, contentType: 'text/javascript; charset=utf-8' }
        } catch (error) {
          return { status: 404, json: { ok: false, error: 'no-module', message: '没有这个模块：' + fileName } }
        }
      },
    },
    {
      path: '/spi',
      methods: ['GET'],
      handler: async () => ({ json: { ok: true, spi: rt.spi.describe() } }),
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
      handler: async () => ({ json: { plugin: name, version: '0.2.0', dataDir: rt.dir } }),
    },
    {
      path: '/state',
      methods: ['GET'],
      handler: async () => {
        const [comfy, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            config: configView(rt),
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
          writePersistedPatch(body?.patch ?? body ?? {})
          Object.assign(rt.config, resolveConfig(rt.config))
        }
        return { json: { config: configView(rt) } }
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
        const endpoint = llmUrl(baseUrl, '/models')
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
          writePersistedPatch({ purge: body?.purge ?? body ?? {} })
          Object.assign(rt.config, resolveConfig(rt.config))
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

function registerTools(ctx, rt) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    rt.log.warn('拿不到 tools 服务，模型工具未注册（面板不受影响）。')
    return
  }
  const jsonOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
  const specs = [
    {
      name: 'prompt_forge',
      description:
        '把白话描述锻造成 WD（Danbooru）+ Camie 标准的图像标签：正向 tag 串 + 负向 tag 串 + 逐条权重。'
        + '用户用口语描述画面时先调它，不要自己手写 tag —— 这一步就是"替代 LLM 转标签"的那一跳，'
        + '输出已经过本地标签库校对，可直接进 ComfyUI。'
        + '**给 text 就够**；需要换标准/上限时给 standards / maxTags。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '用户的白话描述（中文即可），越具体越好。' },
          standards: {
            type: 'array',
            items: { type: 'string', enum: ['wd', 'camie'] },
            description: '标签标准，默认按配置（wd + camie）。',
          },
          maxTags: { type: 'integer', description: '最多几个正向 tag，默认按配置（40）。' },
          negative: { type: 'string', description: '附加负向词（默认留空：负向由 ComfyUI 工作流内置）。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => rt.forge.generate({
        text: String(args.text ?? ''),
        options: {
          standards: Array.isArray(args.standards) ? args.standards : undefined,
          maxTags: typeof args.maxTags === 'number' ? args.maxTags : undefined,
          negative: typeof args.negative === 'string' ? args.negative : undefined,
        },
      }),
    },
    {
      name: 'prompt_forge_run',
      description:
        '锻造并直接投递 ComfyUI：给 text（白话）就走锻造，给 positive（现成 tag 串）就跳过锻造；'
        + '不给 workflowId 用配置里的默认工作流。返回 promptId，用 prompt_forge_status 续查。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '白话描述；给了就先用它锻造 tag。' },
          positive: { type: 'string', description: '现成正向 tag 串；给了就跳过锻造。' },
          negative: { type: 'string', description: '负向 tag 串；留空表示用工作流里内置的那一份。' },
          workflowId: { type: 'string', description: '工作流 id（见 /workflows 或面板列表）。' },
          vars: { type: 'object', additionalProperties: true, description: '其它工作流变量（宽高、seed、steps…）。' },
          wait: { type: 'boolean', description: 'true 表示同步等到出图再返回（上限按配置 timeoutMs）。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => {
        let positive = typeof args.positive === 'string' ? args.positive : ''
        let negative = typeof args.negative === 'string' ? args.negative : ''
        let forged = null
        if (positive.trim() === '' && typeof args.text === 'string' && args.text.trim() !== '') {
          forged = await rt.forge.generate({ text: args.text, options: {} })
          if (!forged.ok) return forged
          positive = forged.positive
          // 负向由 ComfyUI 工作流内置，不再沿用模型给的负向串
        }
        const submitted = await rt.comfy.submit({
          workflowId: typeof args.workflowId === 'string' ? args.workflowId : '',
          positive,
          negative,
          vars: args.vars !== null && typeof args.vars === 'object' ? args.vars : {},
        })
        if (!submitted.ok) return submitted
        if (args.wait === true) {
          const final = await rt.comfy.waitFor(submitted.promptId, {})
          return { ok: final.ok, forged, submitted, final }
        }
        return { ok: true, forged, submitted, next: '用 prompt_forge_status 传 promptId 续查' }
      },
    },
    {
      name: 'prompt_forge_status',
      description: '查一次 ComfyUI 任务：排队 / 运行 / 完成 / 失败，完成时带回图片地址。',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'prompt_forge_run 返回的 promptId。' } },
        required: ['promptId'],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => rt.comfy.status(String(args.promptId ?? '')),
    },
  ]
  for (const spec of specs) {
    try {
      const dispose = tools.register(spec)
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'prompt-forge: tool ' + spec.name)
      }
    } catch (error) {
      rt.log.warn('工具 ' + spec.name + ' 未注册：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  rt.log.info('模型工具已注册：' + specs.map(s => s.name).join(' / '))
}

export function apply(ctx, rawConfig) {
  const rt = createRuntime(ctx, rawConfig)
  const server = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  if (server === undefined || typeof server.register !== 'function') {
    rt.log.warn('拿不到 webServer 服务，HTTP 接口未注册。')
  } else {
    try {
      const routes = createHandlers(rt)
      // 新前缀 + 旧前缀（兼容 dsh-prompt-forge 时期的客户端与脚本）
      const dispose = server.register({ kind: 'prefix', path: PREFIX, handler: createDispatch(routes, rt.log, PREFIX) })
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'prompt-forge: http prefix')
      }
      rt.log.info('接口就绪：' + PREFIX)
      // 旧前缀兼容：同一个 dispatch 换切片长度。失败不影响新前缀。
      try {
        const disposeLegacy = server.register({
          kind: 'prefix',
          path: LEGACY_PREFIX,
          handler: createDispatch(routes, rt.log, LEGACY_PREFIX),
        })
        if (typeof disposeLegacy === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => () => disposeLegacy(), 'tagger: legacy http prefix')
        }
      } catch (error) {
        rt.log.info('旧前缀 ' + LEGACY_PREFIX + ' 未注册（不影响使用）：' + (error instanceof Error ? error.message : String(error)))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('duplicate prefix route')) rt.log.info('HTTP 前缀已存在（热重载），沿用现有实例。')
      else throw error
    }
  }

  registerTools(ctx, rt)

  // 可选：把标签写法注入智能体系统提示词（默认关，开了之后对话里也能直接产出同款 tag）。
  if (rt.config.purge.injectIntoAgentPrompt) {
    try {
      const section = ctx?.systemPrompt?.section
      if (typeof section === 'function') {
        const dispose = section({ id: 'prompt-forge:tag-rules', text: () => rt.forge.agentDirective() })
        if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => () => dispose(), 'prompt-forge: system prompt section')
        }
      } else {
        rt.log.warn('systemPrompt 服务不可用，标签写法未注入。')
      }
    } catch (error) {
      rt.log.warn('注入系统提示词失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  return rt
}
