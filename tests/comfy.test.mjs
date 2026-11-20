/**
 * lib/comfy.js 的测试。
 *
 * 两类用例：
 *   1. 真连本机 ComfyUI（127.0.0.1:8188）：ping / listWorkflows —— 服务不在就跑不动，明确跳过；
 *   2. 假服务（本地 http server）+ 临时工作流目录：submit 的节点映射/vars/拒收、status 四态、
 *      waitFor 轮询、image 取图、不可达地址的错误处理。
 *
 * 为什么第 2 类也起真 server 而不是打桩 fetch：映射对不对只有看"实际 POST 出去的 prompt"才算数，
 * 而且这样能验证我们自己那套 node:http 请求代码（超时、二进制、状态码）真的能跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createComfyClient, resolveWorkflowDir, isUiFormat, resolveTextMapping, applyVars } from '../lib/comfy.js'
import { bindingTargetOf, varsFromSchema } from '../lib/comfy/workflow.js'

const REAL_BASE_URL = 'http://127.0.0.1:8188'
const WORKBENCH_WORKFLOWS = path.join(os.homedir(), '.dsh-comfyui-workbench', 'workflows')

const quietLogger = { info() {}, warn() {}, error() {} }

function clientFor(comfy = {}) {
  return createComfyClient({
    config: {
      comfy: {
        baseUrl: REAL_BASE_URL,
        workflowDir: '',
        defaultWorkflowId: '',
        positiveNode: '',
        negativeNode: '',
        pollIntervalMs: 50,
        timeoutMs: 5000,
        ...comfy,
      },
    },
    logger: quietLogger,
  })
}

function fixtureWorkflow(titles = ['正向提示词', '负向提示词']) {
  return {
    1: { class_type: 'CheckpointLoaderSimple', _meta: { title: '模型' }, inputs: { ckpt_name: 'model.safetensors' } },
    5: { class_type: 'CLIPTextEncode', _meta: { title: titles[0] }, inputs: { text: 'default positive', clip: ['1', 1] } },
    6: { class_type: 'CLIPTextEncode', _meta: { title: titles[1] }, inputs: { text: 'default negative', clip: ['1', 1] } },
    7: { class_type: 'EmptyLatentImage', _meta: { title: '画幅' }, inputs: { width: 832, height: 1216, batch_size: 1 } },
    8: {
      class_type: 'KSampler',
      _meta: { title: '采样器' },
      inputs: {
        model: ['1', 0],
        seed: 123456789,
        steps: 30,
        cfg: 3,
        sampler_name: 'euler',
        scheduler: 'normal',
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['7', 0],
        denoise: 1,
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
    10: { class_type: 'SaveImage', inputs: { filename_prefix: 'anima_smoke', images: ['9', 0] } },
  }
}

function fixtureSchema() {
  return {
    title: '测试工作流',
    description: '假服务用的最小文生图',
    internalInputs: ['ckpt_name'],
    vars: [
      { name: 'prompt', label: '正向提示词', group: 'basic', type: 'string' },
      { name: 'negative_prompt', label: '负向提示词', group: 'basic', type: 'string' },
      { name: 'width', label: '宽', group: 'advanced', type: 'number', default: 832, min: 512, max: 1536, step: 16 },
      { name: 'height', label: '高', group: 'advanced', type: 'number', default: 1216 },
      { name: 'seed', label: '种子', group: 'advanced', type: 'number', default: 123456789 },
      { name: 'steps', label: '步数', group: 'advanced', type: 'number', default: 30 },
    ],
  }
}

function makeWorkflowDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  fs.writeFileSync(path.join(dir, 'demo-t2i.json'), JSON.stringify(fixtureWorkflow(), null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'demo-t2i.schema.json'), JSON.stringify(fixtureSchema(), null, 2), 'utf8')
  return dir
}

/**
 * 假 ComfyUI：state 里的东西由每个用例改，请求全记账（state.requests），
 * 这样断言看的是"我们实际发了什么"，不是"我们以为发了什么"。
 */
async function startFakeComfy() {
  const state = {
    requests: [],
    queue: { queue_running: [], queue_pending: [] },
    history: {},
    promptResponse: { prompt_id: 'pid-1', number: 7, node_errors: {} },
    queueStatus: 200,
    historyStatus: 200,
    view: { status: 200, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), type: 'image/png' },
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      let body
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          body = raw.toString('utf8')
        }
      }
      state.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      })
      const send = (status, payload, type = 'application/json') => {
        const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
        res.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length })
        res.end(buffer)
      }
      if (url.pathname === '/system_stats') {
        send(200, { system: { comfyui_version: '0.45.0-fake', os: 'win32', python_version: '3.13.11 (tags)' }, devices: [{ name: 'cuda:0 fake', vram_total: 8 }] })
        return
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        send(200, state.promptResponse)
        return
      }
      if (url.pathname === '/queue') {
        send(state.queueStatus, typeof state.queueFn === 'function' ? state.queueFn() : state.queue)
        return
      }
      if (url.pathname.startsWith('/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/history/'.length))
        send(state.historyStatus, state.history[id] === undefined ? {} : { [id]: state.history[id] })
        return
      }
      if (url.pathname === '/view') {
        send(state.view.status, state.view.body, state.view.type)
        return
      }
      send(404, { error: 'not-found', path: url.pathname })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(server)
  return {
    state,
    url: 'http://127.0.0.1:' + port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** @param {import('node:net').Server} server @returns {number} */
function portOf(server) {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

/** 一个确定没人监听的端口：先开再关，端口就空出来了。 */
async function deadBaseUrl() {
  const server = http.createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(server)
  await new Promise(resolve => server.close(resolve))
  return 'http://127.0.0.1:' + port
}

function doneHistory(promptId = 'pid-1', extra = {}) {
  return {
    prompt: [0, promptId, {}, { client_id: 'x', create_time: 1794819052421 }, ['10']],
    outputs: { 10: { images: [{ filename: 'anima_smoke_00001_.png', subfolder: '', type: 'output', metadata: { width: 512 } }] } },
    status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: promptId }]] },
    ...extra,
  }
}

// ── 真服务 ────────────────────────────────────────────────────────────────

test('ping：真连本机 ComfyUI（127.0.0.1:8188）', async t => {
  const result = await clientFor().ping()
  if (result.ok !== true) {
    t.skip('ComfyUI 未运行，跳过真连测试：' + result.message)
    return
  }
  assert.equal(result.reachable, true)
  assert.equal(result.baseUrl, REAL_BASE_URL)
  assert.match(result.version, /^\d+\.\d+/)
  console.log('    version=' + result.version + ' device=' + (result.devices[0]?.name ?? 'n/a'))
})

test('ping：不可达地址给出 ok:false + 可读消息', async () => {
  const baseUrl = await deadBaseUrl()
  const result = await clientFor({ baseUrl }).ping()
  assert.equal(result.ok, false)
  assert.equal(result.reachable, false)
  assert.equal(result.baseUrl, baseUrl)
  assert.match(result.message, /连不上 ComfyUI/)
})

test('listWorkflows：读真实工作流目录（跳过条件：目录不存在）', async t => {
  if (!fs.existsSync(WORKBENCH_WORKFLOWS)) {
    t.skip('工作流目录不存在：' + WORKBENCH_WORKFLOWS)
    return
  }
  const result = await clientFor().listWorkflows()
  assert.equal(result.ok, true)
  assert.equal(result.dir, resolveWorkflowDir({ comfy: { workflowDir: '' } }))
  assert.ok(result.workflows.length >= 1, '至少一个工作流')
  const anima = result.workflows.find(item => item.id === 'anima-feiyue-t2i')
  assert.ok(anima !== undefined, 'anima-feiyue-t2i 应该在目录里')
  assert.equal(anima.format, 'api')
  assert.equal(anima.vars[0].name, 'prompt')
  assert.equal(anima.vars[1].name, 'negative_prompt')
  assert.equal(anima.mapping.positiveNode, '5')
  assert.equal(anima.mapping.negativeNode, '6')
  assert.ok(fs.existsSync(anima.path))
  assert.ok(anima.schemaPath.endsWith('anima-feiyue-t2i.schema.json'))
  console.log('    dir=' + result.dir + ' workflows=' + result.workflows.map(item => item.id).join(','))
})

test('listWorkflows：临时目录里的坏 JSON / UI 格式 / 缺 schema 都被标出来', async () => {
  const dir = makeWorkflowDir()
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8')
  fs.writeFileSync(path.join(dir, 'ui-project.json'), JSON.stringify({ nodes: [{ id: 1 }], links: [], last_node_id: 1 }), 'utf8')
  fs.writeFileSync(path.join(dir, 'plain.json'), JSON.stringify(fixtureWorkflow()), 'utf8')

  const result = clientFor({ workflowDir: dir }).listWorkflows()
  const resolved = await result
  assert.equal(resolved.ok, true)
  const byId = new Map(resolved.workflows.map(item => [item.id, item]))
  assert.equal(byId.get('demo-t2i').hasSchema, true)
  assert.equal(byId.get('demo-t2i').title, '测试工作流')
  assert.match(byId.get('broken').error, /JSON 解析失败/)
  assert.equal(byId.get('ui-project').format, 'ui')
  assert.match(byId.get('ui-project').message, /Export \(API\)/)
  assert.equal(byId.get('plain').hasSchema, false)
  assert.ok(byId.get('plain').vars.some(item => item.name === 'seed'), '没有 schema 时从节点输入反推变量')
  assert.ok(Array.isArray(resolved.warnings) && resolved.warnings.length === 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('listWorkflows：目录不存在返回 ok:false', async () => {
  const result = await clientFor({ workflowDir: path.join(os.tmpdir(), 'pf-comfy-missing-' + Date.now()) }).listWorkflows()
  assert.equal(result.ok, false)
  assert.match(result.message, /工作流目录不存在/)
  assert.deepEqual(result.workflows, [])
})

// ── 映射逻辑（纯函数，边界情况多，单独测） ───────────────────────────────

test('resolveTextMapping：标题语义 / 配置优先 / 无线索按顺序', () => {
  const titles = fixtureWorkflow()
  assert.deepEqual(
    { pos: resolveTextMapping(titles, null, {}).positiveNode, neg: resolveTextMapping(titles, null, {}).negativeNode },
    { pos: '5', neg: '6' },
  )

  const cryptic = fixtureWorkflow(['文本 A', '文本 B'])
  assert.equal(resolveTextMapping(cryptic, null, {}).positiveNode, '5')
  assert.equal(resolveTextMapping(cryptic, null, {}).negativeNode, '6')

  // 配置指定压过标题
  const swapped = resolveTextMapping(titles, null, { comfy: { positiveNode: '6', negativeNode: '5' } })
  assert.deepEqual({ pos: swapped.positiveNode, neg: swapped.negativeNode }, { pos: '6', neg: '5' })

  // 配置写了个不存在的节点：忽略并留下提示，不静默
  const warnings = []
  const missing = resolveTextMapping(titles, null, { comfy: { positiveNode: '99' } }, warnings)
  assert.equal(missing.positiveNode, '5')
  assert.ok(warnings.some(item => item.includes('comfy.positiveNode=99')))

  // 英文模板
  const english = fixtureWorkflow(['positive prompt', 'negative prompt'])
  const en = resolveTextMapping(english, null, {})
  assert.deepEqual({ pos: en.positiveNode, neg: en.negativeNode }, { pos: '5', neg: '6' })

  // 只有一个文本节点：负向留空并提示，不许同一节点既正又负
  const single = { 5: { class_type: 'CLIPTextEncode', inputs: { text: 'only' } }, 8: { class_type: 'KSampler', inputs: {} } }
  const one = resolveTextMapping(single, null, {})
  assert.equal(one.positiveNode, '5')
  assert.equal(one.negativeNode, '')
})

test('isUiFormat：nodes+links 才算 UI 格式', () => {
  assert.equal(isUiFormat({ nodes: [], links: [] }), true)
  assert.equal(isUiFormat(fixtureWorkflow()), false)
  assert.equal(isUiFormat(null), false)
})

// ── submit（假服务） ──────────────────────────────────────────────────────

test('submit：按标题找正负节点、vars 落到同名输入、源文件不被改', async () => {
  const dir = makeWorkflowDir()
  const fake = await startFakeComfy()
  const before = fs.readFileSync(path.join(dir, 'demo-t2i.json'), 'utf8')
  try {
    const client = clientFor({ baseUrl: fake.url, workflowDir: dir })
    const result = await client.submit({
      workflowId: 'demo-t2i',
      positive: '1girl, solo, hanfu, masterpiece',
      negative: 'lowres, bad anatomy',
      vars: { width: 512, height: 768, seed: '42', steps: 12, denoise: 0.8, '8.cfg': '6.5' },
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.promptId, 'pid-1')
    assert.equal(result.workflowId, 'demo-t2i')
    assert.deepEqual(result.mapping, { positiveNode: '5', negativeNode: '6' })
    assert.equal(result.queueNumber, 7)

    const post = fake.state.requests.find(item => item.path === '/prompt' && item.method === 'POST')
    assert.ok(post !== undefined, '应该真的 POST 了 /prompt')
    const prompt = post.body.prompt
    assert.equal(prompt['5'].inputs.text, '1girl, solo, hanfu, masterpiece')
    assert.equal(prompt['6'].inputs.text, 'lowres, bad anatomy')
    assert.equal(prompt['7'].inputs.width, 512)
    assert.equal(prompt['7'].inputs.height, 768)
    assert.equal(prompt['8'].inputs.seed, 42, '字符串 seed 应该被转成数字')
    assert.equal(prompt['8'].inputs.steps, 12)
    assert.equal(prompt['8'].inputs.denoise, 0.8)
    assert.equal(prompt['8'].inputs.cfg, 6.5, '点号语法精确打到节点 8')
    assert.equal(typeof post.body.client_id, 'string')
    const appliedNames = result.applied.map(item => item.name)
    for (const name of ['width', 'height', 'seed', 'steps', 'denoise', '8.cfg']) {
      assert.ok(appliedNames.includes(name), '应该记录已应用变量：' + name)
    }

    assert.equal(fs.readFileSync(path.join(dir, 'demo-t2i.json'), 'utf8'), before, '模板文件必须原样不动')
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit：config.positiveNode/negativeNode 覆盖标题推断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-swap-'))
  fs.writeFileSync(path.join(dir, 'swap.json'), JSON.stringify(fixtureWorkflow(['文本 A', '文本 B'])), 'utf8')
  const fake = await startFakeComfy()
  try {
    const client = clientFor({ baseUrl: fake.url, workflowDir: dir, positiveNode: '6', negativeNode: '5' })
    const result = await client.submit({ workflowId: 'swap', positive: 'POS', negative: 'NEG' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.mapping, { positiveNode: '6', negativeNode: '5' })
    const prompt = fake.state.requests.find(item => item.path === '/prompt').body.prompt
    assert.equal(prompt['6'].inputs.text, 'POS')
    assert.equal(prompt['5'].inputs.text, 'NEG')
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit：不给 workflowId 时用目录里第一个 / 配置默认值', async () => {
  const dir = makeWorkflowDir()
  const fake = await startFakeComfy()
  try {
    const auto = await clientFor({ baseUrl: fake.url, workflowDir: dir }).submit({ positive: 'x' })
    assert.equal(auto.ok, true)
    assert.equal(auto.workflowId, 'demo-t2i')

    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-default-'))
    fs.writeFileSync(path.join(fallbackDir, 'a-first.json'), JSON.stringify(fixtureWorkflow()), 'utf8')
    fs.writeFileSync(path.join(fallbackDir, 'b-second.json'), JSON.stringify(fixtureWorkflow()), 'utf8')
    const configured = await clientFor({ baseUrl: fake.url, workflowDir: fallbackDir, defaultWorkflowId: 'b-second' }).submit({ positive: 'x' })
    assert.equal(configured.workflowId, 'b-second')
    fs.rmSync(fallbackDir, { recursive: true, force: true })
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit：空 positive 时保留模板默认提示词，负向照写', async () => {
  const dir = makeWorkflowDir()
  const fake = await startFakeComfy()
  try {
    const result = await clientFor({ baseUrl: fake.url, workflowDir: dir }).submit({ positive: '   ', negative: 'watermark' })
    assert.equal(result.ok, true)
    const prompt = fake.state.requests.find(item => item.path === '/prompt').body.prompt
    assert.equal(prompt['5'].inputs.text, 'default positive')
    assert.equal(prompt['6'].inputs.text, 'watermark')
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit：WorkflowNotFound / UI 格式 / 不可达 / node_errors 都返回 ok:false', async () => {
  const dir = makeWorkflowDir()
  fs.writeFileSync(path.join(dir, 'ui.json'), JSON.stringify({ nodes: [], links: [] }), 'utf8')
  const fake = await startFakeComfy()
  try {
    const client = clientFor({ baseUrl: fake.url, workflowDir: dir })

    const missing = await client.submit({ workflowId: 'nope', positive: 'x' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'workflow-not-found')
    assert.match(missing.message, /demo-t2i/)

    fs.writeFileSync(path.join(dir, 'broken.json'), '{oops', 'utf8')
    const broken = await client.submit({ workflowId: 'broken', positive: 'x' })
    assert.equal(broken.ok, false)
    assert.equal(broken.error, 'bad-workflow')

    const ui = await client.submit({ workflowId: 'ui', positive: 'x' })
    assert.equal(ui.ok, false)
    assert.equal(ui.error, 'ui-format')
    assert.match(ui.message, /Export \(API\)/)

    // 不可达：真去连一个关掉的端口
    const dead = clientFor({ baseUrl: await deadBaseUrl(), workflowDir: dir })
    const unreachable = await dead.submit({ workflowId: 'demo-t2i', positive: 'x' })
    assert.equal(unreachable.ok, false)
    assert.equal(unreachable.error, 'unreachable')
    assert.match(unreachable.message, /投递失败/)

    // ComfyUI 校验失败（200 + node_errors）也要当失败，并带出节点与原因
    fake.state.promptResponse = { prompt_id: null, number: null, error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 8: { errors: [{ message: 'Value not in list', details: 'sampler_name' }] } } }
    const rejected = await client.submit({ workflowId: 'demo-t2i', positive: 'x' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, 'rejected')
    assert.match(rejected.message, /节点 8/)
    assert.match(rejected.message, /sampler_name/)
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('submit：vars 里没有同名输入的键给出警告而不是静默丢弃', async () => {
  const dir = makeWorkflowDir()
  const fake = await startFakeComfy()
  try {
    const result = await clientFor({ baseUrl: fake.url, workflowDir: dir }).submit({ positive: 'x', vars: { nope: 1, ckpt_name: 'other.safetensors' } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.skipped.sort(), ['ckpt_name', 'nope'])
    assert.ok(result.warnings.some(item => item.includes('nope')))
    assert.ok(result.warnings.some(item => item.includes('内部参数')))
  } finally {
    await fake.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── status / waitFor / image（假服务） ────────────────────────────────────

test('status：queued / running / done / failed / unknown 五种状态', async () => {
  const fake = await startFakeComfy()
  const client = clientFor({ baseUrl: fake.url })
  try {
    fake.state.queue = { queue_running: [], queue_pending: [[4, 'pid-q', {}, {}, []]] }
    const queued = await client.status('pid-q')
    assert.equal(queued.ok, true)
    assert.equal(queued.state, 'queued')
    assert.equal(queued.queuePosition, 1)

    fake.state.queue = { queue_running: [[3, 'pid-r', {}, {}, []]], queue_pending: [] }
    assert.equal((await client.status('pid-r')).state, 'running')

    fake.state.queue = { queue_running: [], queue_pending: [] }
    fake.state.history = { 'pid-d': doneHistory('pid-d') }
    const done = await client.status('pid-d')
    assert.equal(done.state, 'done')
    assert.equal(done.images.length, 1)
    assert.equal(done.images[0].filename, 'anima_smoke_00001_.png')
    assert.match(done.images[0].url, /\/view\?filename=anima_smoke_00001_\.png/)
    assert.equal(done.images[0].type, 'output')
    assert.equal(done.history.status, 'success')
    assert.equal(done.history.createTime, 1794819052421)

    fake.state.history = {
      'pid-f': {
        prompt: [0, 'pid-f', {}, {}, ['10']],
        outputs: {},
        status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] },
      },
    }
    const failed = await client.status('pid-f')
    assert.equal(failed.state, 'failed')
    assert.match(failed.message, /CUDA out of memory/)

    fake.state.history = {}
    const unknown = await client.status('pid-x')
    assert.equal(unknown.state, 'unknown')
    assert.match(unknown.message, /队列和历史里都没有/)

    const empty = await client.status('')
    assert.equal(empty.ok, false)

    const dead = clientFor({ baseUrl: await deadBaseUrl() })
    const offline = await dead.status('pid-1')
    assert.equal(offline.ok, false)
    assert.match(offline.message, /查状态的请求失败/)
  } finally {
    await fake.close()
  }
})

test('status：完成但没有保存节点时 state=done 且带一条提示', async () => {
  const fake = await startFakeComfy()
  try {
    fake.state.history = {
      'pid-n': { prompt: [0, 'pid-n', {}, {}, []], outputs: {}, status: { status_str: 'success', completed: true, messages: [] } },
    }
    const result = await clientFor({ baseUrl: fake.url }).status('pid-n')
    assert.equal(result.state, 'done')
    assert.deepEqual(result.images, [])
    assert.match(result.message, /没有保存节点/)
  } finally {
    await fake.close()
  }
})

test('status：/queue 或 /history 返 500 时 ok:false，不伪装成功', async () => {
  const fake = await startFakeComfy()
  try {
    const client = clientFor({ baseUrl: fake.url })
    fake.state.queueStatus = 500
    const broken = await client.status('pid-1')
    assert.equal(broken.ok, false)
    assert.equal(broken.state, 'unknown')
    assert.deepEqual(broken.images, [])
    assert.equal(broken.status, 500)
    assert.match(broken.message, /查队列失败.*500/)

    fake.state.queueStatus = 200
    fake.state.historyStatus = 502
    const noHistory = await client.status('pid-2')
    assert.equal(noHistory.ok, false)
    assert.equal(noHistory.state, 'unknown')
    assert.equal(noHistory.status, 502)
    assert.match(noHistory.message, /查历史失败/)
  } finally {
    await fake.close()
  }
})

test('status：status_str 没标 error，但 messages 里有 execution_interrupted 也判 failed', async () => {
  const fake = await startFakeComfy()
  try {
    fake.state.history = {
      'pid-i': {
        prompt: [0, 'pid-i', {}, {}, []],
        outputs: {},
        // 真机上中断后 status_str 有时还是 success：只能看 messages
        status: { status_str: 'success', completed: false, messages: [['execution_start', {}], ['execution_interrupted', { node_id: '8' }]] },
      },
    }
    const result = await clientFor({ baseUrl: fake.url }).status('pid-i')
    assert.equal(result.state, 'failed')
    assert.match(result.message, /执行被中断/)
  } finally {
    await fake.close()
  }
})

test('waitFor：轮询到 done，带 waitedMs', async () => {
  const fake = await startFakeComfy()
  try {
    fake.state.queue = { queue_running: [], queue_pending: [[2, 'pid-w', {}, {}, []]] }
    const timer = setTimeout(() => {
      fake.state.history = { 'pid-w': doneHistory('pid-w') }
      fake.state.queue = { queue_running: [], queue_pending: [] }
    }, 120)
    const result = await clientFor({ baseUrl: fake.url }).waitFor('pid-w', { timeoutMs: 4000, pollIntervalMs: 50 })
    clearTimeout(timer)
    assert.equal(result.state, 'done', JSON.stringify(result))
    assert.equal(result.timedOut, false)
    assert.equal(result.ok, true)
    assert.ok(result.waitedMs >= 100, 'waitedMs=' + result.waitedMs)
    assert.equal(result.images.length, 1)
  } finally {
    await fake.close()
  }
})

test('waitFor：一直排队则超时返回 timedOut + 最后状态', async () => {
  const fake = await startFakeComfy()
  try {
    fake.state.queue = { queue_running: [], queue_pending: [[2, 'pid-t', {}, {}, []]] }
    const result = await clientFor({ baseUrl: fake.url }).waitFor('pid-t', { timeoutMs: 1000, pollIntervalMs: 50 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.equal(result.state, 'queued')
    // 轮询间隔 50ms，超时判定会略微早于 1000ms 一点，给个容差
    assert.ok(result.waitedMs >= 900, 'waitedMs=' + result.waitedMs)
    assert.match(result.message, /超时/)
  } finally {
    await fake.close()
  }
})

test('waitFor：任务失败时 ok:false（到终态不等于成功）', async () => {
  const fake = await startFakeComfy()
  try {
    fake.state.queue = { queue_running: [], queue_pending: [[2, 'pid-x', {}, {}, []]] }
    const timer = setTimeout(() => {
      fake.state.queue = { queue_running: [], queue_pending: [] }
      fake.state.history = {
        'pid-x': {
          prompt: [0, 'pid-x', {}, {}, []],
          outputs: {},
          status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] },
        },
      }
    }, 120)
    const result = await clientFor({ baseUrl: fake.url }).waitFor('pid-x', { timeoutMs: 4000, pollIntervalMs: 50 })
    clearTimeout(timer)
    assert.equal(result.state, 'failed')
    assert.equal(result.timedOut, false)
    assert.equal(result.ok, false, '失败的终态不能回 ok:true')
    assert.match(result.message, /CUDA out of memory/)
  } finally {
    await fake.close()
  }
})

test('image：拿到二进制与 content-type；404 返回 ok:false', async () => {
  const fake = await startFakeComfy()
  try {
    const client = clientFor({ baseUrl: fake.url })
    const ok = await client.image({ filename: 'anima_smoke_00001_.png', subfolder: 'anima', type: 'output' })
    assert.equal(ok.ok, true)
    assert.ok(Buffer.isBuffer(ok.buffer))
    assert.equal(ok.bytes, 6)
    assert.equal(ok.contentType, 'image/png')
    const view = fake.state.requests.find(item => item.path === '/view')
    assert.equal(view.query.filename, 'anima_smoke_00001_.png')
    assert.equal(view.query.subfolder, 'anima')
    assert.equal(view.query.type, 'output')

    fake.state.view = { status: 404, body: Buffer.alloc(0), type: 'image/png' }
    const missing = await client.image({ filename: 'gone.png' })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /取图失败/)

    const noName = await client.image({})
    assert.equal(noName.ok, false)
    assert.match(noName.message, /缺 filename/)
  } finally {
    await fake.close()
  }
})

test('客户端只读配置：改 config.comfy 立刻生效（面板热改地址）', async () => {
  const fake = await startFakeComfy()
  try {
    const config = { comfy: { baseUrl: REAL_BASE_URL, workflowDir: '', pollIntervalMs: 50, timeoutMs: 5000 } }
    const client = createComfyClient({ config, logger: quietLogger })
    assert.equal(client.baseUrl(), REAL_BASE_URL)
    config.comfy.baseUrl = fake.url
    assert.equal(client.baseUrl(), fake.url)
    assert.equal((await client.ping()).version, '0.45.0-fake')
  } finally {
    await fake.close()
  }
})

test('coerceVar：空串 / 纯空白不把数值参数覆写成 0', () => {
  const schema = { vars: [{ name: 'seed', type: 'number' }, { name: 'width', type: 'number' }, { name: 'denoise', type: 'float' }] }
  const workflow = fixtureWorkflow()
  const warnings = []
  const result = applyVars(workflow, schema, { seed: '', width: '   ', denoise: '' }, { positiveNode: '5', negativeNode: '6' }, warnings)
  assert.equal(workflow['8'].inputs.seed, 123456789, '空串不能变成 0')
  assert.equal(workflow['7'].inputs.width, 832, '纯空白也不能变成 0')
  assert.equal(workflow['8'].inputs.denoise, 1)
  assert.deepEqual(warnings, [])
  assert.deepEqual(result.skipped, [], '保留原值不算丢弃')

  const cleaned = fixtureWorkflow()
  applyVars(cleaned, schema, { seed: ' 42 ' }, { positiveNode: '5', negativeNode: '6' })
  assert.equal(cleaned['8'].inputs.seed, 42, '有值的字符串照旧转数字')

  // 布尔声明：大小写都认（面板 / JSON 里写 TRUE / False 都见过）
  const flags = { 12: { class_type: 'FlagNode', inputs: { enabled: true } } }
  const boolSchema = { vars: [{ name: 'enabled', type: 'boolean' }] }
  applyVars(flags, boolSchema, { enabled: 'FALSE' }, {})
  assert.equal(flags[12].inputs.enabled, false)
  applyVars(flags, boolSchema, { enabled: 'True' }, {})
  assert.equal(flags[12].inputs.enabled, true)
})

test('applyVars：__proto__ / constructor / prototype 这些保留键被拦住，不污染原型', () => {
  const workflow = fixtureWorkflow()
  const warnings = []
  const result = applyVars(workflow, null, {
    '__proto__.polluted': 'yes',
    'constructor.polluted': 'yes',
    '8.__proto__': 'yes',
  }, {}, warnings)
  assert.equal({}.polluted, undefined, '原型链必须干净')
  assert.equal(result.applied.length, 0)
  assert.deepEqual(result.skipped.sort(), ['8.__proto__', '__proto__.polluted', 'constructor.polluted'])
  assert.ok(warnings.some(item => item.includes('保留键')), warnings.join(' | '))
})

test('applyVars / varsFromSchema：单节点绑定 node + input（输入名可与变量名不同）', () => {
  const workflow = {
    15: { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.5, control_net: ['1', 0] } },
    60: { class_type: 'PoseGalleryNode', inputs: { image_id: 'full_sexy_P001_front' } },
  }
  const schema = {
    vars: [
      { name: 'cnStrength', type: 'number', node: '15', input: 'strength' },
      { name: 'poseId', type: 'string', bind: { node: '60', input: 'image_id' } },
    ],
  }
  assert.deepEqual(bindingTargetOf(schema.vars[0]), { node: '15', input: 'strength' })
  assert.deepEqual(bindingTargetOf(schema.vars[1]), { node: '60', input: 'image_id' })

  const warnings = []
  const result = applyVars(workflow, schema, { cnStrength: '0.38', poseId: 'full_sexy_P016_diag' }, {}, warnings)
  assert.equal(workflow['15'].inputs.strength, 0.38)
  assert.equal(workflow['60'].inputs.image_id, 'full_sexy_P016_diag')
  assert.deepEqual(result.applied.map(item => [item.name, item.node, item.input]), [['cnStrength', '15', 'strength'], ['poseId', '60', 'image_id']])
  assert.deepEqual(warnings, [])

  const fresh = { 15: { inputs: { strength: 0.62 } }, 60: { inputs: { image_id: 'thumb-x' } } }
  const filled = varsFromSchema(schema, fresh, {})
  assert.equal(filled[0].default, 0.62, '默认值要从绑定的输入名取')
  assert.equal(filled[1].default, 'thumb-x')
})

test('applyVars：姿势变量写进节点 60 的 image_id，姿势标签节点的连线不动', () => {
  const workflow = {
    '60': { class_type: 'PoseGalleryNode', inputs: { image_id: 'full_sexy_P001_front', width: 1024 } },
    '62': { class_type: 'ControlNetApplyAdvanced', inputs: { strength: 0.45 } },
    '204': { class_type: 'PoseTagsNode', inputs: { image_id: ['60', 1] } },
  }
  const schema = {
    vars: [
      { name: 'pose', type: 'string', bindings: [{ node: '60', input: 'image_id' }] },
      { name: 'cnStrength', type: 'number', bindings: [{ node: '62', input: 'strength' }] },
    ],
  }
  const warnings = []
  const result = applyVars(workflow, schema, { pose: 'full_sexy_P016_diag', cnStrength: '0.38' }, { positiveNode: '1' }, warnings)
  assert.equal(workflow['60'].inputs.image_id, 'full_sexy_P016_diag')
  assert.equal(workflow['62'].inputs.strength, 0.38, '字符串强度要转成数字')
  assert.deepEqual(workflow['204'].inputs.image_id, ['60', 1], '连线不能被字符串顶掉')
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(warnings, [])
})

test('applyVars：bindings 一个变量写多个节点，全落空才警告', () => {
  const workflow = {
    '60': { inputs: { image_id: 'a' } },
    '204': { inputs: { image_id: 'b' } },
  }
  const schema = {
    vars: [
      { name: 'poseAll', type: 'string', bindings: [{ node: '60', input: 'image_id' }, { node: '204', input: 'image_id' }] },
      { name: 'ghost', type: 'string', bindings: [{ node: '999', input: 'image_id' }] },
    ],
  }
  const warnings = []
  const result = applyVars(workflow, schema, { poseAll: 'full_sexy_P026_side', ghost: 'x' }, {}, warnings)
  assert.equal(workflow['60'].inputs.image_id, 'full_sexy_P026_side')
  assert.equal(workflow['204'].inputs.image_id, 'full_sexy_P026_side')
  assert.equal(result.applied.filter(item => item.name === 'poseAll').length, 2)
  assert.deepEqual(result.skipped, ['ghost'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /bindings/)
})
