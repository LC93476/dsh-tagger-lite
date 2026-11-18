/**
 * tests/postprocess.test.mjs — lib/postprocess.js 的行为测试。
 *
 * 跑法（本机没有 node 命令，用 Electron 当 node）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/postprocess.test.mjs
 *
 * 覆盖：tag 规范化 / 13 段归类 / 真同义去重 / 上位词降权不删 / 降权幂等 / 词序（服装先于镜头）/
 * 补人数（只补 1girl、1boy）/ 人数词存在与多人白话一律不补 / 男性线索与「吉他、其他」误判 /
 * 超上限裁剪 / 未命中词丢弃 / 脏输入不崩 / 与真库对齐（保留下来的都是 matched 真词）/
 * 拆分后的结构约束：门面导出面不变、规则层与门面共享同一份常量（task-17）。
 * 无外部依赖：node:test + node:assert + 真库索引。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createTagIndex } from '../lib/tags.js'
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
const scratch = path.join(os.tmpdir(), 'dsh-prompt-postprocess-test-' + process.pid)
// lib/tags 的 createTagIndex JSDoc 还没列 dir/logger（task-19 的活），这里局部收口
const live = createTagIndex(/** @type {any} */ ({ dir: scratch, logger: silent }))
const pp = createPostProcessor({})

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

test('classifyBucket：13 段的代表词各回各家，没见过的落 other', () => {
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
  assert.equal(classifyBucket('best_quality'), 'other')
  assert.equal(classifyBucket('完全没见过的词'), 'other')
  // 桶表顺序即词序：主体在最前，画质在最后
  assert.equal(BUCKET_INDEX.subject, 0)
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

test('词序：镜头词即使权重更高也排在服装词后面，同段保持原顺序', () => {
  const out = pp.apply([
    { tag: 'close-up', weight: 1.4 },
    { tag: 'school_uniform', weight: 1.1 },
    { tag: 'from_side', weight: 1.0 },
  ])
  assert.deepEqual(tagsOf(out.rows), ['school_uniform', 'close-up', 'from_side'])
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

test('超上限按段优先裁剪：画质词与末尾场景先掉，主体与服装留下', () => {
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
  assert.ok(!kept.includes('best_quality'), '画质词先被裁掉')
  assert.ok(!kept.includes('night'), '末尾段先被裁掉')
  const trims = out.changes.filter(function (item) { return item.kind === 'trim' })
  assert.equal(trims.length, 4)
  assert.ok(trims.every(function (item) { return item.reason === 'over-limit' }))
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

test('与真库对齐：收拾完留下来的每一个词都是库里 matched 的真词', async () => {
  await live.ready()
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
  assert.deepEqual(missing, [], '规则表里出现了库里没有的词：' + missing.join(', '))

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
  assert.equal(rulesNamespace.BUCKETS.length, 13)
  // COUNT_RE / FEMALE_RE / MALE_RE 仍是内部实现，门面不该导出
  assert.equal(Object.keys(ppNamespace).includes('COUNT_RE'), false)
  assert.equal(Object.keys(ppNamespace).includes('FEMALE_RE'), false)
  assert.equal(Object.keys(ppNamespace).includes('MALE_RE'), false)
})
