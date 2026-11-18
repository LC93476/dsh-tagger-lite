import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLlmShim } from '../server/shims.mjs'
import { apiUrl, chatCompletionsUrl, createContextAdapter, createLogger, llmSettings, modelsUrl } from '../lib/cordis/adapter.js'

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

