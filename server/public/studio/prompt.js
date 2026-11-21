/* 三栏工作台 · prompt 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { $, state, textOf, el, clear, api, flash, splitTags, tagCore, joinTags, tagName, tagCn, saveUi, autoGrow } from './state.js'

export function setForgeStatus(message, kind) {
  const node = $('forge-status')
  if (node === null) return
  node.textContent = String(message)
  node.dataset.kind = kind || ''
}


export function renderChips() {
  const box = $('chips')
  if (box === null) return
  clear(box)
  const tokens = splitTags(state.forge.positive)
  tokens.forEach(function (token) {
    const core = tagCore(token)
    const cn = state.forge.cn[core] || state.forge.cn[String(token)] || ''
    const chip = el('button', {
      class: 'chip',
      type: 'button',
      title: '点一下从正向里删掉' + (cn === '' ? '' : '（' + cn + '）'),
      dataset: { tag: core },
    })
    chip.append(el('span', { text: token }))
    if (cn !== '') chip.append(el('i', { text: cn }))
    chip.addEventListener('click', function () { removeToken(core) })
    box.append(chip)
  })
  const count = $('pos-count')
  if (count !== null) count.textContent = tokens.length + ' tag'
}


export function renderJudge() {
  const pos = $('positive')
  const neg = $('negative')
  if (pos !== null) pos.textContent = state.forge.positive
  if (neg !== null) neg.textContent = state.forge.negative
  const negCount = $('neg-count')
  if (negCount !== null) negCount.textContent = splitTags(state.forge.negative).length + ' tag'
  renderChips()
}


export function removeToken(core) {
  const tokens = splitTags(state.forge.positive)
  const kept = tokens.filter(function (token) { return tagCore(token).toLowerCase() !== String(core).toLowerCase() })
  if (kept.length === tokens.length) return
  state.forge.positive = joinTags(kept)
  renderJudge()
}


export function appendToPrompt(fragment) {
  const box = $('prompt')
  const add = textOf(fragment)
  if (box === null || add === '') return
  const current = box.value.trim()
  box.value = current === '' ? add : current.replace(/[，,]\s*$/, '') + ', ' + add
  autoGrow()
  saveUi()
  box.focus()
  box.setSelectionRange(box.value.length, box.value.length)
}


export async function doForge() {
  if (state.forge.running) return
  const box = $('prompt')
  const raw = box === null ? '' : box.value.trim()
  if (raw === '') { flash('先写点什么'); if (box !== null) box.focus(); return }
  const wrapped = state.ui.solo ? raw + '\n\n（画面里只画一个人）' : raw
  const button = $('btn-forge')
  const warn = $('forge-warn')
  state.forge.running = true
  if (button !== null) button.disabled = true
  setForgeStatus('锻造中…', 'busy')
  if (warn !== null) { warn.hidden = true; warn.textContent = '' }
  try {
    const res = await api('/forge', { body: { text: wrapped, options: { maxTags: state.ui.maxTags, purgeLevel: state.ui.level } } })
    const data = res.data || {}
    if (res.status === 0 || data.ok !== true) {
      const message = textOf(data.message) || ('锻造失败（HTTP ' + res.status + '）')
      state.forge.error = message
      setForgeStatus(message, 'err')
      return
    }
    state.forge.error = ''
    state.forge.positive = typeof data.positive === 'string' ? data.positive : ''
    state.forge.negative = typeof data.negative === 'string' ? data.negative : ''
    state.forge.ms = Number.isFinite(data.ms) ? data.ms : 0
    state.forge.cn = {}
    const tags = Array.isArray(data.tags) ? data.tags : []
    tags.forEach(function (item) {
      const name = tagName(item)
      const cn = tagCn(item)
      if (name !== '' && cn !== '') state.forge.cn[name] = cn
    })
    renderJudge()
    const count = splitTags(state.forge.positive).length
    setForgeStatus('完成 · ' + count + ' tag · ' + Math.round(state.forge.ms) + 'ms', 'ok')
    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(function (item) { return typeof item === 'string' && item !== '' }) : []
    if (warn !== null && warnings.length > 0) { warn.textContent = warnings.join('；'); warn.hidden = false }
  } catch (err) {
    // fetch 自己抛错（断网、服务被杀）时也得给说法，不然按钮会永久停在「锻造中」
    const message = err !== null && err !== undefined && typeof err.message === 'string' ? '锻造出错：' + err.message : '锻造出错'
    state.forge.error = message
    setForgeStatus(message, 'err')
  } finally {
    state.forge.running = false
    if (button !== null) button.disabled = false
  }
}
