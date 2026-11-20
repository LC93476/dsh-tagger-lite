/**
 * POST /upload：参考图落进 ComfyUI 的 input 目录。
 * 为什么单独测：这条路是「用自己的图锁体态」的入口 —— 写不进 input，LoadImage 就永远读不到。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createHandlers, createRuntime } from '../index.js'
import { createDispatch, PREFIX } from '../lib/routes.js'

const SANDBOX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-upload-'))
process.env.DSH_PROMPT_FORGE_DATA = SANDBOX_DIR

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function fakeCtx() {
  const registrations = { prefixes: [], tools: [] }
  return {
    registrations,
    get(name) {
      if (name === 'webServer') {
        return { register(spec) { registrations.prefixes.push(spec); return () => {} } }
      }
      if (name === 'tools') {
        return { register(spec) { registrations.tools.push(spec); return () => {} } }
      }
      return undefined
    },
    effect(fn) { fn() },
  }
}

/** @param {import('node:net').Server} server @returns {number} */
function portOf(server) {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

async function withServer(rawConfig, run) {
  const rt = createRuntime(fakeCtx(), { ui: { keepHistory: 1 }, ...rawConfig })
  const server = http.createServer(createDispatch(createHandlers(rt), rt.log))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(server)
  try {
    await run({ base: 'http://127.0.0.1:' + port + PREFIX, rt })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function post(base, body) {
  const res = await fetch(base + '/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : JSON.parse(text) }
}

test('POST /upload：base64 参考图写进 ComfyUI 的 input 目录并回文件名', async () => {
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  await withServer({ comfy: { launchDir } }, async ({ base }) => {
    const { status, body } = await post(base, { filename: 'pose ref.png', data: 'data:image/png;base64,' + PNG_1PX })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.match(body.name, /^tagger_ref_[0-9a-f]{8}_pose_ref\.png$/)
    const written = path.join(launchDir, 'input', body.name)
    assert.equal(fs.existsSync(written), true, '文件没落到 input 目录')
    assert.equal(fs.statSync(written).size, Buffer.from(PNG_1PX, 'base64').length)
  })
})

test('POST /upload：非图片扩展名与空文件都回 400，不写盘', async () => {
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  await withServer({ comfy: { launchDir } }, async ({ base }) => {
    const bad = await post(base, { filename: 'evil.sh', data: PNG_1PX })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'bad-type')
    const empty = await post(base, { filename: 'a.png', data: '' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.error, 'empty-file')
    assert.equal(fs.existsSync(path.join(launchDir, 'input')), false, '不该建目录')
  })
})

test('POST /upload：没配 launchDir 时说清楚是缺这一项', async () => {
  await withServer({ comfy: { launchDir: '' } }, async ({ base }) => {
    const { status, body } = await post(base, { filename: 'a.png', data: PNG_1PX })
    assert.equal(status, 400)
    assert.equal(body.error, 'no-launch-dir')
  })
})

test('POST /upload：subfolder 里的 .. 、绝对路径、盘符、NUL 都被挡在 input 外面', async () => {
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  await withServer({ comfy: { launchDir } }, async ({ rt }) => {
    const bads = ['../../escape', '/etc', 'C:\\Windows', 'refs/../../x', 'a\u0000b']
    for (const subfolder of bads) {
      const res = await rt.comfy.upload({ filename: 'a.png', data: 'data:image/png;base64,' + PNG_1PX, subfolder })
      assert.equal(res.ok, false, 'subfolder ' + JSON.stringify(subfolder) + ' 应该被拒绝')
      assert.equal(res.error, 'bad-path', 'subfolder ' + JSON.stringify(subfolder) + ' 的错误码不对')
    }
    assert.equal(fs.existsSync(path.join(launchDir, 'input')), false, '被拒绝时不该建任何目录')
    assert.equal(fs.existsSync(path.join(launchDir, 'escape')), false, '不该写到 input 外面')
  })
})

test('POST /upload：超过 80 字符的文件名截断 stem 后仍保留 .png 扩展名', async () => {
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  await withServer({ comfy: { launchDir } }, async ({ base }) => {
    const long = 'x'.repeat(90) + '.png'
    const { status, body } = await post(base, { filename: long, data: 'data:image/png;base64,' + PNG_1PX })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.match(body.name, /^tagger_ref_[0-9a-f]{8}_x{48}\.png$/, 'stem 该截到 48 字符且扩展名不丢：' + body.name)
    assert.equal(body.name.length, 'tagger_ref_'.length + 8 + 1 + 48 + '.png'.length)
    assert.equal(fs.existsSync(path.join(launchDir, 'input', body.name)), true)
  })
})

test('subfolder 透传：返回的 name 带 refs/ 前缀，反斜杠写法归一成同一层目录', async () => {
  const launchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-comfy-'))
  await withServer({ comfy: { launchDir } }, async ({ rt }) => {
    const refs = await rt.comfy.upload({ filename: 'pose ref.png', data: 'data:image/png;base64,' + PNG_1PX, subfolder: 'refs' })
    assert.equal(refs.ok, true)
    assert.match(refs.name, /^refs\/tagger_ref_[0-9a-f]{8}_pose_ref\.png$/, '带子目录时 name 该是 POSIX 相对路径：' + refs.name)
    assert.equal(fs.existsSync(path.join(launchDir, 'input', 'refs', path.posix.basename(refs.name))), true)

    const deep = await rt.comfy.upload({ filename: 'a.png', data: 'data:image/png;base64,' + PNG_1PX, subfolder: 'refs\\deep' })
    assert.equal(deep.ok, true)
    assert.match(deep.name, /^refs\/deep\/tagger_ref_[0-9a-f]{8}_a\.png$/)
    assert.equal(fs.existsSync(path.join(launchDir, 'input', 'refs', 'deep', path.posix.basename(deep.name))), true)
  })
})
