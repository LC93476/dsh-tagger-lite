// 头部状态条视图：ComfyUI 灯、破甲灯、SPI 徽标，以及工作流下拉与档位选择。
import { LEVELS } from './constants.js'

export function headViews(p) {
  const { h, t, api, text, setText, standards, setStandards, maxTags, setMaxTags, level, setLevel, workflows, workflowState, workflowError, workflowId, setWorkflowId, forge, result, run, refine, setRefine, runRefine, copyStatus, copyPair, refName, refBusy, refError, positiveText, negativeText, bilingualText, negativePairText, pairLines, settings, settingsStatus, settingsError, patchSettings, saveSettings, comfyStatus, checkComfy, startComfy, purgeInfo, spi, generate, submitRun, removeChip, copyPositive, copyBilingual, pickRef, isRefWorkflow } = p
  const lampTitle = purgeInfo.enabled
    ? [t('purge.lamp') + ' · ' + t('level.' + purgeInfo.level),
      purgeInfo.modules.length > 0 ? t('purge.modules') + ': ' + purgeInfo.modules.join(', ') : '',
      purgeInfo.chars > 0 ? purgeInfo.chars + t('purge.charsUnit') : '',
      t('purge.live')].filter(item => item !== '').join(' · ')
    : [t('purge.lamp') + ' · ' + t('purge.off'), t('purge.live')].join(' · ')

  const lampNode = h('span', {
    key: 'lamp',
    class: 'ptf-lamp',
    'data-level': purgeInfo.level,
    'data-enabled': purgeInfo.enabled ? 'on' : 'off',
    'data-testid': 'ptf-purge-lamp',
    title: lampTitle,
  },
  h('span', { key: 'dot', class: 'ptf-dot' }),
  h('span', { key: 'text' }, t('purge.lamp') + ' · ' + t('level.' + purgeInfo.level)),
  )

  // SPI 徽标：版本 + 槽位数 + 当前接口前缀，一眼看出面板连的是哪套接口。
  const spiNode = !spi.ok ? null : h('span', {
    key: 'spi',
    class: 'ptf-spi',
    'data-testid': 'ptf-spi-badge',
    'data-version': spi.version,
    'data-slots': spi.slots,
    title: t('spi.badge') + ' v' + spi.version + ' · ' + spi.slots + t('spi.slots') + ' · ' + api,
  },
  h('span', { key: 'text' }, t('spi.badge') + ' v' + spi.version + ' · ' + spi.slots + t('spi.slots')),
  h('code', { key: 'api' }, api),
  )

  const comfyTitle = [
    t('comfy.lamp') + ' · ' + t('comfy.' + comfyStatus.state),
    comfyStatus.version !== '' ? 'v' + comfyStatus.version : '',
    comfyStatus.launchDir !== '' ? t('comfy.dir') + ': ' + comfyStatus.launchDir : '',
    comfyStatus.message,
    t('comfy.checkHint'),
  ].filter(item => typeof item === 'string' && item !== '').join(' · ')

  const comfyNode = h('button', {
    key: 'comfy',
    type: 'button',
    class: 'ptf-lamp ptf-comfy',
    'data-state': comfyStatus.state,
    'data-testid': 'ptf-comfy-lamp',
    title: comfyTitle,
    disabled: comfyStatus.busy !== '',
    onClick: checkComfy,
  },
  h('span', { key: 'dot', class: 'ptf-dot' }),
  h('span', { key: 'text' }, t('comfy.' + comfyStatus.state) + (comfyStatus.version !== '' ? ' v' + comfyStatus.version : '')),
  )

  const workflowOptions = [h('option', { key: 'auto', value: '' }, t('workflow.auto'))].concat(
    workflows.map(item => {
      const needsImage = Array.isArray(item.vars) && item.vars.some(v => String(v?.name ?? '') === 'image')
      return h('option', { key: String(item.id), value: String(item.id) }, String(item.title ?? item.id) + (needsImage ? t('ref.badge') : ''))
    }),
  )

  const levelSelect = (onChange, testId = 'ptf-level') => h('select', {
    key: 'level',
    class: 'ptf-select',
    value: level,
    'data-testid': testId,
    onChange: event => onChange(event.target.value),
  }, LEVELS.map(item => h('option', { key: item, value: item }, t('level.' + item))))
  return { lampNode, spiNode, comfyNode, workflowOptions, levelSelect }
}
