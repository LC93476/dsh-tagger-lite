/**
 * 参考库（服装 / 人像）：读 ai-pose-gallery-zh 的 catalog.csv，再把 /refs、/ref-image、/ref-tags 接上线。
 * 用临时 launchDir 造一份假参考库，不碰用户的 ComfyUI 目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { REF_KINDS, RefError, refGallery, refImage, refItem, refKind, refRoot } from '../lib/refs.js'
import { createHandlers, createRuntime } from '../index.js'

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-refs-'))
process.env.DSH_PROMPT_FORGE_DATA = SANDBOX

const NODE_REL = path.join('custom_nodes', 'ai-pose-gallery-zh')

/** 造一份小参考库：两个服装库（其中一个带 BOM）+ 一个人像库 + 几张假图。 */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'refs-'))
  const skills = path.join(root, NODE_REL, 'skills')
  const write = (dir, lines) => {
    const at = path.join(skills, dir, 'references')
    fs.mkdirSync(at, { recursive: true })
    fs.writeFileSync(path.join(at, 'catalog.csv'), lines.join('\n'))
  }
  write('costume-reference', [
    'id,分类,服装名称,标签,英文关键词,图片',
    'SPR-0001,春季穿搭,象牙白针织衫・牛仔裙,象牙白 针织 牛仔,ivory knit denim,../../img/costume/SPR-0001.webp',
    'SPR-0002,夏季穿搭,吊带衫・短裤,吊带 短裤,camisole shorts,../../img/costume/SPR-0002.webp',
    'SPR-0003,夏季穿搭,白色连衣裙・凉鞋,白色 连衣裙,white dress sandals,../../img/costume/SPR-0003.webp',
    '',
  ])
  // 第二行故意带 BOM：列名不能跟着变成「﻿id」，否则整库解析不出来
  write('costume-reference-sexy', [
    '\ufeffid,分类,服装名称,标签,英文关键词,图片',
    'LNG-0105,内衣・睡衣,藏青色内衣套装・丝袜,藏青 内衣 丝袜,navy lingerie stockings,../../img/costume/LNG-0105.webp',
  ])
  write('portrait-reference', [
    'id,分区,发长,发型名称,标题,热门,图片',
    'f71f980dde3,正脸参考,短发,标准基础款,短发・标准款,是,../../img/portrait/f71f980dde3.webp',
    'f009cba9893,正脸参考,短发,收腰感短发,收腰感短发（空气刘海）,,../../img/portrait/f009cba9893.webp',
    'e0000000001,造型氛围,长发,大波浪,大波浪・侧光,,../../img/portrait/e0000000001.webp',
    'e0000000002,造型氛围,中发,锁骨发,锁骨发・柔光,是,../../img/portrait/e0000000002.webp',
  ])
  const image = (rel, name, body) => {
    const dir = path.join(root, NODE_REL, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  image('thumbs/costume', 'SPR-0001.webp', 'thumb-spr-0001')
  image('img/costume', 'SPR-0001.webp', 'full-spr-0001')
  image('img/costume', 'SPR-0002.webp', 'full-spr-0002')
  image('img/portrait', 'f71f980dde3.webp', 'portrait-1')
  return root
}

/** 断言回调里 error 是 unknown，统一走这个帮手取 code（顺便要求它确实是 RefError）。 */
function hasCode(error, code) {
  return error instanceof RefError && error.code === code
}

/** 造一个只有一层壳的仓库根（库目录不在盘上）。 */
function makeEmptyRoot() {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'empty-'))
  fs.mkdirSync(path.join(root, NODE_REL, 'skills'), { recursive: true })
  return root
}

function runtimeFor(root) {
  return createRuntime({ get: () => undefined, effect: fn => fn() }, {
    llm: { provider: 'x', model: 'y' },
    comfy: { baseUrl: 'http://127.0.0.1:59999', launchDir: root },
  })
}

function routeOf(root, routePath) {
  const route = createHandlers(runtimeFor(root)).find(item => item.path === routePath)
  assert.ok(route !== undefined, routePath + ' 路由没注册')
  return route
}

function urlOf(search) {
  return new URL('http://127.0.0.1/tagger/api' + search)
}

test('服装库：两个目录合并、按分类出分面、中文标签拆成 cn 数组', () => {
  const root = makeRoot()
  const g = refGallery(root, 'costume')
  assert.equal(g.ok, true)
  assert.equal(g.kind, 'costume')
  assert.equal(g.total, 4, '春季 1 + 夏季 2 + 内衣・睡衣 1')
  assert.equal(g.shown, 4)
  assert.deepEqual(g.sets[0], { key: 'all', label: '全部', count: 4 })
  assert.deepEqual(g.sets.slice(1).map(item => [item.key, item.count]), [['夏季穿搭', 2], ['内衣・睡衣', 1], ['春季穿搭', 1]])
  assert.deepEqual(g.categories.map(item => item.key), ['夏季穿搭', '内衣・睡衣', '春季穿搭'])
  assert.deepEqual(g.hairs, [], '服装库没有发长分面')

  const item = g.items.find(entry => entry.id === 'LNG-0105')
  assert.deepEqual(item.cn, ['藏青', '内衣', '丝袜'], 'BOM 库的标签列也要解析出来')
  assert.equal(item.category, '内衣・睡衣')
  assert.equal(item.keywords, 'navy lingerie stockings')
  assert.equal(item.thumb, '/ref-image?kind=costume&id=LNG-0105')
  assert.equal(item.image, '/ref-image?kind=costume&id=LNG-0105&size=full')
})

test('人像库：分区出 sets、发长出 hairs、热门是布尔', () => {
  const root = makeRoot()
  const g = refGallery(root, 'portrait')
  assert.equal(g.ok, true)
  assert.equal(g.total, 4)
  assert.deepEqual(g.sets.map(item => [item.key, item.count]), [['all', 4], ['正脸参考', 2], ['造型氛围', 2]])
  assert.deepEqual(g.hairs.map(item => [item.key, item.count]), [['短发', 2], ['中发', 1], ['长发', 1]])

  const hot = g.items.find(entry => entry.id === 'f71f980dde3')
  assert.equal(hot.popular, true)
  assert.equal(hot.partition, '正脸参考')
  assert.equal(hot.hair, '短发')
  assert.equal(hot.title, '短发・标准款')
  assert.equal(hot.image, '/ref-image?kind=portrait&id=f71f980dde3')
  assert.equal(hot.thumb, undefined, '人像没有缩略图，别硬塞字段')

  const cold = g.items.find(entry => entry.id === 'f009cba9893')
  assert.equal(cold.popular, false)
})

test('过滤：q 认名字 / 中文标签 / 英文关键词，set / hair / popular 各自生效', () => {
  const root = makeRoot()
  assert.equal(refGallery(root, 'costume', { q: 'camisole' }).total, 1, 'q 要认英文关键词')
  assert.equal(refGallery(root, 'costume', { q: '丝袜' }).total, 1, 'q 要认中文标签')
  assert.equal(refGallery(root, 'costume', { q: '连衣裙' }).total, 1, 'q 要认服装名称')
  assert.equal(refGallery(root, 'costume', { q: 'SPR-0002' }).total, 1, 'q 也认 id')

  const summer = refGallery(root, 'costume', { set: '夏季穿搭' })
  assert.equal(summer.total, 2)
  assert.equal(summer.sets[0].count, 4, 'sets 的 all 是过滤前的总数，切分类不该让它跳')

  assert.equal(refGallery(root, 'costume', { set: 'all' }).total, 4, 'set=all 等于不过滤')

  const shortHair = refGallery(root, 'portrait', { hair: '短发' })
  assert.equal(shortHair.total, 2)
  assert.equal(shortHair.hairs.length, 3, '换发长不缩自己的选项')

  const popular = refGallery(root, 'portrait', { popular: '1' })
  assert.equal(popular.total, 2)
  assert.equal(popular.items.every(item => item.popular === true), true)
  assert.equal(refGallery(root, 'portrait', { popular: '0' }).total, 4, 'popular=0 当没传')
  assert.equal(refGallery(root, 'costume', { popular: '1' }).total, 4, '服装库没有热门列，别过滤成空')
})

test('分页：limit 默认 120、上限 400、offset 从过滤后的池子里切', () => {
  const root = makeRoot()
  const first = refGallery(root, 'costume', { limit: 2 })
  assert.equal(first.shown, 2)
  assert.equal(first.total, 4, 'total 是过滤后的总数，不是这一页的长度')
  assert.equal(first.offset, 0)
  assert.equal(first.items[0].id, 'SPR-0001')

  const second = refGallery(root, 'costume', { limit: 2, offset: 2 })
  assert.equal(second.offset, 2)
  assert.deepEqual(second.items.map(item => item.id), ['SPR-0003', 'LNG-0105'])

  assert.equal(refGallery(root, 'costume', { limit: 0 }).shown, 4, 'limit=0 落回默认值')
  assert.equal(refGallery(root, 'costume', { limit: 9999 }).shown, 4, '超过上限也别报错')
  assert.equal(refGallery(root, 'costume', { offset: -5 }).offset, 0, '负 offset 归零')
})

test('refImage：服装缩略图优先、缺了退回原图、size=full 直接原图', () => {
  const root = makeRoot()
  const thumb = refImage(root, 'costume', 'SPR-0001')
  assert.equal(thumb.mediaType, 'image/webp')
  assert.equal(thumb.file, path.join(root, NODE_REL, 'thumbs', 'costume', 'SPR-0001.webp'))
  assert.equal(fs.readFileSync(thumb.file, 'utf8'), 'thumb-spr-0001')

  const full = refImage(root, 'costume', 'SPR-0001', 'full')
  assert.equal(full.file, path.join(root, NODE_REL, 'img', 'costume', 'SPR-0001.webp'))

  // 没有缩略图的那条：退回原图，不是 404
  const fallback = refImage(root, 'costume', 'SPR-0002')
  assert.equal(fallback.file, path.join(root, NODE_REL, 'img', 'costume', 'SPR-0002.webp'))

  const portrait = refImage(root, 'portrait', 'f71f980dde3', 'full')
  assert.equal(portrait.file, path.join(root, NODE_REL, 'img', 'portrait', 'f71f980dde3.webp'))
})

test('refImage：非法 id / 非法 kind / 盘上没有，一律抛带 code 的 RefError', () => {
  const root = makeRoot()
  for (const bad of ['../secrets', '..\\secrets', 'SPR-0001/../../etc/passwd', '/etc/passwd', '', 'x'.repeat(41), 'SPR 0001', 'a.b']) {
    assert.throws(() => refImage(root, 'costume', bad), error => hasCode(error, 'bad-id'), 'id 要挡住：' + bad)
  }
  assert.throws(() => refImage(root, 'shoes', 'SPR-0001'), error => hasCode(error, 'bad-kind'))
  assert.throws(() => refImage(root, 'costume', 'SPR-9999'), error => hasCode(error, 'no-ref-image'))

  // 库根外面就算真有同名文件也读不到：id 白名单 + inside() 双保险
  fs.writeFileSync(path.join(root, NODE_REL, 'escape.webp'), 'outside')
  assert.throws(() => refImage(root, 'costume', 'escape'), error => hasCode(error, 'no-ref-image'))
})

test('launchDir 空 / 库目录不在盘上：给 no-ref-library，不抛错也不假装有货', () => {
  assert.equal(refRoot(''), '')
  assert.equal(refRoot('   '), '')
  assert.equal(refRoot('D:/some/comfy'), path.join('D:/some/comfy', NODE_REL))
  assert.equal(refKind('Costume '), 'costume')
  assert.equal(refKind('portrait'), 'portrait')
  assert.equal(refKind('shoes'), '')
  assert.equal(refKind(null), '')

  for (const launchDir of ['', makeEmptyRoot()]) {
    const g = refGallery(launchDir, 'costume')
    assert.equal(g.ok, false)
    assert.equal(g.error, 'no-ref-library')
    assert.equal(g.total, 0)
    assert.deepEqual(g.sets, [])
    assert.deepEqual(g.items, [])
    assert.equal(refItem(launchDir, 'costume', 'SPR-0001'), null)
    assert.throws(() => refImage(launchDir, 'costume', 'SPR-0001'), error => hasCode(error, 'no-ref-library'))
  }

  // kind 错了优先报 bad-kind，而不是没库
  assert.equal(refGallery('', 'shoes').error, 'bad-kind')
  assert.equal(refItem(makeRoot(), 'costume', '../SPR-0001'), null, '非法 id 不进库')
})

test('缓存按 mtime 失效：catalog 追加一行，下一次画廊就看得见', () => {
  const root = makeRoot()
  assert.equal(refGallery(root, 'costume').total, 4)
  const file = path.join(root, NODE_REL, 'skills', 'costume-reference', 'references', 'catalog.csv')
  fs.appendFileSync(file, '\nSPR-0004,派对・礼服,黑色晚礼服,黑色 礼服,black gown,../../img/costume/SPR-0004.webp')
  const after = refGallery(root, 'costume')
  assert.equal(after.total, 5)
  assert.ok(after.sets.some(item => item.key === '派对・礼服'))
})

test('GET /refs：kind 合法回画廊，非法 400 bad-kind，库不在 404 no-ref-library', async () => {
  const root = makeRoot()
  const route = routeOf(root, '/refs')

  const ok = await route.handler({ method: 'GET', params: {}, url: urlOf('/refs?kind=costume&set=夏季穿搭&limit=1'), body: {} })
  assert.equal(ok.status, undefined, '成功不用显式状态码')
  assert.equal(ok.json.ok, true)
  assert.equal(ok.json.total, 2)
  assert.equal(ok.json.shown, 1)

  const bad = await route.handler({ method: 'GET', params: {}, url: urlOf('/refs?kind=shoes'), body: {} })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error, 'bad-kind')

  const empty = routeOf(makeEmptyRoot(), '/refs')
  const missing = await empty.handler({ method: 'GET', params: {}, url: urlOf('/refs?kind=portrait'), body: {} })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error, 'no-ref-library')
  assert.equal(typeof missing.json.message, 'string')
})

test('GET /ref-image：回二进制 + image/webp，错 id / 错 kind 400，缺图 404', async () => {
  const root = makeRoot()
  const route = routeOf(root, '/ref-image')
  assert.deepEqual(route.methods, ['GET', 'HEAD'], '只收 GET / HEAD')

  const hit = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-image?kind=costume&id=SPR-0001'), body: {} })
  assert.equal(hit.contentType, 'image/webp')
  assert.equal(hit.binary.toString('utf8'), 'thumb-spr-0001')

  const full = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-image?kind=costume&id=SPR-0001&size=full'), body: {} })
  assert.equal(full.binary.toString('utf8'), 'full-spr-0001')

  const badId = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-image?kind=costume&id=..%2Fsecrets'), body: {} })
  assert.equal(badId.status, 400)
  assert.equal(badId.json.error, 'bad-id')

  const badKind = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-image?kind=shoes&id=SPR-0001'), body: {} })
  assert.equal(badKind.status, 400)

  const gone = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-image?kind=portrait&id=fffffffffff'), body: {} })
  assert.equal(gone.status, 404)
  assert.equal(gone.json.error, 'no-ref-image')
})

test('/ref-tags：模块没就位回 501，就位后结构与错码都稳定', async () => {
  const root = makeRoot()
  const route = routeOf(root, '/ref-tags')
  // 同 handlers：拼字符串 import，缺席时走 501 分支（任务是「模块可能还没落盘」）
  const mod = await import('../lib/ref-' + 'tags.js').catch(() => null)

  const badKind = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-tags?kind=shoes&id=SPR-0001'), body: {} })
  assert.equal(badKind.status, 400)
  assert.equal(badKind.json.error, 'bad-kind')

  const noRef = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-tags?kind=costume&id=SPR-9999'), body: {} })
  assert.equal(noRef.status, 404)
  assert.equal(noRef.json.error, 'no-ref')

  const res = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-tags?kind=costume&id=SPR-0001'), body: {} })
  if (mod === null) {
    assert.equal(res.status, 501)
    assert.equal(res.json.error, 'ref-tags-unavailable')
  } else {
    // lib/ref-tags.js 已就位：形状收敛到 { positive:[{tag,cn}], negative, notes, reasons }
    assert.equal(res.json.ok, true)
    assert.equal(res.json.kind, 'costume')
    assert.equal(res.json.id, 'SPR-0001')
    assert.ok(Array.isArray(res.json.positive))
    assert.ok(Array.isArray(res.json.negative))
    assert.ok(Array.isArray(res.json.notes))
    assert.ok(Array.isArray(res.json.reasons))
    for (const pair of [...res.json.positive, ...res.json.negative]) {
      assert.equal(typeof pair.tag, 'string')
      assert.equal(typeof pair.cn, 'string')
      assert.notEqual(pair.tag, '')
    }
    // knit / denim 至少能被映射出来一条，且都要给出理由（面板要显示「为什么补它」）
    assert.ok(res.json.reasons.length > 0, '映射要有理由')
    const portrait = await route.handler({ method: 'GET', params: {}, url: urlOf('/ref-tags?kind=portrait&id=f71f980dde3'), body: {} })
    assert.equal(portrait.json.ok, true)
    assert.equal(portrait.json.kind, 'portrait')
    assert.ok(portrait.json.reasons.some(line => line.includes('短发')), '人像要按发长补词')
  }
  assert.ok(REF_KINDS.costume.sets.length === 2, '服装库是两个目录合并')
})
/** 只放「名字里没有、标签里有」的服装 + 一条大写英文关键词，用来验中文标签搜索。 */
function makeTagRoot() {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'tags-'))
  const at = path.join(root, NODE_REL, 'skills', 'costume-reference', 'references')
  fs.mkdirSync(at, { recursive: true })
  fs.writeFileSync(path.join(at, 'catalog.csv'), [
    'id,分类,服装名称,标签,英文关键词,图片',
    'SPR-0101,春季穿搭,条纹上衣,藏青 条纹,STRIPED KNIT,../../img/costume/SPR-0101.webp',
    'SPR-0102,春季穿搭,白衬衫,白色 衬衫,white shirt,../../img/costume/SPR-0102.webp',
  ].join('\n'))
  return root
}

test('q 要搜到中文标签（名称里没有的字也算命中），英文关键词不分大小写', () => {
  const root = makeTagRoot()
  const byTag = refGallery(root, 'costume', { q: '藏青' })
  assert.equal(byTag.total, 1, '「藏青」只写在「标签」列里，cn 数组必须参与匹配')
  assert.equal(byTag.items[0].id, 'SPR-0101')

  assert.equal(refGallery(root, 'costume', { q: '条纹' }).total, 1, '名称与标签都命中时不算两条')
  assert.equal(refGallery(root, 'costume', { q: '衬衫' }).total, 1, '名称照旧要能搜')
  assert.equal(refGallery(root, 'costume', { q: 'striped knit' }).total, 1, '英文关键词小写查询')
  assert.equal(refGallery(root, 'costume', { q: 'STRIPED' }).total, 1, '英文关键词大写查询不分大小写')
  assert.equal(refGallery(root, 'costume', { q: '藏青 条纹' }).total, 0, '按子串匹配，不在这里做分词')
})

test('refImage 只认普通文件：软链不跟、目录不认，都回 no-ref-image', t => {
  const root = makeRoot()
  // 先测不依赖权限的那一半：同一个 id 位置上是个目录时，lstat 的 isFile() 不成立，必须跳过
  fs.mkdirSync(path.join(root, NODE_REL, 'thumbs', 'costume', 'DIR-0001.webp'), { recursive: true })
  assert.throws(() => refImage(root, 'costume', 'DIR-0001'), error => hasCode(error, 'no-ref-image'))
  assert.throws(() => refImage(root, 'portrait', 'DIR-0001'), error => hasCode(error, 'no-ref-image'))

  const outside = path.join(root, NODE_REL, 'outside-target.webp')
  fs.writeFileSync(outside, 'outside-webp')
  try {
    fs.symlinkSync(outside, path.join(root, NODE_REL, 'thumbs', 'costume', 'LNK-0001.webp'), 'file')
    fs.symlinkSync(outside, path.join(root, NODE_REL, 'img', 'costume', 'LNK-0001.webp'), 'file')
  } catch (error) {
    // Windows 上没开开发者模式 / 不是管理员时建不了软链（EPERM）：这半边跳过，别让用例变红
    const why = error instanceof Error ? error.message : String(error)
    t.diagnostic('这台机器建不了符号链接，软链那一半跳过：' + why)
    return
  }
  // 缩略图与原图两个候选都是软链：跳过而不是跟随，最后按「没这张图」报错
  assert.throws(() => refImage(root, 'costume', 'LNK-0001'), error => hasCode(error, 'no-ref-image'))
  assert.throws(() => refImage(root, 'costume', 'LNK-0001', 'full'), error => hasCode(error, 'no-ref-image'))
  // 普通文件不受影响
  assert.equal(refImage(root, 'costume', 'SPR-0001').file, path.join(root, NODE_REL, 'thumbs', 'costume', 'SPR-0001.webp'))
})

test('两个 catalog 出现同一个 id：只算一次，先读到的目录赢', () => {
  const root = fs.mkdtempSync(path.join(SANDBOX, 'dup-'))
  const write = (dir, lines) => {
    const at = path.join(root, NODE_REL, 'skills', dir, 'references')
    fs.mkdirSync(at, { recursive: true })
    fs.writeFileSync(path.join(at, 'catalog.csv'), lines.join('\n'))
  }
  write('costume-reference', [
    'id,分类,服装名称,标签,英文关键词,图片',
    'SPR-0501,春季穿搭,共用上衣,白色 上衣,white top,../../img/costume/SPR-0501.webp',
    'SPR-0502,春季穿搭,另一件,灰色 上衣,grey top,../../img/costume/SPR-0502.webp',
  ])
  write('costume-reference-sexy', [
    'id,分类,服装名称,标签,英文关键词,图片',
    'SPR-0501,内衣・睡衣,重复的那条,黑色 内衣,black set,../../img/costume/SPR-0501.webp',
  ])

  const g = refGallery(root, 'costume')
  assert.equal(g.total, 2, '重复 id 只能算一条')
  assert.equal(g.shown, 2)
  assert.equal(g.items.filter(item => item.id === 'SPR-0501').length, 1, 'items 里也只出现一次')
  assert.equal(g.items.find(item => item.id === 'SPR-0501').name, '共用上衣', '先读到的目录赢')
  assert.equal(g.sets.some(item => item.key === '内衣・睡衣'), false, '被去重的那条不再贡献分面')
  assert.equal(refItem(root, 'costume', 'SPR-0501').name, '共用上衣', 'refItem 走 byId 也要拿到同一条')
})

