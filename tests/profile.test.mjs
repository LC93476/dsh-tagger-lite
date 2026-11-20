/**
 * tests/profile.test.mjs —— 模型档案（lib/model-profiles.js）与它在配置里的落地（lib/config.js）。
 *
 * 跑法（本机没有 node 命令，用 Electron 当 node）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/profile.test.mjs
 *
 * 覆盖：四个档案的 applyProfile / listProfiles / profileState；normalize 把档案落成生效值
 * （tag 默认 → masterpiece 组、pony → score 组、natural → 不补质量词且不重排、custom 读显式值）；
 * 未知 id 回落 tag；custom 下质量词清洗（小写 / 空格转下划线 / 去空 / 去重 / 截 12）仍然生效。
 * 无外部依赖：node:test + node:assert。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_IDS,
  PROFILES,
  applyProfile,
  listProfiles,
  profileOf,
  profileState,
} from '../lib/model-profiles.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, normalize, resolveConfig } from '../lib/config.js'

test('档案表：四个档齐全，tag 系 masterpiece 组、pony 系 score 组、natural 不补质量词不重排', () => {
  assert.deepEqual(PROFILE_IDS.slice(), ['tag', 'pony', 'natural', 'custom'])
  assert.deepEqual(Object.keys(PROFILES).sort(), ['custom', 'natural', 'pony', 'tag'])

  const tag = profileOf('tag')
  assert.equal(tag.style, 'tag')
  assert.equal(tag.quality, true)
  assert.deepEqual(tag.qualityTags, ['masterpiece', 'best_quality', 'highres'])
  assert.equal(tag.order, true)

  const pony = profileOf('pony')
  assert.equal(pony.style, 'tag')
  assert.deepEqual(pony.qualityTags, ['score_9', 'score_8_up', 'score_7_up', 'source_anime'])
  assert.equal(pony.order, true)

  const natural = profileOf('natural')
  assert.equal(natural.style, 'prose', '自然语言档的写法是整句/短语，不是 tag 串')
  assert.equal(natural.quality, false)
  assert.deepEqual(natural.qualityTags, [])
  assert.equal(natural.order, false)

  // custom 是「不接管」：三个值都是 null，读配置自己的
  assert.equal(PROFILES.custom.quality, null)
  assert.equal(PROFILES.custom.qualityTags, null)
  assert.equal(PROFILES.custom.order, null)
  assert.equal(PROFILES.custom.style, 'tag')
})

test('profileOf / listProfiles：未知 id 一律回 tag，清单给的是生效值', () => {
  assert.equal(profileOf('PONY ').id, 'pony', '大小写与空格要容忍')
  assert.equal(profileOf('no-such-profile').id, 'tag')
  assert.equal(profileOf(undefined).id, 'tag')
  assert.equal(profileOf(42).id, 'tag')

  const list = listProfiles()
  assert.deepEqual(list.map(function (p) { return p.id }), PROFILE_IDS.slice())
  for (const item of list) {
    assert.equal(typeof item.title, 'string')
    assert.ok(item.title.length > 0)
    assert.equal(typeof item.note, 'string')
    assert.ok(Array.isArray(item.qualityTags))
  }
  const tag = list.find(function (p) { return p.id === 'tag' })
  assert.equal(tag.quality, true)
  assert.ok(tag.qualityTags.includes('masterpiece'))
  const natural = list.find(function (p) { return p.id === 'natural' })
  assert.equal(natural.quality, false)
  assert.equal(natural.order, false)
  // custom 在清单里不接管（quality: null 按 listProfiles 的口径折算成 false / order 折算成 true），
  // 面板要显示生效值请看 profileState(cfg).controlled 与 current。
  const custom = list.find(function (p) { return p.id === 'custom' })
  assert.equal(custom.quality, false)
  assert.equal(custom.order, true)
})

test('applyProfile：前三个档接管 quality / qualityTags / order，custom 回读配置', () => {
  const base = { forge: { quality: false, order: false }, tags: { qualityTags: ['my_word'] } }

  assert.deepEqual(
    applyProfile({ ...base, forge: { ...base.forge, profile: 'tag' } }),
    { id: 'tag', style: 'tag', quality: true, qualityTags: ['masterpiece', 'best_quality', 'highres'], order: true },
  )
  const pony = applyProfile({ ...base, forge: { ...base.forge, profile: 'pony' } })
  assert.deepEqual(pony.qualityTags, ['score_9', 'score_8_up', 'score_7_up', 'source_anime'])
  assert.equal(pony.quality, true)
  assert.equal(pony.order, true)

  assert.deepEqual(
    applyProfile({ ...base, forge: { ...base.forge, profile: 'natural' } }),
    { id: 'natural', style: 'prose', quality: false, qualityTags: [], order: false },
  )
  assert.deepEqual(
    applyProfile({ ...base, forge: { ...base.forge, profile: 'custom' } }),
    { id: 'custom', style: 'tag', quality: false, qualityTags: ['my_word'], order: false },
  )

  // 旧配置里没有 profile ＝ tag 档，行为与以前一致
  const legacy = applyProfile({ tags: { qualityTags: ['masterpiece'] } })
  assert.equal(legacy.id, 'tag')
  assert.equal(legacy.quality, true)
  assert.equal(legacy.order, true)
  assert.deepEqual(legacy.qualityTags, ['masterpiece', 'best_quality', 'highres'])
})

test('profileState：状态卡带 title / note / style 与生效值，并标出是否被档案接管', () => {
  const tag = profileState({ forge: { profile: 'tag' } })
  assert.equal(tag.id, 'tag')
  assert.equal(tag.title, PROFILES.tag.title)
  assert.equal(tag.note, PROFILES.tag.note)
  assert.equal(tag.style, 'tag')
  assert.equal(tag.controlled, true, 'tag 档的质量词由档案接管')
  assert.ok(tag.qualityTags.includes('masterpiece'))
  assert.equal(tag.order, true)

  const natural = profileState({ forge: { profile: 'natural' } })
  assert.equal(natural.style, 'prose')
  assert.equal(natural.quality, false)
  assert.equal(natural.order, false)
  assert.deepEqual(natural.qualityTags, [])

  const custom = profileState({ forge: { profile: 'custom', quality: false, order: false }, tags: { qualityTags: ['absurdres'] } })
  assert.equal(custom.controlled, false, 'custom 档不接管，面板上的值就是用户自己填的')
  assert.equal(custom.quality, false)
  assert.equal(custom.order, false)
  assert.deepEqual(custom.qualityTags, ['absurdres'])
})

test('normalize：档案落成生效值（tag 默认 / pony / natural / custom），未知 id 回落 tag', () => {
  const def = normalize({})
  assert.equal(def.forge.profile, 'tag')
  assert.equal(def.forge.quality, true)
  assert.equal(def.forge.order, true)
  assert.deepEqual(def.tags.qualityTags, DEFAULTS.tags.qualityTags)

  // 向后兼容：settings.json 里没有 forge.profile 时默认 tag，行为与改造前完全一致
  const legacy = normalize({ forge: { quality: true } })
  assert.equal(legacy.forge.profile, 'tag')
  assert.equal(legacy.forge.order, true)
  assert.deepEqual(legacy.tags.qualityTags, ['masterpiece', 'best_quality', 'highres'])

  const pony = normalize({ forge: { profile: 'pony' } })
  assert.equal(pony.forge.profile, 'pony')
  assert.equal(pony.forge.quality, true)
  assert.equal(pony.forge.order, true)
  assert.deepEqual(pony.tags.qualityTags, ['score_9', 'score_8_up', 'score_7_up', 'source_anime'])

  // natural：面板上再改 quality / qualityTags 也会被档案盖掉（面板看到的就是生效值）
  const natural = normalize({ forge: { profile: 'natural', quality: true }, tags: { qualityTags: ['masterpiece'] } })
  assert.equal(natural.forge.profile, 'natural')
  assert.equal(natural.forge.quality, false)
  assert.equal(natural.forge.order, false)
  assert.deepEqual(natural.tags.qualityTags, [])

  // custom：三个值都读配置，但质量词仍要清洗（小写 / 空格转下划线 / 去空 / 去重）
  const custom = normalize({
    forge: { profile: 'custom', quality: false, order: false },
    tags: { qualityTags: ['  High Res ', 'high_res', ''] },
  })
  assert.equal(custom.forge.profile, 'custom')
  assert.equal(custom.forge.quality, false)
  assert.equal(custom.forge.order, false)
  assert.deepEqual(custom.tags.qualityTags, ['high_res'])

  // 未知 id 回落 tag（面板永远拿得到可用值）
  const bogus = normalize({ forge: { profile: 'Midjourney' } })
  assert.equal(bogus.forge.profile, 'tag')
  assert.equal(bogus.forge.quality, true)
  assert.deepEqual(bogus.tags.qualityTags, ['masterpiece', 'best_quality', 'highres'])
})

test('resolveConfig：没选档案但手改过质量词/开关的老配置按 custom 处理，显式 profile 优先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  const settings = path.join(dir, 'settings.json')
  const prev = process.env.DSH_TAGGER_DATA
  process.env.DSH_TAGGER_DATA = dir
  try {
    // 老用户：只改过 tags.qualityTags，settings.json 里没有 forge.profile
    fs.writeFileSync(settings, JSON.stringify({ tags: { qualityTags: ['my_word'] } }), 'utf8')
    const legacy = resolveConfig({})
    assert.equal(legacy.forge.profile, 'custom', '手改过质量词就别按默认 tag 档接管')
    assert.deepEqual(legacy.tags.qualityTags, ['my_word'], '用户自己填的质量词要留着')
    assert.equal(legacy.forge.quality, true)

    // 只改过 forge.quality 也算（加档案前它是唯一的开关）
    fs.writeFileSync(settings, JSON.stringify({ forge: { quality: false } }), 'utf8')
    const quiet = resolveConfig({})
    assert.equal(quiet.forge.profile, 'custom')
    assert.equal(quiet.forge.quality, false)

    // 显式选过档案：settings.json 里的质量词不再把档位拽回 custom
    assert.equal(resolveConfig({ forge: { profile: 'natural' } }).forge.profile, 'natural')
    fs.writeFileSync(settings, JSON.stringify({ forge: { profile: 'pony' }, tags: { qualityTags: ['my_word'] } }), 'utf8')
    assert.equal(resolveConfig({}).forge.profile, 'pony')

    // 什么都没改 → 默认 tag 档
    fs.writeFileSync(settings, JSON.stringify({ server: { port: 7799 } }), 'utf8')
    assert.equal(resolveConfig({}).forge.profile, 'tag')
  } finally {
    if (prev === undefined) delete process.env.DSH_TAGGER_DATA
    else process.env.DSH_TAGGER_DATA = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
