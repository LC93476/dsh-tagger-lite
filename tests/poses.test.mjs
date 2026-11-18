/**
 * 姿势目录：读 ai-pose-gallery-zh 的 catalog.csv，再把 /poses 接线上。
 * 用临时 launchDir 造一份假姿势库，不碰用户的 ComfyUI 目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createPoseCatalog, poseImage } from '../lib/poses.js'
import { createHandlers, createRuntime } from '../index.js'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-poses-'))
process.env.DSH_PROMPT_FORGE_DATA = SANDBOX

function makeGallery(root) {
  const sexy = path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'pose-reference-sexy', 'references')
  const standard = path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'pose-reference-standard', 'references')
  fs.mkdirSync(sexy, { recursive: true })
  fs.mkdirSync(standard, { recursive: true })
  fs.writeFileSync(path.join(sexy, 'catalog.csv'), [
    'id,体系,分类,姿势编号,姿势名称,角度,图片',
    'full_sexy_P016_front,全身单人・性感系,坐姿,P016,侧坐・单手支撑・身体柔弯,正面,../../img/a.png',
    'full_sexy_P016_side,全身单人・性感系,坐姿,P016,侧坐・单手支撑・身体柔弯,侧面,../../img/b.png',
    'full_sexy_P026_diag,全身单人・性感系,坐姿,P026,侧坐・撩发,斜侧,../../img/c.png',
  ].join('\n'))
  fs.writeFileSync(path.join(standard, 'catalog.csv'), [
    'id,体系,分类,姿势编号,姿势名称,角度,图片',
    'full_single_P001_front,全身单人・标准,站姿,P001,自然站立,正面,../../img/d.png',
  ].join('\n'))
  return root
}

test('姿势目录：按体系分组、能按名字和分类筛、文件换了会重读', () => {
  const root = makeGallery(fs.mkdtempSync(path.join(SANDBOX, 'gallery-')))
  const catalog = createPoseCatalog({ config: { comfy: { launchDir: root } }, logger: {} })
  const all = catalog.list()
  assert.equal(all.ok, true)
  assert.equal(all.total, 4)
  assert.deepEqual(all.sets, ['sexy', 'standard'])
  assert.equal(all.poses[0].name, '侧坐・单手支撑・身体柔弯')
  assert.equal(all.poses[0].angle, '正面')

  const sexy = catalog.list({ set: 'sexy' })
  assert.equal(sexy.poses.length, 3)

  const byName = catalog.list({ q: '撩发' })
  assert.deepEqual(byName.poses.map(pose => pose.id), ['full_sexy_P026_diag'])

  const limited = catalog.list({ set: 'sexy', limit: 2 })
  assert.equal(limited.poses.length, 2)
  assert.equal(limited.total, 4)

  // 追加一条新姿势：不用重建对象，下一次 list 就该看见
  fs.appendFileSync(
    path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'pose-reference-sexy', 'references', 'catalog.csv'),
    '\nfull_sexy_P099_front,全身单人・性感系,坐姿,P099,新加的姿势,正面,../../img/z.png',
  )
  assert.equal(catalog.list({ set: 'sexy' }).poses.length, 4)
})

test('姿势目录：launchDir 没配 / 目录不存在时给空表，不抛错', () => {
  const empty = createPoseCatalog({ config: { comfy: { launchDir: '' } }, logger: {} })
  assert.deepEqual({ total: empty.list().total, poses: empty.list().poses }, { total: 0, poses: [] })
  const missing = createPoseCatalog({ config: { comfy: { launchDir: path.join(SANDBOX, 'nope') } }, logger: {} })
  assert.equal(missing.list().total, 0)
})

test('GET /poses：读出目录并带着 launchDir 一起回', async () => {
  const root = makeGallery(fs.mkdtempSync(path.join(SANDBOX, 'route-')))
  const rt = createRuntime({ get: () => undefined, effect: fn => fn() }, {
    llm: { provider: 'x', model: 'y' },
    comfy: { baseUrl: 'http://127.0.0.1:59999', launchDir: root },
  })
  const routes = createHandlers(rt)
  const route = routes.find(item => item.path === '/poses')
  assert.ok(route !== undefined, '/poses 路由没注册')
  const res = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/poses?set=sexy&limit=1'), body: {} })
  assert.equal(res.json.total, 4)
  assert.equal(res.json.poses.length, 1)
  assert.equal(res.json.launchDir, root)
})

test('姿势缩略图：thumbs/<id>.jpg 优先，缺了退回原图 img/<id>.png，非法 id 一律拒绝', async () => {
  const root = makeGallery(fs.mkdtempSync(path.join(SANDBOX, 'thumb-')))
  const imgDir = path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'img')
  fs.mkdirSync(path.join(imgDir, 'thumbs'), { recursive: true })
  fs.writeFileSync(path.join(imgDir, 'thumbs', 'full_sexy_P016_side.jpg'), 'jpg-bytes')
  fs.writeFileSync(path.join(imgDir, 'full_single_P001_front.png'), 'png-bytes')

  const hit = poseImage(root, 'full_sexy_P016_side')
  assert.equal(hit.contentType, 'image/jpeg')
  assert.equal(fs.readFileSync(hit.file, 'utf8'), 'jpg-bytes')

  const fallback = poseImage(root, 'full_single_P001_front')
  assert.equal(fallback.contentType, 'image/png')
  assert.equal(fs.readFileSync(fallback.file, 'utf8'), 'png-bytes')

  assert.equal(poseImage(root, '../secrets'), null, '路径穿越要挡掉')
  assert.equal(poseImage(root, 'no_such_pose'), null)
  assert.equal(poseImage('', 'full_sexy_P016_side'), null)

  const rt = createRuntime({ get: () => undefined, effect: fn => fn() }, {
    llm: { provider: 'x', model: 'y' },
    comfy: { baseUrl: 'http://127.0.0.1:59999', launchDir: root },
  })
  const route = createHandlers(rt).find(item => item.path === '/pose-thumb')
  assert.ok(route !== undefined, '/pose-thumb 路由没注册')
  const ok = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-thumb?id=full_sexy_P016_side'), body: {} })
  assert.equal(ok.contentType, 'image/jpeg')
  assert.equal(ok.binary.toString('utf8'), 'jpg-bytes')
  const miss = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-thumb?id=zzz'), body: {} })
  assert.equal(miss.status, 404)
  assert.equal(miss.json.ok, false)
})

