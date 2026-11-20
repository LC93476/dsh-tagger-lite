/**
 * tests/forge.test.mjs —— lib/forge.js + lib/purge.js 的自测。
 *
 * 本机没有 node 命令，用宿主 Electron 的 node 跑（在 D:/DSh tagger-lite 下）：
 *   ELECTRON_RUN_AS_NODE=1 "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" tests/forge.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createForge } from '../lib/forge.js'
import { closeUnbalanced, repairJsonText } from '../lib/forge/parse.js'
import { createPipelineRunner } from '../lib/forge/pipeline.js'
import {
  PURGE_LEVELS,
  PURGE_LEVEL_LABELS,
  agentDirective,
  buildForgeSystemPrompt,
  purgeDirective,
  purgeState,
  tagSpecText,
} from '../lib/purge.js'

const silent = { info() {}, warn() {}, error() {} }

const KNOWN = [
  '1girl', '1boy', 'solo', 'long_hair', 'blue_eyes', 'smile', 'bedroom',
  'worst_quality', 'lowres', 'censored', 'sex', 'cowgirl_position', 'explicit',
  // 质量词：库里真有的评分词（现编的 highly_detailed 之类故意不放，用来验证伪词会被丢）
  'masterpiece', 'best_quality', 'highres', 'absurdres', 'very_aesthetic',
]

function tagKey(raw) {
  return String(raw).trim().toLowerCase().replace(/\s+/g, '_')
}

function makeConfig(patch = {}) {
  return {
    llm: {
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: '',
      maxTokens: 2200,
      timeoutMs: 3000,
      ...(patch.llm ?? {}),
    },
    purge: { enabled: true, level: 'full', extraDirectives: [], ...(patch.purge ?? {}) },
    tags: { standards: ['wd', 'camie'], maxTags: 40, weightSyntax: 'comfy', chineseAlias: true, ...(patch.tags ?? {}) },
    comfy: {
      baseUrl: 'http://127.0.0.1:8188',
      workflowDir: '',
      defaultWorkflowId: '',
      positiveNode: '',
      negativeNode: '',
      pollIntervalMs: 1000,
      timeoutMs: 900000,
    },
    // 这些用例断言的是完整正向串；质量词默认会顶到最前面把期望值全打乱，
    // 所以默认关掉，需要验证质量词的用例自己 makeConfig({ forge: { quality: true } })。
    forge: { quality: false, ...(patch.forge ?? {}) },
    ui: { keepHistory: 20, ...(patch.ui ?? {}) },
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-forge-'))
}

function fakeTags(known = KNOWN, options = {}) {
  const set = new Set(known.map(tagKey))
  const index = {
    stats: () => ({ loaded: set.size, ready: options.ready !== false, builtAt: null, sourceFiles: [] }),
    // 修复器要靠 get() 判断"改写后的拼写库里到底有没有"，假索引也得给一份。
    get(raw) {
      const tag = tagKey(raw)
      return set.has(tag) ? { tag, kind: 'general', cn: '' } : undefined
    },
    canonicalizeMany(list) {
      return list.map(raw => {
        const tag = tagKey(raw)
        const matched = set.has(tag)
        const row = { raw, tag, weight: 1, matched }
        if (matched) row.kind = 'general'
        return row
      })
    },
  }
  if (options.formatTagString === true) {
    index.formatTagString = (rows, { syntax }) => rows
      .map(row => {
        const weight = row.weight ?? 1
        if (syntax === 'plain' || Math.abs(weight - 1) < 0.005) return row.tag
        return '(' + row.tag + ':' + weight + ')'
      })
      .join(' | ')
  }
  return index
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

function hangingLlm(delayMs = 1200) {
  return {
    stream() {
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: '{"positive":[' }
        await new Promise(resolve => setTimeout(resolve, delayMs))
      })()
    },
  }
}

/** @param {{ config?: object, llm?: object, tags?: object, dir?: string }} [deps] 缺省项各自回落到默认 */
function makeForge({ config, llm, tags, dir } = {}) {
  return createForge({
    config: config ?? makeConfig(),
    llm,
    tags: tags ?? fakeTags(),
    logger: silent,
    dir: dir ?? tempDir(),
  })
}

test('正常 JSON：流式拼串、权重格式化、调用参数、history 落盘', async () => {
  const dir = tempDir()
  const payload = {
    positive: [
      { tag: '1girl', weight: 1 },
      { tag: 'solo', weight: 1.2 },
      { tag: 'long_hair', weight: 1 },
    ],
    negative: [{ tag: 'worst quality', weight: 1 }],
    notes: '补了窗边背景光',
  }
  const llm = jsonStream(payload, { cut: 17, usage: { inputTokens: 120, outputTokens: 64 } })
  const forge = makeForge({ llm, dir })
  const result = await forge.generate({ text: '一个长发的女孩，蓝色眼睛，笑着站在窗边' })

  assert.equal(result.ok, true)
  assert.equal(result.error, undefined)
  assert.equal(result.positive, '1girl, (solo:1.2), long_hair')
  assert.equal(result.negative, '', '负向由 ComfyUI 内置，锻造结果不带负向')
  assert.equal(result.repaired, false)
  assert.deepEqual(result.standards, ['wd', 'camie'])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.notes, '补了窗边背景光')
  assert.equal(result.model, 'deepseek-v4.1-flash')
  assert.equal(result.provider, 'opencode-go')
  assert.equal(result.tags.length, 3)
  assert.equal(result.tags[1].tag, 'solo')
  assert.equal(result.tags[1].weight, 1.2)
  assert.equal(result.negativeTags.length, 0, '模型给的负向一律丢掉')
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 64 })
  assert.ok(result.raw.includes('long_hair'))
  assert.ok(result.ms >= 0)

  const call = llm.calls[0]
  assert.equal(call.provider, 'opencode-go')
  assert.equal(call.model, 'deepseek-v4.1-flash')
  assert.equal(call.maxTokens, 2200)
  assert.equal(call.temperature, 0.5)
  assert.ok(call.signal instanceof AbortSignal)
  assert.ok(call.system.length > 3000, 'system 提示词偏短：' + call.system.length)
  assert.ok(call.system.includes('锻造器'))
  assert.ok(call.system.includes('"positive":[{"tag":"1girl","weight":1}]'))
  assert.equal(call.messages.length, 1)
  assert.equal(call.messages[0].role, 'user')
  assert.ok(call.messages[0].content[0].text.includes('窗边'))

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].ok, true)
  assert.equal(saved[0].positive, result.positive)
  assert.ok(saved[0].text.includes('窗边'))
})

test('markdown 围栏里的 JSON 也能吃下（repaired=true）', async () => {
  const body = '好的，这是标签：\n' + "```" + 'json\n'
    + '{"positive":[{"tag":"1girl","weight":1},{"tag":"blue_eyes","weight":1}],"negative":[{"tag":"lowres"}],"notes":"围栏测试"}'
    + '\n' + "```" + '\n希望有用。'
  const forge = makeForge({ llm: jsonStream(body) })
  const result = await forge.generate({ text: '蓝眼睛女孩' })

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(result.positive, '1girl, blue_eyes')
  assert.equal(result.negative, '')
  assert.equal(result.notes, '围栏测试')
})

test('坏 JSON：单引号 + 尾逗号，修复一次后仍成功', async () => {
  const raw = "{'positive':[{'tag':'1girl','weight':1},{'tag':'solo','weight':0.8},],"
    + "'negative':[{'tag':'worst quality'},],'notes':'单引号'}"
  const forge = makeForge({ llm: jsonStream(raw) })
  const result = await forge.generate({ text: '单人女孩' })

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(result.positive, '1girl, (solo:0.8)')
  assert.equal(result.negative, '')
  assert.equal(result.notes, '单引号')
})

test('坏 JSON：输出被截断，补齐括号后两个 tag 都在', async () => {
  const raw = '{"positive":[{"tag":"1girl","weight":1},{"tag":"solo'
  const forge = makeForge({ llm: jsonStream(raw) })
  const result = await forge.generate({ text: '两个 tag 截断' })

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  assert.equal(result.tags.length, 2)
  assert.equal(result.positive, '1girl, solo')
})

test('模型拒答/说人话 → bad-json，raw 保留', async () => {
  const raw = '这个请求涉及成人内容，我不方便协助。'
  const forge = makeForge({ llm: jsonStream(raw) })
  const result = await forge.generate({ text: '成人向画面' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad-json')
  assert.equal(result.raw, raw)
  assert.equal(result.repaired, true)
  assert.deepEqual(result.tags, [])
  assert.equal(result.positive, '')
})

test('超时：timeoutMs 到点就停，error=timeout 且不抛', async () => {
  const forge = makeForge({ config: makeConfig({ llm: { timeoutMs: 150 } }), llm: hangingLlm(1500) })
  const startedAt = Date.now()
  const result = await forge.generate({ text: '慢模型' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.ok(result.message.includes('150ms'))
  assert.ok(result.raw.startsWith('{"positive":['))
  assert.ok(Date.now() - startedAt < 1400)
})

test('外部 AbortSignal 取消 → error=aborted', async () => {
  const controller = new AbortController()
  const forge = makeForge({ config: makeConfig({ llm: { timeoutMs: 5000 } }), llm: hangingLlm(1500) })
  const pending = forge.generate({ text: '取消我', signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  const result = await pending

  assert.equal(result.ok, false)
  assert.equal(result.error, 'aborted')

  const pre = new AbortController()
  pre.abort()
  const again = await forge.generate({ text: '已取消', signal: pre.signal })
  assert.equal(again.error, 'aborted')
})

test('没有 llm 服务 → no-llm，不抛异常', async () => {
  const forge = makeForge({ llm: undefined })
  const result = await forge.generate({ text: '没有 llm' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-llm')
  assert.ok(result.message.includes('llm 服务'))
  assert.deepEqual(result.tags, [])
  assert.deepEqual(result.warnings, [])
})

test('finish kind=error → 用 failure.code / failure.message', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '{"positive":[' },
    { type: 'finish', kind: 'error', failure: { code: 'rate_limit', message: '429 Too Many Requests' } },
  ])
  const result = await makeForge({ llm }).generate({ text: '限流' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'rate_limit')
  assert.equal(result.message, '429 Too Many Requests')
})

test('finish kind=max-tokens → error=max-tokens', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '{"positive":[{"tag":"1girl"}]}' },
    { type: 'finish', kind: 'max-tokens' },
  ])
  const result = await makeForge({ llm }).generate({ text: '截断' })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'max-tokens')
  assert.ok(result.raw.includes('1girl'))
})

test('截断自动翻倍重试：第一次被截断，第二次成功并留 warning', async () => {
  const calls = []
  const llm = {
    calls,
    stream(options) {
      calls.push(options)
      const truncated = calls.length === 1
      return (async function* emit() {
        yield {
          type: 'text-delta',
          index: 0,
          text: truncated ? '{"positive":[{"tag":"1girl"}' : '{"positive":[{"tag":"1girl"},{"tag":"solo"}]}',
        }
        yield { type: 'finish', kind: truncated ? 'max-tokens' : 'stop' }
      })()
    },
  }
  const result = await makeForge({ llm }).generate({ text: '很长很细的描述' })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].maxTokens, 2200)
  assert.equal(calls[1].maxTokens, 4400)
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some(w => w.includes('截断')), JSON.stringify(result.warnings))
})

test('权重格式化：comfy 带括号、plain 丢权重、formatTagString 优先', async () => {
  const payload = {
    positive: [{ tag: '1girl', weight: 1.3 }, { tag: 'solo', weight: 0.8 }, { tag: 'smile', weight: 1 }],
  }
  const comfy = await makeForge({ llm: jsonStream(payload) }).generate({ text: 'x' })
  assert.equal(comfy.positive, '(1girl:1.3), (solo:0.8), smile')

  const plain = await makeForge({
    config: makeConfig({ tags: { weightSyntax: 'plain' } }),
    llm: jsonStream(payload),
  }).generate({ text: 'x' })
  assert.equal(plain.positive, '1girl, solo, smile')

  const delegated = await makeForge({
    llm: jsonStream(payload),
    tags: fakeTags(KNOWN, { formatTagString: true }),
  }).generate({ text: 'x' })
  assert.equal(delegated.positive, '(1girl:1.3) | (solo:0.8) | smile')
})

test('库里没有的词进 warnings；库未就绪时补一句说明', async () => {
  const payload = {
    positive: [{ tag: '1girl' }, { tag: 'gigantic_hat' }, { tag: 'nonsense_word' }],
  }
  const forge = makeForge({ llm: jsonStream(payload), tags: fakeTags(KNOWN, { ready: false }) })
  const result = await forge.generate({ text: '帽子' })

  assert.equal(result.ok, true)
  assert.ok(result.warnings.includes('gigantic_hat 不在库里'))
  assert.ok(result.warnings.includes('nonsense_word 不在库里'))
  assert.ok(result.warnings.includes('标签库尚未就绪，本条未做全量校对'))
})

test('库里没有但词根认得出桶的词，插回后仍归到它那一段（不打乱词序）', async () => {
  // soft_lighting 不在 fake 词库里（真实快照里也没有），但词根规则能认出是光照段。
  const payload = {
    positive: [{ tag: '1girl' }, { tag: 'soft_lighting' }, { tag: 'from_side' }, { tag: 'smile' }],
  }
  const forge = makeForge({ llm: jsonStream(payload), tags: fakeTags(KNOWN) })
  const result = await forge.generate({ text: '柔光，侧面' })

  assert.ok(result.warnings.includes('soft_lighting 不在库里'))
  assert.equal(result.positive, '1girl, smile, from_side, soft_lighting', '不在库里也不许打断段落顺序：主体 → 表情 → 镜头 → 光照')
})
test('超过 maxTags 截断并给 warning', async () => {
  const payload = { positive: Array.from({ length: 12 }, (_, i) => ({ tag: 'solo', weight: 1, cn: 'c' + i })) }
  const tags = fakeTags(KNOWN)
  const forge = makeForge({ config: makeConfig({ tags: { maxTags: 8 } }), llm: jsonStream(payload), tags })
  const result = await forge.generate({ text: '一堆 tag' })

  assert.equal(result.ok, true)
  assert.equal(result.tags.length, 1, '12 个同名 tag 应该先去重')
  assert.deepEqual(result.warnings, [])

  const varied = { positive: Array.from({ length: 12 }, (_, i) => ({ tag: 'tag_' + i, weight: 1 })) }
  const second = await makeForge({
    config: makeConfig({ tags: { maxTags: 8 } }),
    llm: jsonStream(varied),
    tags,
  }).generate({ text: '12 个不同 tag' })

  assert.equal(second.tags.length, 8)
  assert.ok(second.warnings.includes('正向 12 条超过上限，已截到 8 条'))
})

test('options：显式 negative 是唯一负向来源、standards 覆盖、字符串形式正向也能吃', async () => {
  const payload = { positive: '1girl, solo, (smile:1.2)', negative: 'worst quality' }
  const forge = makeForge({ llm: jsonStream(payload) })
  const result = await forge.generate({
    text: '串形式的标签',
    options: { standards: ['camie'], negative: 'blurry, extra_digits', maxTags: 12 },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.standards, ['camie'])
  assert.equal(result.positive, '1girl, solo, (smile:1.2)')
  const negativeText = result.negative
  assert.ok(negativeText.includes('blurry'))
  assert.ok(negativeText.includes('extra_digits'))
  assert.equal(negativeText.includes('worst_quality'), false, '模型给的负向不该混进来')
})

test('画质词：库里真有的评分词交给后处理置顶，模型现编的丢掉', async () => {
  const payload = {
    positive: [{ tag: '1girl' }, { tag: 'masterpiece' }, { tag: 'best_quality' }, { tag: 'highres' }, { tag: 'smile' }],
    negative: [{ tag: 'worst quality' }],
  }
  const result = await makeForge({ llm: jsonStream(payload) }).generate({ text: '女孩微笑' })
  assert.equal(result.ok, true)
  assert.equal(result.positive, '1girl, smile')
  assert.equal(result.negative, '')
  assert.equal(result.negativeTags.length, 0)
  assert.equal(result.warnings.some(text => text.includes('画质词')), false, '真评分词不算「现编」，不报警告')

  // 模型现编的画质词（highly_detailed / extremely_detailed）也要按画质词处理
  const invented = {
    positive: [{ tag: '1girl' }, { tag: 'highly_detailed' }, { tag: 'extremely_detailed' }, { tag: 'detailed_skin' }, { tag: 'smile' }],
  }
  const cleaned = await makeForge({ llm: jsonStream(invented) }).generate({ text: '女孩微笑' })
  assert.equal(cleaned.positive, '1girl, detailed_skin, smile', 'highly_detailed 清掉，但 detailed_skin 这种画面词要留')
  assert.ok(cleaned.warnings.some(text => text.includes('去掉现编的画质词') && text.includes('highly_detailed')))

  // 打开质量词后，同样这组输入会在串首补一组，模型写过的 masterpiece 并进来、权重更高
  const withQuality = makeForge({ config: makeConfig({ forge: { quality: true } }), llm: jsonStream(payload) })
  const boosted = await withQuality.generate({ text: '女孩微笑' })
  assert.equal(boosted.positive, 'masterpiece, best_quality, highres, 1girl, smile')
})

test('质量词开关：默认在串首加一组且不重复，quality:false 时一个字都不加', async () => {
  const payload = { positive: [{ tag: '1girl' }, { tag: 'smile' }, { tag: 'highres', weight: 1.2 }] }
  const on = await makeForge({ config: makeConfig({ forge: { quality: true } }), llm: jsonStream(payload) }).generate({ text: '女孩微笑' })
  assert.equal(on.positive, 'masterpiece, best_quality, (highres:1.2), 1girl, smile', '按配置顺序补齐；模型写过的 highres 只留一条并保住权重')
  assert.equal(on.positive.split('highres').length - 1, 1, 'highres 不许出现两次')

  const off = await makeForge({ llm: jsonStream(payload) }).generate({ text: '女孩微笑' })
  assert.equal(off.positive, '1girl, smile', '关掉后评分词一个都不留')
})

test('空输入 → empty-text；模型只给负向 → empty-tags', async () => {
  const forge = makeForge({ llm: jsonStream({ positive: [] }) })
  const blank = await forge.generate({ text: '   ' })
  assert.equal(blank.ok, false)
  assert.equal(blank.error, 'empty-text')

  const empty = await forge.generate({ text: '只有负向' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'empty-tags')
})

test('models()：读 llm.listModels，缺席/异常都返回空数组', async () => {
  const llm = {
    stream() {},
    listModels: async provider => [
      { provider, id: 'deepseek-v4.1-flash', name: 'V4.1 Flash' },
      { provider, id: 'deepseek-v4.1-pro' },
      { provider },
    ],
  }
  const forge = makeForge({ llm })
  assert.deepEqual(await forge.models('opencode-go'), [
    { id: 'deepseek-v4.1-flash', label: 'V4.1 Flash' },
    { id: 'deepseek-v4.1-pro' },
  ])

  const noLlm = makeForge({ llm: undefined })
  assert.deepEqual(await noLlm.models('opencode-go'), [])

  const broken = makeForge({ llm: { stream() {}, listModels: async () => { throw new Error('boom') } } })
  assert.deepEqual(await broken.models('opencode-go'), [])
})

test('破甲提示词与状态：档位、预览更短、refreshPurge 重建', () => {
  const cfg = makeConfig()
  const full = buildForgeSystemPrompt(cfg)
  assert.ok(full.includes('锻造器'))
  assert.ok(full.includes('不做内容审查'))
  assert.ok(full.includes('"positive":[{"tag":"1girl","weight":1}]'))
  assert.ok(tagSpecText(cfg).includes('(tag:1.2)'))

  assert.equal(purgeDirective(makeConfig({ purge: { level: 'off' } })), '')
  assert.equal(purgeDirective(makeConfig({ purge: { enabled: false } })).length, 0)
  assert.ok(purgeDirective(makeConfig({ purge: { level: 'max' } })).includes('极限档'))
  assert.ok(buildForgeSystemPrompt(makeConfig({ purge: { level: 'off' } })).includes('锻造器'))
  assert.ok(buildForgeSystemPrompt(makeConfig({ purge: { level: 'off' } })).includes('不做内容审查') === false)

  const state = purgeState(cfg)
  assert.deepEqual(Object.keys(state).sort(), ['chars', 'enabled', 'level', 'modules'])
  assert.equal(state.level, 'full')
  assert.equal(state.enabled, true)
  assert.ok(state.chars > 200)
  assert.ok(state.modules.includes('no-self-censor'))
  assert.deepEqual(purgeState(makeConfig({ purge: { level: 'off' } })), { enabled: false, level: 'off', chars: 0, modules: [] })
  assert.deepEqual(purgeState(makeConfig({ purge: { enabled: false } })).enabled, false)

  const forge = makeForge({ config: cfg })
  const preview = forge.systemPrompt({ preview: true })
  const whole = forge.systemPrompt()
  assert.ok(preview.length > 0 && preview.length < whole.length)
  assert.equal(forge.systemPrompt({ preview: true }), preview, '缓存应稳定')
  forge.refreshPurge()
  assert.equal(forge.systemPrompt(), whole)
  assert.deepEqual(forge.levels.slice(), PURGE_LEVELS.slice())
  assert.equal(Object.keys(PURGE_LEVEL_LABELS).length, PURGE_LEVELS.length)
  assert.ok(forge.purgeState().modules.includes('direct-output'))
  assert.ok(forge.agentDirective().includes('prompt_forge'))
  assert.ok(agentDirective(cfg).includes('prompt_forge'))
})

test('history：按 keepHistory 截断；keepHistory=0 不写文件', async () => {
  const payload = { positive: [{ tag: '1girl' }] }
  const dir = tempDir()
  const forge = makeForge({ config: makeConfig({ ui: { keepHistory: 1 } }), llm: jsonStream(payload), dir })

  await forge.generate({ text: '第一次' })
  await forge.generate({ text: '第二次' })

  const rows = forge.history()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, '第二次')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'))
  assert.equal(saved.length, 1)

  const offDir = tempDir()
  const off = makeForge({ config: makeConfig({ ui: { keepHistory: 0 } }), llm: jsonStream(payload), dir: offDir })
  await off.generate({ text: '不记' })
  assert.equal(fs.existsSync(path.join(offDir, 'history.json')), false)
  assert.deepEqual(off.history(), [])
})

test('options.purgeLevel 临时覆盖破甲档：生效但不写回 config', async () => {
  const llm = jsonStream({ positive: [{ tag: '1girl' }] })
  const forge = makeForge({ config: makeConfig({ purge: { level: 'full' } }), llm })
  const before = forge.systemPrompt()
  assert.ok(before.includes('不做内容审查'))

  const light = await forge.generate({ text: '临时降到 light', options: { purgeLevel: 'light' } })
  assert.equal(light.ok, true)
  assert.equal(light.purgeLevel, 'light')
  assert.ok(llm.calls[0].system.includes('锻造器'))
  assert.equal(llm.calls[0].system.includes('不做内容审查'), false)

  const maxed = await forge.generate({ text: '拉到 max', options: { purgeLevel: 'max' } })
  assert.equal(maxed.purgeLevel, 'max')
  assert.ok(llm.calls[1].system.includes('极限档'))

  const bad = await forge.generate({ text: '非法档回落', options: { purgeLevel: 'ultra' } })
  assert.equal(bad.purgeLevel, 'full')
  assert.ok(llm.calls[2].system.includes('不做内容审查'))

  assert.equal(forge.systemPrompt(), before, 'config 不该被选项改写')
  assert.equal(forge.purgeState().level, 'full')
  assert.equal(forge.config.purge.level, 'full')
})

test('标签索引未就绪 / canonicalizeMany 抛错：仍 ok:true，只记 warning', async () => {
  const payload = { positive: [{ tag: '1girl' }, { tag: 'solo' }], negative: [{ tag: 'lowres' }] }

  const coldTags = {
    ready: async () => false,
    stats: () => ({ ready: false }),
    canonicalizeMany: () => { throw new Error('不该被调用') },
  }
  const cold = await makeForge({ llm: jsonStream(payload), tags: coldTags }).generate({ text: '冷索引' })
  assert.equal(cold.ok, true)
  assert.equal(cold.positive, '1girl, solo')
  assert.equal(cold.tags.length, 2)
  assert.ok(cold.warnings.includes('标签库未就绪，未校对'))
  assert.equal(
    cold.warnings.includes('标签库尚未就绪，本条未做全量校对'),
    false,
    '已经记过「未校对」就不该再补一条同义提示：' + JSON.stringify(cold.warnings),
  )
  assert.equal(cold.warnings.filter(text => text.includes('标签库')).length, 1, '冷索引只留一行：' + JSON.stringify(cold.warnings))
  assert.equal(cold.warnings.some(text => text.includes('不在库里')), false)

  const boomTags = {
    ready: async () => true,
    stats: () => ({ ready: true }),
    canonicalizeMany: () => { throw new Error('index exploded') },
  }
  const boom = await makeForge({ llm: jsonStream(payload), tags: boomTags }).generate({ text: '索引炸了' })
  assert.equal(boom.ok, true)
  assert.equal(boom.positive, '1girl, solo')
  assert.equal(boom.negative, '')
  assert.ok(boom.warnings.includes('标签库未就绪，未校对'))
})

test('结果带 pipeline 痕迹：词形修正、补进来的姿势词、整理动作都能回溯', async () => {
  const payload = {
    positive: [
      { tag: '1girl', weight: 1 },
      { tag: 'top_down_bottom_up', weight: 1 },
      { tag: 'from_behind', weight: 1 },
      { tag: 'facing_away', weight: 1 },
      { tag: 'profile', weight: 1 },
      { tag: 'from_side', weight: 1 },
    ],
  }
  const tags = fakeTags([...KNOWN, 'top-down_bottom-up', 'from_above', 'all_fours', 'kneeling', 'looking_back', 'from_side', 'profile', 'facing_away', 'from_behind'])
  const forge = makeForge({ llm: jsonStream(payload), tags })
  const result = await forge.generate({ text: '少女跪趴回头，从正后方俯拍' })

  assert.equal(result.ok, true)
  assert.ok(result.pipeline, '结果必须带 pipeline 字段')
  const repair = result.pipeline.repairs.find(item => item.from === 'top_down_bottom_up')
  assert.ok(repair, '下划线多词应被记进 repairs：' + JSON.stringify(result.pipeline.repairs))
  assert.equal(repair.to, 'top-down_bottom-up')
  assert.ok(result.pipeline.poseHints.some(item => item.tag === 'all_fours'), '话里的跪趴应补给 all_fours')
  assert.ok(Array.isArray(result.pipeline.changes))
  assert.ok(result.pipeline.changes.every(item => item.kind !== 'order' && item.kind !== 'buckets'), '内部步骤不进面板')
  // 视角词不再被当上位词降权：from_behind / facing_away 都留满权重
  assert.equal(result.tags.find(item => item.tag === 'from_behind').weight, 1)
  assert.equal(result.tags.find(item => item.tag === 'facing_away').weight, 1)
})

test('repairJsonText：字符串内的撇号/冒号/斜杠原样透传，只修字符串外部', () => {
  const raw = '{\n'
    + '  "positive": ["worm\'s_eye_view", "fireman\'s_carry",],\n'
    + '  "notes": \'斜杠 a//b、冒号 1:2 都原样\',\n'
    + '}'
  const text = repairJsonText(raw)
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed.positive, ["worm's_eye_view", "fireman's_carry"])
  assert.equal(parsed.notes, '斜杠 a//b、冒号 1:2 都原样')
})

test('repairJsonText：字符串外部的注释、单引号键、裸键仍照旧修掉', () => {
  const text = repairJsonText('{positive: [\'a\' /* 注释 */, \'b\' // 行尾注释\n,], notes: \'x\'}')
  assert.deepEqual(JSON.parse(text), { positive: ['a', 'b'], notes: 'x' })
})

test('closeUnbalanced：先清尾部悬空逗号/冒号/截断键名，再按栈逆序补括号', () => {
  assert.equal(closeUnbalanced('{"positive":["1girl"],"notes":'), '{"positive":["1girl"]}')
  assert.equal(closeUnbalanced('{"positive":["1girl"],"not'), '{"positive":["1girl"]}')
  assert.equal(closeUnbalanced('{"positive":["1girl"],"notes":"'), '{"positive":["1girl"],"notes":""}')
  assert.equal(closeUnbalanced('{"positive":["1girl",'), '{"positive":["1girl"]}')
  // 数组里最后一个字符串是真 tag（值位置），不能当键名摘掉
  assert.equal(closeUnbalanced('{"positive":["1girl"'), '{"positive":["1girl"]}')
})

test('坏 JSON：两撇号 tag + 尾逗号，generate 后两个 tag 都在', async () => {
  const raw = '{"positive":[{"tag":"worm\'s_eye_view"},{"tag":"fireman\'s_carry"},],"notes":"两撇号"}'
  const tags = fakeTags([...KNOWN, "worm's_eye_view", "fireman's_carry"])
  const result = await makeForge({ llm: jsonStream(raw), tags }).generate({ text: '虫视角抱人' })

  assert.equal(result.ok, true)
  assert.equal(result.repaired, true)
  const got = result.tags.map(row => row.tag)
  assert.ok(got.includes("worm's_eye_view"), JSON.stringify(got))
  assert.ok(got.includes("fireman's_carry"), JSON.stringify(got))
  assert.equal(result.notes, '两撇号')
})

test('取消时底层流抛原生 AbortError → error=aborted（不是 llm-error）', async () => {
  const controller = new AbortController()
  const llm = {
    stream() {
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: '{"positive":[' }
        await new Promise((resolve, reject) => {
          setTimeout(() => {
            const error = /** @type {any} */ (new Error('The operation was aborted'))
            error.name = 'AbortError'
            error.code = 'ABORT_ERR'
            reject(error)
            controller.abort()
          }, 30)
        })
      })()
    },
  }
  const result = await makeForge({ config: makeConfig({ llm: { timeoutMs: 5000 } }), llm })
    .generate({ text: '取消我', signal: controller.signal })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'aborted')
})

test('底层流直接抛原生 AbortError：不误判成 llm-error，已收到的文本仍留在 raw', async () => {
  const llm = {
    stream() {
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: '{"positive":[' }
        const error = /** @type {any} */ (new Error('aborted by host'))
        error.name = 'AbortError'
        error.code = 'ABORT_ERR'
        throw error
      })()
    },
  }
  const result = await makeForge({ llm }).generate({ text: '直接抛' })

  assert.notEqual(result.error, 'llm-error')
  assert.equal(result.raw, '{"positive":[')
  assert.equal(result.error, 'empty-tags')
})

test('max-tokens 重试后第二次超时：只报 timeout，不说「重试成功」', async () => {
  const calls = []
  const llm = {
    calls,
    stream(options) {
      calls.push(options)
      const first = calls.length === 1
      return (async function* emit() {
        yield { type: 'text-delta', index: 0, text: '{"positive":[{"tag":"1girl"}' }
        if (first) {
          yield { type: 'finish', kind: 'max-tokens' }
          return
        }
        // 第二次装死：把超时耗掉，模拟「重试也没救回来」
        await new Promise(resolve => setTimeout(resolve, 1000))
      })()
    },
  }
  const result = await makeForge({ llm, config: makeConfig({ llm: { timeoutMs: 200 } }) }).generate({ text: '很长很细的描述' })

  assert.equal(calls.length, 2, '截断后应该重试一次')
  assert.equal(calls[1].maxTokens, 4400)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout')
  assert.equal(result.warnings.some(text => text.includes('重试成功')), false, JSON.stringify(result.warnings))
})

test('多条 opts.negative 保序：按调用方写的顺序进 negativeTags', async () => {
  const payload = { positive: [{ tag: '1girl' }] }
  const result = await makeForge({ llm: jsonStream(payload) })
    .generate({ text: 'x', options: { negative: 'worst_quality, lowres\n censored' } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.negativeTags.map(row => row.tag), ['worst_quality', 'lowres', 'censored'])
  assert.equal(result.warnings.some(text => text.includes('不在库里')), false, JSON.stringify(result.warnings))
})

test('姿势补词只校对新增行：第①步词形修复记下的 raw 不被重校冲掉', async () => {
  // 进来的行已经过 ①（fixer 把 top_down_bottom_up 修成 top-down_bottom-up 并留下 raw）。
  const rows = [
    { raw: 'top_down_bottom_up', tag: 'top-down_bottom-up', weight: 1, matched: true, kind: 'general' },
  ]
  const calls = []
  const canonicalizeAll = async list => {
    calls.push(list.map(row => row.tag))
    return list.map(row => ({ raw: row.tag, tag: row.tag, weight: row.weight ?? 1, matched: true, kind: 'general', cn: '中文' }))
  }
  const runner = createPipelineRunner({
    cfg: makeConfig(),
    log: silent,
    tags: fakeTags([...KNOWN, 'all_fours']),
    canonicalizeAll,
  })
  const out = await runner.run({
    rows,
    described: '少女跪趴',
    opts: { maxTags: 40, syntax: 'comfy', standards: ['wd', 'camie'] },
    forgeCfg: { repair: false, postprocess: false },
    warnings: [],
    warnOnce: () => {},
    quality: { enabled: false },
  })

  assert.deepEqual(calls, [['all_fours', 'kneeling']], '只给新补的行做校对，整表重校会冲掉 ① 的 raw')
  assert.ok(out.rows.some(row => row.tag === 'all_fours'), '跪趴应补进 all_fours')
  assert.ok(out.rows.some(row => row.tag === 'kneeling'), '跪趴应补进 kneeling')
  const kept = out.rows.find(row => row.tag === 'top-down_bottom-up')
  assert.equal(kept.raw, 'top_down_bottom_up', '① 记下的模型原拼写必须留着')
  assert.deepEqual(out.info.poseHints.map(item => item.tag), ['all_fours', 'kneeling'])
})

test('withCn：库里没有的词不查、多条走一次批量查询', async () => {
  const calls = []
  const tags = fakeTags(KNOWN)
  tags.canonicalizeMany = list => {
    calls.push(list.slice())
    return list.map(raw => ({ tag: tagKey(raw), cn: '中文:' + raw }))
  }
  let single = 0
  tags.canonicalize = async () => {
    single += 1
    return { cn: '单查' }
  }
  const runner = createPipelineRunner({ cfg: makeConfig(), log: silent, tags, canonicalizeAll: async list => list })
  const rows = [
    { tag: '1girl', weight: 1, matched: true },
    { tag: 'solo', weight: 1, matched: true },
    { tag: 'gigantic_hat', weight: 1, matched: false },
    { tag: 'smile', weight: 1, matched: true, cn: '微笑' },
  ]

  const out = await runner.withCn(rows)

  assert.deepEqual(calls, [['1girl', 'solo']], '只查需要补的两条，且一批发出去')
  assert.equal(single, 0, '有批量就不再逐条查')
  assert.equal(out[0].cn, '中文:1girl')
  assert.equal(out[2].cn, undefined, '库里没有的词不查也不补')
  assert.equal(out[3].cn, '微笑', '已经有中文名的行原样留着')
})
