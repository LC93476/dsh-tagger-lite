/**
 * 姿势 → tag 映射：角度 / 分类 / 名称提示 / 真词表校验。
 * 词表与 catalog 都可能不在本机（干净机器、CI），那两类用例 skip 而不是变红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ANGLE_TAGS,
  CATEGORY_TAGS,
  NAME_HINTS,
  SET_TAGS,
  TAG_SOURCES,
  tagsForPose,
} from '../lib/pose-tags.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 实测的真 catalog 分类值（2026-11 快照，26 个）。没有 catalog 时用它兜底做覆盖断言。 */
const KNOWN_CATEGORIES = [
  '性感・大胆系',
  '趴卧',
  '站姿',
  '坐姿',
  '可爱系',
  '挤胸・强调事业线系',
  '特殊',
  '跪立・四肢着地',
  '正常位（传教士）',
  '跪立',
  '侧坐・女孩坐',
  '后入位',
  '背向坐位',
  '前倾',
  '蹲姿',
  '贴脸系',
  '骑乘位',
  '立位',
  '立位贴身',
  '后仰・挺背',
  '扭身',
  '侧卧位',
  '坐位',
  '面对面坐位',
  '坐位贴身',
  '贴身',
]

function splitCsv(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1 } else quoted = false
      } else cur += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(cell => cell.trim())
}

/** 找本机的姿势库（ComfyUI 的 launchDir），找不到返回 ''。 */
function findLaunchDir() {
  const candidates = [
    process.env.DSH_POSE_DIR,
    process.env.COMFY_DIR,
    'C:/ComfyUI',
    'D:/ComfyUI',
    'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI',
    '/c/ComfyUI',
  ].filter(value => typeof value === 'string' && value.trim() !== '')
  for (const candidate of candidates) {
    const skills = path.join(candidate, 'custom_nodes', 'ai-pose-gallery-zh', 'skills')
    if (fs.existsSync(skills)) return candidate
  }
  return ''
}

/** 读真 catalog 的所有行（姿势库不在本机返回 []）。 */
function readCatalogRows() {
  const launchDir = findLaunchDir()
  if (launchDir === '') return []
  const skills = path.join(launchDir, 'custom_nodes', 'ai-pose-gallery-zh', 'skills')
  let names = []
  try { names = fs.readdirSync(skills) } catch { return [] }
  const rows = []
  for (const name of names) {
    if (name.startsWith('pose-reference') === false) continue
    const file = path.join(skills, name, 'references', 'catalog.csv')
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    let head = null
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue
      const cells = splitCsv(line)
      if (head === null) { head = cells; continue }
      const row = {}
      cells.forEach((cell, index) => { row[head[index] ?? String(index)] = cell })
      if (String(row.id ?? '') === '') continue
      rows.push({
        set: name.replace('pose-reference-', ''),
        system: String(row['体系'] ?? ''),
        category: String(row['分类'] ?? ''),
        code: String(row['姿势编号'] ?? ''),
        name: String(row['姿势名称'] ?? ''),
        angle: String(row['角度'] ?? ''),
      })
    }
  }
  return rows
}

/** 找 Danbooru 大词表（general.jsonl），找不到返回 ''。 */
function findGeneralDict() {
  const candidates = [
    process.env.DSH_DANBOORU_DIR ? path.join(process.env.DSH_DANBOORU_DIR, 'general.jsonl') : '',
    path.join(REPO, 'data', 'danbooru', 'general.jsonl'),
  ].filter(Boolean)
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return ''
}

function dictTags(file) {
  const tags = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      const tag = String(row.tag ?? '')
      if (tag !== '') tags.add(tag)
    } catch { /* 坏行跳过 */ }
  }
  return tags
}

test('角度映射：五个角度全覆盖，未知角度不补镜头词', () => {
  assert.deepEqual(Object.keys(ANGLE_TAGS).sort(), ['俯视', '仰视', '侧面', '斜侧', '正面'].sort())
  assert.equal(ANGLE_TAGS['正面'], 'facing_viewer')
  assert.equal(ANGLE_TAGS['斜侧'], 'from_side')
  assert.equal(ANGLE_TAGS['侧面'], 'from_side')
  assert.equal(ANGLE_TAGS['俯视'], 'from_above')
  assert.equal(ANGLE_TAGS['仰视'], 'from_below')

  for (const [angle, tag] of Object.entries(ANGLE_TAGS)) {
    const out = tagsForPose({ name: '自然站立', category: '站姿', angle, set: 'standard' })
    assert.deepEqual(out.camera, [tag], angle + ' 应该映射成 ' + tag)
    assert.ok(out.reasons.some(text => text.includes('角度：' + angle)), '推导链里要写明角度来源')
  }

  const unknown = tagsForPose({ name: '自然站立', category: '站姿', angle: '背面', set: 'standard' })
  assert.deepEqual(unknown.camera, [])
  assert.ok(unknown.reasons.some(text => text.includes('未收录')))
  assert.deepEqual(tagsForPose({ name: '自然站立', category: '站姿', angle: '   ' }).camera, [])
})

test('分类映射：真 catalog 出现的每个分类都有键，且键不落在实测清单之外', () => {
  const rows = readCatalogRows()
  const realCategories = [...new Set(rows.map(row => row.category))]
  if (rows.length === 0) {
    // 本机没有姿势库：退回实测快照，至少保证这 26 个分类的键不丢
    for (const category of KNOWN_CATEGORIES) {
      assert.ok(Object.hasOwn(CATEGORY_TAGS, category), '缺分类键：' + category)
    }
    return
  }
  assert.ok(realCategories.length >= 10, '真 catalog 分类数异常：' + realCategories.length)
  for (const category of realCategories) {
    assert.ok(Object.hasOwn(CATEGORY_TAGS, category), '真 catalog 里有、映射表里没有：' + category)
  }
  for (const category of KNOWN_CATEGORIES) {
    assert.ok(Object.hasOwn(CATEGORY_TAGS, category), '实测清单里的分类丢了：' + category)
  }
  // 每个真分类都要产出非空姿态词，除非显式给了空数组（特殊）
  for (const category of realCategories) {
    const tags = CATEGORY_TAGS[category]
    assert.ok(Array.isArray(tags), category + ' 的值必须是数组')
    assert.ok(tags.length > 0 || category === '特殊', category + ' 不该是空数组')
    assert.equal(new Set(tags).size, tags.length, category + ' 里不该有重复 tag')
  }
  // 每一行真 catalog 都能推出一串 tag，且不含重复。
  // 例外只有「分类本身没姿态词、名字也没命中关键词」的行（特殊系那批）：那时必须老实给空串，不硬编。
  for (const row of rows) {
    const out = tagsForPose({ ...row, base: row.code })
    const mappable = CATEGORY_TAGS[row.category].length > 0 || NAME_HINTS.some(hint => hint.re.test(row.name))
    if (mappable === false) {
      assert.deepEqual(out.pose, [], '推不出 tag 的行应该给空串：' + row.set + '/' + row.category + '/' + row.name)
      continue
    }
    assert.ok(out.pose.length > 0, '推不出 tag：' + row.set + '/' + row.category + '/' + row.name)
    assert.equal(new Set(out.pose).size, out.pose.length, '重复 tag：' + row.name)
    assert.ok(out.reasons.length >= 2, '推导链太少：' + row.name)
  }
})

test('名称提示：真姿势名（或实测快照）能命中关键词，产出不重复', () => {
  const rows = readCatalogRows()
  const picks = (rows.length > 0 ? rows : [
    { set: 'upper', category: '可爱系', code: 'P001', name: '胸前双手比心', angle: '正面' },
    { set: 'standard', category: '站姿', code: 'P002', name: '背部后仰・双手撩发', angle: '斜侧' },
    { set: 'standard', category: '坐姿', code: 'P016', name: '侧坐・单手支撑・身体柔弯', angle: '侧面' },
    { set: 'sexy', category: '趴卧', code: 'P047', name: '俯卧托腮・双腿上抬', angle: '俯视' },
    { set: 'couple', category: '背向坐位', code: 'P009', name: '自背后环抱・令其坐于膝上', angle: '正面' },
  ]).slice(0, 5)
  assert.equal(picks.length, 5)

  for (const row of picks) {
    const out = tagsForPose({ ...row, base: row.code })
    assert.ok(out.pose.length > 0, '没推出 tag：' + row.name)
    assert.equal(new Set(out.pose).size, out.pose.length, '有重复：' + row.name)
    assert.ok(Array.isArray(out.reasons) && out.reasons.length > 0)
    assert.ok(out.reasons.every(text => typeof text === 'string' && text !== ''))
    assert.deepEqual(out.camera, ANGLE_TAGS[row.angle] ? [ANGLE_TAGS[row.angle]] : [])
    // 分类 tag 必须排在名称提示前面
    const categoryTags = CATEGORY_TAGS[row.category]
    if (categoryTags.length > 0) {
      assert.deepEqual(out.pose.slice(0, categoryTags.length), categoryTags, '分类标签要排在前：' + row.name)
    }
  }

  // 具体几条命中关系：比心 → heart_hands；回头 → looking_back；抱膝 → hugging_own_legs
  assert.ok(tagsForPose({ name: '双手比心', category: '可爱系', angle: '正面' }).pose.includes('heart_hands'))
  assert.ok(tagsForPose({ name: '扭身・跪立回望', category: '扭身', angle: '正面' }).pose.includes('looking_back'))
  assert.ok(tagsForPose({ name: '坐姿・双手抱膝', category: '坐姿', angle: '正面' }).pose.includes('hugging_own_legs'))
  // 没有关键词的名字只出分类 tag，不硬编
  assert.deepEqual(tagsForPose({ name: '自然站立', category: '站姿', angle: '正面' }).pose, ['standing'])
})

test('真词表校验：所有产出 tag 都在 Danbooru 库里', t => {
  const file = findGeneralDict()
  if (file === '') {
    t.skip('本机没有 Danbooru 词表（data/danbooru/general.jsonl 或 DSH_DANBOORU_DIR），跳过真库校验')
    return
  }
  const dict = dictTags(file)
  assert.ok(dict.size > 20000, '词表条数异常：' + dict.size)

  const missing = []
  const check = (tag, where) => {
    if (dict.has(tag) === false) missing.push(tag + '（' + where + '）')
  }
  for (const [key, tag] of Object.entries(ANGLE_TAGS)) check(tag, 'ANGLE_TAGS.' + key)
  for (const [key, tags] of Object.entries(CATEGORY_TAGS)) for (const tag of tags) check(tag, 'CATEGORY_TAGS.' + key)
  for (const hint of NAME_HINTS) for (const tag of hint.tags) check(tag, 'NAME_HINTS.' + hint.why)
  for (const [key, tags] of Object.entries(SET_TAGS)) for (const tag of tags) check(tag, 'SET_TAGS.' + key)

  const rows = readCatalogRows()
  for (const row of rows.slice(0, 200)) {
    const out = tagsForPose({ ...row, base: row.code })
    for (const tag of out.pose) check(tag, '推出来的 pose tag')
    for (const tag of out.camera) check(tag, '推出来的 camera tag')
  }
  assert.deepEqual(missing, [], '这些词不在词表里：' + missing.join(', '))

  // 来源表要能遍历到四张表，避免以后加表忘了登记
  assert.deepEqual(Object.keys(TAG_SOURCES).sort(), ['angle', 'category', 'name', 'set'])
  assert.equal(TAG_SOURCES.category, CATEGORY_TAGS)
  assert.equal(TAG_SOURCES.angle, ANGLE_TAGS)
  assert.equal(TAG_SOURCES.set, SET_TAGS)
  assert.equal(TAG_SOURCES.name, NAME_HINTS)
})

test('脏输入不崩：缺名称给三空数组，缺分类/角度只补能补的', () => {
  for (const bad of [undefined, null, '', 0, [], {}, { name: '' }, { name: '   ' }]) {
    const out = tagsForPose(/** @type {any} */ (bad))
    assert.deepEqual(out, { pose: [], camera: [], reasons: [] }, '这些输入该给空数组：' + JSON.stringify(bad))
  }
  const noCategory = tagsForPose({ name: '双手比心', angle: '正面' })
  assert.deepEqual(noCategory.pose, ['heart_hands'])
  assert.deepEqual(noCategory.camera, ['facing_viewer'])
  assert.ok(noCategory.reasons.some(text => text.includes('（空）')))

  const unknownCategory = tagsForPose({ name: '自然站立', category: '不存在的分类', angle: '正面' })
  assert.deepEqual(unknownCategory.pose, [])
  assert.ok(unknownCategory.reasons.some(text => text.includes('未收录')))
})
