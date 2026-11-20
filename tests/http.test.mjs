/**
 * 接口集成测试：真的起一个 http server，走 createDispatch → createHandlers → forge/tags/comfy。
 *
 * 为什么要有这一层：各模块自己的测试都绿，不代表拼起来能跑 —— 路由表、返回信封
 * （{ ok:true, ...json } / raw / 204）、配置热改、破甲覆盖键，这些只在接线处出错。
 * llm 是假的（真的 llm 要宿主进程），ComfyUI 是真连的（本机 8188 常在）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHandlers, createRuntime } from '../index.js'
import { createDispatch, LEGACY_PREFIX, PREFIX } from '../lib/routes.js'
import { requireRealLibrary } from './_lib-guard.mjs'

// 数据目录隔离：POST /config 会写 settings.json，不能污染用户真实配置。
const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-http-'))
process.env.DSH_PROMPT_FORGE_DATA = SANDBOX_DIR

const MODEL_REPLY = JSON.stringify({
  positive: [
    { tag: '1girl', weight: 1.1 },
    { tag: 'solo', weight: 1 },
    { tag: 'rain', weight: 1 },
    { tag: 'wet hair', weight: 1.15 },
    { tag: 'neon lights', weight: 1.05 },
    { tag: 'zzz-not-a-real-tag', weight: 1 },
  ],
  negative: [{ tag: 'lowres', weight: 1.2 }, { tag: 'bad anatomy', weight: 1.1 }],
  notes: '雨夜霓虹街头',
})

function fakeLlm(reply = MODEL_REPLY) {
  const calls = []
  return {
    calls,
    async *stream(args) {
      calls.push(args)
      yield { type: 'reasoning-delta', index: 0, text: '想一想' }
      // 故意分片，逼锻造器真的拼流
      const half = Math.floor(reply.length / 2)
      yield { type: 'text-delta', index: 0, text: reply.slice(0, half) }
      yield { type: 'text-delta', index: 0, text: reply.slice(half) }
      yield { type: 'finish', kind: 'stop' }
    },
    async listModels() {
      return [{ id: 'deepseek-v4.1-flash', label: 'v4.1-flash' }]
    },
    async listProviders() {
      return [{ id: 'opencode-go' }]
    },
  }
}

function fakeCtx(llm) {
  const registrations = { prefixes: [], tools: [] }
  return {
    registrations,
    get(name) {
      if (name === 'llm') return llm
      if (name === 'webServer') {
        return {
          register(spec) {
            registrations.prefixes.push(spec)
            return () => {}
          },
        }
      }
      if (name === 'tools') {
        return {
          register(spec) {
            registrations.tools.push(spec)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      fn()
    },
  }
}

/** @param {import('node:net').Server} server @returns {number} */
function portOf(server) {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

async function withServer(rawConfig, run, llmOverride) {
  const llm = llmOverride ?? fakeLlm()
  const ctx = fakeCtx(llm)
  const rt = createRuntime(ctx, { ui: { keepHistory: 3 }, ...rawConfig })
  const server = http.createServer(createDispatch(createHandlers(rt), rt.log))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(server)
  const base = 'http://127.0.0.1:' + port + PREFIX
  try {
    await run({ base, rt, llm, ctx })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function getJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

test('GET /health：插件自报身份与数据目录', async () => {
  await withServer({}, async ({ base, rt }) => {
    const { status, body } = await getJson(base + '/health')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-tagger')
    assert.equal(body.dataDir, rt.dir)
  })
})

test('GET /spi：暴露 SPI 版本与槽位快照', async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await getJson(base + '/spi')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.spi.version, 'number')
    for (const slot of ['tagProviders', 'postProcessors', 'workflowBackends', 'panels']) {
      assert.ok(Array.isArray(body.spi.slots[slot]), '缺槽位 ' + slot)
    }
    for (const hook of ['beforeForge', 'afterForge', 'beforeRefine', 'afterRefine', 'beforeSubmit', 'afterSubmit']) {
      assert.ok(Array.isArray(body.spi.hooks[hook]), '缺钩子 ' + hook)
    }
    assert.ok(Array.isArray(body.spi.backends))
  })
})

test('GET /locale：中英语言包都能取、key 数一致，非法 lang 退回 zh', async () => {
  await withServer({}, async ({ base }) => {
    const zh = await getJson(base + '/locale')
    assert.equal(zh.status, 200)
    assert.equal(zh.body.ok, true)
    assert.equal(zh.body.locale, 'zh')
    assert.deepEqual(zh.body.langs, ['zh', 'en'])
    assert.equal(typeof zh.body.dict, 'object')
    assert.ok(Object.keys(zh.body.dict).length > 0, '中文语言包是空的')

    const en = await getJson(base + '/locale?lang=en')
    assert.equal(en.status, 200)
    assert.equal(en.body.locale, 'en')
    assert.equal(
      Object.keys(en.body.dict).length,
      Object.keys(zh.body.dict).length,
      '中英 key 数不一致：' + Object.keys(en.body.dict).length + ' vs ' + Object.keys(zh.body.dict).length,
    )

    const bad = await getJson(base + '/locale?lang=fr')
    assert.equal(bad.status, 200)
    assert.equal(bad.body.locale, 'zh', '非法 lang 要退回 zh')
    assert.equal(Object.keys(bad.body.dict).length, Object.keys(zh.body.dict).length)
  })
})

test('POST /refine：增量精修只回差分，空指令 400/502 不崩', async () => {
  const refineReply = JSON.stringify({
    add: ['night', 'indoors'],
    remove: ['rain'],
    weights: [{ tag: '1girl', weight: 1.2 }],
    notes: '换成室内夜景',
  })
  const llm = fakeLlm(refineReply)
  await withServer({}, async ({ base }) => {
    const { status, body } = await getJson(base + '/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: '1girl, rain, solo', instruction: '改成室内夜景', mode: 'edit' }),
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.mode, 'edit')
    assert.ok(body.delta.added.includes('night'), '缺新增 night：' + JSON.stringify(body.delta))
    assert.ok(body.delta.removed.includes('rain'), '缺删除 rain：' + JSON.stringify(body.delta))
    assert.equal(body.delta.weighted.length, 1)
    assert.equal(body.delta.weighted[0].tag, '1girl')
    assert.match(body.positive, /night/)
    assert.doesNotMatch(body.positive, /rain/)

    // 空指令：契约里 ok:false，HTTP 层按结果映射状态码，不许 500 抛栈
    const empty = await getJson(base + '/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive: '1girl' }),
    })
    assert.ok(empty.status === 502 || empty.status === 400, '空指令应为 4xx/502，实际 ' + empty.status)
    assert.equal(empty.body.ok, false)
  }, llm)
})

test('GET /state：真连 ComfyUI、暴露破甲状态与配置视图', async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await getJson(base + '/state')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.config.llm.provider, 'string')
    assert.equal(body.config.purge.level, 'full')
    assert.equal(body.config.llm.hasLlmService, true)
    assert.ok(Array.isArray(body.history))
    // 本机 ComfyUI 常在；不在也不该 500，只该 reachable:false
    assert.equal(typeof body.comfy.reachable, 'boolean')
  })
})

test('POST /forge：HTTP 信封 + 流式拼接 + 标签库校对 + 权重格式化', async () => {
  await withServer({}, async ({ base, llm }) => {
    const { status, body } = await getJson(base + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '雨夜霓虹街头，一个女孩回头看镜头，湿发' }),
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.ok(body.positive.includes('1girl'), '正向串里应有 1girl：' + body.positive)
    assert.ok(body.positive.length > 10)
    assert.ok(Array.isArray(body.tags) && body.tags.length >= 5)
    // 负向与画质词归 ComfyUI 工作流内置：锻造结果里不该再有负向
    assert.equal(body.negative, '')
    assert.ok(Array.isArray(body.negativeTags) && body.negativeTags.length === 0)
    assert.equal(body.standards.includes('wd'), true)
    assert.equal(body.standards.includes('camie'), true)
    // 权重必须真的进字符串
    assert.ok(/\(1girl:1\.1\)|\(wet hair:1\.15\)/i.test(body.positive), '权重语法没生效：' + body.positive)
    // 假模型吐了一个不存在的 tag：必须进 warnings 而不是静默丢掉或整体失败
    assert.ok(Array.isArray(body.warnings))
    assert.ok(
      body.warnings.some(w => String(w).includes('zzz-not-a-real-tag')),
      '库外词未进 warnings：' + JSON.stringify(body.warnings),
    )
    // 真的把破甲系统提示词发给了模型
    assert.equal(llm.calls.length, 1)
    // 系统提示词走 stream 的独立 system 字段（不是 messages 里的 system 角色）
    const systemText = String(llm.calls[0].system ?? '')
    assert.ok(systemText.length > 500, '系统提示词太短，破甲层可能没接上')
    const messages = llm.calls[0].messages ?? []
    assert.ok(Array.isArray(messages) && messages.length >= 1, 'messages 形状不对')
    assert.equal(messages[0].role, 'user')
    assert.ok(JSON.stringify(messages[0].content).includes('雨夜'), '用户白话没进 messages')
  })
})

test('POST /forge：options.purgeLevel / maxTags / standards 覆盖本次调用', async () => {
  const many = JSON.stringify({
    positive: Array.from({ length: 12 }, (_, i) => ({ tag: 'tag' + i, weight: 1 })),
    negative: [{ tag: 'lowres', weight: 1 }],
  })
  const llm = fakeLlm(many)
  const ctx = fakeCtx(llm)
  const rt = createRuntime(ctx, {})
  const server = http.createServer(createDispatch(createHandlers(rt), rt.log))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + portOf(server) + PREFIX
  try {
    const { body } = await getJson(base + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '测试覆盖',
        options: { standards: ['camie'], maxTags: 8, purgeLevel: 'off' },
      }),
    })
    assert.equal(body.ok, true)
    assert.deepEqual(body.standards, ['camie'])
    assert.equal(body.purgeLevel, 'off')
    assert.equal(body.tags.length, 8, 'maxTags 没截断：' + body.tags.length)
    assert.ok(body.warnings.some(w => String(w).includes('上限')), '没给截断警告：' + JSON.stringify(body.warnings))
    const systemText = String(llm.calls[0].system ?? '')
    assert.ok(systemText.length > 0, 'off 档系统提示词是空的')
    // purgeLevel=off 的系统提示词必须比 full 短得多 —— 破甲层真的接上了
    const offLen = systemText.length
    const rtFull = createRuntime(fakeCtx(fakeLlm(many)), { purge: { level: 'full' } })
    const fullLen = rtFull.forge.systemPrompt({}).length
    assert.ok(fullLen > offLen, 'off 档没变短：off=' + offLen + ' full=' + fullLen)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('POST /forge：空输入 400，llm 缺席 502 且错误可读', async () => {
  await withServer({}, async ({ base }) => {
    const empty = await getJson(base + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.ok, false)
    assert.equal(empty.body.error, 'empty-text')
  })

  // llm 缺席：generate 返回 ok:false（不是抛），路由转 502
  const llm = fakeLlm()
  const ctx = fakeCtx(llm)
  ctx.get = name => (name === 'llm' ? undefined : fakeCtx(llm).get(name))
  const rt = createRuntime(ctx, {})
  const server = http.createServer(createDispatch(createHandlers(rt), rt.log))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + portOf(server) + PREFIX
  try {
    const res = await getJson(base + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    assert.equal(res.status, 502)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error, 'no-llm')
    assert.equal(typeof res.body.message, 'string')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('GET /tags 与 POST /tags/canonicalize：本地索引可查可校', async () => {
  await withServer({}, async ({ base }) => {
    const tags = await getJson(base + '/tags?q=' + encodeURIComponent('1girl') + '&limit=5')
    assert.equal(tags.status, 200)
    assert.equal(tags.body.ok, true)
    assert.ok(Array.isArray(tags.body.rows))

    const canon = await getJson(base + '/tags/canonicalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['1girl', 'Wet Hair', 'zzz-not-a-real-tag'] }),
    })
    assert.equal(canon.status, 200)
    assert.equal(canon.body.rows.length, 3)
    assert.equal(canon.body.rows[0].tag, '1girl')
  })
})

test('POST /mcp：initialize / tools/list / 通知回 204 / 批量回数组', async () => {
  await withServer({}, async ({ base }) => {
    const init = await getJson(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(init.status, 200)
    assert.equal(init.body.jsonrpc, '2.0')
    assert.equal(typeof init.body.result.protocolVersion, 'string')

    const list = await getJson(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    const names = list.body.result.tools.map(t => t.name)
    assert.ok(names.includes('forge_tags'), '工具名不对：' + names.join(','))
    assert.ok(names.includes('comfy_run'))

    // 通知：没有 id → 204 空体
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(res.status, 204)
    assert.equal((await res.text()).length, 0)

    // 批量：必须是裸数组，不能被包成 { ok:true, ... }
    const batch = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 3, method: 'ping' },
        { jsonrpc: '2.0', id: 4, method: 'nope/unknown' },
      ]),
    })
    const rows = await batch.json()
    assert.ok(Array.isArray(rows), '批量回了非数组：' + JSON.stringify(rows))
    assert.equal(rows.length, 2)
    assert.equal(rows[1].error.code, -32601)
  })
})

test('POST /config：改配置立刻进 /state（hot reload，不重启）', async () => {
  await withServer({}, async ({ base }) => {
    const posted = await getJson(base + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { purge: { level: 'standard' }, tags: { maxTags: 12 } } }),
    })
    assert.equal(posted.status, 200)
    assert.equal(posted.body.config.purge.level, 'standard')
    assert.equal(posted.body.config.tags.maxTags, 12)

    const state = await getJson(base + '/state')
    assert.equal(state.body.config.purge.level, 'standard')
    assert.equal(state.body.purge.level, 'standard')
  })
})

test('GET /workflows：读到本机工作流目录（无目录时给空数组不报 500）', async () => {
  await withServer({}, async ({ base }) => {
    const res = await getJson(base + '/workflows')
    assert.ok(res.status === 200 || res.status === 502)
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.workflows))
    } else {
      assert.equal(res.body.ok, false)
      assert.equal(typeof res.body.message, 'string')
    }
  })
})

test('未知路由 404、方法不对 405、坏 JSON 500 带可读消息', async () => {
  await withServer({}, async ({ base }) => {
    const missing = await getJson(base + '/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'unknown-route')

    const wrong = await fetch(base + '/forge', { method: 'GET' })
    assert.equal(wrong.status, 405)
    assert.equal((await wrong.json()).error, 'method-not-allowed')

    const bad = await getJson(base + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(bad.status, 500)
    assert.equal(bad.body.ok, false)
    assert.match(String(bad.body.message), /JSON/)
  })
})


test('GET /comfy：状态灯要的三样都在（ping / 启动计划 / 工作流清单）', async () => {
  await withServer({}, async ({ base }) => {
    const { status, body } = await getJson(base + '/comfy')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(typeof body.status.reachable, 'boolean')
    assert.equal(typeof body.status.baseUrl, 'string')
    // 启动计划即使找不到目录也要给全，面板才能把「缺什么」写进 title
    assert.equal(typeof body.launch.ok, 'boolean')
    assert.ok(Array.isArray(body.launch.args), '要有 args：' + JSON.stringify(body.launch))
    assert.ok(body.launch.args.includes('main.py'), '启动命令必须跑 main.py：' + body.launch.args.join(' '))
    assert.ok(Array.isArray(body.workflows))
  })
})

test('POST /comfy/launch：已在跑就直接认账，不重复起第二个实例', async () => {
  await withServer({}, async ({ base }) => {
    // 本机 8188 常在：在线时必须 alreadyRunning，绝不能又 spawn 一个抢显存的 ComfyUI
    const probe = await getJson(base + '/comfy')
    if (probe.body.status.ok !== true) return
    const { status, body } = await getJson(base + '/comfy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitMs: 5000 }),
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.state, 'online')
    assert.equal(body.alreadyRunning, true)
    assert.equal(body.pid, undefined)
  })
})

test('POST /comfy/launch：起不来就 500 launch-failed，并把原因带回面板', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-launch-'))
  fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)\n')
  await withServer({ comfy: { baseUrl: 'http://127.0.0.1:65531', launchDir: dir, pythonPath: path.join(dir, 'no-such-python.exe') } }, async ({ base }) => {
    const { status, body } = await getJson(base + '/comfy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitMs: 5000 }),
    })
    assert.equal(status, 500)
    assert.equal(body.ok, false)
    assert.equal(body.error, 'launch-failed')
    assert.ok(String(body.message).length > 0, '失败必须给出可读原因')
    assert.equal(body.launch.dir, dir)
  })
})

test('POST /config：接口地址存得进去，但 /config 只回「配没配」与尾号，不回明文 key', async () => {
  await withServer({}, async ({ base }) => {
    const posted = await getJson(base + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { llm: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-http-secret', model: 'm1' } } }),
    })
    assert.equal(posted.status, 200)
    assert.equal(posted.body.config.llm.baseUrl, 'https://api.example.com/v1')
    assert.equal(posted.body.config.llm.apiKeySet, true)
    assert.equal(posted.body.config.llm.apiKeyHint, '…cret')
    assert.equal(JSON.stringify(posted.body).includes('sk-http-secret'), false, '明文 key 不许出接口')
    assert.equal(Object.prototype.hasOwnProperty.call(posted.body.config.llm, 'apiKey'), false)

    const cleared = await getJson(base + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { llm: { baseUrl: '', apiKey: '' } } }),
    })
    assert.equal(cleared.body.config.llm.apiKeySet, false)
    assert.equal(cleared.body.config.llm.baseUrl, '')
  })
})

test('POST /llm/probe：地址或 key 缺一个就 400（不偷偷联网），连不上给 502 与原因', async () => {
  await withServer({}, async ({ base }) => {
    const noBase = await getJson(base + '/llm/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: '', apiKey: '' }),
    })
    assert.equal(noBase.status, 400)
    assert.equal(noBase.body.error, 'no-base-url')

    const noKey = await getJson(base + '/llm/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' }),
    })
    assert.equal(noKey.status, 400)
    assert.equal(noKey.body.error, 'no-api-key')
    assert.equal(noKey.body.endpoint, 'http://127.0.0.1:9/v1/models')

    const unreachable = await getJson(base + '/llm/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-x' }),
    })
    assert.equal(unreachable.status, 502)
    assert.equal(unreachable.body.error, 'unreachable')
    assert.equal(typeof unreachable.body.message, 'string')
  })
})

test('POST /workflows/import：导入 API 格式工作流后立刻出现在 /workflows，脏输入 4xx 不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-http-wf-'))
  const workflow = {
    '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 24, cfg: 4.5, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['13', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['5', 0] }, _meta: { title: '正向提示词' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['5', 0] }, _meta: { title: '负向提示词' } },
    '13': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  }
  let base = ''
  const post = body => getJson(base + '/workflows/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await withServer({ comfy: { workflowDir: dir } }, async ({ base: apiBase }) => {
    base = apiBase
    const ok = await post({ name: 'My SDXL T2I', workflow })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.id, 'my-sdxl-t2i')
    assert.equal(fs.existsSync(path.join(dir, 'my-sdxl-t2i.json')), true)
    assert.equal(fs.existsSync(path.join(dir, 'my-sdxl-t2i.schema.json')), true)
    const entry = ok.body.workflows.find(item => item.id === 'my-sdxl-t2i')
    assert.ok(entry, '导入结果里应该有新模板')
    assert.ok(Array.isArray(entry.vars) && entry.vars.some(v => v.name === 'width' && v.default === 1024), '缺反推出来的变量表')

    const list = await getJson(base + '/workflows')
    assert.equal(list.status, 200)
    assert.ok(list.body.workflows.some(item => item.id === 'my-sdxl-t2i'), '列表里没有新模板')

    const dup = await post({ name: 'my-sdxl-t2i', workflow })
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error, 'exists')

    const forced = await post({ name: 'my-sdxl-t2i', workflow, overwrite: true })
    assert.equal(forced.status, 200)
    assert.equal(forced.body.ok, true)

    const ui = await post({ name: 'ui-one', workflow: { nodes: [], links: [] } })
    assert.equal(ui.status, 400)
    assert.equal(ui.body.error, 'ui-format')

    const noName = await post({ workflow })
    assert.equal(noName.status, 400)
    assert.equal(noName.body.error, 'bad-name')

    const wrong = await getJson(base + '/workflows/import')
    assert.equal(wrong.status, 405)
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('ui')).length, 0, 'UI 格式不该落盘')
  })
})

test('POST /llm/probe：跨源且没填 key 一律 400，同源才借用已保存的 key', async () => {
  await withServer({}, async ({ base, rt }) => {
    // 直接定配置：别的用例可能已经往 settings.json 里写过东西，走 rawConfig 会被覆盖
    rt.config.llm.baseUrl = 'http://127.0.0.1:9/v1'
    rt.config.llm.apiKey = 'sk-saved'
    const probe = body => getJson(base + '/llm/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // 换了源（端口不同就是不同源）：配置里存着 key 也不许顺手带上，否则等于把 key 送出去
    const cross = await probe({ baseUrl: 'http://127.0.0.1:10/v1', apiKey: '' })
    assert.equal(cross.status, 400)
    assert.equal(cross.body.error, 'no-api-key')
    assert.equal(cross.body.endpoint, 'http://127.0.0.1:10/v1/models')

    // 显式给 key：跨源也照打（用户自己填的，不是借用）
    const crossWithKey = await probe({ baseUrl: 'http://127.0.0.1:10/v1', apiKey: 'sk-typed' })
    assert.equal(crossWithKey.status, 502)
    assert.equal(crossWithKey.body.error, 'unreachable')

    // 同源（就是配置里那个地址）：允许回落到已保存的 key，于是走到「连不上」而不是「没 key」
    const same = await probe({ baseUrl: 'http://127.0.0.1:9/v1' })
    assert.equal(same.status, 502)
    assert.equal(same.body.error, 'unreachable')
  })
})

test('POST /workflows/import：body.path 只认 .json 普通文件且不超过 10MB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-http-wfpath-'))
  const txt = path.join(dir, 'notes.txt')
  fs.writeFileSync(txt, '{}')
  const folder = path.join(dir, 'folder.json')
  fs.mkdirSync(folder)
  const huge = path.join(dir, 'huge.json')
  fs.writeFileSync(huge, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))
  const missing = path.join(dir, 'nope.json')

  await withServer({ comfy: { workflowDir: dir } }, async ({ base }) => {
    const post = body => getJson(base + '/workflows/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const bad = await post({ path: txt })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'bad-path')

    const noFile = await post({ path: missing })
    assert.equal(noFile.status, 400)
    assert.equal(noFile.body.error, 'no-file')

    // 目录名也叫 .json：后缀过了，但不是普通文件
    const isDir = await post({ path: folder })
    assert.equal(isDir.status, 400)
    assert.equal(isDir.body.error, 'no-file')

    const tooLarge = await post({ path: huge })
    assert.equal(tooLarge.status, 400)
    assert.equal(tooLarge.body.error, 'too-large')

    assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.schema.json')), [], '被拒的路径不该落盘')
  })
})

test('POST /comfy/launch：并发两次只拉起一次 rt.launch()', async () => {
  await withServer({ comfy: { baseUrl: 'http://127.0.0.1:65531' } }, async ({ base, rt }) => {
    let calls = 0
    rt.launch = async () => {
      calls += 1
      // 拖一下：让第二个请求一定撞在同一份 Promise 上
      await new Promise(resolve => setTimeout(resolve, 60))
      return { ok: false, message: 'stub 起不来' }
    }
    const post = () => getJson(base + '/comfy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitMs: 5000 }),
    })
    const [first, second] = await Promise.all([post(), post()])
    assert.equal(calls, 1, 'rt.launch 只该跑一次')
    assert.equal(first.status, 500)
    assert.equal(first.body.error, 'launch-failed')
    assert.equal(second.status, 500)
    assert.equal(second.body.error, 'launch-failed')
  })
})

test('GET /tags：冷启动先等索引 ready()，再回结果', async () => {
  await withServer({}, async ({ base, rt }) => {
    let ready = false
    rt.tags.ready = async () => {
      await new Promise(resolve => setTimeout(resolve, 80))
      ready = true
    }
    const hit = await getJson(base + '/tags?q=1girl&limit=5')
    assert.equal(hit.status, 200)
    assert.equal(ready, true, '取标签之前必须等索引就绪')
    assert.ok(Array.isArray(hit.body.rows))

    // limit 越界要钳住，不能把 0 / 巨值漏进查询
    const clamped = await getJson(base + '/tags?q=1girl&limit=999999')
    assert.equal(clamped.status, 200)
    assert.ok(Array.isArray(clamped.body.rows))
  })
})

test('POST 缺 body：/forge /upload /run /tags/canonicalize 都不 500', async () => {
  await withServer({}, async ({ base }) => {
    const empty = route => getJson(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    })

    const forge = await empty('/forge')
    assert.equal(forge.status, 400)
    assert.equal(forge.body.error, 'empty-text')

    const upload = await empty('/upload')
    assert.notEqual(upload.status, 500)
    assert.equal(upload.body.ok, false)

    const run = await empty('/run')
    assert.notEqual(run.status, 500)
    assert.equal(run.body.ok, false)

    const canonical = await empty('/tags/canonicalize')
    assert.notEqual(canonical.status, 500)
    assert.ok(Array.isArray(canonical.body.rows))

    // JSON 里塞 null：parseJson 会归一成 {}，照样不该 500
    const nullBody = route => getJson(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    })
    assert.notEqual((await nullBody('/upload')).status, 500)
    assert.notEqual((await nullBody('/run')).status, 500)
  })
})

test('GET /pose-thumb 与 GET /health：脏 id 回 404，version 跟着根 package.json', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  await withServer({}, async ({ base }) => {
    const thumb = await getJson(base + '/pose-thumb?id=definitely-not-a-pose')
    assert.equal(thumb.status, 404)
    assert.equal(thumb.body.error, 'pose-image')

    const health = await getJson(base + '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.version, pkg.version)
  })
})


