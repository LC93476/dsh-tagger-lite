/**
 * lib/mcp.js 的测试：JSON-RPC 2.0 外壳 + 六个工具的转发。
 *
 * 只测协议层，所以 forge / comfy / tags 全是记账用的假实现：
 * 真锻造归 lib/forge.js 的测试，真投递归 tests/comfy.test.mjs，
 * 这里要验的是"参数有没有原样转过去、结果有没有按 MCP 形状包回来、异常有没有兜住"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMcpHandler, PROTOCOL_VERSION, SERVER_INFO } from '../lib/mcp.js'

const quietLogger = { info() {}, warn() {}, error() {} }

function makeForge(overrides = {}) {
  const calls = []
  const value = {
    ok: true,
    positive: '1girl, solo, hanfu, night, neon',
    negative: 'lowres, bad anatomy',
    tags: [{ tag: '1girl', weight: 1 }],
    ...overrides,
  }
  return {
    calls,
    async generate(args) {
      calls.push(args)
      return value
    },
  }
}

function makeComfy(overrides = {}) {
  const calls = { submit: [], status: [], waitFor: [], listWorkflows: 0 }
  return {
    calls,
    async submit(args) {
      calls.submit.push(args)
      return {
        ok: true,
        promptId: 'pid-1',
        queueNumber: 3,
        workflowId: args.workflowId === '' ? 'demo-t2i' : args.workflowId,
        mapping: { positiveNode: '5', negativeNode: '6' },
        ...overrides.submit,
      }
    },
    async status(promptId) {
      calls.status.push(promptId)
      return {
        ok: true,
        promptId,
        state: 'done',
        images: [{ filename: 'a.png', subfolder: '', type: 'output', url: '/view?filename=a.png' }],
        ...overrides.status,
      }
    },
    async waitFor(promptId, options) {
      calls.waitFor.push({ promptId, options })
      return { ok: true, promptId, state: 'done', timedOut: false, waitedMs: 4200, images: [], ...overrides.waitFor }
    },
    async listWorkflows() {
      calls.listWorkflows += 1
      return {
        ok: true,
        dir: 'C:/Users/x/.dsh-comfyui-workbench/workflows',
        workflows: [{ id: 'demo-t2i', title: '测试文生图', vars: [{ name: 'prompt' }] }],
        ...overrides.listWorkflows,
      }
    },
  }
}

function makeTags(rows = [{ tag: 'hanfu', kind: 'general', zh: '汉服', count: 1234 }]) {
  const calls = []
  return {
    calls,
    search(query, options) {
      calls.push({ query, options })
      return rows
    },
    stats() {
      return { total: 1, kinds: { general: 1 } }
    },
  }
}

function makeRefiner(overrides = {}) {
  const calls = []
  const value = {
    ok: true,
    mode: 'add',
    positive: '1girl, solo, hanfu, night, neon, warm light',
    negative: '',
    tags: [{ tag: 'warm light', weight: 1 }],
    delta: { added: ['warm light'], removed: [], weighted: [] },
    ops: 1,
    notes: '补了光线',
    ms: 12,
    model: 'fake-model',
    purgeLevel: 'none',
    warnings: [],
    ...overrides,
  }
  return {
    calls,
    async refine(input) {
      calls.push(input)
      return value
    },
  }
}

/**
 * 测试里注入的假实现：每个都是记账对象，字段形状各用例自己关心。
 * @typedef {object} McpTestDeps
 * @property {any} [forge]
 * @property {any} [comfy]
 * @property {any} [tags]
 * @property {any} [refine]
 */

/** @param {McpTestDeps} [deps] */
function build(deps = {}) {
  const forge = 'forge' in deps ? deps.forge : makeForge()
  const comfy = 'comfy' in deps ? deps.comfy : makeComfy()
  const tags = 'tags' in deps ? deps.tags : makeTags()
  const refine = 'refine' in deps ? deps.refine : makeRefiner()
  const handler = createMcpHandler({ forge, comfy, tags, refine, config: { comfy: {} }, logger: quietLogger })
  return { handler, forge, comfy, tags, refine }
}

let counter = 1
async function rpc(handler, method, params, id) {
  const useId = id === undefined ? counter++ : id
  return handler.handle({ jsonrpc: '2.0', id: useId, method, ...(params === undefined ? {} : { params }) })
}

function payloadOf(reply) {
  assert.equal(reply.jsonrpc, '2.0')
  assert.ok(Array.isArray(reply.result.content), 'content 应该是数组')
  assert.equal(reply.result.content.length, 1)
  assert.equal(reply.result.content[0].type, 'text')
  return JSON.parse(reply.result.content[0].text)
}

// ── 协议外壳 ──────────────────────────────────────────────────────────────

test('initialize：返回协议版本、tools 能力、serverInfo、说明', async () => {
  const { handler } = build()
  const reply = await rpc(handler, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  })
  assert.equal(reply.jsonrpc, '2.0')
  assert.equal(reply.result.protocolVersion, '2024-11-05')
  assert.deepEqual(reply.result.capabilities.tools, { listChanged: false })
  assert.equal(reply.result.serverInfo.name, SERVER_INFO.name)
  assert.equal(reply.result.serverInfo.version, SERVER_INFO.version)
  assert.match(reply.result.instructions, /forge_tags/)
})

test('ping：回空对象', async () => {
  const { handler } = build()
  const reply = await rpc(handler, 'ping')
  assert.deepEqual(reply.result, {})
  assert.equal(reply.error, undefined)
})

test('tools/list：六个工具、都有 object 型 inputSchema、必填项合理', async () => {
  const { handler } = build()
  const reply = await rpc(handler, 'tools/list')
  const tools = reply.result.tools
  assert.deepEqual(tools.map(tool => tool.name), ['forge_tags', 'refine_tags', 'comfy_workflows', 'comfy_run', 'comfy_status', 'tag_search'])
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
    assert.ok(tool.description.length > 10, tool.name + ' 要有像样的说明')
  }
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  assert.deepEqual(byName.get('forge_tags').inputSchema.required, ['text'])
  assert.deepEqual(byName.get('comfy_status').inputSchema.required, ['promptId'])
  assert.deepEqual(byName.get('comfy_workflows').inputSchema.properties, {})
  assert.deepEqual(byName.get('comfy_run').inputSchema.required, [])
  assert.equal(byName.get('comfy_run').inputSchema.properties.wait.type, 'boolean')
  // refine_tags：对已有串做增量精修，positive + instruction 必填，mode 收四种
  assert.deepEqual(byName.get('refine_tags').inputSchema.required, ['positive', 'instruction'])
  assert.deepEqual(byName.get('refine_tags').inputSchema.properties.mode.enum, ['add', 'edit', 'prune', 'weights'])
})

test('通知（无 id）不回复；批量请求逐条回，通知被跳过', async () => {
  const { handler } = build()
  assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  assert.equal(await handler.handle({ jsonrpc: '2.0', method: 'initialize' }), null)

  const replies = await handler.handle([
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ])
  assert.ok(Array.isArray(replies))
  assert.deepEqual(replies.map(reply => reply.id), ['a', 'b'])
})

test('错误码：未知方法 -32601、缺 method -32600、非对象 -32600', async () => {
  const { handler } = build()
  const unknown = await rpc(handler, 'tools/nope', undefined, 'x1')
  assert.equal(unknown.error.code, -32601)
  assert.equal(unknown.id, 'x1')

  /** @type {any} */
  const noMethod = await handler.handle({ jsonrpc: '2.0', id: 'x2' })
  assert.equal(noMethod.error.code, -32600)

  /** @type {any} */
  const notObject = await handler.handle('not-a-message')
  assert.equal(notObject.error.code, -32600)
  assert.equal(notObject.id, null)
})

test('tools/call 参数错误：缺 name / 未知工具都是 -32602', async () => {
  const { handler } = build()
  const missing = await rpc(handler, 'tools/call', { arguments: {} })
  assert.equal(missing.error.code, -32602)
  assert.match(missing.error.message, /params\.name/)

  const unknownTool = await rpc(handler, 'tools/call', { name: 'nope' })
  assert.equal(unknownTool.error.code, -32602)
  assert.ok(unknownTool.error.data.available.includes('forge_tags'))
})

// ── 工具转发 ──────────────────────────────────────────────────────────────

test('forge_tags：把 text 与归一化后的 options 转给锻造器', async () => {
  const { handler, forge } = build()
  const reply = await rpc(handler, 'tools/call', {
    name: 'forge_tags',
    arguments: { text: '  雨夜霓虹街头，红衣少女回头  ', standards: ['WD', 'Camie', 'nope'], maxTags: '24', negative: 'watermark', syntax: 'danbooru' },
  })
  const payload = payloadOf(reply)
  assert.equal(reply.result.isError, false)
  assert.equal(payload.ok, true)
  assert.equal(payload.positive, '1girl, solo, hanfu, night, neon')
  assert.equal(forge.calls.length, 1)
  assert.equal(forge.calls[0].text, '雨夜霓虹街头，红衣少女回头')
  assert.deepEqual(forge.calls[0].options, { standards: ['wd', 'camie'], maxTags: 24, negative: 'watermark', syntax: 'danbooru' })
})

test('forge_tags：空 text、锻造器抛错、锻造器缺席都回 ok:false', async () => {
  const { handler, forge } = build()
  const empty = payloadOf(await rpc(handler, 'tools/call', { name: 'forge_tags', arguments: { text: '   ' } }))
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'empty-text')
  assert.equal(forge.calls.length, 0)

  const throwing = createMcpHandler({
    forge: { async generate() { throw new Error('llm 挂了') } },
    comfy: makeComfy(),
    tags: makeTags(),
    logger: quietLogger,
  })
  const reply = await rpc(throwing, 'tools/call', { name: 'forge_tags', arguments: { text: '随便' } })
  assert.equal(reply.result.isError, true)
  assert.match(payloadOf(reply).message, /llm 挂了/)

  const bare = createMcpHandler({ comfy: makeComfy(), tags: makeTags(), logger: quietLogger })
  const unavailable = payloadOf(await rpc(bare, 'tools/call', { name: 'forge_tags', arguments: { text: '随便' } }))
  assert.equal(unavailable.error, 'unavailable')
})

test('comfy_workflows：转发 listWorkflows', async () => {
  const { handler, comfy } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', { name: 'comfy_workflows', arguments: {} }))
  assert.equal(payload.ok, true)
  assert.equal(payload.workflows[0].id, 'demo-t2i')
  assert.equal(comfy.calls.listWorkflows, 1)
})

test('comfy_run：给 positive 就直接投，不碰锻造器', async () => {
  const { handler, forge, comfy } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', {
    name: 'comfy_run',
    arguments: { positive: '1girl, solo', negative: 'lowres', workflowId: 'demo-t2i', vars: { width: 832, seed: 7 } },
  }))
  assert.equal(payload.ok, true)
  assert.equal(payload.submitted.promptId, 'pid-1')
  assert.equal(payload.forged, null)
  assert.equal(forge.calls.length, 0)
  assert.deepEqual(comfy.calls.submit[0], { workflowId: 'demo-t2i', positive: '1girl, solo', negative: 'lowres', vars: { width: 832, seed: 7 } })
  assert.match(payload.next, /comfy_status/)
})

test('comfy_run：只给 text 时先锻造，再拿锻造结果去投', async () => {
  const { handler, forge, comfy } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', {
    name: 'comfy_run',
    arguments: { text: '雨夜霓虹街头，红衣少女回头', wait: false },
  }))
  assert.equal(payload.ok, true)
  assert.equal(forge.calls.length, 1)
  assert.equal(comfy.calls.submit[0].positive, '1girl, solo, hanfu, night, neon')
  assert.equal(comfy.calls.submit[0].negative, '', '负向由 ComfyUI 内置，不再沿用锻造结果的负向串')
  assert.equal(comfy.calls.submit[0].workflowId, '')
  assert.deepEqual(comfy.calls.submit[0].vars, {})
  assert.equal(payload.forged.ok, true)
})

test('comfy_run：显式 negative 原样传给工作流', async () => {
  const { handler, comfy } = build()
  await rpc(handler, 'tools/call', { name: 'comfy_run', arguments: { text: '古风少女', negative: 'nsfw' } })
  assert.equal(comfy.calls.submit[0].negative, 'nsfw')
})

test('comfy_run：wait:true 会等出图，并把 final 一起带回来', async () => {
  const { handler, comfy } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', { name: 'comfy_run', arguments: { positive: '1girl', wait: true, timeoutMs: 60000 } }))
  assert.equal(payload.ok, true)
  assert.equal(payload.final.state, 'done')
  assert.equal(payload.final.waitedMs, 4200)
  assert.deepEqual(comfy.calls.waitFor, [{ promptId: 'pid-1', options: { timeoutMs: 60000 } }])
})

test('comfy_run：wait:true 但没出成图时 ok 跟 final 走', async () => {
  const comfy = makeComfy({ waitFor: { ok: false, state: 'failed', timedOut: true, message: '超时' } })
  const { handler } = build({ comfy })
  const reply = await rpc(handler, 'tools/call', { name: 'comfy_run', arguments: { positive: '1girl', wait: true } })
  assert.equal(reply.result.isError, true)
  const payload = payloadOf(reply)
  assert.equal(payload.ok, false)
  assert.equal(payload.final.timedOut, true)
  assert.equal(payload.submitted.ok, true, '投递本身是成功的，信息不该丢')
})

test('comfy_run：空提示词 / 锻造失败 / 投递失败 / 投递抛错 都回 ok:false', async () => {
  const { handler, comfy } = build()
  const empty = payloadOf(await rpc(handler, 'tools/call', { name: 'comfy_run', arguments: { positive: '  ', negative: '' } }))
  assert.equal(empty.error, 'empty-prompt')
  assert.equal(comfy.calls.submit.length, 0)

  const failingForge = build({ forge: makeForge({ ok: false, error: 'no-llm', message: '没有可用模型' }) })
  const forged = payloadOf(await rpc(failingForge.handler, 'tools/call', { name: 'comfy_run', arguments: { text: '古风少女' } }))
  assert.equal(forged.ok, false)
  assert.equal(forged.error, 'no-llm')
  assert.equal(failingForge.comfy.calls.submit.length, 0)

  const rejecting = build({ comfy: makeComfy({ submit: { ok: false, error: 'unreachable', message: '连不上 ComfyUI' } }) })
  const rejected = payloadOf(await rpc(rejecting.handler, 'tools/call', { name: 'comfy_run', arguments: { positive: '1girl' } }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'unreachable')

  const throwing = createMcpHandler({
    forge: makeForge(),
    comfy: { async submit() { throw new Error('socket hang up') } },
    tags: makeTags(),
    logger: quietLogger,
  })
  const thrown = payloadOf(await rpc(throwing, 'tools/call', { name: 'comfy_run', arguments: { positive: '1girl' } }))
  assert.equal(thrown.error, 'submit-failed')
  assert.match(thrown.message, /socket hang up/)
})

test('comfy_status：转发 promptId，缺参报错', async () => {
  const { handler, comfy } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', { name: 'comfy_status', arguments: { promptId: 'pid-1' } }))
  assert.equal(payload.state, 'done')
  assert.equal(payload.images[0].filename, 'a.png')
  assert.deepEqual(comfy.calls.status, ['pid-1'])

  const missing = payloadOf(await rpc(handler, 'tools/call', { name: 'comfy_status', arguments: {} }))
  assert.equal(missing.error, 'no-prompt-id')
})

test('tag_search：转发查询、limit 上限 200、带 stats', async () => {
  const { handler, tags } = build()
  const payload = payloadOf(await rpc(handler, 'tools/call', { name: 'tag_search', arguments: { q: ' 汉服 ', limit: 500, kinds: ['general'] } }))
  assert.equal(payload.ok, true)
  assert.equal(payload.query, '汉服')
  assert.equal(payload.rows.length, 1)
  assert.equal(payload.rows[0].zh, '汉服')
  assert.equal(payload.stats.total, 1)
  assert.deepEqual(tags.calls[0], { query: '汉服', options: { limit: 200, kinds: ['general'] } })

  const missing = payloadOf(await rpc(handler, 'tools/call', { name: 'tag_search', arguments: { q: '' } }))
  assert.equal(missing.error, 'empty-query')
})

test('标签库抛错时兜成 ok:false 而不是把整条通道打崩', async () => {
  const handler = createMcpHandler({
    forge: makeForge(),
    comfy: makeComfy(),
    tags: { search() { throw new Error('索引坏了') } },
    logger: quietLogger,
  })
  const reply = await rpc(handler, 'tools/call', { name: 'tag_search', arguments: { q: 'hanfu' } })
  assert.equal(reply.result.isError, true)
  assert.equal(payloadOf(reply).error, 'search-failed')
})

test('refine_tags：把已有串 + 指令原样转给精修器，只回紧凑结果', async () => {
  const { handler, refine } = build()
  const reply = await rpc(handler, 'tools/call', {
    name: 'refine_tags',
    arguments: { positive: '1girl, solo', negative: 'lowres', instruction: '再加点暖光和发丝细节' },
  })
  assert.equal(reply.result.isError, false)
  assert.deepEqual(refine.calls, [
    { positive: '1girl, solo', negative: 'lowres', instruction: '再加点暖光和发丝细节', mode: 'add' },
  ])
  const payload = payloadOf(reply)
  assert.equal(payload.ok, true)
  assert.equal(payload.mode, 'add')
  assert.equal(payload.positive, '1girl, solo, hanfu, night, neon, warm light')
  assert.deepEqual(payload.delta, { added: ['warm light'], removed: [], weighted: [] })
  assert.equal(payload.ops, 1)
  assert.equal(payload.notes, '补了光线')
  // 紧凑：全量 tags / 模型名这些不进 MCP 结果
  assert.equal(payload.tags, undefined)
  assert.equal(payload.model, undefined)
})

test('refine_tags：mode 只认四种，乱给按 add 走', async () => {
  const { handler, refine } = build()
  await rpc(handler, 'tools/call', {
    name: 'refine_tags',
    arguments: { positive: 'a, b', instruction: '重排权重', mode: 'weights' },
  })
  await rpc(handler, 'tools/call', {
    name: 'refine_tags',
    arguments: { positive: 'a, b', instruction: '随便', mode: 'bogus' },
  })
  assert.deepEqual(refine.calls.map(call => call.mode), ['weights', 'add'])
})

test('refine_tags：缺参 / 精修器缺席 / 精修器回 not-implemented 都回结构化结果', async () => {
  const bareHandler = build({ refine: undefined }).handler
  const noPositive = payloadOf(await rpc(bareHandler, 'tools/call', { name: 'refine_tags', arguments: { instruction: 'x' } }))
  assert.equal(noPositive.error, 'empty-positive')

  const noInstruction = payloadOf(await rpc(bareHandler, 'tools/call', { name: 'refine_tags', arguments: { positive: 'a, b' } }))
  assert.equal(noInstruction.error, 'empty-instruction')

  const noRefiner = payloadOf(await rpc(bareHandler, 'tools/call', { name: 'refine_tags', arguments: { positive: 'a, b', instruction: 'x' } }))
  assert.equal(noRefiner.ok, false)
  assert.equal(noRefiner.error, 'unavailable')

  // 骨架占位阶段：refine 会回 not-implemented —— 这时也要给出能读的结构，不能把通道打崩
  const stub = makeRefiner({
    ok: false,
    error: 'not-implemented',
    message: 'refine 引擎还没接上（骨架占位）。',
    positive: '',
    negative: '',
    delta: { added: [], removed: [], weighted: [] },
    notes: '',
    ms: 0,
  })
  const reply = await rpc(build({ refine: stub }).handler, 'tools/call', {
    name: 'refine_tags',
    arguments: { positive: 'a, b', negative: 'lowres', instruction: 'x' },
  })
  assert.equal(reply.result.isError, true)
  const payload = payloadOf(reply)
  assert.equal(payload.error, 'not-implemented')
  assert.equal(payload.positive, 'a, b')
  assert.equal(payload.negative, 'lowres')
  assert.deepEqual(payload.delta, { added: [], removed: [], weighted: [] })
  assert.deepEqual(payload.warnings, [])
})

test('attach：精修器可以后补上（宿主构造顺序不保证 refine 先到）', async () => {
  const handler = createMcpHandler({ forge: makeForge(), comfy: makeComfy(), tags: makeTags(), logger: quietLogger })
  const before = payloadOf(await rpc(handler, 'tools/call', { name: 'refine_tags', arguments: { positive: 'a, b', instruction: 'x' } }))
  assert.equal(before.error, 'unavailable')

  const refine = makeRefiner()
  assert.equal(handler.attach({ refine }), true)
  const after = payloadOf(await rpc(handler, 'tools/call', { name: 'refine_tags', arguments: { positive: 'a, b', instruction: 'x' } }))
  assert.equal(after.ok, true)
})

test('客户端只读接口：handler.tools() 给的是快照，不含 run', async () => {
  const { handler } = build()
  const snapshot = handler.tools()
  assert.equal(snapshot.length, 6)
  assert.equal(/** @type {any} */ (snapshot[0]).run, undefined)
  assert.equal(handler.protocolVersion, PROTOCOL_VERSION)
  assert.equal(handler.serverInfo.name, SERVER_INFO.name)
  assert.equal(typeof handler.handle, 'function')
  assert.ok(handler.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }) instanceof Promise)
})
