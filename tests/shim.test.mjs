import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLlmShim } from '../server/shims.mjs'

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
