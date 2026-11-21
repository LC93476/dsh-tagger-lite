/* 三栏工作台 · refs 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { API, $, state, textOf, refSrc, el, clear, api, flash, tagName, tagCn } from './state.js'
import { appendToPrompt } from './prompt.js'
/* ---------------- 中栏：服装 / 人像 ---------------- */

export const REF_PAGE = 36

export const REF_LABELS = { costume: '服装', portrait: '人像' }

export const REF_EMPTY = {
  costume: ['没有匹配的服装。', '换个关键词，或点「全部分类」看回来。'],
  portrait: ['没有匹配的人像。', '换个关键词，或把筛选放宽一点。'],
}

export const REF_FAIL_HINT = '参考库接口还没就绪时这里会留空；素材目录也要在 ComfyUI 的安装目录里。'

export const REF_FAIL_TEXT = '参考库暂时用不了'


export function refFailText(message) {
  const text = textOf(message)
  if (text === '' || text.indexOf('/') >= 0 || /^network$/i.test(text)) return REF_FAIL_TEXT
  return text
}


export function refGridBox(kind) {
  return $(kind === 'costume' ? 'ref-costume-grid' : 'ref-portrait-grid')
}


export function refCountBox(kind) {
  return $('tab-' + kind + '-count')
}


export function setRefEmpty(kind, line, hint) {
  const head = $(kind + '-empty-line')
  const tail = $(kind + '-empty-hint')
  if (head !== null) head.textContent = line
  if (tail !== null) {
    tail.textContent = hint
    tail.hidden = hint === ''
  }
  const empty = $(kind + '-empty')
  if (empty !== null) empty.hidden = false
  const more = $(kind + '-more')
  if (more !== null) more.hidden = true
}


export function resetRefEmpty(kind) {
  setRefEmpty(kind, REF_EMPTY[kind][0], REF_EMPTY[kind][1])
}


export function paintRefCount(kind, total) {
  const box = refCountBox(kind)
  if (box === null) return
  const show = Number.isFinite(total) && total > 0
  box.textContent = show ? String(total) : ''
  box.hidden = !show
}


export function renderCostumeCats() {
  const box = $('costume-cats')
  if (box === null) return
  clear(box)
  const ref = state.refs.costume
  box.append(el('button', {
    class: 'pill-i' + (ref.set === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { set: '' },
    text: '全部分类',
  }))
  const list = Array.isArray(ref.categories) ? ref.categories : []
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === ref.set ? ' is-on' : ''),
      type: 'button',
      dataset: { set: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}


export function renderPortraitSets() {
  const box = $('portrait-sets')
  if (box === null) return
  clear(box)
  const ref = state.refs.portrait
  const list = Array.isArray(ref.sets) ? ref.sets : []
  if (list.length === 0) {
    box.append(el('button', {
      class: 'seg-i is-on',
      type: 'button',
      role: 'tab',
      dataset: { set: 'all' },
      text: '全部',
    }))
    return
  }
  list.forEach(function (item) {
    const key = textOf(item.key) || 'all'
    const button = el('button', {
      class: 'seg-i' + (key === ref.set ? ' is-on' : ''),
      type: 'button',
      role: 'tab',
      dataset: { set: key },
      text: (textOf(item.label) || key) + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    })
    button.setAttribute('aria-selected', key === ref.set ? 'true' : 'false')
    box.append(button)
  })
}


export function renderPortraitHairs() {
  const box = $('portrait-hairs')
  if (box === null) return
  clear(box)
  const ref = state.refs.portrait
  box.append(el('button', {
    class: 'pill-i' + (ref.hair === '' ? ' is-on' : ''),
    type: 'button',
    dataset: { hair: '' },
    text: '全部发型',
  }))
  const list = Array.isArray(ref.hairs) ? ref.hairs : []
  list.forEach(function (item) {
    const key = textOf(item.key)
    if (key === '') return
    box.append(el('button', {
      class: 'pill-i' + (key === ref.hair ? ' is-on' : ''),
      type: 'button',
      dataset: { hair: key },
      text: key + ' ' + (Number.isFinite(item.count) ? item.count : ''),
    }))
  })
}


export function paintPopular() {
  const button = $('portrait-popular')
  if (button === null) return
  const on = state.refs.portrait.popular === true
  button.classList.toggle('is-on', on)
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
}


export function refCard(kind, item) {
  const isCostume = kind === 'costume'
  const id = textOf(item.id)
  const title = isCostume ? (textOf(item.name) || id) : (textOf(item.title) || id)
  const corner = isCostume ? textOf(item.category) : textOf(item.hair)
  const meta = isCostume
    ? [id, textOf(item.keywords)].filter(function (part) { return part !== '' }).join(' · ')
    : [textOf(item.partition), textOf(item.style)].filter(function (part) { return part !== '' }).join(' · ')
  const src = refSrc(isCostume ? item.thumb : item.image)
  const card = el('button', {
    class: 'gcard rcard' + (isCostume ? '' : ' rcard-portrait'),
    type: 'button',
    dataset: { refKind: kind, refId: id, picked: '0' },
    'aria-label': '把「' + title + '」的 tag 加到提示词',
  })
  const thumb = el('div', { class: 'gcard-thumb', dataset: { tone: kind } })
  if (src !== '') {
    thumb.append(el('img', {
      src: src,
      alt: '',
      loading: 'lazy',
      draggable: 'false',
      referrerpolicy: 'no-referrer',
    }))
  }
  if (corner !== '') thumb.append(el('span', { class: 'rcard-tag', text: corner }))
  if (kind === 'portrait' && item.popular === true) thumb.append(el('span', { class: 'rcard-hot', text: '热门' }))
  thumb.append(el('span', { class: 'gcard-badge', text: '' }))
  card.append(thumb)
  card.append(el('div', { class: 'gcard-name' + (isCostume ? '' : ' rcard-name-one'), text: title }))
  card.append(el('div', { class: 'gcard-meta', text: meta }))
  return card
}


export function renderRefGrid(kind, append, addedItems) {
  const box = refGridBox(kind)
  if (box === null) return
  const ref = state.refs[kind]
  // 与姿势栏同一处理：加载更多只画新增切片，累计数组留在 state 里做总数与空态判断。
  const fresh = append === true && Array.isArray(addedItems) ? addedItems : null
  if (fresh === null) clear(box)
  const items = fresh === null ? ref.items : fresh
  items.forEach(function (item) { box.append(refCard(kind, item)) })
  const empty = $(kind + '-empty')
  if (empty !== null) {
    if (ref.items.length > 0) empty.hidden = true
    else resetRefEmpty(kind)
  }
  const more = $(kind + '-more')
  if (more !== null) more.hidden = !(Number.isFinite(ref.total) && ref.offset < ref.total)
  paintRefCount(kind, ref.total)
}


export function refFail(kind, message) {
  const ref = state.refs[kind]
  ref.items = []
  ref.total = 0
  ref.offset = 0
  const box = refGridBox(kind)
  if (box !== null) clear(box)
  setRefEmpty(kind, message === '' ? '参考库加载失败' : message, REF_FAIL_HINT)
  paintRefCount(kind, 0)
}


const refSeq = { costume: 0, portrait: 0 }

export async function loadRefs(kind, reset) {
  const ref = state.refs[kind]
  if (reset !== true && ref.loading) return
  refSeq[kind] += 1
  const seq = refSeq[kind]
  ref.loading = true
  const offset = reset === true ? 0 : ref.offset
  const params = new URLSearchParams()
  params.set('kind', kind)
  if (ref.q !== '') params.set('q', ref.q)
  if (ref.set !== '' && ref.set !== 'all') params.set('set', ref.set)
  if (kind === 'portrait' && ref.hair !== '') params.set('hair', ref.hair)
  if (kind === 'portrait' && ref.popular === true) params.set('popular', '1')
  params.set('limit', String(REF_PAGE))
  params.set('offset', String(offset))
  const res = await api('/refs?' + params.toString())
  if (seq !== refSeq[kind]) return
  ref.loading = false
  ref.tried = true
  const data = res.data || {}
  if (res.status === 0 || data.ok === false || !Array.isArray(data.items)) {
    ref.ok = false
    ref.message = textOf(data.message)
    refFail(kind, refFailText(ref.message))
    return
  }
  ref.ok = true
  ref.message = ''
  ref.sets = Array.isArray(data.sets) ? data.sets : ref.sets
  ref.categories = Array.isArray(data.categories) ? data.categories : []
  ref.hairs = Array.isArray(data.hairs) ? data.hairs : []
  ref.total = Number.isFinite(data.total) ? data.total : 0
  ref.items = reset === true ? data.items : ref.items.concat(data.items)
  ref.offset = offset + data.items.length
  if (kind === 'costume') renderCostumeCats()
  else {
    if (ref.set === '') ref.set = 'all'
    renderPortraitSets()
    renderPortraitHairs()
    paintPopular()
  }
  renderRefGrid(kind, reset !== true, data.items)
}


export function dockEmpty() {
  return { kind: '', id: '', name: '', meta: '', thumb: '', tags: [], note: '' }
}


export function renderDock() {
  const dock = $('ref-dock')
  if (dock === null) return
  const data = state.dock
  const thumb = $('ref-dock-thumb')
  if (thumb !== null) {
    if (data.thumb !== '') thumb.src = data.thumb
    else thumb.removeAttribute('src')
    thumb.hidden = data.thumb === ''
  }
  const name = $('ref-dock-name')
  if (name !== null) name.textContent = data.name
  const meta = $('ref-dock-meta')
  if (meta !== null) meta.textContent = data.meta
  const box = $('ref-dock-tags')
  if (box !== null) {
    clear(box)
    data.tags.forEach(function (item, index) {
      box.append(el('button', {
        class: 'rdock-tag',
        type: 'button',
        dataset: { index: String(index) },
        title: '点掉这个 tag',
        text: item.tag + (item.cn !== '' ? ' ' + item.cn : ''),
      }))
    })
  }
  const note = $('ref-dock-note')
  if (note !== null) {
    note.textContent = data.note
    note.hidden = data.note === ''
  }
  const has = data.tags.length > 0
  const copy = $('ref-dock-copy')
  if (copy !== null) copy.disabled = !has
  const fill = $('ref-dock-fill')
  if (fill !== null) fill.disabled = !has
}


export function openDock(kind, item) {
  const isCostume = kind === 'costume'
  state.dock = {
    kind: kind,
    id: textOf(item.id),
    name: isCostume ? (textOf(item.name) || textOf(item.id)) : (textOf(item.title) || textOf(item.id)),
    meta: isCostume
      ? [textOf(item.category), textOf(item.id)].filter(function (part) { return part !== '' }).join(' · ')
      : [textOf(item.partition), textOf(item.hair), textOf(item.style)].filter(function (part) { return part !== '' }).join(' · '),
    thumb: refSrc(isCostume ? item.thumb : item.image),
    tags: [],
    note: '',
  }
  const dock = $('ref-dock')
  if (dock !== null) dock.hidden = false
  renderDock()
}


export function dockTagText() {
  return state.dock.tags.map(function (item) { return item.tag }).join(', ')
}


export function fillDockTags() {
  if (state.dock.tags.length === 0) { flash('这个参考还没有可用的 tag'); return }
  appendToPrompt(dockTagText())
  flash('已追加 ' + state.dock.tags.length + ' 个 tag')
}


export function closeDock() {
  state.dock = dockEmpty()
  const dock = $('ref-dock')
  if (dock !== null) dock.hidden = true
}


export async function pickRef(kind, id) {
  const ref = state.refs[kind]
  const item = ref.items.find(function (entry) { return textOf(entry.id) === id })
  if (item === undefined) return
  openDock(kind, item)
  const params = new URLSearchParams()
  params.set('kind', kind)
  params.set('id', id)
  const res = await api('/ref-tags?' + params.toString())
  if (state.dock.kind !== kind || state.dock.id !== id) return
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) {
    state.dock.tags = []
    state.dock.note = res.status === 501
      ? '标签接口还没上线，可以先照名称手动补。'
      : (textOf(data.message) || '取不到这个参考的 tag')
    renderDock()
    return
  }
  const packTags = function (list) {
    const seen = {}
    return (Array.isArray(list) ? list : [])
      .map(function (entry) { return { tag: tagName(entry), cn: tagCn(entry) } })
      .filter(function (entry) {
        if (entry.tag === '' || seen[entry.tag] === true) return false
        seen[entry.tag] = true
        return true
      })
  }
  // 现接口回 positive / negative（docs/API.md:284-292），早先约定的是 tags，两种都认。
  const tags = packTags(Array.isArray(data.positive) ? data.positive : data.tags)
  const negative = packTags(data.negative)
  state.dock.tags = tags
  if (tags.length === 0) state.dock.note = '这个参考没有映射到 tag，可以照名称手动补。'
  else if (negative.length > 0) {
    state.dock.note = '还会补上负向：' + negative.map(function (entry) { return entry.tag }).join(', ')
  } else state.dock.note = ''
  renderDock()
  if (tags.length === 0) return
  const box = refGridBox(kind)
  if (box === null) return
  box.querySelectorAll('.rcard').forEach(function (card) {
    if (card.dataset.refId !== id) return
    card.dataset.picked = '1'
    const badge = card.querySelector('.gcard-badge')
    if (badge !== null) badge.textContent = '✓'
  })
}
