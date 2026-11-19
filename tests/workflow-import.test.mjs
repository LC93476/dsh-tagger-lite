/**
 * 自定义工作流导入：形状判定、id 兜底、schema 反推、写盘与同名冲突。
 *
 * 这一层的价值是「面板不许因为一份脏 JSON 把模板目录写坏」：UI 格式要拒、
 * id 要被折叠成安全文件名、写盘失败要回错误码而不是抛栈。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { inferSchema, importWorkflow, parseSchema, parseWorkflow, slugify } from '../lib/workflow-import.js'

const WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 5, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['13', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'base prompt', clip: ['5', 0] }, _meta: { title: '正向提示词' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: ['5', 0] }, _meta: { title: '负向提示词' } },
  '13': { class_type: 'EmptyLatentImage', inputs: { width: 1200, height: 1800, batch_size: 1 } },
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-wf-import-'))
}

test('slugify：折叠成安全文件名，路径穿越的字符一律吃掉', () => {
  assert.equal(slugify('My SDXL T2I!!'), 'my-sdxl-t2i')
  assert.equal(slugify('   '), '')
  assert.equal(slugify('中文名'), '')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('a'.repeat(80)).length, 64)
})

test('parseWorkflow：UI 格式/坏 JSON/空内容都回错误码，API 格式回节点数', () => {
  assert.equal(parseWorkflow(JSON.stringify({ nodes: [], links: [] })).error, 'ui-format')
  assert.equal(parseWorkflow('{ nope').error, 'bad-json')
  assert.equal(parseWorkflow('').error, 'empty-file')
  assert.equal(parseWorkflow({ hello: 'world' }).error, 'bad-workflow')
  const ok = parseWorkflow(JSON.stringify(WORKFLOW))
  assert.equal(ok.error, undefined)
  assert.equal(ok.nodes, 4)
  assert.equal(parseWorkflow(WORKFLOW).nodes, 4)
})

test('parseSchema：可空、坏 JSON、vars 不是数组都拦下', () => {
  assert.equal(parseSchema(undefined).schema, null)
  assert.equal(parseSchema('').schema, null)
  assert.equal(parseSchema('{ bad').error, 'bad-json')
  assert.equal(parseSchema({ vars: 'nope' }).error, 'bad-schema')
  assert.equal(parseSchema({ vars: [] }).schema.vars.length, 0)
})

test('inferSchema：prompt/negative_prompt 绑到识别出的文本节点，数值变量带默认值', () => {
  const schema = /** @type {any} */ (inferSchema(WORKFLOW, { title: '我的模板', config: { comfy: {} } }))
  assert.equal(schema.title, '我的模板')
  assert.deepEqual(schema.internalInputs, ['filename_prefix'])
  const names = schema.vars.map(v => v.name)
  assert.ok(names.includes('prompt'), '缺 prompt：' + names.join(','))
  assert.ok(names.includes('negative_prompt'), '缺 negative_prompt')
  const prompt = schema.vars.find(v => v.name === 'prompt')
  assert.equal(String(prompt.node), '6')
  const negative = schema.vars.find(v => v.name === 'negative_prompt')
  assert.equal(String(negative.node), '7')
  const width = schema.vars.find(v => v.name === 'width')
  assert.equal(width.default, 1200)
  assert.equal(width.type, 'number')
  const seed = schema.vars.find(v => v.name === 'seed')
  assert.equal(seed.default, 42)
  assert.ok(names.includes('text') === false, 'text 是文本节点的输入，不该当变量')
})

test('importWorkflow：写 json + schema，同名冲突回 exists，overwrite 才覆盖', () => {
  const dir = tmpDir()
  const first = importWorkflow({ dir, name: 'My Test WF', workflow: WORKFLOW })
  assert.equal(first.ok, true)
  assert.equal(first.id, 'my-test-wf')
  assert.equal(first.title, 'my-test-wf')
  assert.equal(fs.existsSync(path.join(dir, 'my-test-wf.json')), true)
  assert.equal(fs.existsSync(path.join(dir, 'my-test-wf.schema.json')), true)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'my-test-wf.json'), 'utf8'))
  assert.equal(saved['3'].class_type, 'KSampler')
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'my-test-wf.schema.json'), 'utf8'))
  assert.ok(Array.isArray(schema.vars) && schema.vars.length > 0)

  const again = /** @type {any} */ (importWorkflow({ dir, name: 'my-test-wf', workflow: WORKFLOW }))
  assert.equal(again.ok, false)
  assert.equal(again.error, 'exists')

  const forced = importWorkflow({ dir, name: 'my-test-wf', workflow: WORKFLOW, overwrite: true, schema: { title: '改过的标题', vars: [] } })
  assert.equal(forced.ok, true)
  assert.equal(forced.title, '改过的标题')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'my-test-wf.schema.json'), 'utf8')).title, '改过的标题')
})

test('importWorkflow：脏输入不落盘（UI 格式 / 空 id / 空目录）', () => {
  const dir = tmpDir()
  const ui = importWorkflow({ dir, name: 'x', workflow: { nodes: [], links: [] } })
  assert.equal(ui.ok, false)
  assert.equal(ui.error, 'ui-format')
  assert.deepEqual(fs.readdirSync(dir), [])

  const noName = /** @type {any} */ (importWorkflow({ dir, name: '中文名', workflow: WORKFLOW }))
  assert.equal(noName.error, 'bad-name')
  assert.deepEqual(fs.readdirSync(dir), [])

  const noDir = /** @type {any} */ (importWorkflow({ dir: '', name: 'ok', workflow: WORKFLOW }))
  assert.equal(noDir.error, 'no-workflow-dir')
})

test('importWorkflow：schema 没写 default 的变量补上模板当前值', () => {
  const dir = tmpDir()
  const result = importWorkflow({
    dir,
    name: 'fill-defaults',
    workflow: WORKFLOW,
    schema: { title: '填充默认值', vars: [{ name: 'width', label: '宽' }, { name: 'seed', label: '种子' }] },
  })
  assert.equal(result.ok, true)
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'fill-defaults.schema.json'), 'utf8'))
  assert.equal(schema.title, '填充默认值')
  assert.equal(schema.vars.find(v => v.name === 'width').default, 1200)
  assert.equal(schema.vars.find(v => v.name === 'seed').default, 42)
})
