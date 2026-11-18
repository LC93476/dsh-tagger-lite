// 输入控制区：白话输入框、标签标准、最多标签、工作流、破甲档与「锻造」按钮，外加工作流读取状态。
// 视图约定与 client/view-*.js 一致：收整个 bag p（这里额外用到 p.workflowOptions / p.levelSelect，
// 由 view-shell.js 从 headViews 取来后并进 bag），返回节点数组按骨架里的原顺序拼进去。
import { clampInt } from './state.js'

/**
 * @param {Record<string, any>} p 面板 bag（含 workflowOptions / levelSelect）
 * @returns {{ inputNodes: any[] }} 输入区节点，顺序：白话 → 选项 → 工作流提示 → 动作 → 错误
 */
export function inputViews(p) {
  const { h, t, text, setText, standards, setStandards, maxTags, setMaxTags, workflowState, workflowError, workflowOptions, workflowId, setWorkflowId, levelSelect, setLevel, forge, generate } = p

  const inputSection = h('section', { key: 'input', class: 'ptf-section' },
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
  )

  const options = h('div', { key: 'options', class: 'ptf-opts' },
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
  )

  const workflowNote = workflowState === 'loading'
    ? h('div', { key: 'workflow-loading', class: 'ptf-hint', 'data-testid': 'ptf-workflow-loading' }, t('workflow.loading'))
    : workflowState === 'error'
      ? h('div', { key: 'workflow-error', class: 'ptf-error', 'data-testid': 'ptf-workflow-error' }, t('workflow.error') + ': ' + workflowError)
      : null

  const actions = h('div', { key: 'actions', class: 'ptf-actions' },
    h('button', {
      key: 'generate',
      type: 'button',
      class: 'ptf-primary',
      'data-testid': 'ptf-generate',
      disabled: forge.status === 'forging' || text.trim() === '',
      onClick: generate,
    }, forge.status === 'forging' ? t('action.generating') : t('action.generate')),
  )

  const forgeError = forge.error !== '' ? h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-error' }, t('error.forge') + ': ' + forge.error) : null

  return { inputNodes: [inputSection, options, workflowNote, actions, forgeError] }
}
