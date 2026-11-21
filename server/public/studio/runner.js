/* 三栏工作台 · runner 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { POLL_MS, HIST_MAX, STAGE_LABELS, $, state, textOf, intOf, floatOf, el, clear, api, flash, selectWant, imageUrl, openLightbox } from './state.js'
/* ---------------- 右栏：工作流与出图 ---------------- */

export async function loadWorkflows() {
  const box = $('workflow')
  const res = await api('/workflows')
  const data = res.data || {}
  if (box === null) return
  clear(box)
  if (res.status === 0 || data.ok === false || !Array.isArray(data.workflows)) {
    box.append(el('option', { value: '', text: textOf(data.message) || '工作流读不到' }))
    return
  }
  const list = data.workflows
  if (list.length === 0) { box.append(el('option', { value: '', text: '工作流目录是空的' })); return }
  list.forEach(function (item) {
    const id = textOf(item.id)
    if (id === '') return
    const note = []
    // 工作流多半只有中文标题没有 name，标题优先，别再显示成光秃秃的文件名
    const title = textOf(item.title)
    if (title !== '' && title !== id) note.push(title)
    else if (typeof item.name === 'string' && item.name !== '' && item.name !== id) note.push(item.name)
    if (Number.isFinite(item.nodes)) note.push(item.nodes + ' 节点')
    if (textOf(item.message) !== '') note.push(item.message)
    box.append(el('option', { value: id, text: note.length > 0 ? id + ' · ' + note.join(' · ') : id }))
  })
  selectWant('workflow', state.ui.workflowId)
  state.ui.workflowId = box.value
}


export function renderShots() {
  const box = $('results')
  const empty = $('results-empty')
  if (box === null) return
  clear(box)
  const images = Array.isArray(state.run.images) ? state.run.images : []
  images.forEach(function (item) {
    const src = imageUrl(item)
    if (src === '') return
    const button = el('button', { class: 'shot', type: 'button', 'aria-label': '放大查看这张图' })
    button.append(el('img', { src: src, alt: textOf(item.filename) || '生成结果', loading: 'lazy' }))
    button.addEventListener('click', function () { openLightbox(src, textOf(item.filename) || '生成结果') })
    box.append(button)
  })
  if (empty !== null) empty.hidden = images.length > 0
}


export function setRunStage(stage, message) {
  state.run.stage = stage
  const badge = $('run-badge')
  if (badge !== null) badge.textContent = STAGE_LABELS[stage] || stage
  const line = $('run-status')
  if (line !== null) line.textContent = message === undefined || message === '' ? (STAGE_LABELS[stage] || stage) : String(message)
  const bar = $('run-progress')
  if (bar !== null) {
    const show = stage === 'queued' || stage === 'running'
    bar.hidden = !show
    const fill = bar.firstElementChild
    if (fill !== null) fill.style.width = Math.round(Math.max(0, Math.min(1, state.run.progress)) * 100) + '%'
  }
}


export function pushHistory(entry) {
  state.history.unshift(entry)
  if (state.history.length > HIST_MAX) state.history.length = HIST_MAX
  renderHistory()
}


export function renderHistory() {
  const box = $('history')
  if (box === null) return
  clear(box)
  state.history.forEach(function (entry) {
    const item = el('li', { class: 'hi' })
    if (entry.thumb !== '') item.append(el('img', { class: 'hi-thumb', alt: '', loading: 'lazy', src: entry.thumb }))
    else item.append(el('span', { class: 'hi-thumb is-empty', 'aria-hidden': 'true' }))
    const main = el('div', { class: 'hi-main' })
    main.append(el('b', { text: entry.workflowId || '（未选工作流）' }))
    main.append(el('span', { text: (entry.time || '') + ' · seed ' + String(entry.seed) }))
    item.append(main)
    item.append(el('span', { class: 'hi-state', dataset: { s: entry.state || 'queued' }, text: STAGE_LABELS[entry.state] || entry.state || 'queued' }))
    box.append(item)
  })
  const count = $('hist-count')
  if (count !== null) count.textContent = state.history.length + ' 条'
}


export function currentVars() {
  const vars = {
    width: intOf($('width').value, 1200, 64, 4096),
    height: intOf($('height').value, 1800, 64, 4096),
    seed: intOf($('seed').value, 20261108, 0, Number.MAX_SAFE_INTEGER),
    steps: intOf($('steps').value, 30, 1, 150),
    cfg: floatOf($('cfg').value, 5.03, 0.5, 30),
  }
  // 变量名与工作流模板一致：参考图就叫 image（不是 refImage）
  if (state.ref.name !== '') vars.image = state.ref.name
  return vars
}


export async function doRun() {
  if (state.run.running) return
  const button = $('btn-run')
  const workflowId = $('workflow') === null ? '' : $('workflow').value
  if (workflowId === '') { flash('先选一个工作流'); return }
  const positive = state.forge.positive
  if (positive.trim() === '') { flash('正向提示词是空的，先锻造'); return }
  const vars = currentVars()
  state.run.running = true
  pollSeq += 1
  pollUnknown = 0
  state.run.images = []
  state.run.progress = 0
  if (button !== null) button.disabled = true
  setRunStage('queued', '提交中…')
  renderShots()
  const res = await api('/run', { body: { workflowId: workflowId, positive: positive, negative: state.forge.negative, vars: vars } })
  const data = res.data || {}
  if (res.status === 0 || data.ok !== true) {
    const message = textOf(data.message) || ('提交失败（HTTP ' + res.status + '）')
    state.run.running = false
    if (button !== null) button.disabled = false
    setRunStage('failed', message)
    pushHistory({ time: clock(), workflowId: workflowId, seed: vars.seed, state: 'failed', thumb: '' })
    return
  }
  state.run.promptId = textOf(data.promptId)
  const entry = { time: clock(), workflowId: workflowId, seed: vars.seed, state: 'queued', thumb: '' }
  pushHistory(entry)
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(function (item) { return typeof item === 'string' && item !== '' }) : []
  const queue = Number.isFinite(data.queueNumber) ? '队列第 ' + data.queueNumber + ' 位' : '已提交'
  setRunStage('queued', queue + (warnings.length > 0 ? ' · ' + warnings[0] : ''))
  schedulePoll()
}


export function clock() {
  const now = new Date()
  const pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())
}


let pollSeq = 0
let pollUnknown = 0


export function schedulePoll() {
  if (state.run.timer !== 0) window.clearTimeout(state.run.timer)
  // 把当前这一单的序号带上：定时器晚一步触发时，属于上一单的轮询会被直接丢掉
  const token = pollSeq
  state.run.timer = window.setTimeout(function () { pollJob(token) }, POLL_MS)
}


export function finishRun(stage, message) {
  state.run.running = false
  const button = $('btn-run')
  if (button !== null) button.disabled = false
  setRunStage(stage, message)
  state.run.progress = stage === 'done' ? 1 : state.run.progress
  const head = state.history[0]
  if (head !== undefined) {
    head.state = stage
    const first = Array.isArray(state.run.images) ? state.run.images[0] : undefined
    if (first !== undefined) head.thumb = imageUrl(first)
    renderHistory()
  }
}


export async function pollJob(token) {
  const stamp = token === undefined ? pollSeq : token
  if (stamp !== pollSeq) return
  const id = state.run.promptId
  if (id === '') { finishRun('unknown', '没有 promptId'); return }
  const res = await api('/job?id=' + encodeURIComponent(id))
  // 等待期间又点了一次出图：这轮响应属于上一单，丢掉，别覆盖新一轮的进度与结果
  if (stamp !== pollSeq) return
  const data = res.data || {}
  if (res.status === 0) { finishRun('failed', textOf(data.message) || '连不上本地服务'); return }
  if (data.ok !== true) {
    finishRun('failed', textOf(data.message) || ('查状态失败（HTTP ' + res.status + '）'))
    return
  }
  const stage = textOf(data.state) || 'unknown'
  if (Number.isFinite(data.progress)) state.run.progress = data.progress
  if (stage === 'done') {
    state.run.images = Array.isArray(data.images) ? data.images : []
    renderShots()
    finishRun('done', textOf(data.message) || ('完成 · ' + state.run.images.length + ' 张图'))
    return
  }
  if (stage === 'failed') {
    state.run.images = Array.isArray(data.images) ? data.images : []
    renderShots()
    finishRun('failed', textOf(data.message) || '生成失败')
    return
  }
  if (stage === 'unknown') {
    pollUnknown += 1
    if (pollUnknown >= 15) { finishRun('unknown', '连续 15 次查不到这个任务，先停下；确认 ComfyUI 还在跑再点出图'); return }
  } else {
    pollUnknown = 0
  }
  const progress = Math.round(Math.max(0, Math.min(1, state.run.progress)) * 100)
  setRunStage(stage, (STAGE_LABELS[stage] || stage) + (stage === 'running' ? ' ' + progress + '%' : ''))
  const head = state.history[0]
  if (head !== undefined && head.state !== stage) { head.state = stage; renderHistory() }
  schedulePoll()
}

/* ---------------- 参考图上传 ---------------- */

export function readFileAsDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader()
    reader.onload = function () { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = function () { reject(new Error('读文件失败')) }
    reader.readAsDataURL(file)
  })
}


export function paintRefName() {
  const box = $('ref-name')
  if (box !== null) {
    const name = state.ref.name
    box.textContent = name === '' ? '' : '参考图：' + name
    box.hidden = name === ''
  }
  const button = $('ref-clear')
  if (button !== null) button.hidden = state.ref.name === ''
}


export function clearRef() {
  state.ref.name = ''
  paintRefName()
  const input = $('ref-file')
  if (input !== null) input.value = ''
  // 出图中别抢 #run-status 的进度文案，只在空闲时留一行确认
  const line = $('run-status')
  if (line !== null && state.run.running !== true) line.textContent = '参考图已清除'
  flash('参考图已清除')
}


export async function uploadRef(file) {
  if (file === null || file === undefined) { state.ref.name = ''; paintRefName(); return }
  if (state.ref.busy) return
  state.ref.busy = true
  const line = $('run-status')
  if (line !== null) line.textContent = '上传参考图…'
  try {
    const dataUrl = await readFileAsDataUrl(file)
    const comma = dataUrl.indexOf(',')
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
    if (base64 === '') { if (line !== null) line.textContent = '参考图读不出来'; return }
    const res = await api('/upload', { body: { filename: file.name, data: base64 } })
    const data = res.data || {}
    if (res.status === 0 || data.ok !== true) {
      if (line !== null) line.textContent = textOf(data.message) || '参考图上传失败'
      return
    }
    state.ref.name = textOf(data.name) || textOf(data.filename) || file.name
    paintRefName()
    if (line !== null) line.textContent = '参考图已就位：' + state.ref.name
  } catch (err) {
    if (line !== null) line.textContent = '参考图上传失败'
  } finally {
    state.ref.busy = false
  }
}
