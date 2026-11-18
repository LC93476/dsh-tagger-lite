// 面板骨架：把头部状态条、输入区、结果区、设置区拼成一棵树。
import { CSS } from './css.js'
import { clampInt } from './state.js'
import { headViews } from './view-head.js'
import { settingsViews } from './view-settings.js'
import { resultViews } from './view-result.js'

export function shell(p) {
  const { h, t, api, text, setText, standards, setStandards, maxTags, setMaxTags, level, setLevel, workflows, workflowState, workflowError, workflowId, setWorkflowId, forge, result, run, refine, setRefine, runRefine, copyStatus, copyPair, refName, refBusy, refError, positiveText, negativeText, bilingualText, negativePairText, pairLines, settings, settingsStatus, settingsError, patchSettings, saveSettings, comfyStatus, checkComfy, startComfy, purgeInfo, spi, generate, submitRun, removeChip, copyPositive, copyBilingual, pickRef, isRefWorkflow } = p
  const { comfyNode, spiNode, lampNode, workflowOptions, levelSelect } = headViews(p)
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
  h('section', { key: 'input', class: 'ptf-section' },
    h('label', { key: 'label', class: 'ptf-label', htmlFor: 'ptf-text' }, t('label.input')),
    h('textarea', {
      key: 'textarea',
      id: 'ptf-text',
      class: 'ptf-textarea',
      rows: 4,
      placeholder: t('placeholder.input'),
      value: text,
      'data-testid': 'ptf-text',
      onChange: event => setText(event.target.value),
    }),
  ),
  h('div', { key: 'options', class: 'ptf-opts' },
    h('label', { key: 'wd', class: 'ptf-check' },
      h('input', {
        key: 'input',
        type: 'checkbox',
        checked: standards.wd,
        'data-testid': 'ptf-standard-wd',
        onChange: () => setStandards({ ...standards, wd: !standards.wd }),
      }),
      h('span', { key: 'text' }, t('standard.wd')),
    ),
    h('label', { key: 'camie', class: 'ptf-check' },
      h('input', {
        key: 'input',
        type: 'checkbox',
        checked: standards.camie,
        'data-testid': 'ptf-standard-camie',
        onChange: () => setStandards({ ...standards, camie: !standards.camie }),
      }),
      h('span', { key: 'text' }, t('standard.camie')),
    ),
    h('label', { key: 'max', class: 'ptf-field' },
      h('span', { key: 'label' }, t('maxTags')),
      h('input', {
        key: 'input',
        type: 'number',
        min: 8,
        max: 160,
        class: 'ptf-number',
        value: maxTags,
        'data-testid': 'ptf-maxtags',
        onChange: event => setMaxTags(clampInt(event.target.value, 8, 160, 40)),
      }),
    ),
    h('label', { key: 'workflow', class: 'ptf-field ptf-field-wide' },
      h('span', { key: 'label' }, t('workflow')),
      h('select', {
        key: 'select',
        class: 'ptf-select',
        value: workflowId,
        'data-testid': 'ptf-workflow',
        onChange: event => setWorkflowId(event.target.value),
      }, workflowOptions),
    ),
    h('label', { key: 'level', class: 'ptf-field' },
      h('span', { key: 'label' }, t('level')),
      levelSelect(setLevel),
    ),
  ),
  workflowState === 'loading'
    ? h('div', { key: 'workflow-loading', class: 'ptf-hint', 'data-testid': 'ptf-workflow-loading' }, t('workflow.loading'))
    : workflowState === 'error'
      ? h('div', { key: 'workflow-error', class: 'ptf-error', 'data-testid': 'ptf-workflow-error' }, t('workflow.error') + ': ' + workflowError)
      : null,
  h('div', { key: 'actions', class: 'ptf-actions' },
    h('button', {
      key: 'generate',
      type: 'button',
      class: 'ptf-primary',
      'data-testid': 'ptf-generate',
      disabled: forge.status === 'forging' || text.trim() === '',
      onClick: generate,
    }, forge.status === 'forging' ? t('action.generating') : t('action.generate')),
  ),
  forge.error !== '' ? h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-error' }, t('error.forge') + ': ' + forge.error) : null,
  body,
  settingsNode,
  )
}
