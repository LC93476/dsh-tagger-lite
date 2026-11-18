// 标签操作：chips 增删、复制正向与中英对照、二次精修、破甲档位同步。
// 纯动作，不渲染：视图照旧从 bag 里拿这些函数，状态全由调用方（client/panel.js）传进来。
import { LEVELS } from './constants.js'
import { formatTagLine, normalizeDelta, normalizeTags } from './state.js'
import { requestJson } from './api.js'

/**
 * 造出面板要用的一组标签动作。参数都是面板当前值的快照 + 对应 setter，
 * 所以每次 render 都重新造一遍（闭包里拿到的是这一轮的值，和原来写在 Panel 里时一致）。
 * @param {Record<string, any>} ctx 见 client/panel.js 里的调用点
 */
export function createActions(ctx) {
  const { api, t, result, setResult, refine, setRefine, positiveText, negativeText, bilingualText, applyLevel, setCopyStatus, setCopyPair } = ctx

  /** 点掉一颗芯片：只动 chips，正负向串由调用方按 chips 重新拼。 */
  const removeChip = index => {
    if (result === null) return
    setResult({ ...result, chips: result.chips.filter((_, at) => at !== index) })
  }

  // 二次精修：拿「当前看得见的」正负向串（用户可能已经点掉过芯片）去让模型增删标签，
  // 成功后用返回的 tags/positive/negative 覆盖结果，其它字段（raw/warnings）保持原样。
  const runRefine = async () => {
    if (result === null || refine.status === 'running') return
    setRefine(previous => ({ ...previous, status: 'running', error: '', delta: null }))
    const res = await requestJson(api + '/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positive: positiveText,
        negative: negativeText,
        instruction: refine.instruction.trim(),
        mode: refine.mode,
        options: {},
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setRefine(previous => ({
        ...previous,
        status: 'failed',
        error: String(res.payload?.message ?? res.message ?? t('refine.failed')),
        delta: null,
      }))
      return
    }
    const payload = res.payload ?? {}
    const negativeGiven = typeof payload.negative === 'string' && payload.negative !== formatTagLine(result === null ? [] : result.negativeChips)
    setResult(previous => previous === null ? previous : ({
      ...previous,
      positive: typeof payload.positive === 'string' ? payload.positive : previous.positive,
      negative: typeof payload.negative === 'string' ? payload.negative : previous.negative,
      chips: normalizeTags(payload.tags),
      // 负向串变了但没给负向芯片时，宁可留空（回落 result.negative），也不留过期芯片。
      negativeChips: Array.isArray(payload.negativeTags)
        ? normalizeTags(payload.negativeTags)
        : negativeGiven ? [] : previous.negativeChips,
      model: typeof payload.model === 'string' && payload.model !== '' ? payload.model : previous.model,
      ms: Number(payload.ms) > 0 ? Number(payload.ms) : previous.ms,
    }))
    setRefine(previous => ({ ...previous, status: 'done', error: '', delta: normalizeDelta(payload.delta) }))
    // 精修也可能换破甲档：服务端回了合法档位就同步灯与档位状态。
    if (typeof payload.purgeLevel === 'string' && LEVELS.includes(payload.purgeLevel)) applyLevel(payload.purgeLevel)
  }

  const copyPositive = async () => {
    if (positiveText === '') return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(positiveText)
        setCopyStatus('copied')
      } else {
        setCopyStatus('failed')
      }
    } catch (error) {
      setCopyStatus('failed')
    }
  }

  const copyBilingual = async () => {
    if (bilingualText === '') return
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(bilingualText)
        setCopyPair('copied')
      } else {
        setCopyPair('failed')
      }
    } catch (error) {
      setCopyPair('failed')
    }
  }

  return { removeChip, runRefine, copyPositive, copyBilingual }
}
