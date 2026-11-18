/**
 * tests/repair.test.mjs — lib/repair.js 的行为测试（真实标签库）。
 *
 * 跑法（本机没有 node 命令）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 \
 *     "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" tests/repair.test.mjs
 *
 * 覆盖：连字符↔下划线、撇号归一、空白归一、单复数、词序、近邻兜底；
 * 只动 matched=false、严格不改命中行、修不上原样保留并给 warning、
 * 幂等（跑两次 fixes 为空）、limit 上限、入参不被改写、修完的 tag 一定在库里。
 * 无外部依赖：node:test + node:assert。
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRepairer } from '../lib/repair.js'
import { createTagIndex, suggestTags as modSuggest } from '../lib/tags.js'

const silent = { info() {}, warn() {}, error() {} }
const scratch = path.join(os.tmpdir(), 'dsh-prompt-forge-repair-test-' + process.pid)

// lib/tags 的 createTagIndex JSDoc 还没列 dir/logger（task-19 的活），这里局部收口
const tags = createTagIndex(/** @type {any} */ ({ dir: scratch, logger: silent }))
// 等真实库加载完再测：未 ready 时只有种子数据，get() 会漏（top-down_bottom-up 就查不到）。
await tags.ready()
const repairer = createRepairer({ tags, logger: silent })

/** 用真实 canonicalizeMany 造行，保证和 forge 里的形状一致。 */
function rowsOf(list) {
  return tags.canonicalizeMany(list)
}

test('连字符↔下划线：top-down_bottom_up 修成库里的 top-down_bottom-up', async () => {
  const rows = rowsOf(['top-down_bottom_up'])
  assert.equal(rows[0].matched, false, '前置条件：原词未收录')
  const out = await repairer.fix(rows)
  assert.equal(out.rows[0].tag, 'top-down_bottom-up')
  assert.equal(out.rows[0].matched, true)
  assert.equal(out.fixes.length, 1)
  assert.equal(out.fixes[0].how, 'hyphen')
  assert.ok(out.rows[0].cn, '修复后应带中文')
})

test("撇号 + 连字符：worm's-eye_view 修成库里的 worm's_eye_view", async () => {
  const rows = rowsOf(["worm's-eye_view"])
  assert.equal(rows[0].matched, false)
  const out = await repairer.fix(rows)
  assert.equal(out.rows[0].tag, "worm's_eye_view")
  assert.ok(['hyphen', 'apostrophe'].includes(out.fixes[0].how))
  assert.equal(out.warnings.length, 0)
})

test('近邻兜底：one_leg_up 落到 leg_up，不是 legs_up', async () => {
  const rows = rowsOf(['one_leg_up'])
  assert.equal(rows[0].matched, false)
  const out = await repairer.fix(rows)
  assert.equal(out.rows[0].tag, 'leg_up')
  assert.equal(out.fixes[0].how, 'suggest')
})

test('单复数：blue_eye → blue_eyes、closed_eye → closed_eyes', async () => {
  const out = await repairer.fix(rowsOf(['blue_eye', 'closed_eye']))
  assert.deepEqual(out.fixes.map(f => [f.from, f.to, f.how]), [
    ['blue_eye', 'blue_eyes', 'plural'],
    ['closed_eye', 'closed_eyes', 'plural'],
  ])
  assert.deepEqual(out.rows.map(r => r.matched), [true, true])
})

test('词序与连字符：hair_long → long_hair（swap）、long-hair → long_hair（hyphen）', async () => {
  const out = await repairer.fix(rowsOf(['hair_long', 'long-hair']))
  const byFrom = new Map(out.fixes.map(f => [f.from, f]))
  assert.equal(byFrom.get('hair_long').to, 'long_hair')
  assert.equal(byFrom.get('hair_long').how, 'swap')
  assert.equal(byFrom.get('long-hair').to, 'long_hair')
  assert.equal(byFrom.get('long-hair').how, 'hyphen')
})

test("空白写法由 canonicalize 自己解决（'silver hair'），repair 不该重复动手", async () => {
  const rows = rowsOf(['silver hair'])
  assert.equal(rows[0].matched, true, '前置条件：空格写法本来就命中 silver_hair')
  const out = await repairer.fix(rows)
  assert.equal(out.fixes.length, 0)
  assert.equal(out.rows[0].tag, 'silver_hair')
})

test('只动 matched=false：已经命中的 legs_up / spread_leg / blue_eyes 原样不动', async () => {
  const rows = rowsOf(['legs_up', 'spread_leg', 'blue_eyes'])
  assert.deepEqual(rows.map(r => r.matched), [true, true, true], '前置条件：这三个本来就能命中')
  const out = await repairer.fix(rows)
  assert.equal(out.fixes.length, 0)
  assert.equal(out.warnings.length, 0)
  // spread_leg 由别名解析成 spread_legs，三行都保持 canonicalize 之后的样子
  assert.deepEqual(out.rows.map(r => r.tag), rows.map(r => r.tag))
  assert.deepEqual(out.rows.map(r => r.tag), ['legs_up', 'spread_legs', 'blue_eyes'])
  assert.equal(out.rows[0], rows[0], '命中行应是同一个对象，不做无谓拷贝')
})

test('修不上就原样保留并给 warning，绝不硬猜（parted_legs / leg_over_shoulder / zzz）', async () => {
  const rows = rowsOf(['parted_legs', 'leg_over_shoulder', 'zzz_not_a_tag_xyz'])
  assert.deepEqual(rows.map(r => r.matched), [false, false, false], '前置条件：三个都没收录')
  const out = await repairer.fix(rows)
  assert.equal(out.fixes.length, 0, '这三个一个都不该被改')
  // 关键：leg_over_shoulder 绝不能掉到 over_shoulder（过肩镜头）这种丢了实词的近邻
  assert.deepEqual(out.rows.map(r => r.tag), ['parted_legs', 'leg_over_shoulder', 'zzz_not_a_tag_xyz'])
  assert.equal(out.warnings.length, 3)
  assert.ok(out.warnings.every(w => w.includes('未收录，已原样保留')))
})

test('幂等：修完的行再跑一次，fixes 为空且 rows 不变', async () => {
  const first = await repairer.fix(rowsOf(['top-down_bottom_up', "worm's-eye_view", 'one_leg_up', 'blue_eye']))
  assert.equal(first.fixes.length, 4)
  const second = await repairer.fix(first.rows)
  assert.equal(second.fixes.length, 0)
  assert.equal(second.warnings.length, 0)
  assert.deepEqual(second.rows.map(r => r.tag), first.rows.map(r => r.tag))
})

test('limit：limit=1 只修一条，其余原样保留并进 warning；limit=0 一条都不修', async () => {
  const rows = rowsOf(['top-down_bottom_up', 'blue_eye', 'hair_long'])
  const one = await repairer.fix(rows, { limit: 1 })
  assert.equal(one.fixes.length, 1)
  assert.equal(one.rows[0].tag, 'top-down_bottom-up')
  assert.deepEqual(one.rows.slice(1).map(r => r.matched), [false, false])
  assert.equal(one.warnings.length, 2)
  assert.ok(one.warnings[0].includes('上限'))

  const none = await repairer.fix(rows, { limit: 0 })
  assert.equal(none.fixes.length, 0)
  assert.deepEqual(none.rows.map(r => r.tag), rows.map(r => r.tag))
})

test('入参不被改写，weight 与未知字段原样带过去', async () => {
  const rows = rowsOf(['hair_long'])
  rows[0].weight = 1.35
  rows[0].extra = 'keep-me'
  const snapshot = JSON.parse(JSON.stringify(rows))
  const out = await repairer.fix(rows)
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), snapshot, '原 rows 必须原封不动')
  assert.notEqual(out.rows[0], rows[0], '修过的行应是新对象')
  assert.equal(out.rows[0].weight, 1.35)
  assert.equal(out.rows[0].extra, 'keep-me')
  assert.equal(out.rows[0].raw, 'hair_long')
})

test('修好的 tag 一定能在库里查到（修完不弹「不在库里」）', async () => {
  const list = ['top-down_bottom_up', "worm's-eye_view", 'one_leg_up', 'blue_eye', 'hair_long', 'closed_eye']
  const out = await repairer.fix(rowsOf(list))
  assert.equal(out.rows.length, list.length)
  for (const row of out.rows) {
    assert.equal(row.matched, true, row.tag)
    assert.ok(tags.get(row.tag), '库里应能查到 ' + row.tag)
  }
  assert.equal(out.warnings.length, 0)
})

test('matched 缺省时按库里查不到来判断（裸行也能修）', async () => {
  const out = await repairer.fix([{ tag: 'hair_long', weight: 1 }, { tag: 'blue_eyes', weight: 1 }])
  assert.deepEqual(out.fixes.map(f => f.to), ['long_hair'])
  assert.equal(out.rows[1].tag, 'blue_eyes')
  assert.equal(out.rows[1].matched, undefined, '命中行不该被塞 matched')
})

test('空输入与畸形行不炸', async () => {
  assert.deepEqual(await repairer.fix([]), { rows: [], fixes: [], warnings: [] })
  const out = await repairer.fix([null, { tag: '' }, { tag: '   ' }, {}])
  assert.equal(out.fixes.length, 0)
  assert.equal(out.rows.length, 4)
})

test('tags.suggestTags：one_leg_up → leg_up，乱七八糟的词给空数组（严格）', () => {
  const top = tags.suggestTags('one_leg_up', 3)
  assert.equal(top[0].tag, 'leg_up')
  assert.equal(top[0].matched, true)
  assert.ok(top[0].score >= 52)
  for (const junk of ['ass', 'zzz_not_a_tag_xyz', 'parted_legs', 'leg_over_shoulder', '']) {
    assert.deepEqual(tags.suggestTags(junk, 3), [], '不该给建议：' + junk)
  }
  // 只差连字符/下划线时给得出来
  assert.equal(tags.suggestTags('top-down_bottom_up', 1)[0].tag, 'top-down_bottom-up')
  assert.equal(tags.suggestTags("worm's-eye_view", 1)[0].tag, "worm's_eye_view")
})

test('模块级 suggestTags 便捷导出复用已有索引，结果与实例方法一致', () => {
  assert.deepEqual(modSuggest('two_leg_up', 1), tags.suggestTags('two_leg_up', 1))
  assert.equal(modSuggest('two_leg_up', 1)[0].tag, 'legs_up', '复数提示该落到 legs_up')
})

test('createRepairer 缺少 tags 时立刻报错（接线错误要早暴露）', () => {
  assert.throws(() => createRepairer({}), /需要 tags/)
})
