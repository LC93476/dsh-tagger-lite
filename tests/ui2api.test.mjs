import test from 'node:test'
import assert from 'node:assert/strict'
import { convert } from '../scripts/release/ui2api.mjs'

function info(required, optional = {}) {
  return { QuarkSAM3SEGS: { input: { required, optional } } }
}

test('转换器：节点后来加的新输入按 object_info 默认值补齐（不然 /prompt 报 required_input_missing）', () => {
  const objectInfo = info({
    thr1: ['FLOAT', { default: 0.45 }],
    kinds: ['STRING', { default: 'face,hand,foot' }],
    detect_max_side: ['INT', { default: 0, step: 64 }],
  })
  const ui = {
    nodes: [{ id: 310, type: 'QuarkSAM3SEGS', mode: 0, widgets_values: [0.4, 'face,hand,foot'], inputs: [] }],
    links: [],
  }
  const { api, warnings } = convert(ui, objectInfo, { outputs: [310] })
  assert.equal(api['310'].inputs.detect_max_side, 0)
  assert.equal(api['310'].inputs.kinds, 'face,hand,foot')
  assert.ok(warnings.some(w => w.includes('detect_max_side')))
})

test('转换器：seed 后面的 control_after_generate 值要被跳过，不占输入名', () => {
  const objectInfo = { KSampler: { input: { required: {
    seed: ['INT', { default: 0 }],
    steps: ['INT', { default: 20 }],
    cfg: ['FLOAT', { default: 7 }],
  } } } }
  const ui = {
    nodes: [{ id: 14, type: 'KSampler', mode: 0, widgets_values: [20261108, 'randomize', 30, 5.03], inputs: [] }],
    links: [],
  }
  const { api } = convert(ui, objectInfo, { outputs: [14] })
  assert.equal(api['14'].inputs.seed, 20261108)
  assert.equal(api['14'].inputs.steps, 30)
  assert.equal(api['14'].inputs.cfg, 5.03)
})
