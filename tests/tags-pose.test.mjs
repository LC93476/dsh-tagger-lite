// plan: 测 pose-view overlay 进索引后中文「跪趴/仰视/俯视/过肩」能 search 命中
/**
 * tests/tags-pose.test.mjs — 姿势/视角词表（data/tags/pose-view.jsonl）接进标签索引后的行为。
 *
 * 跑法：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/tags-pose.test.mjs
 *
 * 关键点：overlay 目录（插件自带 data/tags）无条件叠加在主流数据之后，所以这里
 * probeDefaults:false 也能读到 pose-view.jsonl；另外用真实 danbooru 数据核对
 * 词表里每个 tag 都真的存在（写了库里没有的词，锻造时会弹「不在库里」）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { createTagIndex } from '../lib/tags.js'
import { detectPoseHints } from '../lib/zh-intent.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const poseFile = path.join(here, '..', 'data', 'tags', 'pose-view.jsonl')
const danbooruGeneral = 'D:/QUARK/dsh-comfyui-workbench/data/danbooru/general.jsonl'
const silent = { info() {}, warn() {}, error() {} }
// 同上：mkdtemp 保证目录唯一、结束即删，避免进程号被复用后读到上一轮的残留词表
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tagger-tags-pose-test-'))
after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// overlay 只读插件自带 data/tags + <scratch>/tags，不探测本机真实数据（快、可复现）
const index = createTagIndex({ dir: scratch, logger: silent, probeDefaults: false })

/** 姿势词表用例的守卫：公开版不带 data/tags/pose-view.jsonl 就 skip，别当成失败。 */
function needPoseFile(t) {
  if (fs.existsSync(poseFile)) return true
  t.skip('本机没有姿势词表：' + poseFile)
  return false
}

function top(term, limit = 5) {
  return index.search(term, { limit })
}

test('overlay 生效：中文「跪趴」命中 all_fours', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  const rows = top('跪趴')
  assert.ok(rows.length > 0, 'search 没结果')
  assert.equal(rows[0].tag, 'all_fours')
  assert.equal(rows[0].cn, '四肢着地（跪趴）')
})

test('「仰视」「俯视」分别命中 from_below / from_above', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  assert.equal(top('仰视')[0].tag, 'from_below')
  assert.equal(top('俯视')[0].tag, 'from_above')
})

test('「过肩」命中 over_shoulder', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  assert.equal(top('过肩')[0].tag, 'over_shoulder')
})

test('口语别名同样可查：从下面看 / 从上往下 / 屁股翘起来', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  assert.equal(top('从下面看')[0].tag, 'from_below')
  assert.equal(top('从上往下')[0].tag, 'from_above')
  const butt = top('屁股翘起来')
  assert.ok(butt.some(row => row.tag === 'arched_back'), 'arched_back 没进结果：' + butt.map(row => row.tag).join(','))
})

test('体位词也可查：女上位 / 后入 / 过肩镜头之外的常用说法', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  assert.ok(top('女上位').some(row => row.tag === 'cowgirl_position'), '缺 cowgirl_position')
  assert.ok(top('后入').some(row => row.tag === 'sex_from_behind'), '缺 sex_from_behind')
  assert.ok(top('深喉').some(row => row.tag === 'deepthroat'), '缺 deepthroat')
})

test('口语别名回归：贴在墙上 / 对着镜头 也能落到库里的 tag', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  assert.equal(top('贴在墙上')[0].tag, 'against_wall')
  assert.equal(top('贴在墙')[0].tag, 'against_wall')
  assert.equal(top('对着镜头')[0].tag, 'looking_at_viewer')
  assert.equal(top('看镜头')[0].tag, 'looking_at_viewer')
})

test('意图识别出的 tag 都能在索引里查到（词表与短语表联动）', async t => {
  if (!needPoseFile(t)) return
  await index.ready()
  for (const said of ['跪趴', '从下面看', '过肩', '仰视']) {
    for (const item of detectPoseHints(said)) {
      for (const tag of item.tags) {
        const rows = index.search(tag.tag, { limit: 8 })
        assert.ok(rows.some(row => row.tag === tag.tag), said + ' 的 ' + tag.tag + ' 查不到')
      }
    }
  }
})

test('词表里每个 tag 都真实存在于 danbooru 数据（库不存在则跳过）', async t => {
  if (!fs.existsSync(danbooruGeneral)) {
    t.skip('没有本机 danbooru 数据：' + danbooruGeneral)
    return
  }
  if (!needPoseFile(t)) return
  const wanted = new Set()
  for (const line of fs.readFileSync(poseFile, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue
    wanted.add(JSON.parse(line).tag)
  }
  const found = new Set()
  const stream = fs.createReadStream(danbooruGeneral, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of reader) {
    const at = line.indexOf('"tag":"')
    if (at < 0) continue
    const end = line.indexOf('"', at + 7)
    if (end < 0) continue
    const tag = line.slice(at + 7, end)
    if (wanted.has(tag)) {
      found.add(tag)
      if (found.size === wanted.size) break
    }
  }
  reader.close()
  stream.destroy()
  const missing = [...wanted].filter(tag => !found.has(tag))
  assert.deepEqual(missing, [], '词表里有库里不存在的 tag（会弹「不在库里」）：' + missing.join(','))
})
