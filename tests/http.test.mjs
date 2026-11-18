/**
 * 宿主侧集成测试：真的起一个 http server，走 createDispatch → createHandlers → forge/tags/comfy。
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

test('apply()：挂前缀 + 注册三个模型工具', async () => {
  // 前一个 /config 用例会把 settings.json 落进 SANDBOX_DIR，先把持久化配置清干净
  fs.rmSync(path.join(SANDBOX_DIR, 'settings.json'), { force: true })
  const { apply } = await import('../index.js')
  const llm = fakeLlm()
  const ctx = fakeCtx(llm)
  const rt = apply(ctx, {})
  // 新前缀 + 旧前缀（/prompt-forge/api）同时注册，老脚本不用改
  assert.equal(ctx.registrations.prefixes.length, 2)
  assert.equal(ctx.registrations.prefixes[0].path, PREFIX)
  assert.equal(ctx.registrations.prefixes[0].kind, 'prefix')
  assert.equal(typeof ctx.registrations.prefixes[0].handler, 'function')
  assert.equal(ctx.registrations.prefixes[1].path, LEGACY_PREFIX)
  const names = ctx.registrations.tools.map(t => t.name)
  for (const expected of ['prompt_forge', 'prompt_forge_run', 'prompt_forge_status']) {
    assert.ok(names.includes(expected), '缺工具 ' + expected + '（实际 ' + names.join(',') + '）')
  }
  // 工具 spec 形状：parameters 是 JSON Schema，output 有 schema + render
  const spec = ctx.registrations.tools.find(t => t.name === 'prompt_forge')
  assert.equal(spec.parameters.type, 'object')
  assert.ok(spec.parameters.properties.text)
  assert.equal(typeof spec.output.render, 'function')
  const rendered = spec.output.render({}, { ok: true })
  assert.ok(Array.isArray(rendered) && rendered[0].type === 'text')
  // 工具真能跑（假 llm）
  const value = await spec.execute({ text: '雨夜街头' })
  assert.equal(value.ok, true)
  assert.ok(value.positive.includes('1girl'))
  assert.equal(rt.config.purge.level, 'full')
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

test('GET /_mod/*：只吐 client/ 下一层的 js 模块，坏名字 400、缺文件 404', async () => {
  await withServer({}, async ({ base }) => {
    // 只认 client/<小写字母数字连字符>.js：大写、带子目录、不在 client/ 下都拒绝
    const badPaths = ['/_mod/client/Panel.js', '/_mod/panel.js', '/_mod/client/sub/panel.js', '/_mod/client/panel.mjs']
    for (const badPath of badPaths) {
      const { status, body } = await getJson(base + badPath)
      assert.equal(status, 400, badPath + ' 应当 400')
      assert.equal(body.error, 'bad-module')
    }

    // 名字合法且文件存在：真能读到 client/ 下的模块（光测 400/404 会漏掉解析路径写错的情况）
    const okRes = await fetch(base + '/_mod/client/api.js')
    assert.equal(okRes.status, 200)
    assert.equal(okRes.headers.get('content-type'), 'text/javascript; charset=utf-8')
    const okSource = await okRes.text()
    assert.match(okSource, /export (?:async )?function requestJson/)

    // 名字合法但文件不存在：404 且不吐堆栈
    const missing = await getJson(base + '/_mod/client/zzz-no-such-module.js')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error, 'no-module')

    // 通配路由不能抢掉精确路由
    const health = await getJson(base + '/health')
    assert.equal(health.status, 200)
  })
})

