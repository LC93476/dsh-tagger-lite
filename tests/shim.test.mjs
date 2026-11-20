import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createContext, createLlmShim, createWebServerShim } from '../server/shims.mjs'
import { apiUrl, chatCompletionsUrl, createContextAdapter, createLogger, llmSettings, modelsUrl } from '../lib/cordis/adapter.js'
import { SERVICE_KEYS, bindServices, readConfig, saveConfig, servicesOf } from '../lib/spi.js'

/** @param {import('node:net').Server} server @returns {number} */
function portOf(server) {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

async function withStub(handler, run) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    handler(req, res, seen)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + portOf(server)
  try {
    return await run(base, seen)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function sseReply(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'stop' }] }) + '\n\n')
  res.end('data: [DONE]\n\n')
}

test('shim：OpenCode 系地址带 x-opencode-session，普通 OpenAI 地址不带', async () => {
  await withStub((req, res) => sseReply(res, 'ok'), async (base, seen) => {
    const forced = createLlmShim({
      baseUrl: base + '/v1',
      apiKey: 'sk-test',
      model: 'm',
      forceSessionHeader: true,
      logger: {},
    })
    const chunks = []
    for await (const chunk of forced.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
    assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'ok'))
    assert.equal(seen[0].headers['x-opencode-session'], 'dsh-tagger')

    const plain = createLlmShim({
      baseUrl: base + '/v1',
      apiKey: 'sk-test',
      model: 'm',
      logger: {},
    })
    for await (const chunk of plain.stream({ messages: [{ role: 'user', content: 'hi' }] })) void chunk
    assert.equal(seen[1].headers['x-opencode-session'], undefined)
  })
})

test('shim：timeoutMs / model / baseUrl 都现读 resolve，面板改完立刻反映到 describe()', async () => {
  let resolved = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-a', model: 'm-a', timeoutMs: 5000 }
  const shim = createLlmShim({ resolve: () => resolved, logger: {} })
  assert.equal(shim.describe().timeoutMs, 5000)
  assert.equal(shim.describe().model, 'm-a')
  assert.equal(shim.describe().endpoint, 'http://127.0.0.1:9/v1/chat/completions')
  resolved = { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-a', model: 'm-b', timeoutMs: 180000 }
  assert.equal(shim.describe().timeoutMs, 180000)
  assert.equal(shim.describe().model, 'm-b')
  assert.equal(shim.ready, true)
})

test('adapter：apiUrl 认得已有的 /vN，两种端点只写一遍规则', () => {
  assert.equal(chatCompletionsUrl('http://h/v1'), 'http://h/v1/chat/completions')
  assert.equal(chatCompletionsUrl('http://h/'), 'http://h/v1/chat/completions')
  assert.equal(modelsUrl('http://h/v2'), 'http://h/v2/models')
  assert.equal(apiUrl('', '/models'), '')
})

test('adapter：llmSettings 不给默认地址、没有 apiKey 就是未配置，超时被钳制', () => {
  const empty = llmSettings()
  assert.equal(empty.endpoint, '')
  assert.equal(empty.configured, false)
  assert.equal(empty.provider, 'openai-compatible')

  const low = llmSettings({ baseUrl: 'http://h/', apiKey: ' sk-1 ', timeoutMs: 10 })
  assert.equal(low.baseUrl, 'http://h')
  assert.equal(low.apiKey, 'sk-1')
  assert.equal(low.timeoutMs, 1000)
  assert.equal(low.configured, true)
  assert.equal(llmSettings({ baseUrl: 'http://h', apiKey: 'k', timeoutMs: 999999 }).timeoutMs, 600000)
  assert.equal(llmSettings({ baseUrl: 'http://h' }).configured, false)
})

test('adapter：createContextAdapter 的 get / provide / effect 反序卸载，kind 可指定', async () => {
  const order = []
  const ctx = createContextAdapter({ llm: { tag: 'L' }, extra: { comfy: { tag: 'C' } } })
  assert.equal(ctx.kind, 'shim')
  assert.deepEqual(ctx.get('llm'), { tag: 'L' })
  assert.deepEqual(ctx.get('comfy'), { tag: 'C' })
  assert.equal(ctx.get('missing'), undefined)
  assert.deepEqual(ctx.provide('ws', 1), 1)
  assert.equal(ctx.get('ws'), 1)
  ctx.effect(() => () => order.push('first'))
  ctx.effect(() => () => order.push('second'))
  ctx.effect(() => undefined)
  await ctx.disposeAll()
  assert.deepEqual(order, ['second', 'first'])
  assert.equal(createContextAdapter({ kind: 'cordis' }).kind, 'cordis')
})

test('adapter：createLogger 走调用方的 write，前缀由它拼', () => {
  const lines = []
  const log = createLogger({ prefix: '[t] ', write: (level, line) => lines.push(level + ' ' + line) })
  log.info('a', 1)
  log.warn({ x: 2 })
  log.error('boom')
  assert.deepEqual(lines, ['info [t] a 1', 'warn [t] {"x":2}', 'error [t] boom'])
})

test('shims.mjs 门面：只剩生命周期，体量 ≤12KB 且不含传输实现', () => {
  const source = fs.readFileSync(new URL('../server/shims.mjs', import.meta.url), 'utf8')
  const bytes = Buffer.byteLength(source)
  assert.ok(bytes <= 12288, 'shims.mjs 超过 12KB：' + bytes)
  for (const marker of ['http.createServer', 'fetch(', 'createMcpHandler', 'tools.register', "path: '/mcp'", 'register({ kind']) {
    assert.equal(source.includes(marker), false, 'shims.mjs 里不该再有传输 / MCP 实现：' + marker)
  }
  // 门面必须把原来那批名字继续导出（standalone.mjs 与这个测试直接用）
  for (const name of ['createLlmShim', 'createWebServerShim', 'createContext', 'flattenMessages', 'normalizeBaseUrl', 'chatCompletionsUrl', 'modelsUrl']) {
    assert.equal(source.includes(name), true, 'shims.mjs 丢了导出：' + name)
  }
})

test('spi：servicesOf / bindServices 把 runtime 的服务装进 ctx，缺席的跳过', () => {
  const rt = { llm: { tag: 'L' }, comfy: { tag: 'C' }, forge: undefined, tags: null }
  assert.deepEqual(Object.keys(servicesOf(rt, ['llm', 'comfy', 'forge', 'tags'])), ['llm', 'comfy'])
  assert.deepEqual(servicesOf(null), {}, 'rt 不是对象就给空表')

  const ctx = createContext({})
  assert.deepEqual(bindServices(ctx, rt, ['llm', 'comfy', 'forge']), ['llm', 'comfy'])
  assert.deepEqual(ctx.get('comfy'), { tag: 'C' })
  assert.deepEqual(bindServices({}, rt), [], '没有 provide 的 ctx 不该抛')
})

test('spi：配置读写有统一入口，服务名清单固定', () => {
  assert.equal(typeof readConfig, 'function')
  assert.equal(typeof saveConfig, 'function')
  assert.deepEqual(SERVICE_KEYS.slice(0, 2), ['llm', 'webServer'])
  assert.ok(SERVICE_KEYS.includes('refine'))
})

async function plainGet(url) {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', part => {
        body += part
      })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    request.on('error', reject)
  })
}

test('shim：stream 尊重 args.sessionId，空值才回落到默认会话', async () => {
  await withStub((req, res) => sseReply(res, 'ok'), async (base, seen) => {
    const shim = createLlmShim({ baseUrl: base + '/v1', apiKey: 'sk-t', model: 'm', forceSessionHeader: true, logger: {} })
    for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-42' })) void chunk
    assert.equal(seen[0].headers['x-opencode-session'], 'sess-42')
    for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }], sessionId: '   ' })) void chunk
    assert.equal(seen[1].headers['x-opencode-session'], 'dsh-tagger')
  })
})

test('shim：SSE 读到一半超时 → finish(error, timeout)，不往外抛', async () => {
  const sockets = []
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '半句' } }] }) + '\n\n')
    // 之后既不写也不 end：客户端只能靠自己的 timeoutMs 收场
  })
  server.on('connection', socket => sockets.push(socket))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + portOf(server)
  try {
    const shim = createLlmShim({ baseUrl: base + '/v1', apiKey: 'sk-t', model: 'm', logger: {} })
    const chunks = []
    for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 200 })) chunks.push(chunk)
    const end = chunks[chunks.length - 1]
    assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === '半句'), '超时前收到的增量要留下')
    assert.equal(end.type, 'finish')
    assert.equal(end.kind, 'error')
    assert.equal(end.failure.code, 'timeout')
    assert.match(end.failure.message, /200ms/)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test('shim：读到一半连接断了 → finish(error, llm-error)，不往外抛', async () => {
  await withStub(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'a' } }] }) + '\n\n')
      setTimeout(() => res.destroy(), 30)
    },
    async base => {
      const shim = createLlmShim({ baseUrl: base + '/v1', apiKey: 'sk-t', model: 'm', logger: {} })
      const chunks = []
      for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
      const end = chunks[chunks.length - 1]
      assert.equal(end.type, 'finish')
      assert.equal(end.kind, 'error')
      assert.equal(end.failure.code, 'llm-error')
      assert.ok(end.failure.message.length > 0, '错误文案不能是空的')
    },
  )
})

test('shim：SSE 收尾冲残留字节，分片多字节中文与无尾换行的裸 JSON 都不丢字', async () => {
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '雨夜' } }] }) + '\n\n'
  const bytes = Buffer.from(line, 'utf8')
  const cutAt = bytes.indexOf(Buffer.from('雨', 'utf8')) + 1 // 切点落在「雨」的三个字节中间
  await withStub(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(bytes.subarray(0, cutAt))
      setTimeout(() => res.end(bytes.subarray(cutAt)), 20)
    },
    async base => {
      const shim = createLlmShim({ baseUrl: base + '/v1', apiKey: 'sk-t', model: 'm', logger: {} })
      const texts = []
      let end
      for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
        if (chunk.type === 'finish') end = chunk
      }
      assert.equal(texts.join(''), '雨夜')
      assert.equal(end.kind, 'stop')
    },
  )

  await withStub(
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // 没有 data: 前缀、也没有结尾换行：只能靠 tail 收
      res.end(JSON.stringify({ choices: [{ delta: { content: '裸JSON' } }] }))
    },
    async base => {
      const shim = createLlmShim({ baseUrl: base + '/v1', apiKey: 'sk-t', model: 'm', logger: {} })
      const texts = []
      let end
      for await (const chunk of shim.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (chunk.type === 'text-delta') texts.push(chunk.text)
        if (chunk.type === 'finish') end = chunk
      }
      assert.equal(texts.join(''), '裸JSON')
      assert.equal(end.kind, 'stop')
    },
  )
})

test('webServerShim：close() 等在飞请求写完再关，不砍连接', async () => {
  const ws = createWebServerShim({ logger: {} })
  let served = false
  ws.register({
    kind: 'prefix',
    path: '/slow',
    handler: async (req, res) => {
      await new Promise(resolve => setTimeout(resolve, 200))
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('late-ok')
      served = true
    },
  })
  const info = await ws.listen()
  const inflight = plainGet(info.url + '/slow')
  inflight.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 80))
  const closing = ws.close()
  assert.equal(await inflight, 'late-ok', '在飞请求要能写完')
  await closing
  assert.equal(served, true)
  assert.equal(ws.listening, false)
})

test('webServerShim：close() 遇到挂死连接，1.5s 兜底强拆后 resolve', async () => {
  const ws = createWebServerShim({ logger: {} })
  ws.register({ kind: 'prefix', path: '/hang', handler: () => new Promise(() => {}) })
  const info = await ws.listen()
  const hung = http.get(info.url + '/hang')
  hung.on('error', () => undefined)
  await new Promise(resolve => setTimeout(resolve, 60))
  const started = Date.now()
  await ws.close()
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 1200, 'close 应该先等自然收尾，兜底时间到了才硬来：' + elapsed)
  assert.ok(elapsed < 4000, 'close 不该拖过 4s：' + elapsed)
  hung.destroy()
})

test('webServerShim：同路径 prefix 与 exact 并存时，正好命中那条走 exact', async () => {
  const ws = createWebServerShim({ logger: {} })
  ws.register({
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('prefix')
    },
  })
  ws.register({
    kind: 'exact',
    path: '/api',
    handler: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('exact')
    },
  })
  const info = await ws.listen()
  try {
    assert.equal(await plainGet(info.url + '/api'), 'exact')
    assert.equal(await plainGet(info.url + '/api/x'), 'prefix')
  } finally {
    await ws.close()
  }
})

test('webServerShim：IPv6 地址拼成带方括号的 url', () => {
  const v6 = createWebServerShim({ host: '::1', port: 0, logger: {} })
  assert.equal(v6.address().host, '::1')
  assert.equal(v6.address().url, 'http://[::1]:0')
  const v4 = createWebServerShim({ host: '127.0.0.1', port: 8080, logger: {} })
  assert.equal(v4.address().url, 'http://127.0.0.1:8080')
})



