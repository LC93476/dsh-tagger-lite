/**
 * tests/tags.test.mjs — lib/tags.js 的行为测试。
 *
 * 跑法（本机没有 node 命令）：
 *   ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" tests/tags.test.mjs
 *
 * 覆盖：权重/翻转解析、三种格式化语法、WD/Camie 写法、canonicalize 命中与未命中、
 * 中文别名查询、真实数据 ready() 后 general>0、无数据时 seed 兜底、canonicalizeMany。
 * 无外部依赖：node:test + node:assert。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import tagsEntry, * as tagsNs from '../lib/tags.js'
import * as matcherNs from '../lib/tags/matcher.js'
import { createTagIndex, escapeParens, parseTerm, resetTagIndexCache, unescapeTag } from '../lib/tags.js'
import { addRecord, isOverlayJsonl, overlaySignature } from '../lib/tags/loader.js'
import { standardsFor } from '../lib/tags/text.js'
import { runNormalize, summaryToJson, summaryToText } from '../scripts/tags/build-tags.mjs'

const silent = { info() {}, warn() {}, error() {} }
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 每个进程一份独立目录，且结束就删：不能用 '前缀 + process.pid' —— pid 会被系统复用，
// 上一次运行残留的 hot.jsonl / my-words.jsonl / build-out 会让这一轮的断言凭空失败
// （hot-reload 用例里 canonicalize('zz_hot_word').matched 就该是 false）。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prompt-forge-tags-test-'))
after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// DSH_TAGGER_DATA 被显式指定（CI、公开版、指到空目录做验收）时视作「隔离跑」：
// 这种环境下不该再去探测本机那套 Danbooru 全量库，否则同一份测试在两台机器上行为不同。
const isolated = String(process.env.DSH_TAGGER_DATA ?? '').trim() !== ''

/** 包内的 data/tags/*.jsonl（overlay 补词表）在本仓里实际有哪几个：判定复用加载器的 isOverlayJsonl，
 *  .example.jsonl 模板不算 overlay，否则「包里有几个文件」与「索引里加载了几个」两边就对不上。 */
function packageOverlayFiles() {
  const dir = path.join(repoRoot, 'data', 'tags')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => isOverlayJsonl(name)).map(name => path.join(dir, name))
}

// 真实数据索引：默认探测（DSH_DANBOORU_DIR / ~/.dsh-comfyui-workbench / 便携包快照 / 相邻 workbench），
// 本机没有全量库时 live 只剩 seed + overlay，真实词库用例自己 skip，不影响其它断言。
const live = createTagIndex({ dir: scratch, logger: silent, probeDefaults: !isolated })

/**
 * 真实词库用例的守卫：拿不到 Danbooru 全量库（公开版 / CI / 隔离跑）就主动 skip，
 * 返回 false 让调用方直接 return —— 缺库不是失败，是这台机器没有那份数据。
 */
async function needRealLib(t) {
  await live.ready()
  const stats = live.stats()
  if (isolated || stats.seedOnly === true || stats.general === 0) {
    t.skip('本机没有 Danbooru 词库')
    return false
  }
  return true
}

/** overlay 用例的守卫：公开版不带那份补词表就 skip。 */
async function needOverlay(t, fileName) {
  await live.ready()
  if (!live.stats().overlayFiles.some(file => file.endsWith(fileName))) {
    t.skip('本机没有包内词表 ' + fileName)
    return false
  }
  return true
}

test('构造是同步且便宜的：立刻有 seed 可用', () => {
  const stats = live.stats()
  assert.ok(stats.loaded > 100, 'seed 条数 ' + stats.loaded)
  assert.ok(live.search('初音未来', { limit: 3 }).length > 0)
})

test('parseTagString：(tag:1.2) / tag::0.8 / {{tag}} / ((tag)) / [tag] / 纯 tag', () => {
  const rows = live.parseTagString(
    '1girl, ((smile)), [blush], {{long_hair}}, (solo:1.3), long hair::0.8, fate\\(series\\)',
  )
  const byTag = new Map(rows.map(row => [row.tag, row.weight]))
  assert.equal(rows.length, 7)
  assert.equal(byTag.get('1girl'), 1)
  assert.equal(byTag.get('smile'), 1.21)
  assert.equal(byTag.get('blush'), 0.91)
  assert.equal(byTag.get('long_hair'), 1.1)
  assert.equal(byTag.get('solo'), 1.3)
  assert.equal(byTag.get('long hair'), 0.8)
  assert.equal(byTag.get('fate(series)'), 1)
})

test('parseTagString：括号里的逗号不切分', () => {
  const rows = live.parseTagString('(fate:1.2), solo')
  assert.deepEqual(rows, [{ tag: 'fate', weight: 1.2 }, { tag: 'solo', weight: 1 }])
})

test('parseTerm：16:9 是 tag，不是权重', () => {
  assert.deepEqual(parseTerm('16:9'), { tag: '16:9', weight: 1 })
  assert.deepEqual(parseTerm('  '), { tag: '', weight: 1 })
  assert.deepEqual(parseTerm('(smile:1.25)'), { tag: 'smile', weight: 1.25 })
})

test('formatTagString：comfy / a1111 / plain', () => {
  const list = [{ tag: 'smile', weight: 1.2 }, { tag: 'long_hair', weight: 1 }, { tag: 'blush', weight: 0.91 }]
  assert.equal(live.formatTagString(list, { syntax: 'comfy' }), '(smile:1.2), long_hair, (blush:0.91)')
  assert.equal(live.formatTagString(list, { syntax: 'a1111' }), '(smile:1.2), long_hair, (blush:0.91)')
  assert.equal(live.formatTagString(list, { syntax: 'plain' }), 'smile, long_hair, blush')
  assert.equal(live.formatTagString('smile, (long_hair:1.3)', { syntax: 'comfy' }), 'smile, (long_hair:1.3)')
  assert.equal(live.formatTagString([{ tag: 'fate_\\(series\\)', weight: 1 }]), 'fate_\\(series\\)')
})

test('toStandard：WD 下划线 / Camie 空格 / 括号转义', () => {
  assert.equal(live.toStandard('Long Hair', 'wd'), 'long_hair')
  assert.equal(live.toStandard('long_hair', 'camie'), 'long hair')
  assert.equal(live.toStandard('Fate (series)', 'wd'), 'fate_\\(series\\)')
  assert.equal(live.toStandard('Fate (series)', 'camie'), 'fate \\(series\\)')
  assert.equal(live.toStandard('', 'wd'), '')
  assert.equal(escapeParens('a(b)c'), 'a\\(b\\)c')
  assert.equal(unescapeTag('fate_\\(series\\)'), 'fate_(series)')
})

test('canonicalize：命中、大小写、中文名、权重、未命中原样保留', () => {
  const hit = live.canonicalize('1girl')
  assert.equal(hit.matched, true)
  assert.equal(hit.tag, '1girl')
  assert.equal(hit.kind, 'general')

  const upper = live.canonicalize('Long Hair')
  assert.equal(upper.matched, true)
  assert.equal(upper.tag, 'long_hair')

  const cn = live.canonicalize('初音未来')
  assert.equal(cn.matched, true)
  assert.equal(cn.tag, 'hatsune_miku')
  assert.equal(cn.kind, 'character')

  const weighted = live.canonicalize('((smile))')
  assert.equal(weighted.tag, 'smile')
  assert.equal(weighted.weight, 1.21)

  const camie = live.canonicalize('long_hair', { standards: ['camie'] })
  assert.equal(camie.tag, 'long hair')

  const miss = live.canonicalize('zzzz_not_a_real_tag_9999')
  assert.equal(miss.matched, false)
  assert.equal(miss.tag, 'zzzz_not_a_real_tag_9999')
  assert.equal(miss.kind, 'unknown')
  assert.ok(miss.note.length > 0)
})

test('canonicalizeMany：保留 raw 与逐条 matched', () => {
  const rows = live.canonicalizeMany(['1girl', 'zzzz_not_a_real_tag_9999'], { syntax: 'comfy' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].raw, '1girl')
  assert.equal(rows[0].matched, true)
  assert.equal(rows[1].matched, false)
  assert.equal(rows[1].tag, 'zzzz_not_a_real_tag_9999')
})

test('search：中文、别名、前缀、kinds 过滤', () => {
  const byCn = live.search('女孩', { limit: 10 })
  assert.ok(byCn.some(row => row.tag === '1girl'), JSON.stringify(byCn.slice(0, 3)))

  const miku = live.search('初音未来', { limit: 5 })
  assert.equal(miku[0].tag, 'hatsune_miku')
  assert.equal(miku[0].kind, 'character')
  assert.equal(miku[0].cn, '初音未来')

  const prefix = live.search('long_h', { limit: 10 })
  assert.ok(prefix.some(row => row.tag === 'long_hair'))

  const characters = live.search('', { limit: 5, kinds: 'character' })
  assert.equal(characters.length, 5)
  assert.ok(characters.every(row => row.kind === 'character'))
})

test('search：空查询按热度降序', () => {
  const rows = live.search('', { limit: 5 })
  assert.equal(rows.length, 5)
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].postCount >= rows[i].postCount, 'postCount 未降序')
  }
  assert.ok(rows[0].standards.includes('wd'))
})

test('真实数据：ready() 之后 general/character/copyright/artist 都有量', async t => {
  if (!(await needRealLib(t))) return
  const stats = live.stats()
  assert.equal(stats.ready, true)
  assert.ok(stats.general > 1000, 'general ' + stats.general)
  assert.ok(stats.character > 1000, 'character ' + stats.character)
  assert.ok(stats.copyright > 1000, 'copyright ' + stats.copyright)
  assert.ok(stats.artist > 1000, 'artist ' + stats.artist)
  assert.ok(stats.sourceFiles.length >= 3, JSON.stringify(stats.sourceFiles))
  assert.equal(stats.seedOnly, false)
  assert.equal(stats.loaded, stats.total)
  const miku = live.canonicalize('hatsune_miku')
  assert.equal(miku.matched, true)
  assert.ok(miku.cn.length > 0)
  const ba = live.canonicalize('blue archive')
  assert.equal(ba.matched, true)
  assert.equal(ba.kind, 'copyright')
})

test('无数据时用内置 seed 兜底（不探测默认路径）', async () => {
  const seedOnly = createTagIndex({
    dir: path.join(scratch, 'no-data'),
    probeDefaults: false,
    logger: silent,
  })
  await seedOnly.ready()
  const stats = seedOnly.stats()
  assert.equal(stats.seedOnly, true)
  assert.equal(stats.primaryFiles.length, 0)
  // 包内 overlay（data/tags/*.jsonl）永远叠加，所以 sourceFiles 非空但不算「有真实数据」
  // 包内 overlay 的数量应严格等于仓里 data/tags 实际有几个 jsonl（公开版可能一个都不带）
  assert.equal(stats.overlayFiles.length, packageOverlayFiles().length, JSON.stringify(stats.overlayFiles))
  assert.ok(stats.general > 100, 'seed general ' + stats.general)
  assert.ok(stats.character >= 20, 'seed character ' + stats.character)
  assert.equal(seedOnly.search('初音未来', { limit: 1 }).length, 1)
  assert.equal(seedOnly.canonicalize('甘雨').tag, 'ganyu_\\(genshin_impact\\)')

  await seedOnly.reload()
  assert.equal(seedOnly.stats().ready, true)
})

test('dataDirs 显式指定：读自己那份归一化数据', async () => {
  const dir = path.join(scratch, 'explicit')
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'characters.jsonl'),
    [JSON.stringify({ tag: 'test_char', kind: 'character', postCount: 123, names: ['测试角色'] }), ''].join('\n'),
    'utf8',
  )
  const index = createTagIndex({
    dir: path.join(scratch, 'explicit-plugin'),
    dataDirs: [dir],
    probeDefaults: false,
    logger: silent,
  })
  await index.ready()
  const stats = index.stats()
  assert.equal(stats.primaryFiles.length, 1)
  assert.equal(stats.seedOnly, false)
  assert.equal(index.canonicalize('测试角色').tag, 'test_char')
})

test('search：多词查询按命中词数优先，不被单个词的热度带偏', async () => {
  const dir = path.join(scratch, 'multi')
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
  // 用 zz_ 前缀的自造 tag，避免和内置 seed 撞名（seed 会一起进索引）。
  const records = [
    { tag: 'zz_long_hair_probe', kind: 'general', postCount: 3000000, names: ['zz长头发'] },
    { tag: 'zz_hair_probe', kind: 'general', postCount: 5000000, names: ['zz头发'] },
    { tag: 'zz_long_probe', kind: 'general', postCount: 4000000, names: ['zz长发'] },
  ]
  await fs.writeFile(
    path.join(dir, 'general.jsonl'),
    records.map(record => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  )
  const index = createTagIndex({
    dir: path.join(scratch, 'multi-plugin'),
    dataDirs: [dir],
    probeDefaults: false,
    logger: silent,
  })
  await index.ready()

  // 'zz' 命中三个，'long' 再加一个，'hair' 再加一个：zz_long_hair_probe 共 3 票排第一，
  // 而热度最高的 zz_hair_probe（5e6）票数少，只能排在后面。
  const byWords = index.search('zz long hair', { limit: 5 })
  assert.equal(byWords[0].tag, 'zz_long_hair_probe')
  assert.ok(byWords.some(row => row.tag === 'zz_hair_probe'), byWords.map(row => row.tag).join(','))

  // 中文逐词查同样合并且都留在结果里。
  const byChinese = index.search('zz长发 微笑', { limit: 10 }).map(row => row.tag)
  assert.ok(byChinese.includes('zz_long_probe'), 'zz_long_probe in ' + byChinese.join(','))
  assert.ok(byChinese.includes('smile'), 'smile in ' + byChinese.join(','))
})


test('overlay：<dataDir>/tags 的用户词表能被查到（不依赖真实库）', async () => {
  const dir = path.join(scratch, 'overlay-user')
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.join(dir, 'tags'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'tags', 'my-words.jsonl'),
    JSON.stringify({ tag: 'zz_custom_probe_tag', cn: 'zz自造词', kind: 'general', postCount: 12 }) + '\n',
    'utf8',
  )
  // probeDefaults:false：公开版没有 workbench 全量库，这条只验「用户词表会不会被读进来」
  const index = createTagIndex({ dir, probeDefaults: false, logger: silent })
  await index.ready()
  const stats = index.stats()
  assert.ok(
    stats.overlayFiles.some(file => file.endsWith('my-words.jsonl')),
    JSON.stringify(stats.overlayFiles),
  )
  const hit = index.canonicalize('zz自造词')
  assert.equal(hit.matched, true)
  assert.equal(hit.tag, 'zz_custom_probe_tag')
  assert.equal(hit.cn, 'zz自造词')
})

test('overlay：用户词表叠加进主流数据，不替换主流', async t => {
  const dir = path.join(scratch, 'overlay-user-main')
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.join(dir, 'tags'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'tags', 'my-words.jsonl'),
    JSON.stringify({ tag: 'zz_custom_probe_tag', cn: 'zz自造词', kind: 'general', postCount: 12 }) + '\n',
    'utf8',
  )
  const index = createTagIndex({ dir, probeDefaults: !isolated, logger: silent })
  await index.ready()
  const stats = index.stats()
  if (isolated || stats.seedOnly === true || stats.general === 0) {
    t.skip('本机没有 Danbooru 词库')
    return
  }
  assert.equal(stats.seedOnly, false, '主流 workbench 数据还在')
  assert.ok(stats.primaryFiles.length >= 3, JSON.stringify(stats.primaryFiles))
  assert.ok(stats.general > 1000, 'general ' + stats.general)
  assert.equal(index.canonicalize('zz自造词').tag, 'zz_custom_probe_tag')
})


test('构图/光线词 overlay：半身、全景、特写、逆光都命中且带中文', async t => {
  if (!(await needOverlay(t, 'scene-common.jsonl'))) return
  // light_rays / depth_of_field 这类是主流库里的词，没有全量库时这条也跳过
  if (!(await needRealLib(t))) return
  const want = ['medium_shot', 'full_shot', 'close-up', 'light_beam', 'backlighting', 'light_rays', 'depth_of_field']
  const missing = want.filter(tag => !live.canonicalize(tag).matched)
  assert.deepEqual(missing, [], '索引里没有这些构图词：' + missing.join(','))
  assert.equal(live.canonicalize('close_up').tag, 'close-up')
  assert.equal(live.canonicalize('backlight').tag, 'backlighting')
  assert.ok(live.canonicalize('medium_shot').cn.includes('中景'), live.canonicalize('medium_shot').cn)
})

test('ensureFresh：词表文件一改，下一次查就热重载，不用重启', async () => {
  const dir = path.join(scratch, 'hot-reload')
  const fs = await import('node:fs/promises')
  await fs.mkdir(path.join(dir, 'tags'), { recursive: true })
  const index = createTagIndex({ dir, logger: silent })
  await index.ready()
  assert.equal(index.ensureFresh !== undefined, true, 'createTagIndex 要暴露 ensureFresh')

  assert.equal(index.canonicalize('zz_hot_word').matched, false)
  // 没动文件：不该白重建
  assert.equal(await index.ensureFresh(), false)

  await fs.writeFile(
    path.join(dir, 'tags', 'hot.jsonl'),
    JSON.stringify({ tag: 'zz_hot_word', cn: 'hot热词', kind: 'general', postCount: 5 }) + '\n',
    'utf8',
  )
  assert.equal(await index.ensureFresh(), true, '新增文件应触发重载')
  const hit = index.canonicalize('zz_hot_word')
  assert.equal(hit.matched, true)
  assert.equal(hit.cn, 'hot热词')

  // 指纹稳定后再次调用不该反复重建
  assert.equal(await index.ensureFresh(), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 拆分后的结构：lib/tags.js 只做转发，实现分在 lib/tags/ 四个文件里。
// 这几条是「拆分没走样」的护栏：体积、单例、导出面、build-tags 统计。

test('拆分体积：lib/tags.js 是薄入口（< 8KB），子模块各自 < 30KB', () => {
  const entryFile = path.join(repoRoot, 'lib', 'tags.js')
  const entrySize = fs.statSync(entryFile).size
  assert.ok(entrySize > 0, 'lib/tags.js 不存在')
  assert.ok(entrySize < 8 * 1024, 'lib/tags.js 应只剩转发，实际 ' + entrySize + ' 字节')

  for (const name of ['text.js', 'loader.js', 'matcher.js', 'index.js']) {
    const file = path.join(repoRoot, 'lib', 'tags', name)
    const size = fs.statSync(file).size
    assert.ok(size > 0, file + ' 不存在')
    assert.ok(size < 30 * 1024, name + ' 超过 30KB：' + size)
  }
})

// matcher 拆分后的护栏：门面导出面与拆分前完全一致（4 个键），实现文件各自 < 30KB。
// 后续再拆子模块时，漏导出/多导出一个 key 都会在这里被拦住——外部契约只认这 4 个。
test('门面导出面快照：lib/tags/matcher.js 仍只出 4 个键，子模块各自 < 30KB', async () => {
  assert.deepEqual(Object.keys(matcherNs).sort(), ['createMatcher', 'parseTerm', 'splitTopLevel', 'wrapsWhole'])

  // 拆分前 lib/tags/matcher.js 是 25815 字节，现在只剩转发，必须明显更薄
  const facadeFile = path.join(repoRoot, 'lib', 'tags', 'matcher.js')
  const facadeSize = fs.statSync(facadeFile).size
  assert.ok(facadeSize > 0, 'lib/tags/matcher.js 不存在')
  assert.ok(facadeSize < 8 * 1024, 'lib/tags/matcher.js 应只剩转发，实际 ' + facadeSize + ' 字节')

  const matcherDir = path.join(repoRoot, 'lib', 'tags', 'matcher')
  const files = fs.readdirSync(matcherDir).filter(name => name.endsWith('.js')).sort()
  assert.deepEqual(files, ['exact.js', 'filter.js', 'format.js', 'index.js', 'parse.js', 'score.js'])
  for (const name of files) {
    const size = fs.statSync(path.join(matcherDir, name)).size
    assert.ok(size > 0, name + ' 是空文件')
    assert.ok(size < 30 * 1024, 'lib/tags/matcher/' + name + ' 超过 30KB：' + size)
  }

  // createMatcher 返回的方法一个都不能少：编排层重组时最容易漏掉某个方法名
  const stub = createTagIndex({ dir: path.join(scratch, 'facade'), probeDefaults: false, logger: silent })
  await stub.ready()
  assert.deepEqual(
    Object.keys(matcherNs.createMatcher({ tags: new Map(), byCount: [], lower: new Map(), lowerKeys: [], aliases: new Map() }, () => {})).sort(),
    [
      'canonicalize', 'canonicalizeMany', 'formatTagString', 'get', 'lookup', 'parseTagString',
      'runQuery', 'search', 'stats', 'suggest', 'suggestTags', 'toRow', 'toStandard',
    ],
  )
})

test('单例：同参数 createTagIndex 复用同一个实例，resetTagIndexCache 后重建', async () => {
  const dir = path.join(scratch, 'singleton')
  const first = createTagIndex({ dir, probeDefaults: false, logger: silent })
  const second = createTagIndex({ dir, probeDefaults: false, logger: silent })
  assert.equal(first, second, '同参数应复用实例，别把 99k 的索引建两份')

  // 参数不同就是另一份（dataDirs 变了意味着数据源变了）
  const other = createTagIndex({ dir, probeDefaults: false, dataDirs: [path.join(dir, 'nope')], logger: silent })
  assert.notEqual(first, other)

  resetTagIndexCache()
  const fresh = createTagIndex({ dir, probeDefaults: false, logger: silent })
  assert.notEqual(first, fresh, 'resetTagIndexCache 之后应新建')

  await first.ready()
  await fresh.ready()
  assert.equal(first.stats().loaded > 100, true)
  assert.equal(fresh.stats().ready, true)
})

test('导出面：老路径 lib/tags.js 的导出一个都不少（default 也是 createTagIndex）', () => {
  for (const name of [
    'createTagIndex', 'resetTagIndexCache', 'suggestTags',
    'discoverDataDir', 'loadTagEntries', 'pluginRoot', 'overlayDirs',
    'escapeParens', 'normalizeKind', 'primaryChineseName', 'unescapeTag', 'parseTerm',
  ]) {
    assert.equal(typeof tagsNs[name], 'function', '缺少导出 ' + name)
  }
  assert.equal(tagsEntry, tagsNs.createTagIndex, 'default 应是 createTagIndex')
  assert.equal(tagsNs.createTagIndex, createTagIndex)
})

test('build-tags：runNormalize 报告总条目 / 分类计数 / 重复 tag / 缺中文 / overlay 统计', async () => {
  const from = path.join(scratch, 'build-src')
  const out = path.join(scratch, 'build-out')
  fs.mkdirSync(from, { recursive: true })
  const rows = [
    { tag: 'zz_build_probe_a', kind: 'general', postCount: 10, names: ['zz探针甲'] },
    { tag: 'zz_build_probe_b', kind: 'general', postCount: 5 },
  ]
  fs.writeFileSync(path.join(from, 'general.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  // 同名再来一次（跨文件重复），并且这次带中文与更高热度
  fs.writeFileSync(
    path.join(from, 'general-extra.jsonl'),
    [
      JSON.stringify({ tag: 'zz_build_probe_a', kind: 'general', postCount: 30, cn: 'zz甲补名' }),
      JSON.stringify({ tag: 'zz_build_probe_artist', kind: 'artist', postCount: 7, names: ['zz画家'] }),
      '',
    ].join('\n'),
    'utf8',
  )

  const summary = await runNormalize({ from, out, quiet: true })
  assert.equal(summary.ok, true, summaryToText(summary))
  assert.equal(summary.destination, path.resolve(out))
  assert.equal(summary.total, 3, '重复 tag 合并后应是 3 条')
  assert.deepEqual(summary.byKind, { general: 2, character: 0, copyright: 0, artist: 1 })
  assert.deepEqual(summary.duplicates, { tags: 1, rows: 1 })
  assert.equal(summary.missingChinese, 1, 'zz_build_probe_b 没有中文名')
  assert.equal(summary.bad, 0)
  assert.equal(summary.sourceFiles.length, 2)

  // overlay 统计：数出来的文件数应等于仓里 data/tags 实际有几个 jsonl（公开版可能 0 个），
  // 「有词汇表」与「有文件」必须同时成立，不能靠单边断言糊过去
  const pkgOverlay = packageOverlayFiles()
  assert.equal(summary.overlay.files, pkgOverlay.length, JSON.stringify(summary.overlay))
  assert.equal(summary.overlay.tags > 0, pkgOverlay.length > 0, JSON.stringify(summary.overlay))
  assert.equal(summary.overlay.covered, 0, 'zz_ 开头的自造词不该被 overlay 认领')
  assert.equal(summary.overlay.missing, summary.overlay.tags)

  // 写出来的行按热度降序，重复记录只升不降
  const written = fs.readFileSync(path.join(out, 'general.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(written.map(row => row.tag), ['zz_build_probe_a', 'zz_build_probe_b'])
  assert.equal(written[0].postCount, 30)
  assert.ok(written[0].names.includes('zz探针甲'))
  assert.ok(written[0].names.includes('zz甲补名'))
  assert.ok(fs.existsSync(path.join(out, 'artists.jsonl')))
  assert.ok(fs.existsSync(path.join(out, 'meta.json')))

  // --json 输出能原样解析回来
  const parsed = JSON.parse(summaryToJson(summary))
  assert.equal(parsed.total, summary.total)
  assert.equal(parsed.duplicates.tags, 1)
  assert.ok(summaryToText(summary).includes('缺中文 1 条'))
})

test('.example.jsonl 只是模板：不加载，改它也不触发热重载', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'example-'))
  const overlay = path.join(dir, 'tags')
  fs.mkdirSync(overlay, { recursive: true })
  const real = path.join(overlay, 'my-words.jsonl')
  const example = path.join(overlay, 'adult-overlay.example.jsonl')
  fs.writeFileSync(real, JSON.stringify({ tag: 'zz_example_probe_real', kind: 'general', postCount: 10, cn: '真实词条' }) + '\n', 'utf8')
  fs.writeFileSync(example, JSON.stringify({ tag: 'zz_example_probe_ghost', kind: 'general', postCount: 99, cn: '模板词条' }) + '\n', 'utf8')

  const idx = createTagIndex({ dir, logger: silent, probeDefaults: false })
  await idx.ready()
  assert.equal(idx.canonicalize('zz_example_probe_real').matched, true)
  assert.equal(idx.canonicalize('zz_example_probe_ghost').matched, false, '模板文件里的词条不该进索引')
  assert.equal(
    idx.stats().overlayFiles.some(file => file.includes('.example.jsonl')),
    false,
    'overlayFiles 不能把模板文件算进去',
  )

  const sigBefore = overlaySignature(dir)
  // 只改模板：签名不该变，ensureFresh 也不该触发重载（mtime 变了，但它不在签名里）
  fs.writeFileSync(
    example,
    [
      JSON.stringify({ tag: 'zz_example_probe_ghost', kind: 'general', postCount: 99, cn: '模板词条' }),
      JSON.stringify({ tag: 'zz_example_probe_ghost2', kind: 'general', postCount: 98 }),
      '',
    ].join('\n'),
    'utf8',
  )
  assert.equal(overlaySignature(dir), sigBefore, '模板文件不参与签名')
  assert.equal(await idx.ensureFresh(), false, '只改模板不该触发重载')
  assert.equal(idx.canonicalize('zz_example_probe_ghost2').matched, false)

  // 改真词表：签名变、热重载触发、新词条立刻可用
  fs.appendFileSync(real, JSON.stringify({ tag: 'zz_example_probe_two', kind: 'general', postCount: 5 }) + '\n', 'utf8')
  assert.notEqual(overlaySignature(dir), sigBefore, '真词表变了签名必须变')
  assert.equal(await idx.ensureFresh(), true)
  assert.equal(idx.canonicalize('zz_example_probe_two').matched, true)
})

test('addRecord：类型从 general 升级到画师时格式标准跟着换', () => {
  const entries = new Map()
  addRecord(entries, { tag: 'zz_upgrade_probe', kind: 'general', postCount: 10 }, 'general')
  const entry = entries.get('zz_upgrade_probe')
  assert.equal(entry.kind, 'general')
  assert.deepEqual(entry.standards, standardsFor('general'))
  // 同一个 tag 后面又出现一次，这次标成画师：kind 升级，standards 必须同步收窄
  addRecord(entries, { tag: 'zz_upgrade_probe', kind: 'artist', postCount: 20 }, undefined)
  assert.equal(entry.kind, 'artist')
  assert.deepEqual(entry.standards, ['wd'], '画师只在 WD 体系里稳定存在')
  assert.equal(entry.postCount, 20, '热度只升不降')
  // 已经升级过的不许再被 general 记录降回去
  addRecord(entries, { tag: 'zz_upgrade_probe', kind: 'general', postCount: 30 }, 'general')
  assert.equal(entry.kind, 'artist')
  assert.deepEqual(entry.standards, ['wd'])
  assert.equal(entry.postCount, 30)

  // 一般类升级到角色类：标准与 general 相同，但 kind 要变
  addRecord(entries, { tag: 'zz_upgrade_probe_char', kind: 'character', postCount: 1 }, 'general')
  assert.equal(entries.get('zz_upgrade_probe_char').kind, 'character')
  assert.deepEqual(entries.get('zz_upgrade_probe_char').standards, standardsFor('character'))
})

test('addRecord：names 与 aliases 并存时两者都进 names', () => {
  const entries = new Map()
  addRecord(
    entries,
    { tag: 'zz_names_probe', kind: 'general', postCount: 1, names: ['zz甲名'], aliases: ['zz乙别名'], cn: 'zz中文名' },
    'general',
  )
  const entry = entries.get('zz_names_probe')
  assert.equal(entry.names.includes('zz甲名'), true, 'names 里的名字要收')
  assert.equal(entry.names.includes('zz乙别名'), true, 'aliases 不能因为 names 存在就被丢掉')
  assert.equal(entry.names.includes('zz中文名'), true)
  assert.deepEqual(entry.names, ['zz甲名', 'zz乙别名', 'zz中文名'])
})

