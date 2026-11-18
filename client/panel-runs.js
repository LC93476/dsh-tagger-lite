// 锻造 / 参考图上传 / 投递出图：三段副作用在这里，panel.js 只留状态编排与骨架。
import { LEVELS } from './constants.js'
import { chosenStandards, describe, normalizePipeline, normalizePurge, normalizeTags } from './state.js'
import { readAsDataUrl, requestJson } from './api.js'

/**
 * /upload 的失败文案：服务端只回错误码（bad-type / empty-file / too-large / no-launch-dir），
 * 先按 ref.err.<code> 查本地字典翻成中文；查不到就退回服务端 message，再退回原码 ——
 * 绝不把真实错误吞成一句笼统的「上传失败」。
 */
function uploadErrorText(res, t) {
  const payload = res !== null && res !== undefined && res.payload !== null && typeof res.payload === 'object' ? res.payload : {}
  const code = typeof payload.error === 'string' ? payload.error : ''
  if (code !== '') {
    const key = 'ref.err.' + code
    const mapped = t(key)
    if (typeof mapped === 'string' && mapped !== '' && mapped !== key) return mapped
  }
  if (typeof payload.message === 'string' && payload.message !== '') return payload.message
  if (typeof res?.message === 'string' && res.message !== '') return res.message
  if (code !== '') return code
  return t('ref.failed')
}

/**
 * 一次渲染内的三段动作。每次 render 重建：闭包拿的就是这一轮的 state，
 * 行为与原来写在 Panel 里完全一致（纯搬移，没有改判断或文案）。
 */
export function createRunOps(ctx) {
  const {
    api,
    t,
    text,
    standards,
    maxTags,
    level,
    workflowId,
    refName,
    positiveText,
    negativeText,
    setForge,
    setCopyStatus,
    setRun,
    setRefine,
    setResult,
    setPurgeInfo,
    setRefName,
    setRefBusy,
    setRefError,
  } = ctx

  const generate = async () => {
    const value = text.trim()
    if (value === '') {
      setForge({ status: 'error', error: t('error.emptyText') })
      return
    }
    setForge({ status: 'forging', error: '' })
    setCopyStatus('idle')
    setRun({ status: 'idle', promptId: '', images: [], error: '' })
    // 新一轮锻造换了结果，上一轮的 delta 就不再对应当前标签了。
    setRefine(previous => ({ ...previous, status: 'idle', error: '', delta: null }))
    const res = await requestJson(api + '/forge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: value,
        options: { standards: chosenStandards(standards), maxTags, purgeLevel: level },
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setForge({ status: 'error', error: res.payload?.message ?? res.message ?? t('error.forge') })
      return
    }
    const payload = res.payload
    setResult({
      positive: String(payload.positive ?? ''),
      negative: String(payload.negative ?? ''),
      chips: normalizeTags(payload.tags),
      negativeChips: normalizeTags(payload.negativeTags),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(item => String(item)) : [],
      raw: String(payload.raw ?? ''),
      model: String(payload.model ?? ''),
      ms: Number(payload.ms) || 0,
      repaired: payload.repaired === true,
      pipeline: normalizePipeline(payload.pipeline),
    })
    if (typeof payload.purgeLevel === 'string' && LEVELS.includes(payload.purgeLevel)) {
      setPurgeInfo(previous => normalizePurge({ ...previous, level: payload.purgeLevel }))
    }
    setForge({ status: 'done', error: '' })
  }

  const pickRef = async event => {
    const file = event?.target?.files?.[0]
    if (file === undefined || file === null) return
    setRefBusy(true)
    setRefError('')
    try {
      const dataUrl = await readAsDataUrl(file)
      const res = await requestJson(api + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: String(file.name ?? 'ref.png'), data: dataUrl }),
      })
      if (!res.ok || res.payload?.ok === false) {
        setRefName('')
        setRefError(uploadErrorText(res, t))
      } else {
        setRefName(String(res.payload?.name ?? ''))
      }
    } catch (error) {
      setRefName('')
      setRefError(describe(error))
    } finally {
      setRefBusy(false)
    }
  }

  const submitRun = async () => {
    if (positiveText === '') return
    // 参考图模板才带 image 变量；其它模板传了也会被 applyVars 丢掉，但保持请求干净更好
    const runVars = workflowId.indexOf('ref') >= 0 && refName !== '' ? { image: refName } : {}
    setRun({ status: 'submitting', promptId: '', images: [], error: '' })
    const res = await requestJson(api + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId, positive: positiveText, negative: negativeText, vars: runVars }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setRun({ status: 'failed', promptId: '', images: [], error: res.payload?.message ?? res.message ?? t('error.run') })
      return
    }
    const promptId = String(res.payload?.promptId ?? '')
    setRun({
      status: promptId === '' ? 'failed' : 'queued',
      promptId,
      images: [],
      error: promptId === '' ? t('error.run') : '',
    })
  }

  return { generate, pickRef, submitRun, uploadErrorText }
}
