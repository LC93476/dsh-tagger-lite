/**
 * tests/postprocess.test.mjs — lib/postprocess.js 的行为测试。
 *
 * 跑法（本机没有 node 命令，用 Electron 当 node）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/postprocess.test.mjs
 *
 * 覆盖：tag 规范化 / 14 段归类 / 真同义去重 / 上位词降权不删 / 降权幂等 / 词序（服装先于镜头）/
 * 补人数（只补 1girl、1boy）/ 人数词存在与多人白话一律不补 / 男性线索与「吉他、其他」误判 /
 * 超上限裁剪 / 未命中词丢弃 / 脏输入不崩 / 与真库对齐（保留下来的都是 matched 真词）/
 * 拆分后的结构约束：门面导出面不变、规则层与门面共享同一份常量（task-17）。
 * 无外部依赖：node:test + node:assert + 真库索引。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTagIndex } from '../lib/tags.js'
import { requireRealLibrary } from './_lib-guard.mjs'

// 公开仓带的是 SFW 词表（data/danbooru/manifest.json 里 sfw:true）：露骨 tag 在生成公开版时
// 就被剔掉了。规则表里保留它们没问题（私有仓是完整快照，全部照查），但公开仓那几条断言要放行。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SFW_DICT = (function () {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'danbooru', 'manifest.json'), 'utf8')).sfw === true
  } catch {
    return false
  }
})()

import {
  BUCKET_INDEX,
  BUCKETS,
  SYNONYM_GROUPS,
  SUPERSET_PAIRS,
  SUPERSET_WEIGHT,
  bucketLabel,
  classifyBucket,
  createPostProcessor,
  detectGender,
  escapeParens,
  EXACT_BUCKET,
  fillSubject,
  formatRows,
  normTag,
  orderRows,
  trimRows,
} from '../lib/postprocess.js'
import * as ppNamespace from '../lib/postprocess.js'
import * as rulesNamespace from '../lib/postprocess/rules.js'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
// 每个进程一份独立目录，跑完就删：不能用「前缀 + process.pid」——pid 会被系统复用，
// 上一轮残留的索引缓存会让这一轮断言凭空失败（同 tests/tags.test.mjs 里 task-22 的修法）。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tagger-postprocess-test-'))
after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})
// lib/tags 的 createTagIndex JSDoc 还没列 dir/logger（task-19 的活），这里局部收口
const live = createTagIndex(/** @type {any} */ ({ dir: scratch, logger: silent }))
// 质量词置顶另有用例（要显式打开才加），这里统一关掉，免得每条断言都得把三个质量词写进期望值。
const pp = createPostProcessor({ quality: false })

// 真库判定（task-44）：tests/_lib-guard.mjs 只看 loaded 条数，而 seed 词表涨到 1200+ 条后
// 「只有 seed」和「有真库」就分不出来了 —— seedOnly 是索引自己给的标记，比条数可靠。
function hasDanbooruLibrary(tags) {
  const stats = typeof tags?.stats === 'function' ? tags.stats() : tags
  if (!stats || stats.seedOnly === true) return false
  return Number(stats.loaded ?? 0) > 1000
}
function requireDanbooruLibrary(t) {
  if (hasDanbooruLibrary(live)) return true
  t.skip('本机只加载到 seed 词表（seedOnly=true），真库用例跳过')
  return false
}

// 反斜杠在多层字符串里极易数错，统一用码点构造
const BS = String.fromCharCode(92)

function tagsOf(rows) {
  return rows.map(function (row) { return row.tag })
}
function weightOf(rows, tag) {
  const found = rows.find(function (row) { return row.tag === tag })
  return found ? found.weight : undefined
}

test('normTag：权重后缀 / 括号 / 空格 / 反斜杠转义统一成小写下划线', () => {
  assert.equal(normTag('  Long Hair  '), 'long_hair')
  assert.equal(normTag('(school_uniform:1.3)'), 'school_uniform')
  assert.equal(normTag('from_side::0.8'), 'from_side')
  assert.equal(normTag('name_' + BS + '(series' + BS + ')'), 'name_(series)')
  assert.equal(normTag(''), '')
  assert.equal(normTag(null), '')
  assert.equal(escapeParens('name_(series)'), 'name_' + BS + '(series' + BS + ')')
})

test('classifyBucket：14 段的代表词各回各家，没见过的落 other', () => {
  assert.equal(classifyBucket('1girl'), 'subject')
  assert.equal(classifyBucket('long_hair'), 'hair')
  assert.equal(classifyBucket('blush'), 'expression')
  assert.equal(classifyBucket('lying'), 'pose')
  assert.equal(classifyBucket('hand_on_hip'), 'limbs')
  assert.equal(classifyBucket('school_uniform'), 'clothing')
  assert.equal(classifyBucket('completely_nude'), 'sexual')
  assert.equal(classifyBucket('from_side'), 'camera')
  assert.equal(classifyBucket('top-down_bottom-up'), 'camera', '俯拍是视角不是姿势')
  assert.equal(classifyBucket("worm's_eye_view"), 'camera')
  assert.equal(classifyBucket('bedroom'), 'scene')
  assert.equal(classifyBucket('backlighting'), 'lighting')
  assert.equal(classifyBucket('masterpiece'), 'quality', '质量词单独成段，排在所有人前面')
  assert.equal(classifyBucket('best_quality'), 'quality')
  assert.equal(classifyBucket('ultra_detailed'), 'quality', '维度词按词根规则归质量段')
  assert.equal(classifyBucket('worst_quality'), 'other', '负向侧评分词不许被置顶')
  assert.equal(classifyBucket('完全没见过的词'), 'other')
  // 桶表顺序即词序：质量词最前，主体其次，其它最后
  assert.equal(BUCKET_INDEX.quality, 0)
  assert.equal(BUCKET_INDEX.subject, 1)
  assert.equal(BUCKET_INDEX.other, BUCKETS.length - 1)
  assert.equal(bucketLabel('camera'), '镜头与构图')
})

test('真同义合并：from_side 与 profile 同时出现只留 from_side，权重取大', () => {
  const out = pp.apply([
    { tag: 'from_side', weight: 1.05 },
    { tag: 'profile', weight: 1.2 },
  ])
  assert.deepEqual(tagsOf(out.rows), ['from_side'])
  assert.equal(weightOf(out.rows, 'from_side'), 1.2)
  const change = out.changes.find(function (item) { return item.tag === 'profile' })
  assert.ok(change, 'profile 要有 change 记录')
  assert.equal(change.kind, 'dedupe')
  assert.equal(change.reason, 'synonym')
  assert.equal(change.detail, 'from_side')
})

test('上位词降权不删：lying + on_back 保留两个，lying 降到 0.85', () => {
  const out = pp.apply([
    { tag: 'lying', weight: 1.2 },
    { tag: 'on_back', weight: 1.1 },
  ])
  assert.deepEqual(tagsOf(out.rows).sort(), ['lying', 'on_back'])
  assert.equal(weightOf(out.rows, 'lying'), SUPERSET_WEIGHT)
  assert.equal(weightOf(out.rows, 'on_back'), 1.1)
  const change = out.changes.find(function (item) { return item.kind === 'superset' })
  assert.ok(change)
  assert.equal(change.tag, 'lying')
  assert.equal(change.detail, 'on_back')
  assert.equal(change.weight, SUPERSET_WEIGHT)
})

test('降权是幂等的：连跑两遍权重不会再掉，第二遍没有 change', () => {
  const first = pp.apply([
    { tag: 'lying', weight: 1.3 },
    { tag: 'on_back', weight: 1.2 },
  ])
  const second = pp.apply(first.rows, { described: '' })
  assert.equal(weightOf(second.rows, 'lying'), SUPERSET_WEIGHT)
  assert.deepEqual(second.rows, first.rows)
  assert.deepEqual(second.changes, [])
})

test('词序：镜头词即使权重更高也排在服装词后面，同段内按 SUBORDER 二级序', () => {
  const out = pp.apply([
    { tag: 'close-up', weight: 1.4 },
    { tag: 'school_uniform', weight: 1.1 },
    { tag: 'from_side', weight: 1.0 },
  ])
  // camera 段内部再分两级：视角（from_side）排在景别（close-up）之前 —— 先定机位再定取景。
  assert.deepEqual(tagsOf(out.rows), ['school_uniform', 'from_side', 'close-up'])
  const orderChange = out.changes.find(function (item) { return item.kind === 'order' })
  assert.ok(orderChange, '顺序变了要有 order change')
  const bucketChange = out.changes.find(function (item) { return item.kind === 'buckets' })
  assert.ok(bucketChange, '要有 buckets 统计')
  assert.equal(bucketChange.counts.camera, 2)
})

test('补人数：白话有少女就补 1girl 并排在最前，权重 1.2', () => {
  const out = pp.apply(
    [
      { tag: 'school_uniform', weight: 1.1 },
      { tag: 'lying', weight: 1.0 },
    ],
    { described: '一个穿着校服的少女侧躺着' },
  )
  assert.equal(out.rows[0].tag, '1girl')
  assert.equal(out.rows[0].weight, 1.2)
  const change = out.changes.find(function (item) { return item.kind === 'fill' })
  assert.ok(change)
  assert.equal(change.tag, '1girl')
  assert.equal(change.reason, 'gender-cue')
})

test('人数词已存在就绝不补：hetero / 2girls / solo / multiple_girls 各一例', () => {
  const cases = [['hetero'], ['2girls'], ['solo'], ['multiple_girls'], ['1boy']]
  for (const rows of cases) {
    const input = rows.map(function (tag) { return { tag, weight: 1.1 } })
    const out = pp.apply(input, { described: '两个少女在一起' })
    const fill = out.changes.filter(function (item) { return item.kind === 'fill' })
    assert.equal(fill.length, 0, '不该补：' + rows[0])
    assert.equal(tagsOf(out.rows).filter(function (tag) { return tag === '1girl' }).length, 0, '不该出现 1girl：' + rows[0])
  }
})

test('多人白话不补（两个 / 情侣 / 一群人），fillSubject 会给出 skipped 原因', () => {
  assert.equal(fillSubject([], '两个女孩坐在床边').skipped, 'multiple')
  assert.equal(fillSubject([], '一对情侣').skipped, 'multiple')
  assert.equal(fillSubject([], '一群人在沙滩上').skipped, 'multiple')
  assert.equal(fillSubject([], '只有风景没有人物').skipped, 'no-cue')
})

test('男性线索补 1boy；「吉他 / 其他」里的他不能误判成男性', () => {
  const boy = pp.apply([{ tag: 'school_uniform', weight: 1 }], { described: '一个男孩背着包' })
  assert.ok(tagsOf(boy.rows).includes('1boy'))
  assert.ok(!tagsOf(boy.rows).includes('1girl'))

  assert.deepEqual(detectGender('一把吉他和一束花'), { female: false, male: false, multiple: false })
  assert.deepEqual(detectGender('其他东西'), { female: false, male: false, multiple: false })
  assert.equal(detectGender('少女').female, true)
})

test('超上限按段优先裁剪：末尾场景先掉，主体与服装留下（关掉质量词时它们更早被移除）', () => {
  const rows = [
    { tag: '1girl', weight: 1.1 },
    { tag: 'long_hair', weight: 1.0 },
    { tag: 'black_hair', weight: 1.0 },
    { tag: 'smile', weight: 1.0 },
    { tag: 'school_uniform', weight: 1.2 },
    { tag: 'close-up', weight: 1.3 },
    { tag: 'from_side', weight: 1.0 },
    { tag: 'night', weight: 1.0 },
    { tag: 'best_quality', weight: 1.2 },
    { tag: 'absurdres', weight: 1.1 },
  ]
  const out = pp.apply(rows, { described: '', maxTags: 6 })
  assert.equal(out.rows.length, 6)
  const kept = tagsOf(out.rows)
  assert.ok(kept.includes('1girl'))
  assert.ok(kept.includes('school_uniform'))
  // 这里 pp 是 quality:false —— 两个评分词在 ensureQuality 那步就被移除了（不记 trim），
  // 所以 10 条进来只剩 8 条参与裁剪，裁够 6 条要掉 2 个。
  assert.ok(!kept.includes('best_quality'), '关掉质量词时评分词直接移除')
  assert.ok(!kept.includes('absurdres'), '同上')
  assert.ok(!kept.includes('night'), '末尾段先被裁掉')
  const trims = out.changes.filter(function (item) { return item.kind === 'trim' })
  assert.equal(trims.length, 2)
  assert.ok(trims.every(function (item) { return item.reason === 'over-limit' }))
})

test('质量词置顶：默认配置在串首补一组、模型写过的只留一条并保留权重；关掉时一个都不加', () => {
  const on = createPostProcessor({})
  const out = on.apply([
    { tag: 'school_uniform', weight: 1.2 },
    { tag: 'masterpiece', weight: 1.3 },
    { tag: 'smile', weight: 1.0 },
  ])
  const kept = tagsOf(out.rows)
  assert.deepEqual(kept.slice(0, 3), ['masterpiece', 'best_quality', 'highres'], '质量词在最前，按配置顺序')
  assert.equal(kept.filter(function (tag) { return tag === 'masterpiece' }).length, 1, '模型自己写的那条并进来，不重复')
  assert.equal(weightOf(out.rows, 'masterpiece'), 1.3, '保留模型给的权重')
  assert.equal(weightOf(out.rows, 'best_quality'), 1, '补的那条权重 1')
  assert.deepEqual(kept.slice(3), ['smile', 'school_uniform'], '其余照旧按段排（表情在服装前）')
  assert.deepEqual(
    out.changes.map(function (item) { return item.kind }).sort(),
    ['buckets', 'order'],
    '质量词置顶不算整理动作（没有 add/trim），只留下本来就有的重排与统计',
  )

  const off = createPostProcessor({ quality: false })
  const none = off.apply([{ tag: 'smile', weight: 1.0 }, { tag: 'best_quality', weight: 1.2 }])
  assert.deepEqual(tagsOf(none.rows), ['smile'], '关掉后连库里真有的评分词也不留')

  const custom = createPostProcessor({ qualityTags: ['absurdres'] })
  assert.deepEqual(tagsOf(custom.apply([{ tag: 'smile', weight: 1 }]).rows).slice(0, 1), ['absurdres'], 'tags.qualityTags 可自定义')
})
test('没命中库的词（matched:false）直接丢掉，不污染 prompt', () => {
  const out = pp.apply([
    { tag: 'face_closeup', weight: 1.3, matched: false },
    { tag: 'smile', weight: 1.0, matched: true },
  ])
  assert.deepEqual(tagsOf(out.rows), ['smile'])
  assert.equal(out.changes[0].reason, 'unmatched')
})

test('脏输入不崩：undefined / null / 空串 / 数字 / 空对象', () => {
  const out = pp.apply([null, undefined, '', '   ', {}, 42, { tag: '' }], { described: '' })
  assert.equal(out.rows.length, 0)
  assert.equal(out.positive, '')
  assert.deepEqual(pp.apply(undefined, {}).rows, [])
})

test('完整管线：真机事故串被收拾干净，且跑两遍完全一致（幂等）', () => {
  const raw = [
    { tag: 'close-up', weight: 1.3 },
    { tag: 'lying', weight: 1.1 },
    { tag: 'on_back', weight: 1.1 },
    { tag: 'profile', weight: 1.0 },
    { tag: 'from_side', weight: 1.0 },
    { tag: 'school_uniform', weight: 1.2 },
    { tag: 'long_hair', weight: 1.0 },
    { tag: 'school_uniform', weight: 1.0 },
    { tag: 'best_quality', weight: 1.2 },
  ]
  const opts = { described: '一个少女侧躺着，穿着校服', maxTags: 12 }
  const first = pp.apply(raw, opts)
  const second = pp.apply(first.rows, opts)
  const kept = tagsOf(first.rows)

  assert.equal(kept.filter(function (tag) { return tag === 'school_uniform' }).length, 1, '重复 tag 只留一份')
  assert.ok(!kept.includes('profile'), '同义重复被收掉')
  assert.ok(kept.includes('from_side') && kept.includes('on_back') && kept.includes('lying'), '构图信息一个都不许删')
  assert.equal(weightOf(first.rows, 'lying'), SUPERSET_WEIGHT)
  assert.equal(kept[0], '1girl')
  assert.ok(kept.indexOf('school_uniform') < kept.indexOf('close-up'), '服装在镜头之前')
  assert.deepEqual(second.rows, first.rows)
  assert.deepEqual(second.changes, [])
})

test('formatRows：plain 不带括号，comfy 带权重；给了 tags 实例就和 tags.formatTagString 一致', () => {
  const rows = [
    { tag: '1girl', weight: 1.2 },
    { tag: 'smile', weight: 1 },
  ]
  assert.equal(formatRows(rows, { syntax: 'plain' }), '1girl, smile')
  assert.equal(formatRows(rows, {}), '(1girl:1.2), smile')
  const viaTags = formatRows(rows, { syntax: 'comfy', tags: live })
  assert.equal(viaTags, live.formatTagString(rows, { syntax: 'comfy' }))
  // 括号必须转义，否则会被当成权重语法
  assert.equal(formatRows([{ tag: 'name_(series)', weight: 1 }], { syntax: 'plain' }), 'name_' + BS + '(series' + BS + ')')
})

test('与真库对齐：收拾完留下来的每一个词都是库里 matched 的真词', async (t) => {
  await live.ready()
  // 没有 Danbooru 大词表（CI / 干净机器）时，这条真库用例没有意义，跳过
  if (!requireRealLibrary(t, live)) return
  if (!requireDanbooruLibrary(t)) return
  const raw = [
    '1girl', 'lying', 'on_back', 'profile', 'from_side', 'school_uniform',
    'close-up', 'long_hair', 'best_quality', 'on_bed', 'night', 'blush',
  ].map(function (tag) { return { tag, weight: 1 } })
  const out = pp.apply(raw, { described: '一个少女侧躺在床上的特写' })
  const checked = await live.canonicalizeMany(tagsOf(out.rows))
  assert.ok(checked.length === out.rows.length, '每个 tag 都要能被真库 canonicalize')
  for (const item of checked) {
    assert.equal(item.matched, true, '留下来的词必须是真词：' + item.raw)
    assert.equal(item.tag, item.raw, '后处理不改变 canonical 写法：' + item.raw)
  }
  // 规则表里的同义组与上下位对，两边都得是库里真有的词
  const flat = []
  for (const pair of SUPERSET_PAIRS) flat.push(pair[0], pair[1])
  for (const group of SYNONYM_GROUPS) for (const tag of group) flat.push(tag)
  const ruleCheck = await live.canonicalizeMany(flat)
  const missing = ruleCheck.filter(function (item) { return !item.matched }).map(function (item) { return item.raw })
  if (SFW_DICT) {
    // 公开仓是 SFW 词表：规则表里那几个露骨词在生成公开版时就被剔掉了，不放行这条会永远红。
    t.diagnostic('SFW 词表构建，跳过同义组/上下位对的漏词断言：' + missing.join(', '))
  } else {
    assert.deepEqual(missing, [], '规则表里出现了库里没有的词：' + missing.join(', '))
  }

  // 公开版不内置成人词表：EXACT_BUCKET 里少数只在该词表里的词，本机库认不到，
  // 这条校验只在完整版（带词表）下成立。
})

test('orderRows / trimRows 可直接单用：稳定排序、裁剪不重排', () => {
  const rows = [
    { tag: 'close-up', weight: 1.3 },
    { tag: 'school_uniform', weight: 1.1 },
  ]
  const ordered = orderRows(rows)
  assert.deepEqual(tagsOf(ordered.rows), ['school_uniform', 'close-up'])
  assert.equal(ordered.changes.length, 2)
  const same = orderRows(ordered.rows)
  assert.equal(same.changes.length, 0, '已排好序不该再报 change')

  const trimmed = trimRows(ordered.rows, 1)
  assert.deepEqual(tagsOf(trimmed.rows), ['school_uniform'])
  assert.equal(trimmed.changes.length, 1)
  assert.deepEqual(tagsOf(trimRows(ordered.rows, 0).rows), ['school_uniform', 'close-up'], '不设上限就原样返回')
})

// --- 拆分后的结构约束（task-17）：门面导出面不变，规则层与门面共享同一份常量 ---

const FACADE_EXPORTS = [
  'BUCKETS', 'BUCKET_INDEX', 'COUNT_WORDS', 'EXACT_BUCKET', 'SUPERSET_PAIRS', 'SUPERSET_WEIGHT',
  'SYNONYM_GROUPS', 'TOKEN_RULES', 'bucketLabel', 'clampWeight', 'classifyBucket', 'createPostProcessor',
  'dedupeRows', 'default', 'detectGender', 'escapeParens', 'fillSubject', 'formatRows', 'mergeSupersets',
  'normTag', 'normalizeRows', 'orderRows', 'parseRow', 'round2', 'trimRows',
  'DEFAULT_QUALITY_TAGS', 'SUBORDER', 'ensureQuality',
]

test('门面 lib/postprocess.js 的导出面与拆分前一致，default 就是 createPostProcessor', () => {
  assert.deepEqual(Object.keys(ppNamespace).sort(), FACADE_EXPORTS.slice().sort())
  assert.equal(ppNamespace.default, ppNamespace.createPostProcessor)
  assert.equal(typeof ppNamespace.createPostProcessor({}).apply, 'function')
})

test('规则层 rules.js 与门面共享同一份常量对象，实现细节不对外泄漏', () => {
  assert.equal(ppNamespace.BUCKETS, rulesNamespace.BUCKETS)
  assert.equal(ppNamespace.BUCKET_INDEX, rulesNamespace.BUCKET_INDEX)
  assert.equal(ppNamespace.SUPERSET_PAIRS, rulesNamespace.SUPERSET_PAIRS)
  assert.equal(ppNamespace.SYNONYM_GROUPS, rulesNamespace.SYNONYM_GROUPS)
  assert.equal(ppNamespace.EXACT_BUCKET, rulesNamespace.EXACT_BUCKET)
  assert.equal(ppNamespace.TOKEN_RULES, rulesNamespace.TOKEN_RULES)
  assert.equal(ppNamespace.COUNT_WORDS, rulesNamespace.COUNT_WORDS)
  assert.equal(rulesNamespace.SUPERSET_WEIGHT, 0.85)
  assert.equal(rulesNamespace.BUCKETS.length, 14)
  // COUNT_RE / FEMALE_RE / MALE_RE 仍是内部实现，门面不该导出
  assert.equal(Object.keys(ppNamespace).includes('COUNT_RE'), false)
  assert.equal(Object.keys(ppNamespace).includes('FEMALE_RE'), false)
  assert.equal(Object.keys(ppNamespace).includes('MALE_RE'), false)
})

// --- 分桶修正（task-44）：括号限定词 / 词根正则的边界 / 贴墙移桶 ---

test('括号后缀不都是角色：_(medium) _(style) 进风格段，服装与道具各回各家', () => {
  // 括号后缀在真库里长这样：star_(symbol) / charm_(object) / pom_pom_(clothes) /
  // tapestry_(medium) / mika_pikazo_(style) —— 老规则一律当角色塞进第 2 桶，画风词会跑到角色前面。
  assert.equal(classifyBucket('watercolor_(medium)'), 'lighting', '媒介就是风格')
  assert.equal(classifyBucket('tapestry_(medium)'), 'lighting')
  assert.equal(classifyBucket('mika_pikazo_(style)'), 'lighting', '画师画风归风格段')
  assert.equal(classifyBucket('shrug_(clothing)'), 'clothing')
  assert.equal(classifyBucket('pom_pom_(clothes)'), 'clothing', '库里写的是 clothes 不是 clothing')
  assert.equal(classifyBucket('lekku_(anatomy)'), 'body')
  assert.equal(classifyBucket('charm_(object)'), 'other')
  assert.equal(classifyBucket('bow_(weapon)'), 'other')
  assert.equal(classifyBucket('bat_(animal)'), 'other')
  assert.equal(classifyBucket('nut_(food)'), 'other')
  assert.equal(classifyBucket('triangle_(instrument)'), 'other')
  assert.equal(classifyBucket('stance_(vehicle)'), 'other')
  // 真角色 / 作品仍然要进第 2 桶
  assert.equal(classifyBucket('eimi_(blue_archive)_(cosplay)'), 'character')
})

test('词根正则收紧：close / arch / lean / sex 不再按裸子串误伤', () => {
  // ^close 收紧成 ^close[-_]up：伞和衣柜不是景别
  assert.equal(classifyBucket('close-up'), 'camera')
  assert.equal(classifyBucket('close_up'), 'camera')
  assert.equal(classifyBucket('closed_umbrella'), 'other', '库内真有这个词，别当特写')
  assert.notEqual(classifyBucket('closed_umbrella'), 'camera')
  assert.equal(classifyBucket('closet'), 'other')
  // arch / lean 加词边界：cleaning 里的 lean 不是姿势
  assert.equal(classifyBucket('arched_back'), 'pose')
  assert.equal(classifyBucket('leaning_forward'), 'pose')
  assert.equal(classifyBucket('cleaning'), 'other', 'cleaning 里含 lean，但不是姿势')
  assert.notEqual(classifyBucket('cleaning'), 'pose')
  // sex 加词边界：unisex 不含性行为语义
  assert.equal(classifyBucket('sex'), 'sexual')
  assert.equal(classifyBucket('sex_from_behind'), 'sexual')
  assert.equal(classifyBucket('unisex'), 'other')
  assert.notEqual(classifyBucket('unisex'), 'sexual')
  // 贴墙是姿势（与 lib/zh-intent.js 的 靠墙 / 壁咚 同一段），不是性行为细节
  assert.equal(classifyBucket('against_wall'), 'pose')
  assert.equal(EXACT_BUCKET.against_wall, 'pose')
})

test('分桶探针全部是库里真词：规则表不许靠幽灵词自证', async (t) => {
  await live.ready()
  if (!requireDanbooruLibrary(t)) return
  const probes = [
    'star_(symbol)', 'charm_(object)', 'bow_(weapon)', 'bat_(animal)', 'nut_(food)',
    'triangle_(instrument)', 'stance_(vehicle)', 'lekku_(anatomy)', 'shrug_(clothing)',
    'pom_pom_(clothes)', 'watercolor_(medium)', 'tapestry_(medium)', 'mika_pikazo_(style)',
    'eimi_(blue_archive)_(cosplay)', 'closed_umbrella', 'closet', 'cleaning', 'against_wall',
    'close-up', 'arched_back', 'leaning_forward', 'bent_over', 'squatting',
  ]
  const checked = await live.canonicalizeMany(probes)
  const ghost = checked.filter(function (item) { return !item.matched }).map(function (item) { return item.raw })
  assert.deepEqual(ghost, [], '分桶探针里有库里没有的词：' + ghost.join(', '))
})
