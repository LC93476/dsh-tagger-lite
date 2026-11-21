/* 三栏工作台 · poses 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { PAGE, $, state, textOf, el, clear, api, flash, tagName, refSrc } from './state.js'
import { appendToPrompt } from './prompt.js'
import { loadRefs, closeDock } from './refs.js'
/* ---------------- 中栏：页签 ---------------- */

export const TABS = ['pose', 'costume', 'portrait', 'style']


export function showTab(which) {
  const id = TABS.indexOf(which) >= 0 ? which : 'pose'
  TABS.forEach(function (key) {
    const on = key === id
    const tab = $('tab-' + key)
    const panel = $('panel-' + key)
    if (tab !== null) {
      tab.classList.toggle('is-on', on)
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    if (panel !== null) panel.hidden = !on
  })
  // 切页签就把 dock 收掉：它记的是上一页签选中的那条参考，留着会串台（服装卡出现在人像页签下）
  if (state.dock.kind !== '' && state.dock.kind !== id) closeDock()
  // 参考库按需加载：不在启动时把 1400+ 条一起拉下来
  if ((id === 'costume' || id === 'portrait') && state.refs[id].tried !== true) loadRefs(id, true)
}

/* ---------------- 中栏：姿势 ---------------- */

export function poseCardVariant(group) {
  const variants = Array.isArray(group.variants) ? group.variants : []
  const want = state.poses.angle
  if (want === '') return variants[0] || null
  const hit = variants.find(function (item) { return item.angle === want })
  return hit || variants[0] || null
}


export function renderPoseSets() {
  const box = $('pose-sets')
  if (box === null) return
  clear(box)
  const sets = Array.isArray(state.poses.sets) ? state.poses.sets : []
  sets.forEach(function (item) {
    const key = textOf(item.key) || 'all'
    const button = el('button', {
      class: 'seg-i' + (key === state.poses.set ? ' is-on' : ''),
      type: 'button',
      role: 'tab',
      dataset: { set: key },
      text: (textOf(item.label) || key) + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    })
    button.setAttribute('aria-selected', key === state.poses.set ? 'true' : 'false')
    box.append(button)
  })
}


export function renderPoseCategories() {
  const box = $('pose-cats')
  if (box === null) return
  clear(box)
  const list = Array.isArray(state.poses.categories) ? state.poses.categories : []
  const all = el('button', {
    class: 'pill-i' + (state.poses.category === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { category: '' },
    text: '全部分类',
  })
  box.append(all)
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === state.poses.category ? ' is-on' : ''),
      type: 'button',
      dataset: { category: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}


export function renderPoseAngles() {
  const box = $('pose-angles')
  if (box === null) return
  clear(box)
  box.append(el('button', {
    class: 'angle' + (state.poses.angle === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { angle: '' },
    text: '全视角',
  }))
  const list = Array.isArray(state.poses.angles) ? state.poses.angles : []
  list.forEach(function (angle) {
    const key = textOf(angle)
    if (key === '') return
    box.append(el('button', {
      class: 'angle' + (key === state.poses.angle ? ' is-on' : ''),
      type: 'button',
      dataset: { angle: key },
      text: key,
    }))
  })
}


export function renderPoseGrid(append, addedGroups) {
  const box = $('pose-grid')
  if (box === null) return
  // 「加载更多」只渲染本次新增的那一页：把累计数组再 append 一遍会叠出重复卡片。
  const fresh = append === true && Array.isArray(addedGroups) ? addedGroups : null
  if (fresh === null) clear(box)
  const all = Array.isArray(state.poses.groups) ? state.poses.groups : []
  const groups = fresh === null ? all : fresh
  groups.forEach(function (group) {
    const variant = poseCardVariant(group)
    if (variant === null) return
    const base = textOf(group.base)
    const picked = state.poses.picked[base] || 0
    const card = el('button', {
      class: 'gcard',
      type: 'button',
      dataset: { base: base, picked: picked > 0 ? '1' : '0' },
      'aria-label': '把「' + (textOf(group.name) || base) + '」的 tag 追加到提示词',
    })
    const thumb = el('div', { class: 'gcard-thumb' })
    thumb.append(el('img', {
      src: refSrc(variant.thumb),
      alt: '',
      loading: 'lazy',
      draggable: 'false',
      referrerpolicy: 'no-referrer',
    }))
    thumb.append(el('span', { class: 'gcard-badge', text: picked > 0 ? String(picked) : '' }))
    card.append(thumb)
    card.append(el('div', { class: 'gcard-name', text: textOf(group.name) || base }))
    card.append(el('div', {
      class: 'gcard-meta',
      text: (textOf(group.code) || '') + (Array.isArray(group.variants) && group.variants.length > 1 ? ' · ' + group.variants.length + ' 视角' : ''),
    }))
    box.append(card)
  })
  const empty = $('pose-empty')
  if (empty !== null) empty.hidden = all.length > 0
  const more = $('pose-more')
  if (more !== null) more.hidden = !(Number.isFinite(state.poses.total) && state.poses.offset < state.poses.total)
}


let poseSeq = 0

export async function loadPoses(reset) {
  const p = state.poses
  // 「加载更多」照旧防重入；换筛选立刻发新请求，旧响应回来时序号已过期，直接丢掉。
  if (reset !== true && p.loading) return
  const seq = ++poseSeq
  p.loading = true
  const offset = reset === true ? 0 : p.offset
  const params = new URLSearchParams()
  if (p.q !== '') params.set('q', p.q)
  if (p.set !== '' && p.set !== 'all') params.set('set', p.set)
  if (p.category !== '') params.set('category', p.category)
  if (p.angle !== '') params.set('angle', p.angle)
  params.set('limit', String(PAGE))
  params.set('offset', String(offset))
  const res = await api('/pose-gallery?' + params.toString())
  if (seq !== poseSeq) return
  p.loading = false
  const data = res.data || {}
  if (res.status === 0 || data.ok === false || !Array.isArray(data.groups)) {
    const message = textOf(data.message) || '姿势库加载失败'
    const empty = $('pose-empty')
    if (empty !== null) {
      clear(empty)
      empty.append(el('p', { text: message }))
      empty.append(el('p', { class: 'dim', text: '把 ComfyUI 安装目录填好后再试一次。' }))
      empty.hidden = false
    }
    return
  }
  p.sets = Array.isArray(data.sets) ? data.sets : []
  p.categories = Array.isArray(data.categories) ? data.categories : []
  p.angles = Array.isArray(data.angles) ? data.angles : []
  p.total = Number.isFinite(data.total) ? data.total : 0
  p.offset = offset
  p.groups = reset === true ? data.groups : p.groups.concat(data.groups)
  p.offset = offset + data.groups.length
  renderPoseSets()
  renderPoseCategories()
  renderPoseAngles()
  renderPoseGrid(reset !== true, data.groups)
}


export async function pickPose(base, card) {
  const group = state.poses.groups.find(function (item) { return item.base === base })
  if (group === undefined) return
  const variant = poseCardVariant(group)
  if (variant === null) return
  const params = new URLSearchParams()
  params.set('base', base)
  if (textOf(variant.id) !== '') params.set('ids', textOf(variant.id))
  else params.set('angle', textOf(variant.angle))
  const res = await api('/pose-tags?' + params.toString())
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) { flash(textOf(data.message) || '这个姿势取不到 tag'); return }
  const list = Array.isArray(data.tags) ? data.tags.map(tagName).filter(function (item) { return item !== '' }) : []
  if (list.length === 0) { flash('这个姿势没有映射到 tag'); return }
  appendToPrompt(list.join(', '))
  state.poses.picked[base] = (state.poses.picked[base] || 0) + 1
  if (card !== undefined && card !== null) {
    card.dataset.picked = '1'
    const badge = card.querySelector('.gcard-badge')
    if (badge !== null) badge.textContent = String(state.poses.picked[base])
  }
  flash('已追加 ' + list.length + ' 个 tag')
}
