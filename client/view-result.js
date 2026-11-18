// 结果区视图：芯片、本地处理痕迹、二次精修卡与 delta、出图、正负向与元信息。
import { JOB_KEY, REFINE_MODES } from './constants.js'
import { imageSrc } from './api.js'

export function resultViews(p) {
  const { h, t, api, text, setText, standards, setStandards, maxTags, setMaxTags, level, setLevel, workflows, workflowState, workflowError, workflowId, setWorkflowId, forge, result, run, refine, setRefine, runRefine, copyStatus, copyPair, refName, refBusy, refError, positiveText, negativeText, bilingualText, negativePairText, pairLines, settings, settingsStatus, settingsError, patchSettings, saveSettings, comfyStatus, checkComfy, startComfy, purgeInfo, spi, generate, submitRun, removeChip, copyPositive, copyBilingual, pickRef, isRefWorkflow } = p
  // delta 摘要：三类各自成串，全空就明说「没有改动」，别让用户猜按钮有没有生效。
  const deltaNode = refine.status !== 'done' || refine.delta === null ? null : (() => {
    const { added, removed, weighted } = refine.delta
    if (added.length === 0 && removed.length === 0 && weighted.length === 0) {
      return h('div', { key: 'delta', class: 'ptf-hint', 'data-testid': 'ptf-refine-delta' }, t('refine.nochange'))
    }
    const part = (key, label, value) => h('span', { key, class: 'ptf-delta-part' },
      h('span', { key: 'label', class: 'ptf-label' }, label),
      h('span', { key: 'tags', class: 'ptf-delta-tags' }, value),
    )
    return h('div', { key: 'delta', class: 'ptf-delta', 'data-testid': 'ptf-refine-delta' },
      added.length === 0 ? null : part('added', t('refine.added'), added.join(', ')),
      removed.length === 0 ? null : part('removed', t('refine.removed'), removed.join(', ')),
      weighted.length === 0 ? null : part('weighted', t('refine.weighted'),
        weighted.map(item => item.tag + ' ' + item.from + '→' + item.to).join('; ')),
    )
  })()

  // 精修卡：没有结果就没有可改的东西，整块不渲染。
  const refineNode = result === null ? null : h('div', {
    key: 'refine',
    class: 'ptf-refine',
    'data-testid': 'ptf-refine-card',
    'data-mode': refine.mode,
    'data-status': refine.status,
  },
  h('div', { key: 'head', class: 'ptf-card-head' },
    h('span', { key: 'label', class: 'ptf-label' }, t('refine.title')),
  ),
  h('textarea', {
    key: 'input',
    class: 'ptf-textarea ptf-refine-input',
    rows: 2,
    placeholder: t('refine.placeholder'),
    value: refine.instruction,
    'data-testid': 'ptf-refine-input',
    onChange: event => setRefine(previous => ({ ...previous, instruction: event.target.value })),
  }),
  h('div', { key: 'modes', class: 'ptf-refine-modes' }, REFINE_MODES.map(mode => h('button', {
    key: 'mode-' + mode,
    type: 'button',
    class: 'ptf-mode',
    'data-testid': 'ptf-refine-mode-' + mode,
    'data-on': refine.mode === mode ? 'on' : 'off',
    onClick: () => setRefine(previous => ({ ...previous, mode })),
  }, t('refine.mode.' + mode)))),
  h('div', { key: 'actions', class: 'ptf-actions' },
    h('button', {
      key: 'run',
      type: 'button',
      class: 'ptf-primary',
      'data-testid': 'ptf-refine-run',
      disabled: refine.status === 'running',
      onClick: runRefine,
    }, refine.status === 'running' ? t('refine.running') : t('refine.run')),
    refine.error === '' ? null : h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-refine-error' }, refine.error),
  ),
  deltaNode,
  )

  const chipNodes = (result?.chips ?? []).map((chip, index) => h('button', {
    key: 'chip-' + index,
    type: 'button',
    class: 'ptf-chip',
    title: t('action.removeTag'),
    'data-testid': 'ptf-chip',
    'data-tag': chip.tag,
    onClick: () => removeChip(index),
  },
  h('span', { key: 'tag' }, chip.tag),
  chip.weight !== 1 ? h('span', { key: 'w', class: 'ptf-chip-weight' }, 'x' + chip.weight) : null,
  ))

  const warningNodes = (result?.warnings ?? []).map((warning, index) => h('li', { key: 'warn-' + index }, warning))

  // 本地处理痕迹：让用户看得见"模型给的词被改成了什么"，词库缺词也一眼可查。
  const pipe = result?.pipeline ?? { repairs: [], poseHints: [], changes: [] }
  const pipeParts = []
  if (pipe.repairs.length > 0) {
    pipeParts.push(t('pipeline.repairs') + ' ' + pipe.repairs.map(item => item.from + '→' + item.to).join('、'))
  }
  if (pipe.poseHints.length > 0) {
    pipeParts.push(t('pipeline.poseHints') + ' ' + pipe.poseHints.map(item => item.tag).join('、'))
  }
  if (pipe.changes.length > 0) {
    pipeParts.push(t('pipeline.changes') + ' ' + pipe.changes.map(item => item.tag).join('、'))
  }
  const pipelineNode = pipeParts.length === 0
    ? null
    : h('div', { key: 'pipeline', class: 'ptf-pipeline', 'data-testid': 'ptf-pipeline', title: pipeParts.join(' · ') },
      h('span', { key: 'label', class: 'ptf-label' }, t('pipeline.title')),
      h('span', { key: 'text' }, pipeParts.join(' · ')))

  const imageNodes = (run.images ?? []).map((image, index) => h('a', {
    key: 'image-' + index,
    class: 'ptf-image',
    href: imageSrc(api, image),
    target: '_blank',
    rel: 'noreferrer',
    title: image?.filename ?? '',
  },
  h('img', { key: 'img', src: imageSrc(api, image), alt: t('image'), 'data-testid': 'ptf-image', loading: 'lazy' }),
  ))
  const resultNode = result === null ? null : h('section', {
    key: 'result',
    class: 'ptf-card',
    'data-testid': 'ptf-result',
  },
  h('div', { key: 'head', class: 'ptf-card-head' },
    h('span', { key: 'label', class: 'ptf-label' }, t('result.positive')),
    h('button', {
      key: 'copy',
      type: 'button',
      class: 'ptf-ghost',
      'data-testid': 'ptf-copy',
      onClick: copyPositive,
    }, copyStatus === 'copied' ? t('action.copied') : copyStatus === 'failed' ? t('action.copyFailed') : t('action.copy')),
  ),
  h('div', { key: 'pair', class: 'ptf-pair' },
    h('div', { key: 'head', class: 'ptf-card-head' },
      h('span', { key: 'label', class: 'ptf-label' }, t('result.bilingual')),
      h('button', {
        key: 'copy',
        type: 'button',
        class: 'ptf-ghost',
        'data-testid': 'ptf-copy-bilingual',
        onClick: copyBilingual,
      }, copyPair === 'copied' ? t('action.copied') : copyPair === 'failed' ? t('action.copyFailed') : t('action.copy')),
    ),
    h('textarea', {
      key: 'text',
      class: 'ptf-textarea ptf-bilingual',
      'data-testid': 'ptf-bilingual',
      readOnly: true,
      rows: Math.min(20, Math.max(4, pairLines.length)),
      value: bilingualText,
      title: t('hint.bilingual'),
      onFocus: event => { if (typeof event?.target?.select === 'function') event.target.select() },
    }),
  ),
  h('div', { key: 'chips', class: 'ptf-chips', 'data-testid': 'ptf-chips' },
    chipNodes.length > 0 ? chipNodes : h('span', { key: 'none', class: 'ptf-hint' }, '-'),
  ),
  pipelineNode,
  refineNode,
  h('div', { key: 'full', class: 'ptf-pre', 'data-testid': 'ptf-positive' }, positiveText),
  warningNodes.length > 0
    ? h('div', { key: 'warnings' },
      h('div', { key: 'label', class: 'ptf-label' }, t('result.warnings')),
      h('ul', { key: 'list', class: 'ptf-warnings', 'data-testid': 'ptf-warnings' }, warningNodes),
    )
    : null,
  h('details', { key: 'negative', class: 'ptf-details', 'data-testid': 'ptf-negative' },
    h('summary', { key: 'summary' }, t('result.negative') + ' (' + result.negativeChips.length + ')'),
    h('div', { key: 'builtin', class: 'ptf-hint', 'data-testid': 'ptf-negative-builtin' }, t('result.negativeBuiltin')),
    h('pre', { key: 'text', class: 'ptf-pre' }, negativeText),
    h('pre', { key: 'pairs', class: 'ptf-pre ptf-bilingual', 'data-testid': 'ptf-negative-pairs' }, negativePairText),
  ),
  h('details', { key: 'raw', class: 'ptf-details', 'data-testid': 'ptf-raw' },
    h('summary', { key: 'summary' }, t('result.raw')),
    h('pre', { key: 'text', class: 'ptf-pre' }, result.raw),
  ),
  h('div', { key: 'meta', class: 'ptf-meta' },
    t('result.meta') + ': ' + (result.model === '' ? '-' : result.model) + (result.ms > 0 ? ' / ' + result.ms + 'ms' : ''),
  ),
  h('div', {
    key: 'ref',
    class: isRefWorkflow ? 'ptf-field ptf-field-wide' : 'ptf-field ptf-field-wide ptf-ref-off',
    'data-testid': 'ptf-ref',
    'data-active': isRefWorkflow ? 'on' : 'off',
  },
    h('span', { key: 'label' }, t('ref.label')),
    h('input', {
      key: 'file',
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      disabled: !isRefWorkflow,
      'data-testid': 'ptf-ref-file',
      onChange: pickRef,
    }),
    h('div', {
      key: 'status',
      class: refError !== '' ? 'ptf-error' : 'ptf-hint',
      'data-testid': 'ptf-ref-status',
    }, !isRefWorkflow
      ? t('ref.offHint')
      : refBusy ? t('ref.uploading') : refError !== '' ? t('ref.failed') + ': ' + refError : refName !== '' ? t('ref.ready') + ' ' + refName : t('ref.hint')),
  ),
  h('div', { key: 'actions', class: 'ptf-actions' },
    h('button', {
      key: 'submit',
      type: 'button',
      class: 'ptf-primary',
      'data-testid': 'ptf-submit',
      disabled: run.status === 'submitting' || run.status === 'queued' || run.status === 'running',
      onClick: submitRun,
    }, run.status === 'submitting'
      ? t('action.submitting')
      : run.status === 'idle' ? t('action.submit') : t('action.resubmit')),
  ),
  h('div', { key: 'job', class: 'ptf-job', 'data-testid': 'ptf-job', 'data-job': run.status },
    h('span', { key: 'label', class: 'ptf-label' }, t('job')),
    h('span', { key: 'state', class: 'ptf-pill' }, t('job.' + (JOB_KEY[run.status] ?? 'idle'))),
    run.promptId === '' ? null : h('code', { key: 'id', class: 'ptf-code' }, run.promptId),
  ),
  run.error !== '' ? h('div', { key: 'error', class: 'ptf-error', 'data-testid': 'ptf-run-error' }, t('error.run') + ': ' + run.error) : null,
  imageNodes.length > 0 ? h('div', { key: 'images', class: 'ptf-images', 'data-testid': 'ptf-images' }, imageNodes) : null,
  )
  return { deltaNode, refineNode, chipNodes, warningNodes, pipelineNode, imageNodes, resultNode }
}
