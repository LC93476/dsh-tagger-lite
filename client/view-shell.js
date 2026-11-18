// 面板骨架：把头部状态条、输入区、结果区、设置区拼成一棵树。
// 输入区自己成模块（client/panel-input.js），骨架只负责按顺序把它拼进来。
import { CSS } from './css.js'
import { headViews } from './view-head.js'
import { inputViews } from './panel-input.js'
import { settingsViews } from './view-settings.js'
import { resultViews } from './view-result.js'

export function shell(p) {
  const { h, t, forge, result, run } = p
  const { comfyNode, spiNode, lampNode, workflowOptions, levelSelect } = headViews(p)
  // 下拉与档位选择是 headViews 产出的，输入区要用，所以并进同一份 bag 递过去。
  const { inputNodes } = inputViews({ ...p, workflowOptions, levelSelect })
  const { resultNode } = resultViews(p)
  const { settingsNode } = settingsViews(p)
  const body = forge.status === 'forging'
    ? h('div', { key: 'loading', class: 'ptf-hint', 'data-testid': 'ptf-loading' }, t('state.loading'))
    : resultNode !== null
      ? resultNode
      : h('div', { key: 'empty', class: 'ptf-hint', 'data-testid': 'ptf-empty' }, t('state.empty'))
  return h('div', {
    class: 'ptf',
    'data-testid': 'ptf-panel',
    'data-state': forge.status,
    'data-job': run.status,
  },
  h('style', { key: 'style' }, CSS),
  h('div', { key: 'head', class: 'ptf-head' },
    h('div', { key: 'row', class: 'ptf-head-row' },
      h('div', { key: 'titles', class: 'ptf-head-titles' },
        h('div', { key: 'title', class: 'ptf-title' }, t('title')),
        h('div', { key: 'sub', class: 'ptf-sub' }, t('subtitle')),
      ),
      h('div', { key: 'tags', class: 'ptf-head-tags' }, comfyNode, spiNode, lampNode),
    ),
  ),
  ...inputNodes,
  body,
  settingsNode,
  )
}
