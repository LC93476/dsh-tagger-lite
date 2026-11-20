/**
 * tests/refine.test.mjs —— lib/refine.js 的自测（假 llm / 假标签库，不起宿主）。
 *
 * 跑法（本机没有 node 命令）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --test tests/refine.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefiner } from '../lib/refine.js'
import { buildRefineSystemPrompt } from '../lib/purge.js'

const silent = { info() {}, warn() {}, error() {} }

// 假标签库的"已知词"：键是归一化 tag，值是中文名
const CN = {
  '1girl': '一个女孩',
  '1boy': '一个男孩',
  solo: '单人',
  long_hair: '长发',
  blue_eyes: '蓝眼睛',
  smile: '微笑',
  backlighting: '逆光',
  cityscape: '城市',
  night: '夜晚',
  bedroom: '卧室',
  indoors: '室内',
  dusk: '黄昏',
  school_uniform: '校服',
  classroom: '教室',
  window: '窗户',
  wet_skin: '湿皮肤',
}

function tagKey(raw) {
  return String(raw).trim().toLowerCase().replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '')
}

function fakeTags(map = CN) {
  const known = new Map(Object.entries(map).map(([key, cn]) => [tagKey(key), cn]))
  return {
    stats: () => ({ loaded: known.size, ready: true }),
    canonicalizeMany(list) {
      return list.map(raw => {
        const key = tagKey(raw)
        const matched = known.has(key)
        return {
          raw,
          tag: key,
          weight: 1,
          matched,
          cn: matched ? known.get(key) : '',
          kind: matched ? 'general' : 'unknown',
        }
      })
    },
  }
}

function makeConfig(patch = {}) {
  return {
    llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: '', maxTokens: 4000, timeoutMs: 3000 },
    purge: { enabled: true, level: 'full', extraDirectives: [], ...(patch.purge ?? {}) },
    tags: { standards: ['wd', 'camie'], maxTags: 40, weightSyntax: 'comfy', chineseAlias: true, ...(patch.tags ?? {}) },
    refine: {
      mode: 'add',
      maxNewTags: 12,
      temperature: 0.4,
      maxTokens: 3000,
      timeoutMs: 3000,
      keepOrder: true,
      ...(patch.refine ?? {}),
    },
  }
}

function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* emit() {
        for (const chunk of chunks) {
          if (typeof chunk === 'function') {
            await chunk()
            continue
          }
          yield chunk
        }
      })()
    },
  }
}

function jsonStream(value, options = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const cut = options.cut ?? Math.max(1, Math.floor(text.length / 2))
  return fakeLlm([
    { type: 'text-delta', index: 0, text: text.slice(0, cut) },
    { type: 'text-delta', index: 0, text: text.slice(cut) },
    { type: 'finish', kind: 'stop', ...(options.usage === undefined ? {} : { usage: options.usage }) },
  ])
}

/** @param {{ config?: object, llm?: object, tags?: object, spi?: object }} [deps] 缺省项各自回落到默认 */
function makeRefiner({ config, llm, tags, spi } = {}) {
  return createRefiner({
    config: config ?? makeConfig(),
    llm,
    tags: tags ?? fakeTags(),
    logger: silent,
    ...spi === undefined ? {} : { spi },
  })
}

test('modes 与 system 提示词：四档 + 精修契约 + 破甲层同档位', async () => {
  const refiner = makeRefiner({ llm: jsonStream({ add: [] }) })
  assert.deepEqual(refiner.modes, ['add', 'edit', 'prune', 'weights'])

  const system = buildRefineSystemPrompt(makeConfig())
  assert.ok(system.includes('精修'))
  assert.ok(system.includes('"add"'))
  assert.ok(system.includes('覆盖'))
  assert.ok(system.length > 2000)
})

test('add：只补缺失、不动已有权重与顺序，cn 回填', async () => {
  const llm = jsonStream({ add: ['blue_eyes'], remove: [], weights: [], notes: '补蓝眼' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, (solo:1.2), long_hair',
    instruction: '加一双蓝眼睛',
  })

  assert.equal(result.ok, true)
  assert.equal(result.error, undefined)
  assert.equal(result.mode, 'add')
  assert.equal(result.positive, '1girl, (solo:1.2), long_hair, blue_eyes')
  assert.deepEqual(result.delta, { added: ['blue_eyes'], removed: [], weighted: [] })
  assert.equal(result.ops, 1)
  assert.equal(result.notes, '补蓝眼')
  assert.equal(result.negative, '')
  assert.equal(result.purgeLevel, 'full')
  assert.equal(result.tags.length, 4)
  assert.equal(result.tags[1].tag, 'solo')
  assert.equal(result.tags[1].weight, 1.2)
  assert.equal(result.tags[3].cn, '蓝眼睛')
  assert.deepEqual(result.warnings, [])

  const call = llm.calls[0]
  assert.equal(call.maxTokens, 3000)
  assert.equal(call.temperature, 0.4)
  assert.ok(call.signal instanceof AbortSignal)
  assert.ok(call.system.includes('精修器'))
  assert.equal(call.messages[0].role, 'user')
  const userText = call.messages[0].content[0].text
  assert.ok(userText.includes('1girl, (solo:1.2), long_hair'))
  assert.ok(userText.includes('加一双蓝眼睛'))
  assert.ok(userText.includes('【精修模式】add'))
})

test('edit：删掉冲突标签并补新标签', async () => {
  const llm = jsonStream({
    add: ['night', 'indoors'],
    remove: ['backlighting', 'cityscape'],
    weights: [],
    notes: '换夜景室内',
  })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, solo, backlighting, cityscape',
    instruction: '改成夜里室内，不要逆光',
    mode: 'edit',
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, solo, night, indoors')
  assert.deepEqual(result.delta.added, ['night', 'indoors'])
  assert.deepEqual(result.delta.removed, ['backlighting', 'cityscape'])
  assert.equal(result.ops, 4)
  assert.equal(result.tags.length, 4)
})

test('prune：只删不新增，模型硬塞的 add 被忽略并记 warning', async () => {
  const llm = jsonStream({ add: ['blue_eyes'], remove: ['solo'], weights: [], notes: '去冗余' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, solo, smile, long_hair',
    instruction: '删掉多余的单人标记',
    mode: 'prune',
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, smile, long_hair')
  assert.deepEqual(result.delta.added, [])
  assert.deepEqual(result.delta.removed, ['solo'])
  assert.ok(result.warnings.some(text => text.includes('prune 模式不新增')))
})

test('weights：只改权重、顺序与标签集合不变', async () => {
  const llm = jsonStream({ add: [], remove: [], weights: [{ tag: 'solo', weight: 0.8 }], notes: '弱化单人' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, solo, long_hair',
    instruction: '把单人标记弱化到 0.8',
    mode: 'weights',
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, (solo:0.8), long_hair')
  assert.deepEqual(result.delta.added, [])
  assert.deepEqual(result.delta.removed, [])
  assert.deepEqual(result.delta.weighted, [{ tag: 'solo', from: 1, to: 0.8 }])
  assert.equal(result.ops, 1)
  assert.deepEqual(result.tags.map(row => row.tag), ['1girl', 'solo', 'long_hair'])
})

test('add/remove/weights 三个 delta 字段同时正确（edit 模式）', async () => {
  const llm = jsonStream({
    add: ['night'],
    remove: ['backlighting'],
    weights: [{ tag: 'solo', weight: 1.3 }],
    notes: '三件事都做了',
  })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, solo, backlighting',
    instruction: '改成夜景，强化单人',
    mode: 'edit',
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, (solo:1.3), night')
  assert.deepEqual(result.delta.added, ['night'])
  assert.deepEqual(result.delta.removed, ['backlighting'])
  assert.deepEqual(result.delta.weighted, [{ tag: 'solo', from: 1, to: 1.3 }])
  assert.equal(result.ops, 3)
})

test('库里没有的 tag 被丢弃并留 warning，原串保持不变', async () => {
  const llm = jsonStream({ add: ['moonlight_glow'], remove: [], weights: [], notes: '' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '1girl, solo', instruction: '加月光' })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, solo')
  assert.deepEqual(result.delta.added, [])
  assert.ok(result.warnings.some(text => text.includes('moonlight_glow 不在库里，已丢弃')))
})

test('maxNewTags 截断生效', async () => {
  const llm = jsonStream({ add: ['night', 'indoors', 'bedroom', 'dusk'], remove: [], weights: [] })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl',
    instruction: '加点夜景',
    options: { maxNewTags: 2 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, night, indoors')
  assert.deepEqual(result.delta.added, ['night', 'indoors'])
  assert.ok(result.warnings.some(text => text.includes('maxNewTags(2)')))
})

test('keepOrder=true 默认保持原顺序（模型给的 order 不生效）', async () => {
  const llm = jsonStream({ add: ['blue_eyes'], remove: [], weights: [], order: ['blue_eyes', '1girl'], notes: '' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '1girl, solo', instruction: '加蓝眼' })
  assert.equal(result.positive, '1girl, solo, blue_eyes')
})

test('keepOrder=false 允许按 order 重排', async () => {
  const llm = jsonStream({ add: ['blue_eyes'], remove: [], weights: [], order: ['blue_eyes', 'solo', '1girl'], notes: '' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl, solo',
    instruction: '加蓝眼，把蓝眼放最前',
    options: { keepOrder: false },
  })

  assert.equal(result.ok, true)
  assert.equal(result.positive, 'blue_eyes, solo, 1girl')
  assert.deepEqual(result.tags.map(row => row.tag), ['blue_eyes', 'solo', '1girl'])
})

test('markdown 围栏包裹的 JSON 也能解析', async () => {
  // 围栏用字符码拼，避免测试文件里出现真换行 / 反引号干扰
  const fence = String.fromCharCode(96, 96, 96)
  const body = [
    '好的，这是差分：',
    fence + 'json',
    '{"add":["wet_skin"],"remove":[],"weights":[],"notes":"围栏测试"}',
    fence,
    '希望有用。',
  ].join('\n')
  const refiner = makeRefiner({ llm: jsonStream(body) })
  const result = await refiner.refine({ positive: '1girl, solo', instruction: '加湿皮肤' })

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(result.positive, '1girl, solo, wet_skin')
  assert.equal(result.notes, '围栏测试')
})

test('空 positive + add 模式能工作', async () => {
  const llm = jsonStream({ add: ['1girl', 'classroom'], remove: [], weights: [], notes: '从零补' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '', instruction: '一个女孩在教室' })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, classroom')
  assert.deepEqual(result.delta.added, ['1girl', 'classroom'])
  assert.equal(result.tags.length, 2)
})

test('空 positive + weights 模式返回 ok:false（没有可调的对象）', async () => {
  const refiner = makeRefiner({ llm: jsonStream({ weights: [] }) })
  const result = await refiner.refine({ positive: '', instruction: '强化一点', mode: 'weights' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'empty-positive')
})

test('模型抛错：ok:false，不冒到调用方', async () => {
  const llm = {
    stream() {
      throw new Error('boom 400')
    },
  }
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '1girl', instruction: '加点东西' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'llm-error')
  assert.ok(result.message.includes('boom 400'))
  assert.deepEqual(result.delta, { added: [], removed: [], weighted: [] })
  assert.equal(result.positive, '1girl')
  assert.ok(Array.isArray(result.warnings))
})

test('模型 finish=error（400）：ok:false 且 error 用 failure.code', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '{"add":' },
    { type: 'finish', kind: 'error', failure: { code: 'http-400', message: '模型返回 400' } },
  ])
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '1girl', instruction: '加点东西' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'http-400')
  assert.equal(result.message, '模型返回 400')
})

test('模型超时：ok:false + timeout，不抛', async () => {
  const llm = {
    stream() {
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: '{"add":' }
        await new Promise(resolve => setTimeout(resolve, 800))
      })()
    },
  }
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({
    positive: '1girl',
    instruction: '加点东西',
    options: { timeoutMs: 120 },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
})

test('JSON 完全解析不出来：bad-json，不抛', async () => {
  const refiner = makeRefiner({ llm: jsonStream('抱歉，我做不到这件事。') })
  const result = await refiner.refine({ positive: '1girl', instruction: '加点东西' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad-json')
})

test('没有 llm 服务：no-llm', async () => {
  const refiner = makeRefiner({})
  const result = await refiner.refine({ positive: '1girl', instruction: '加点东西' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-llm')
})

test('空 instruction：empty-instruction', async () => {
  const refiner = makeRefiner({ llm: jsonStream({ add: [] }) })
  const result = await refiner.refine({ positive: '1girl', instruction: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'empty-instruction')
})

test('SPI：beforeRefine / afterRefine 都发，postProcessors 能改结果', async () => {
  const emitted = []
  const spi = {
    async emit(name, payload) {
      emitted.push({ name, payload })
    },
    async applyPostProcessors(result) {
      return { ...result, notes: result.notes + '（spi）' }
    },
  }
  const llm = jsonStream({ add: ['blue_eyes'], remove: [], weights: [], notes: '原话' })
  const refiner = makeRefiner({ llm, spi })
  const result = await refiner.refine({ positive: '1girl', instruction: '加蓝眼' })

  assert.deepEqual(emitted.map(item => item.name), ['beforeRefine', 'afterRefine'])
  assert.equal(emitted[0].payload.positive, '1girl')
  assert.equal(emitted[0].payload.instruction, '加蓝眼')
  assert.equal(result.ok, true)
  assert.equal(result.notes, '原话（spi）')
})

test('删除不存在的标签只记 warning，不中断', async () => {
  const llm = jsonStream({ add: [], remove: ['not_there'], weights: [], notes: '' })
  const refiner = makeRefiner({ llm })
  const result = await refiner.refine({ positive: '1girl, solo', instruction: '删掉 not_there', mode: 'prune' })

  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, solo')
  assert.deepEqual(result.delta.removed, [])
  assert.ok(result.warnings.some(text => text.includes('not_there 不在现有串里')))
})
