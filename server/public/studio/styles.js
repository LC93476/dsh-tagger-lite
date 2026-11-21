/* 三栏工作台 · styles 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { GROUP_LABELS, $, state, textOf, el, clear, api, flash, splitTags, tagCore } from './state.js'
import { appendToPrompt } from './prompt.js'
/* ---------------- 中栏：样式 ---------------- */

export function styleGroupLabel(key) {
  const hit = state.styles.groups.find(function (item) {
    if (typeof item === 'string') return item === key
    return item !== null && typeof item === 'object' && (textOf(item.id) === key || textOf(item.key) === key)
  })
  if (hit !== null && typeof hit === 'object') {
    const label = textOf(hit.label)
    if (label !== '') return label
    const title = textOf(hit.title)
    if (title !== '') return title
  }
  return GROUP_LABELS[key] || key
}


export function renderStyles() {
  const box = $('style-groups')
  if (box === null) return
  clear(box)
  const styles = Array.isArray(state.styles.styles) ? state.styles.styles : []
  if (!state.styles.ok) {
    box.append(el('p', { class: 'dim', text: '样式库不可用：' + (state.styles.message || '接口没上线') }))
    return
  }
  if (styles.length === 0) {
    box.append(el('p', { class: 'dim', text: '样式库是空的。' }))
    return
  }
  const order = []
  const map = {}
  styles.forEach(function (style) {
    const key = textOf(style.group) || 'other'
    if (map[key] === undefined) { map[key] = []; order.push(key) }
    map[key].push(style)
  })
  order.forEach(function (key) {
    const section = el('section', { class: 'sgroup' })
    const head = el('div', { class: 'sgroup-h' })
    head.append(el('b', { text: styleGroupLabel(key) }))
    head.append(el('span', { text: String(map[key].length) }))
    section.append(head)
    const grid = el('div', { class: 'sgrid' })
    map[key].forEach(function (style) {
      const id = textOf(style.id)
      const on = state.styles.selected.has(id)
      const card = el('button', {
        class: 'scard' + (on ? ' is-on' : ''),
        type: 'button',
        dataset: { id: id, accent: textOf(style.accent) || 'indigo' },
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': '套用样式「' + (textOf(style.title) || id) + '」',
      })
      card.append(el('span', { class: 'scard-title', text: textOf(style.title) || id }))
      if (textOf(style.note) !== '') card.append(el('span', { class: 'scard-note', text: textOf(style.note) }))
      const tags = Array.isArray(style.tags) ? style.tags : []
      const cn = Array.isArray(style.cn) ? style.cn : []
      const preview = tags.map(function (tag, index) {
        const zh = textOf(cn[index])
        return zh === '' ? tag : tag + '（' + zh + '）'
      })
      card.append(el('span', { class: 'scard-tags', text: preview.join(' · ') }))
      grid.append(card)
    })
    section.append(grid)
    box.append(section)
  })
}


export function paintStylePicked() {
  const picked = state.styles.selected.size
  const label = $('style-picked')
  if (label !== null) label.textContent = '已选 ' + picked
  const button = $('style-apply')
  if (button !== null) button.disabled = picked === 0
}


export async function loadStyles() {
  const res = await api('/styles')
  const data = res.data || {}
  const status = $('style-status')
  if (res.status === 0 || data.ok !== true) {
    state.styles.ok = false
    state.styles.message = textOf(data.message) || (res.status === 0 ? '连不上本地服务' : '接口 HTTP ' + res.status)
    renderStyles()
    if (status !== null) status.textContent = '样式库不可用：' + state.styles.message
    return
  }
  state.styles.ok = true
  state.styles.styles = Array.isArray(data.styles) ? data.styles : []
  state.styles.groups = Array.isArray(data.groups) ? data.groups : []
  renderStyles()
  paintStylePicked()
  if (status !== null) status.textContent = '共 ' + state.styles.styles.length + ' 个样式，点一下选中，再套用到提示词。'
}


export function toggleStyle(id) {
  const key = textOf(id)
  if (key === '') return
  const on = !state.styles.selected.has(key)
  if (on) state.styles.selected.add(key)
  else state.styles.selected.delete(key)
  // 不拼 CSS 选择器：样式 id 里带引号或方括号时选择器会语法错，遍历比 dataset 更稳。
  const cards = document.querySelectorAll('.scard')
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    if (card.dataset === undefined || card.dataset.id !== key) continue
    card.classList.toggle('is-on', on)
    card.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  paintStylePicked()
}


export function applyStyles() {
  const chosen = state.styles.styles.filter(function (style) { return state.styles.selected.has(textOf(style.id)) })
  if (chosen.length === 0) { flash('先选一个样式'); return }
  const box = $('prompt')
  const current = splitTags(box.value).map(function (token) { return tagCore(token).toLowerCase() })
  const add = []
  chosen.forEach(function (style) {
    const tags = Array.isArray(style.tags) ? style.tags : []
    tags.forEach(function (tag) {
      const name = textOf(tag)
      if (name === '' || current.indexOf(name.toLowerCase()) >= 0) return
      current.push(name.toLowerCase())
      add.push(name)
    })
  })
  if (add.length === 0) { flash('这些样式的 tag 都已经在提示词里了'); return }
  appendToPrompt(add.join(', '))
  flash('已套用 ' + chosen.length + ' 个样式，追加 ' + add.length + ' 个 tag')
}
