/**
 * MCP（Model Context Protocol）通道：把锻造器、ComfyUI 客户端、标签库包成 JSON-RPC 2.0。
 *
 * 为什么单独一条通道：面板是给人看的，模型要的是工具 —— 同一批能力两个入口，
 * 走 HTTP /mcp 就能被任何 MCP 客户端接走，不必再写一遍胶水。
 *
 * 只做协议层：不缓存、不改配置、不写文件；每个工具就是转发 + 兜住异常。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeError, isRecord, msgOf } from './backend-common.js'

export const PROTOCOL_VERSION = '2024-11-05'
const FALLBACK_VERSION = '0.2.0'

/** 包版本：读根 package.json；读不到才退到兜底值（版本别在两处各写一份）。 */
function packageVersion() {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/** 进程内只算一次：package.json 在运行期不会变。 */
export const SERVER_INFO = { name: 'dsh-tagger', version: packageVersion(), title: 'DSh Tagger · 标签锻造台' }
export const SERVER_INSTRUCTIONS =
  '白话描述画面 → WD + Camie 标准图像标签 → 直接投递本机 ComfyUI。'
  + '先用 forge_tags 把中文描述锻造成 tag，再用 comfy_run 投递（给 text 时会自动锻造）。'

const REFINE_MODES = new Set(['add', 'edit', 'prune', 'weights'])

const ERROR_METHOD_NOT_FOUND = -32601
const ERROR_INVALID_PARAMS = -32602
const ERROR_INVALID_REQUEST = -32600
const ERROR_INTERNAL = -32603

function textResult(value) {
  return [{ type: 'text', text: JSON.stringify(value === undefined ? { ok: true } : value) }]
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function positiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/** 校验不了就丢：锻造器只认 standards/maxTags/negative，多传的键会被它的归一化忽略。 */
function forgeOptions(args) {
  const options = {}
  if (Array.isArray(args.standards)) {
    const standards = args.standards.map(item => String(item).toLowerCase()).filter(item => item === 'wd' || item === 'camie')
    if (standards.length > 0) options.standards = standards
  }
  if (args.maxTags !== undefined && args.maxTags !== null) options.maxTags = positiveInt(args.maxTags, undefined)
  if (typeof args.negative === 'string') options.negative = args.negative
  if (typeof args.syntax === 'string') options.syntax = args.syntax
  return options
}

/**
 * @param {{ forge?: any, comfy?: any, tags?: any, config?: any, logger?: any, refine?: any }} [deps]
 */
export function createMcpHandler({ forge, comfy, tags, config, logger, refine } = {}) {
  const log = logger ?? {}
  // 宿主（index.js）在 createRuntime 里直接传 refine；独立入口先建 MCP、后建精修器时用 attach({ refine }) 补绑。
  let refiner = refine
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {}

  const unavailable = (what, detail) => ({ ok: false, error: 'unavailable', message: what + '不可用：' + detail })
  /** comfy.baseUrl 在真客户端上是函数，在测试桩上是字符串 —— 两种都认，别让错误文案里出现 undefined。 */
  const comfyTarget = () => (typeof comfy?.baseUrl === 'function' ? str(comfy.baseUrl()) : str(comfy?.baseUrl))

  async function forgeTags(args) {
    if (typeof forge?.generate !== 'function') {
      return unavailable('锻造器', '宿主没有 llm 服务（检查 provider 配置）')
    }
    const text = str(args.text).trim()
    if (text === '') return { ok: false, error: 'empty-text', message: '给 text：白话描述画面，例如"雨夜霓虹街头，红衣少女回头"' }
    try {
      return await forge.generate({ text, options: forgeOptions(args) })
    } catch (error) {
      return { ok: false, error: 'forge-failed', message: describeError(error, { scope: '锻造器' }) }
    }
  }

  /** 二次精修：把已有 tag 串按一句话指令做增量改动（add / edit / prune / weights）。 */
  async function refineTags(args) {
    const positive = str(args.positive).trim()
    if (positive === '') {
      return { ok: false, error: 'empty-positive', message: '给 positive：已有的正向 tag 串（先 forge_tags 或手写都行）。' }
    }
    const instruction = str(args.instruction).trim()
    if (instruction === '') {
      return { ok: false, error: 'empty-instruction', message: '给 instruction：想加 / 想改 / 想删什么，例如"再加点暖光和发丝细节"。' }
    }
    if (typeof refiner?.refine !== 'function') {
      return unavailable('精修器', '宿主没有装配 refine（或它还没接上）')
    }
    const mode = REFINE_MODES.has(str(args.mode)) ? str(args.mode).trim() : 'add'
    const negative = str(args.negative)
    let result
    try {
      result = await refiner.refine({ positive, negative, instruction, mode })
    } catch (error) {
      return { ok: false, error: 'refine-failed', message: describeError(error, { scope: '精修器' }) }
    }
    if (!isRecord(result)) {
      return { ok: false, error: 'refine-failed', message: '精修器返回了非对象结果。' }
    }
    const delta = isRecord(result.delta) ? result.delta : { added: [], removed: [], weighted: [] }
    const warnings = Array.isArray(result.warnings) ? result.warnings : []
    // 紧凑结果：前端 / 模型要的就是这两串 tag + 这次改了什么，其余（tags 全量、模型名）不进 MCP。
    if (result.ok !== true) {
      return {
        ok: false,
        error: str(result.error) || 'refine-failed',
        message: str(result.message),
        mode: str(result.mode).trim() || mode,
        positive: str(result.positive) === '' ? positive : str(result.positive),
        negative: str(result.negative) === '' ? negative : str(result.negative),
        delta,
        notes: str(result.notes),
        warnings,
      }
    }
    const payload = {
      ok: true,
      mode: str(result.mode).trim() || mode,
      positive: str(result.positive),
      negative: str(result.negative),
      delta,
      ops: Number.isFinite(result.ops) ? result.ops : 0,
      notes: str(result.notes),
      warnings,
    }
    if (Number.isFinite(result.ms)) payload.ms = result.ms
    return payload
  }

  async function comfyWorkflows() {
    if (typeof comfy?.listWorkflows !== 'function') return unavailable('ComfyUI 客户端', '插件运行时没装配 comfy')
    try {
      return await comfy.listWorkflows()
    } catch (error) {
      return { ok: false, error: 'list-failed', message: describeError(error, { scope: 'ComfyUI 列工作流', target: comfyTarget() }) }
    }
  }

  async function comfyRun(args) {
    if (typeof comfy?.submit !== 'function') return unavailable('ComfyUI 客户端', '插件运行时没装配 comfy')
    let positive = str(args.positive)
    let negative = str(args.negative)
    let forged = null
    const text = str(args.text).trim()
    if (positive.trim() === '' && text !== '') {
      forged = await forgeTags({ text, ...(isRecord(args.options) ? args.options : {}) })
      if (forged?.ok !== true) return forged
      positive = str(forged.positive)
      // 负向由 ComfyUI 工作流内置，不再沿用锻造结果的负向串
    }
    if (positive.trim() === '' && negative.trim() === '') {
      return { ok: false, error: 'empty-prompt', message: '给 text（白话，会先锻造）或 positive（现成 tag 串）' }
    }
    let submitted
    try {
      submitted = await comfy.submit({
        workflowId: str(args.workflowId),
        positive,
        negative,
        vars: isRecord(args.vars) ? args.vars : {},
      })
    } catch (error) {
      return { ok: false, error: 'submit-failed', message: describeError(error, { scope: 'ComfyUI 投递', target: comfyTarget() }) }
    }
    if (submitted?.ok !== true) return submitted
    if (args.wait === true) {
      let final
      try {
        final = await comfy.waitFor(submitted.promptId, {
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        })
      } catch (error) {
        // 等待失败不等于投递失败：submitted 一起带回去，调用方能拿 promptId 接着 comfy_status 轮询，别重复投。
        return {
          ok: false,
          error: 'wait-failed',
          message: describeError(error, { scope: 'ComfyUI 等待出图', target: comfyTarget() }),
          forged,
          submitted,
        }
      }
      // wait:true 只有真出图才算成功：final 失败（state:failed / 超时）对 MCP 也是 isError
      return { ok: final?.ok === true && final?.state === 'done', forged, submitted, final }
    }
    return { ok: true, forged, submitted, next: '用 comfy_status 传 promptId 续查（或 comfy_run 时给 wait:true 同步等）' }
  }

  async function comfyStatus(args) {
    if (typeof comfy?.status !== 'function') return unavailable('ComfyUI 客户端', '插件运行时没装配 comfy')
    const promptId = str(args.promptId).trim()
    if (promptId === '') return { ok: false, error: 'no-prompt-id', message: '给 promptId（comfy_run 返回的那个）' }
    try {
      return await comfy.status(promptId)
    } catch (error) {
      return { ok: false, error: 'status-failed', message: describeError(error, { scope: 'ComfyUI 查状态', target: comfyTarget() }) }
    }
  }

  async function tagSearch(args) {
    if (typeof tags?.search !== 'function') return unavailable('标签库', '插件运行时没装配 tags')
    const query = str(args.q ?? args.query).trim()
    if (query === '') return { ok: false, error: 'empty-query', message: '给 q：要查的标签（中文或英文都行）' }
    const limit = positiveInt(args.limit, 20)
    const options = { limit: Math.min(200, limit) }
    if (Array.isArray(args.kinds)) options.kinds = args.kinds.map(String)
    // 冷启动时标签索引还在异步加载：先等它就绪，否则第一次检索会退化成只搜 seed 词表。
    if (typeof tags.ready === 'function') {
      try {
        await tags.ready()
      } catch {
        // 就绪失败不挡住检索：让它按手上现有的索引尽力答
      }
    }
    try {
      const rows = tags.search(query, options)
      return { ok: true, query, rows: Array.isArray(rows) ? rows : [], stats: typeof tags.stats === 'function' ? tags.stats() : undefined }
    } catch (error) {
      return { ok: false, error: 'search-failed', message: describeError(error, { scope: '标签库检索' }) }
    }
  }

  const TOOLS = [
    {
      name: 'forge_tags',
      description: '把白话（中文）画面描述锻造成 WD（Danbooru）+ Camie 标准图像标签：正向串、负向串、逐条权重。'
        + '这一步替代"再找一个 LLM 把话转成 tag"，输出已按本地标签库校对，可直接进 ComfyUI。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '用户的白话描述（中文即可）。' },
          standards: { type: 'array', items: { type: 'string', enum: ['wd', 'camie'] }, description: '标签标准，默认按配置。' },
          maxTags: { type: 'integer', description: '最多几个正向 tag，默认按配置。' },
          negative: { type: 'string', description: '附加负向词；默认留空（负向由 ComfyUI 工作流内置）。' },
          syntax: { type: 'string', description: '权重语法（例如 danbooru 的 (tag:1.2)）；不给就按配置的 ui.weightSyntax。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      run: forgeTags,
    },
    {
      name: 'refine_tags',
      description: '对已有标签串做增量精修：给一句话指令（加什么 / 改成什么 / 删什么 / 调权重），返回改后的正向串、负向串与本次增删。'
        + '适合"大体已经对了，只想再修一版"——它不重写整串，只做最小改动。',
      inputSchema: {
        type: 'object',
        properties: {
          positive: { type: 'string', description: '已有的正向 tag 串（要精修的对象）。' },
          negative: { type: 'string', description: '已有的负向 tag 串，可选。' },
          instruction: { type: 'string', description: '一句话说明想怎么改，例如"再加点暖光和发丝细节"。' },
          mode: {
            type: 'string',
            enum: ['add', 'edit', 'prune', 'weights'],
            description: 'add 只加 / edit 改写 / prune 删减 / weights 重排权重，默认 add。',
          },
        },
        required: ['positive', 'instruction'],
        additionalProperties: false,
      },
      run: refineTags,
    },
    {
      name: 'comfy_workflows',
      description: '列出本机工作流目录里的 API 格式模板：id、标题、说明、可调变量（vars 的键名就是 comfy_run 能传的）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: comfyWorkflows,
    },
    {
      name: 'comfy_run',
      description: '投递一次出图：给 text 先用 forge_tags 锻造，给 positive 则直接投；不给 workflowId 用配置里的默认工作流。'
        + '返回 promptId；wait:true 会同步等到出图（上限按配置 timeoutMs）。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '白话描述；给了就自动锻造 tag。' },
          positive: { type: 'string', description: '现成正向 tag 串，给了就跳过锻造。' },
          negative: { type: 'string', description: '负向 tag 串；留空表示用工作流里内置的那一份。' },
          workflowId: { type: 'string', description: '工作流 id（见 comfy_workflows）。' },
          vars: { type: 'object', additionalProperties: true, description: '其它变量（宽高、seed、steps…）；也可用 "节点id.输入名" 精确指定。' },
          wait: { type: 'boolean', description: 'true = 同步等到出图或失败。' },
          timeoutMs: { type: 'integer', description: '等待上限（毫秒），仅 wait:true 时生效。' },
          options: { type: 'object', additionalProperties: true, description: '锻造选项（standards / maxTags / negative），只有走锻造时生效。' },
        },
        required: [],
        additionalProperties: false,
      },
      run: comfyRun,
    },
    {
      name: 'comfy_status',
      description: '查一次 ComfyUI 任务：queued / running / done / failed，完成时给图片地址（filename/subfolder/type/url）。',
      inputSchema: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'comfy_run 返回的 promptId。' } },
        required: ['promptId'],
        additionalProperties: false,
      },
      run: comfyStatus,
    },
    {
      name: 'tag_search',
      description: '在本地标签库（Danbooru 索引）里搜标签：给中文或英文关键词，返回 tag / kind / 中文名 / 出现次数。',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '关键词，中文或英文。' },
          limit: { type: 'integer', description: '最多几条，默认 20。' },
          kinds: { type: 'array', items: { type: 'string', enum: ['general', 'character', 'copyright', 'artist'] }, description: '只查这些类别（general / character / copyright / artist）。' },
        },
        required: ['q'],
        additionalProperties: false,
      },
      run: tagSearch,
    },
  ]

  const toolByName = new Map(TOOLS.map(tool => [tool.name, tool]))

  function ok(id, result) {
    return { jsonrpc: '2.0', id, result }
  }

  function fail(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
  }

  async function callTool(id, params) {
    const name = isRecord(params) ? params.name : undefined
    if (typeof name !== 'string' || name === '') {
      return fail(id, ERROR_INVALID_PARAMS, 'tools/call 需要 params.name')
    }
    const tool = toolByName.get(name)
    if (tool === undefined) {
      return fail(id, ERROR_INVALID_PARAMS, '没有这个工具：' + name, { available: TOOLS.map(item => item.name) })
    }
    const args = isRecord(params.arguments) ? params.arguments : {}
    let value
    try {
      value = await tool.run(args)
    } catch (error) {
      // 工具内部抛出来的也当业务失败返回：JSON-RPC 层不因为一次检索崩掉整条通道
      warn('工具 ' + name + ' 抛错：' + msgOf(error))
      value = { ok: false, error: 'tool-failed', message: describeError(error, { scope: '工具 ' + name }) }
    }
    const payload = isRecord(value) ? value : { ok: true, value }
    return ok(id, { content: textResult(payload), isError: payload.ok === false })
  }

  async function handleOne(message) {
    const isNotification = isRecord(message) && message.id === undefined
    const id = isRecord(message) && message.id !== undefined ? message.id : null

    if (!isRecord(message)) {
      return fail(null, ERROR_INVALID_REQUEST, 'Invalid Request：body 必须是 JSON 对象（或对象数组）')
    }
    const method = str(message.method)
    if (method === '') {
      return isNotification ? null : fail(id, ERROR_INVALID_REQUEST, 'Invalid Request：缺 method')
    }

    switch (method) {
      case 'initialize':
        // 规范：通知（无 id）不回包。请求型方法被当通知发过来也不回，
        // 回一个 id:null 会被严格客户端当成协议错误。
        return isNotification ? null : ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return isNotification ? null : ok(id, {})
      case 'tools/list':
        return isNotification ? null : ok(id, {
          tools: TOOLS.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        })
      case 'tools/call': {
        // 通知型 tools/call：副作用照做，但不回包
        const reply = await callTool(id, message.params)
        return isNotification ? null : reply
      }
      default:
        // 规范：未知方法是 -32601；通知类消息不回复
        return isNotification ? null : fail(id, ERROR_METHOD_NOT_FOUND, 'Method not found: ' + method)
    }
  }

  /** 入口：支持单条与批量（数组）；通知与全通知批量返回 null，空批量回 -32600。 */
  async function handle(body) {
    if (Array.isArray(body)) {
      // 规范：空数组属于 Invalid Request，回一条 id:null 的 -32600（既不是空数组，也不是 null）
      if (body.length === 0) return fail(null, ERROR_INVALID_REQUEST, 'Invalid Request：批量请求不能是空数组')
      const replies = []
      for (const message of body) {
        const reply = await handleOne(message)
        if (reply !== null) replies.push(reply)
      }
      // 全是通知的批量没有可回内容：按规范什么都不回（null），不是空数组
      return replies.length === 0 ? null : replies
    }
    return handleOne(body)
  }

  return {
    handle,
    /** 迟绑定精修器：宿主构造顺序不保证 refine 先到，谁后拿到谁调这个补上。 */
    attach(next = {}) {
      if (isRecord(next) && next.refine !== undefined && next.refine !== null) refiner = next.refine
      return typeof refiner?.refine === 'function'
    },
    /** 给面板 / 调试用：工具清单（只读快照）。 */
    tools: () => TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
  }
}
