/**
 * 参考样式预设库：结构约束 / 纯函数行为 / 真词表核对。
 * 词表在干净机器或 CI 上可能不在，词表那组用例 skip 而不是变红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ACCENTS,
  STYLES,
  STYLE_GROUPS,
  listStyles,
  mergeStylePrompt,
  styleById,
  tagsOfStyles,
} from '../lib/styles.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SOURCE = path.join(REPO, 'lib', 'styles.js')
const DICT = path.join(REPO, 'data', 'danbooru', 'general.jsonl')

/** 面板按分组堆卡片，组太少没得选，卡太多一屏放不下。 */
const GROUP_COUNT = 5
const CARDS_PER_GROUP_MIN = 6
const CARDS_PER_GROUP_MAX = 10
const CARDS_TOTAL_MIN = 32
const CARDS_TOTAL_MAX = 40

/** 词表里能出现的形态：小写、数字、下划线、连字符，少数带 (…) 消歧。 */
const TAG_SHAPE = /^[a-z0-9][a-z0-9_()-]*$/
const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function groupKeys() {
  return STYLE_GROUPS.map(group => group.key)
}

/** 读词表 tag 集合；文件不在返回 null，让相关用例 skip。 */
let dictTags
function readDict() {
  if (dictTags !== undefined) return dictTags
  if (!fs.existsSync(DICT)) {
    dictTags = null
    return dictTags
  }
  const set = new Set()
  for (const line of fs.readFileSync(DICT, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row && typeof row.tag === 'string') set.add(row.tag)
  }
  dictTags = set.size === 0 ? null : set
  return dictTags
}

test('分组：5 组、键唯一、标题与说明非空', () => {
  assert.equal(STYLE_GROUPS.length, GROUP_COUNT)
  const keys = groupKeys()
  assert.equal(new Set(keys).size, keys.length, '分组 key 不能重复')
  for (const group of STYLE_GROUPS) {
    assert.match(group.key, /^[a-z]+$/, 'key 用纯小写英文：' + group.key)
    assert.ok(typeof group.label === 'string' && group.label.trim() !== '', '缺 label：' + group.key)
    assert.ok(typeof group.note === 'string' && group.note.trim() !== '', '缺 note：' + group.key)
  }
})

test('卡片：数量区间、组内数量、id 唯一且 kebab-case', () => {
  assert.ok(
    STYLES.length >= CARDS_TOTAL_MIN && STYLES.length <= CARDS_TOTAL_MAX,
    '卡片总数应在 ' + CARDS_TOTAL_MIN + '~' + CARDS_TOTAL_MAX + '，实际 ' + STYLES.length,
  )

  const ids = STYLES.map(style => style.id)
  assert.equal(new Set(ids).size, ids.length, '卡片 id 不能重复')
  for (const id of ids) assert.match(id, ID_SHAPE, 'id 要 kebab-case：' + id)

  const keys = new Set(groupKeys())
  const perGroup = {}
  for (const style of STYLES) {
    assert.ok(keys.has(style.group), '未知分组：' + style.id + ' → ' + style.group)
    perGroup[style.group] = (perGroup[style.group] ?? 0) + 1
  }
  for (const key of keys) {
    const count = perGroup[key] ?? 0
    assert.ok(
      count >= CARDS_PER_GROUP_MIN && count <= CARDS_PER_GROUP_MAX,
      '分组 ' + key + ' 有 ' + count + ' 张卡，应在 ' + CARDS_PER_GROUP_MIN + '~' + CARDS_PER_GROUP_MAX,
    )
  }
})

test('卡片：标题 / 说明 / accent / tags 形状', () => {
  const accents = new Set(ACCENTS)
  for (const style of STYLES) {
    assert.ok(style.title.length >= 2 && style.title.length <= 6, '标题 2~6 字：' + style.id)
    assert.ok(style.note.trim() !== '', '缺 note：' + style.id)
    assert.ok(accents.has(style.accent), 'accent 不在白名单：' + style.id + ' → ' + style.accent)
    assert.ok(Array.isArray(style.tags) && style.tags.length >= 2, '每张卡至少 2 个 tag：' + style.id)
    assert.ok(style.tags.length <= 10, '单卡 tag 别超过 10 个：' + style.id)
    assert.equal(new Set(style.tags).size, style.tags.length, '单卡内 tag 重复：' + style.id)
    for (const tag of style.tags) assert.match(tag, TAG_SHAPE, 'tag 形态不对：' + style.id + ' → ' + tag)
  }
})

test('源码：每张卡（含 tags 数组）都在同一行，发布脚本才能按行裁剪', () => {
  const lines = fs.readFileSync(SOURCE, 'utf8').split('\n')
  const cardLines = lines.filter(line => /^\s*\{ id: '/.test(line))
  assert.equal(cardLines.length, STYLES.length, '每张卡必须独占一行且以 { id: \'…\' 开头')
  for (const line of cardLines) {
    assert.ok(line.includes('tags: ['), 'tags 数组必须与卡片同行：' + line.slice(0, 40))
    assert.ok(/\],?\s*\},?\s*$/.test(line), '卡片行必须在同处闭合：' + line.slice(0, 40))
  }
})

test('listStyles：组与卡片是浅拷贝，改动不污染源表', () => {
  const snapshot = listStyles()
  assert.equal(snapshot.groups.length, STYLE_GROUPS.length)
  assert.equal(snapshot.styles.length, STYLES.length)
  snapshot.styles[0].tags.push('__junk__')
  snapshot.styles[0].title = '__junk__'
  snapshot.groups[0].label = '__junk__'
  assert.ok(!STYLES[0].tags.includes('__junk__'))
  assert.notEqual(STYLES[0].title, '__junk__')
  assert.notEqual(STYLE_GROUPS[0].label, '__junk__')
})

test('styleById：容忍大小写 / 空格 / 下划线，未知给 null', () => {
  const first = STYLES[0]
  assert.deepEqual(styleById(first.id), first)
  assert.deepEqual(styleById(first.id.toUpperCase()), first)
  assert.deepEqual(styleById('  ' + first.id + '  '), first)
  assert.deepEqual(styleById(first.id.replace(/-/g, ' ')), first)
  assert.deepEqual(styleById(first.id.replace(/-/g, '_')), first)
  assert.deepEqual(styleById('Film Noir Look'), STYLES.find(style => style.id === 'film-noir-look'))
  assert.equal(styleById('no-such-style'), null)
  assert.equal(styleById(''), null)
  assert.equal(styleById(undefined), null)
})

test('styleById：命中返回浅拷贝，改返回值不污染 STYLES', () => {
  const hit = styleById('film-noir-look')
  const source = STYLES.find(style => style.id === 'film-noir-look')
  assert.notEqual(hit, source, '必须是拷贝，不是源对象')
  assert.notEqual(hit.tags, source.tags, 'tags 数组也要另起一份')
  hit.tags.push('__junk__')
  hit.title = '__junk__'
  assert.ok(!source.tags.includes('__junk__'))
  assert.notEqual(source.title, '__junk__')
  // 再取一次还是干净的
  assert.ok(!styleById('film-noir-look').tags.includes('__junk__'))
})

test('tagsOfStyles：按 ids 顺序展开、去重保序、未知 id 静默跳过', () => {
  const a = STYLES.find(style => style.id === 'golden-hour')
  const b = STYLES.find(style => style.id === 'moonlight-hour')
  const forward = tagsOfStyles(['golden-hour', 'moonlight-hour'])
  assert.deepEqual(forward, [...a.tags, ...b.tags].filter((tag, i, arr) => arr.indexOf(tag) === i))

  const backward = tagsOfStyles(['moonlight-hour', 'golden-hour'])
  assert.equal(backward[0], b.tags[0], '顺序按 ids 走，不按注册顺序')

  // night 同时出现在 moonlight-hour 与 city-street-night，去重后只留一次
  const two = tagsOfStyles(['moonlight-hour', 'city-street-night'])
  assert.equal(two.filter(tag => tag === 'night').length, 1)

  assert.deepEqual(tagsOfStyles([]), [])
  assert.deepEqual(tagsOfStyles(['nope-nope']), [])
  assert.deepEqual(tagsOfStyles(['golden-hour', 'golden-hour']), [...a.tags])
  assert.deepEqual(tagsOfStyles('golden-hour'), [...a.tags], '单个 id 字符串也要认')
  assert.deepEqual(tagsOfStyles(undefined), [])
})

test('tagsOfStyles：current 里已有的跳过，忽略 (tag:1.2) 权重写法', () => {
  const golden = STYLES.find(style => style.id === 'golden-hour')
  const picked = tagsOfStyles(['golden-hour'], { current: ['(sunlight:1.3)', 'other_tag'] })
  assert.deepEqual(picked, golden.tags.filter(tag => tag !== 'sunlight'))

  // 大写 + 空格写法也算同一个词
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['Gold Hour', 'SUNLIGHT'] }), golden.tags.filter(tag => tag !== 'sunlight'))
  // 花括号写法同样要去掉
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['{backlighting}'] }), golden.tags.filter(tag => tag !== 'backlighting'))
  // 不给 current 时全部展开
  assert.deepEqual(tagsOfStyles(['golden-hour'], {}), [...golden.tags])
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: [] }), [...golden.tags])
})

test('mergeStylePrompt：样式在前、原文在后、空片段丢弃', () => {
  const noir = STYLES.find(style => style.id === 'film-noir-look')
  assert.equal(mergeStylePrompt(['film-noir-look'], 'a girl on a rooftop'), [...noir.tags, 'a girl on a rooftop'].join(', '))
  assert.equal(mergeStylePrompt(['film-noir-look'], ''), noir.tags.join(', '))
  assert.equal(mergeStylePrompt(['film-noir-look'], '   '), noir.tags.join(', '))
  assert.equal(mergeStylePrompt([], 'a girl on a rooftop'), 'a girl on a rooftop')
  assert.equal(mergeStylePrompt([], ''), '')
  assert.equal(mergeStylePrompt(undefined, undefined), '')
  // 原文里已经写过的词不再重复补
  const merged = mergeStylePrompt(['film-noir-look'], 'high contrast, a girl')
  assert.equal(merged.split('high contrast').length - 1, 1, 'high_contrast 已由原文提供，不该再补一遍')
  assert.equal(merged, 'greyscale, film_grain, high contrast, a girl')
  // 多个 id 与原文一起时保持顺序
  const both = mergeStylePrompt(['golden-hour', 'moonlight-hour'], 'a girl')
  assert.ok(both.startsWith('golden_hour, sunlight, backlighting'), '实际：' + both)
  assert.ok(both.endsWith(', a girl'))
})

test('side-profile：用 from_side + silhouette，不再带会被同义合并删掉的 profile', () => {
  const card = STYLES.find(style => style.id === 'side-profile')
  assert.deepEqual(card.tags, ['from_side', 'silhouette'])
  assert.ok(!card.tags.includes('profile'), 'profile 与 from_side 同义，会被后处理删掉')
  assert.deepEqual(tagsOfStyles(['side-profile']), ['from_side', 'silhouette'])
})

test('tagsOfStyles：current 是字符串时按中英文逗号 / 顿号 / 换行切开', () => {
  const golden = STYLES.find(style => style.id === 'golden-hour')
  const rest = golden.tags.filter(tag => tag !== 'sunlight' && tag !== 'backlighting')

  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: 'sunlight，其他\nbacklighting' }), rest)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: 'sunlight, other, backlighting' }), rest)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: 'sunlight、其他\n\nbacklighting' }), rest)
  // 整串只有一个词
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: 'sunlight' }), golden.tags.filter(tag => tag !== 'sunlight'))
})

test('bareTag（间接）：嵌套括号 / 花括号 / 双冒号权重 / 反斜杠转义都算同一个词', () => {
  const golden = STYLES.find(style => style.id === 'golden-hour')
  const withoutSunlight = golden.tags.filter(tag => tag !== 'sunlight')
  const withoutBacklight = golden.tags.filter(tag => tag !== 'backlighting')

  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['((sunlight))'] }), withoutSunlight)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['{{sunlight}}'] }), withoutSunlight)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['[sunlight]'] }), withoutSunlight)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['sunlight::1.2'] }), withoutSunlight)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['(sunlight::1.2)'] }), withoutSunlight)
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['\\(backlighting\\)'] }), withoutBacklight)
  // 权重写在括号外、括号写两层，也剥得干净
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['((backlighting)):1.4'] }), withoutBacklight)
  // 词本身没被包起来时不受影响
  assert.deepEqual(tagsOfStyles(['golden-hour'], { current: ['sunlight'] }), withoutSunlight)
})

test('mergeStylePrompt：中文逗号 / 换行输入不重复补词', () => {
  const noir = STYLES.find(style => style.id === 'film-noir-look')
  const merged = mergeStylePrompt(['film-noir-look'], 'high contrast，a girl on a rooftop')
  assert.equal(merged, 'greyscale, film_grain, high contrast，a girl on a rooftop')
  assert.equal(merged.split('high contrast').length - 1, 1, 'high_contrast 只出现一次')

  const wrapped = mergeStylePrompt(['golden-hour'], '((sunlight))::1.3\na girl')
  assert.equal(wrapped.split('sunlight').length - 1, 1, '带权重写法的 sunlight 不该再补一遍')
  assert.ok(wrapped.startsWith('golden_hour, backlighting'), '实际：' + wrapped)
  assert.ok(wrapped.endsWith('((sunlight))::1.3\na girl'), '原文本要原样保留：' + wrapped)
  assert.deepEqual(noir.tags.length, 3)
})

test('真词表：每个 tag 都在 data/danbooru/general.jsonl 里', t => {
  const tags = readDict()
  if (tags === null) {
    t.skip('没有 data/danbooru/general.jsonl，跳过词表核对')
    return
  }
  const missing = []
  for (const style of STYLES) {
    for (const tag of style.tags) if (!tags.has(tag)) missing.push(style.id + ' → ' + tag)
  }
  assert.deepEqual(missing, [], '这些 tag 不在词表里：\n' + missing.join('\n'))
})
