// plan: 测中文意图识别（短语→tag）与补全的确定性行为，不需要网络/LLM
/**
 * tests/zh-intent.test.mjs — lib/zh-intent.js 的行为测试。
 *
 * 跑法（本机没有 node 命令，用 Electron 当 node）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/zh-intent.test.mjs
 *
 * 覆盖：跪趴/屁股翘起/从下面看/从上往下/过肩/侧面/仰躺双腿抬起/骑乘 的意图识别，
 * 长词优先与去重叠，已有同义不重复补，权重区间与姿势段之后插入，
 * selectCandidates 的候选合并与降级（没有索引也不炸），以及词表与短语表的一致性。
 * 无外部依赖：node:test + node:assert。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { POSE_HINTS, POSE_TAGS, applyPoseHints, detectPoseHints, selectCandidates } from '../lib/zh-intent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const poseFile = path.join(here, '..', 'data', 'tags', 'pose-view.jsonl')

/** 取某个 key 的命中（没有就 undefined）。 */
function hint(described, key) {
  return detectPoseHints(described).find(item => item.key === key)
}

/** 命中里所有 tag。 */
function tagsOf(described) {
  return detectPoseHints(described).flatMap(item => item.tags.map(tag => tag.tag))
}

test('跪趴 → all_fours + kneeling', () => {
  const hit = hint('她跪趴在床上', 'all_fours')
  assert.ok(hit, 'all_fours 没命中：' + JSON.stringify(detectPoseHints('她跪趴在床上')))
  assert.equal(hit.matched, '跪趴')
  const tags = hit.tags.map(tag => tag.tag)
  assert.deepEqual(tags, ['all_fours', 'kneeling'])
  assert.equal(hit.tags[0].weight, 1.1)
})

test('屁股翘起来 → arched_back + ass（翘臀/撅屁股同样命中）', () => {
  for (const said of ['屁股翘起来', '屁股翘起', '翘臀', '撅屁股']) {
    const tags = tagsOf(said)
    assert.ok(tags.includes('arched_back'), said + ' 没命中 arched_back：' + tags.join(','))
    assert.ok(tags.includes('ass'), said + ' 没命中 ass：' + tags.join(','))
  }
})

test('从下面看 → from_below（仰视/从下往上看同义）', () => {
  for (const said of ['从下面看', '仰视', '从下往上看', '低角度仰拍']) {
    assert.ok(tagsOf(said).includes('from_below'), said + ' 没命中 from_below')
  }
})

test('从上往下 → from_above', () => {
  assert.ok(tagsOf('从上往下看').includes('from_above'))
  assert.ok(tagsOf('俯视').includes('from_above'))
  assert.ok(!tagsOf('俯视').includes('from_below'), '俯视 不该命中 from_below')
})

test('过肩 → over_shoulder', () => {
  const hit = hint('过肩镜头，看不全脸', 'over_shoulder')
  assert.ok(hit, 'over_shoulder 没命中')
  assert.equal(hit.matched, '过肩镜头')
  assert.deepEqual(hit.tags.map(tag => tag.tag), ['over_shoulder'])
})

test('侧面 → from_side + profile', () => {
  const hit = hint('侧面站姿', 'from_side')
  assert.ok(hit, 'from_side 没命中')
  assert.deepEqual(hit.tags.map(tag => tag.tag), ['from_side', 'profile'])
})

test('仰躺双腿抬起 → on_back + legs_up', () => {
  const tags = tagsOf('仰躺，双腿抬起')
  assert.ok(tags.includes('on_back'), '缺 on_back：' + tags.join(','))
  assert.ok(tags.includes('legs_up'), '缺 legs_up：' + tags.join(','))
})

test('骑乘 → cowgirl_position + girl_on_top', () => {
  const hit = hint('女上位骑乘', 'girl_on_top')
  assert.ok(hit, 'girl_on_top 没命中')
  const tags = hit.tags.map(tag => tag.tag)
  assert.ok(tags.includes('cowgirl_position'), '缺 cowgirl_position')
  assert.ok(tags.includes('girl_on_top'), '缺 girl_on_top')
})

test('长词优先且去重叠：跪趴后入 只出 doggystyle，不再单独出 all_fours', () => {
  const keys = detectPoseHints('跪趴后入').map(item => item.key)
  assert.deepEqual(keys, ['doggystyle'])
  const d = hint('跪趴后入', 'doggystyle')
  assert.equal(d.matched, '跪趴后入')
  assert.ok(d.tags.map(tag => tag.tag).includes('sex_from_behind'))
})

test('applyPoseHints：已有同义（主 tag 在列表里）就不重复补', () => {
  const hints = detectPoseHints('跪趴')
  const before = ['1girl', 'all_fours', 'smile']
  const result = applyPoseHints(before, hints)
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.rows, before, '不该改动已有列表')
})

test('applyPoseHints：只补缺失、权重落在 1.05–1.15、字符串入字符串出', () => {
  const hints = detectPoseHints('跪趴')
  const result = applyPoseHints(['1girl', 'smile'], hints)
  assert.equal(result.rows.length, 4)
  assert.equal(result.rows[0], '1girl')
  assert.equal(result.rows[1], 'smile')
  assert.equal(result.rows[2], '(all_fours:1.1)')
  assert.equal(result.rows[3], '(kneeling:1.05)')
  for (const item of result.added) {
    assert.ok(item.weight >= 1.05 && item.weight <= 1.15, item.tag + ' 权重越界：' + item.weight)
  }
})

test('applyPoseHints：补进「姿势段」之后，已有顺序不变', () => {
  const rows = [{ tag: '1girl' }, { tag: 'from_below' }, { tag: 'smile' }]
  const result = applyPoseHints(rows, detectPoseHints('跪趴'))
  assert.deepEqual(result.rows.map(row => row.tag), ['1girl', 'from_below', 'all_fours', 'kneeling', 'smile'])
  assert.equal(result.rows[2].weight, 1.1)
})

test('姿势权重高于视角权重，且都在约定区间内', () => {
  // 同一个 tag 在不同意图里可能是主 tag（高权重）也可能是陪衬（低权重），比较时取最大值。
  const weights = new Map()
  for (const hintItem of POSE_HINTS) {
    for (const item of hintItem.tags) {
      assert.ok(item.weight >= 1.05 && item.weight <= 1.15, hintItem.key + ':' + item.tag + ' 权重 ' + item.weight)
      weights.set(item.tag, Math.max(weights.get(item.tag) ?? 0, item.weight))
    }
  }
  assert.ok(weights.get('all_fours') > weights.get('from_below'), '姿势应重于视角')
  assert.ok(weights.get('missionary') > weights.get('from_below'), '体位应重于视角')
})

test('空输入与非字符串输入不炸', () => {
  assert.deepEqual(detectPoseHints(''), [])
  assert.deepEqual(detectPoseHints(null), [])
  assert.deepEqual(detectPoseHints(undefined), [])
  assert.deepEqual(detectPoseHints('   '), [])
})

test('英文缩写也认：3P → threesome', () => {
  assert.ok(tagsOf('3P 场景').includes('threesome'))
})

test('selectCandidates：意图 tag 排在前面，再用索引补中英候选，且不重复', async () => {
  const fake = {
    async ready() {},
    search(query, options = {}) {
      const limit = options.limit ?? 10
      const rows = query.includes('长发')
        ? [{ tag: 'long_hair', cn: '长发', postCount: 9 }]
        : [{ tag: 'all_fours', cn: '四肢着地（跪趴）', postCount: 3 }]
      return rows.slice(0, limit)
    },
  }
  const rows = await selectCandidates({ described: '跪趴，长发及腰', tags: fake, limit: 6 })
  assert.ok(rows.length <= 6, 'limit 没生效')
  assert.equal(rows[0].tag, 'all_fours')
  assert.equal(rows[0].cn, '四肢着地（跪趴）')
  assert.ok(rows.some(row => row.tag === 'long_hair'), '搜索候选没合并进来：' + JSON.stringify(rows))
  assert.equal(new Set(rows.map(row => row.tag)).size, rows.length, '有重复 tag')
})

test('selectCandidates：没有索引时降级为只给意图 tag', async () => {
  const rows = await selectCandidates({ described: '过肩', limit: 5 })
  assert.deepEqual(rows.map(row => row.tag), ['over_shoulder'])
})

test('词表一致性：POSE_HINTS 里的 tag 都写在 data/tags/pose-view.jsonl', () => {
  assert.ok(fs.existsSync(poseFile), '缺词表文件 ' + poseFile)
  const overlay = new Set()
  for (const line of fs.readFileSync(poseFile, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    overlay.add(JSON.parse(line).tag)
  }
  const missing = [...new Set([...POSE_TAGS])].filter(tag => !overlay.has(tag))
  assert.deepEqual(missing, [], '短语表引用了词表里没有的 tag：' + missing.join(','))
  assert.ok(overlay.size >= 90 && overlay.size <= 160, '词表行数应在 90–160，实际 ' + overlay.size)
})
test('真机踩到的漏口语：回头 / 正后方 / 跪在床边 / 俯拍 / 翘起屁股', () => {
  // 用户真会这么说话，早先这些说法一个都没命中
  assert.ok(tagsOf('跪在床边回头看').includes('looking_back'), '回头 没命中 looking_back')
  assert.ok(tagsOf('跪在床边回头看').includes('kneeling'), '跪在床边 没命中 kneeling')
  assert.ok(tagsOf('从正后方拍').includes('from_behind'), '正后方 没命中 from_behind')
  assert.ok(tagsOf('俯拍').includes('from_above'), '俯拍 没命中 from_above')
  assert.ok(tagsOf('仰拍').includes('from_below'), '仰拍 没命中 from_below')
  assert.ok(tagsOf('翘起屁股').includes('arched_back'), '翘起屁股 没命中 arched_back')
  assert.ok(tagsOf('张开大腿').includes('spread_legs'), '张开大腿 没命中 spread_legs')

  // 整句里多个意图要一起命中
  const tags = tagsOf('跪趴在床上翘起屁股，从正后方拍，回头看镜头')
  for (const expected of ['all_fours', 'kneeling', 'arched_back', 'from_behind', 'looking_back']) {
    assert.ok(tags.includes(expected), '整句漏了 ' + expected + '：' + tags.join(','))
  }
})
