/**
 * 姿势目录：读 ai-pose-gallery-zh 的 catalog.csv，再把 /poses 接线上。
 * 用临时 launchDir 造一份假姿势库，不碰用户的 ComfyUI 目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ANGLE_SUFFIX, SET_LABELS, baseOfId, createPoseCatalog, poseGallery, poseImage, setOfId } from '../lib/poses.js'
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

function makeGallery2(root) {
  const mk = (set, lines) => {
    const dir = path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'pose-reference-' + set, 'references')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'catalog.csv'), ['id,体系,分类,姿势编号,姿势名称,角度,图片'].concat(lines).join('\n'))
  }
  // 故意不按角度顺序写：画廊要自己排成 正面 → 斜侧 → 侧面 → 俯视 → 仰视
  mk('sexy', [
    'full_sexy_P016_side,全身单人·性感系,坐姿,P016,侧坐・单手支撑,侧面,../../img/16s.png',
    'full_sexy_P016_front,全身单人·性感系,坐姿,P016,侧坐・单手支撑,正面,../../img/16f.png',
    'full_sexy_P016_diag,全身单人·性感系,坐姿,P016,侧坐・单手支撑,斜侧,../../img/16d.png',
    'full_sexy_P026_front,全身单人·性感系,坐姿,P026,侧坐・撩发,正面,../../img/26f.png',
  ])
  mk('standard', [
    'full_single_P001_front,全身单人·标准系,站姿,P001,自然站立,正面,../../img/1f.png',
    'full_single_P001_high,全身单人·标准系,站姿,P001,自然站立,俯视,../../img/1h.png',
  ])
  mk('upper', ['upper80v2_P001_front,上半身单人,可爱系,P001,胸前双手比心,正面,../../img/u1.png'])
  mk('couple', ['pair60_P020_front,双人缠绵,侧卧位,P020,侧身・单腿搭肩,正面,../../img/p20.png'])
  return root
}

function makeBigGallery() {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'big-'))
  const dir = path.join(root, 'custom_nodes', 'ai-pose-gallery-zh', 'skills', 'pose-reference-standard', 'references')
  fs.mkdirSync(dir, { recursive: true })
  const lines = ['id,体系,分类,姿势编号,姿势名称,角度,图片']
  for (let i = 1; i <= 405; i += 1) {
    const code = 'P' + String(i).padStart(3, '0')
    lines.push('full_single_' + code + '_front,全身单人·标准系,站姿,' + code + ',站位' + i + ',正面,../../img/' + code + '.png')
  }
  fs.writeFileSync(path.join(dir, 'catalog.csv'), lines.join('\n'))
  return root
}

test('姿势画廊：按角度聚成组、variant 按固定角度序、sets 一律是组数', () => {
  const root = makeGallery2(fs.mkdtempSync(path.join(SANDBOX, 'g2-')))
  const g = poseGallery({ launchDir: root })
  assert.equal(g.total, 5)
  assert.equal(g.shown, 5)
  const p016 = g.groups.find(item => item.base === 'full_sexy_P016')
  assert.deepEqual(p016.variants.map(variant => variant.angle), ['正面', '斜侧', '侧面'])
  assert.equal(p016.count, 3)
  assert.equal(p016.set, 'sexy')
  assert.equal(p016.setLabel, '全身单人·性感系')
  assert.equal(p016.category, '坐姿')
  assert.equal(p016.variants[0].thumb, '/tagger/api/pose-thumb?id=full_sexy_P016_front')
  assert.equal(p016.variants[0].image, '../../img/16f.png')
  assert.deepEqual(g.angles, ['正面', '斜侧', '侧面', '俯视', '仰视'])
  assert.equal(g.sets[0].key, 'all')
  assert.equal(g.sets[0].label, '全部')
  assert.equal(g.sets[0].count, 5)
  assert.deepEqual(g.sets.slice(1).map(item => [item.key, item.count]), [['standard', 1], ['sexy', 2], ['upper', 1], ['couple', 1]])
  assert.equal(g.categories[0].key, '坐姿')
  assert.equal(g.categories[0].count, 2)
  const counts = g.categories.map(item => item.count)
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), '分类按组数降序')
})

test('姿势画廊：set / category / angle / q 过滤，分页与 limit 上限', () => {
  const root = makeGallery2(fs.mkdtempSync(path.join(SANDBOX, 'g3-')))
  const sexy = poseGallery({ launchDir: root, set: 'sexy' })
  assert.equal(sexy.total, 2)
  assert.ok(sexy.groups.every(item => item.set === 'sexy'))

  const side = poseGallery({ launchDir: root, angle: '侧面' })
  assert.equal(side.total, 1)
  assert.deepEqual(side.groups[0].variants.map(variant => variant.angle), ['侧面'])
  assert.equal(side.groups[0].count, 1)

  const standing = poseGallery({ launchDir: root, category: '站姿' })
  assert.deepEqual(standing.groups.map(item => item.base), ['full_single_P001'])

  const named = poseGallery({ launchDir: root, q: '撩发' })
  assert.deepEqual(named.groups.map(item => item.base), ['full_sexy_P026'])

  const all = poseGallery({ launchDir: root })
  const page = poseGallery({ launchDir: root, limit: 1, offset: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.shown, 1)
  assert.equal(page.offset, 2)
  assert.equal(page.groups[0].base, all.groups[2].base)
  assert.equal(poseGallery({ launchDir: root, offset: 99 }).shown, 0)

  // limit 非法 / 超上限：0 回落默认 120，9999 钳到 400
  assert.equal(poseGallery({ launchDir: root, limit: 0 }).shown, 5)
  const big = poseGallery({ launchDir: makeBigGallery(), limit: 9999 })
  assert.equal(big.total, 405)
  assert.equal(big.shown, 400)
})

test('setOfId / baseOfId / ANGLE_SUFFIX / SET_LABELS：按真 id 前缀归一', () => {
  assert.deepEqual(Object.keys(ANGLE_SUFFIX), ['_front', '_diag', '_side', '_high', '_low'])
  assert.deepEqual(Object.values(ANGLE_SUFFIX), ['正面', '斜侧', '侧面', '俯视', '仰视'])
  assert.deepEqual(Object.keys(SET_LABELS), ['standard', 'sexy', 'upper', 'couple'])
  assert.equal(setOfId('upper80v2_P001_front'), 'upper')
  assert.equal(setOfId('full_single_P041_diag'), 'standard')
  assert.equal(setOfId('full_sexy_P016_side'), 'sexy')
  assert.equal(setOfId('pair60_P020_front'), 'couple')
  assert.equal(setOfId('full_couple_X_front'), 'couple')
  assert.equal(setOfId('STS-0001'), 'other')
  assert.equal(setOfId(null), 'other')
  assert.equal(baseOfId('upper80v2_P001_low'), 'upper80v2_P001')
  assert.equal(baseOfId('pair60_P020_high'), 'pair60_P020')
  assert.equal(baseOfId('no_suffix_here'), 'no_suffix_here')
  assert.equal(baseOfId(''), '')
})

test('GET /pose-gallery：接线，set / limit 从 query 进来', async () => {
  const root = makeGallery2(fs.mkdtempSync(path.join(SANDBOX, 'g4-')))
  const rt = createRuntime({ get: () => undefined, effect: fn => fn() }, {
    llm: { provider: 'x', model: 'y' },
    comfy: { baseUrl: 'http://127.0.0.1:59999', launchDir: root },
  })
  const route = createHandlers(rt).find(item => item.path === '/pose-gallery')
  assert.ok(route !== undefined, '/pose-gallery 路由没注册')
  const res = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-gallery?set=standard&limit=1'), body: {} })
  assert.equal(res.json.total, 1)
  assert.equal(res.json.groups[0].base, 'full_single_P001')
  const full = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-gallery'), body: {} })
  assert.equal(full.json.total, 5)
  assert.equal(full.json.sets[0].key, 'all')
})

test('GET /pose-tags：base + angle 出姿态/镜头标签，缺参 400、没这张 404、没有的 base 404', async () => {
  const root = makeGallery2(fs.mkdtempSync(path.join(SANDBOX, 'g5-')))
  const rt = createRuntime({ get: () => undefined, effect: fn => fn() }, {
    llm: { provider: 'x', model: 'y' },
    comfy: { baseUrl: 'http://127.0.0.1:59999', launchDir: root },
  })
  const route = createHandlers(rt).find(item => item.path === '/pose-tags')
  assert.ok(route !== undefined, '/pose-tags 路由没注册')

  const ok = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-tags?base=full_single_P001&angle=正面'), body: {} })
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.base, 'full_single_P001')
  assert.equal(ok.json.set, 'standard')
  assert.ok(ok.json.pose.some(item => item.tag === 'standing'), '站姿要补 standing')
  assert.ok(ok.json.camera.some(item => item.tag === 'facing_viewer'), '正面要补 facing_viewer')
  for (const item of ok.json.tags) {
    assert.equal(typeof item.tag, 'string')
    assert.equal(typeof item.cn, 'string')
    assert.equal(typeof item.matched, 'boolean')
  }

  const multi = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-tags?base=full_single_P001&ids=full_single_P001_front,full_single_P001_high'), body: {} })
  assert.equal(multi.json.items.length, 2)
  assert.deepEqual(multi.json.items.map(item => item.angle), ['正面', '俯视'])

  const noVariant = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-tags?base=full_single_P001&angle=侧面'), body: {} })
  assert.equal(noVariant.status, 404)
  assert.equal(noVariant.json.error, 'no-variant')

  const badBase = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-tags'), body: {} })
  assert.equal(badBase.status, 400)
  assert.equal(badBase.json.error, 'bad-base')

  const noPose = await route.handler({ method: 'GET', params: {}, url: new URL('http://127.0.0.1/tagger/api/pose-tags?base=zzz_P999'), body: {} })
  assert.equal(noPose.status, 404)
  assert.equal(noPose.json.error, 'no-pose')
})

test('姿势画廊：真姿势库（有就校验，没有就跳过）', t => {
  const realDir = process.env.DSH_POSE_REAL_DIR ?? 'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI'
  if (fs.existsSync(path.join(realDir, 'custom_nodes', 'ai-pose-gallery-zh')) === false) {
    t.skip('本机没有真姿势库')
    return
  }
  const g = poseGallery({ launchDir: realDir, limit: 400 })
  assert.ok(g.total >= 200, '真库至少 200 组，实际 ' + g.total)
  assert.equal(g.sets[0].key, 'all')
  const sum = g.sets.slice(1).reduce((acc, item) => acc + item.count, 0)
  assert.equal(sum, g.total, 'sets 各档组数加起来要等于总组数')
  assert.ok(g.groups.every(group => group.set !== 'other'), '真库的 id 前缀都要能归一')
  assert.ok(g.groups.every(group => group.variants.length >= 1 && group.variants.length <= 5))
  assert.equal(new Set(g.groups.map(group => group.base)).size, g.groups.length, '组不重复')
})

