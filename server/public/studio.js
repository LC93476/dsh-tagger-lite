/* 三栏工作台：左提示词 / 中参考样式 / 右生成结果。
   零构建、零外链、纯原生 ES 模块；只调用 /tagger/api 下既有接口，不改后端。 */


import { LEVELS, LEVEL_LABELS, $, state, textOf, intOf, el, clear, api, copyText, saveUi, applyStored, selectWant, paintProfilePill, paintLlmPill, autoGrow, closeLightbox, applyState, applyProfiles, saveConfig, normalizeLlmBase, normalizeComfyBase, parseComfyInput } from './studio/state.js'
import { renderJudge, doForge } from './studio/prompt.js'
import { showTab, loadPoses, pickPose } from './studio/poses.js'
import { REF_LABELS, paintPopular, loadRefs, renderDock, dockTagText, fillDockTags, closeDock, pickRef } from './studio/refs.js'
import { loadStyles, toggleStyle, applyStyles } from './studio/styles.js'
import { loadWorkflows, renderShots, setRunStage, renderHistory, doRun, uploadRef, clearRef } from './studio/runner.js'
import { applyLlmPreset, fillSettings, settingsOpen, openSettings, closeSettings, probeLlm, saveLlmSettings, probeComfy, launchComfyFromSettings, saveComfySettings } from './studio/settings.js'
/* ---------------- 事件绑定 ---------------- */

export function bindEvents() {
  LEVELS.forEach(function (key) {
    const opt = el('option', { value: key, text: LEVEL_LABELS[key] })
    $('level').append(opt)
  })

  $('prompt').addEventListener('input', function () { autoGrow(); saveUi() })
  $('prompt-clear').addEventListener('click', function () {
    $('prompt').value = ''
    autoGrow()
    saveUi()
    $('prompt').focus()
  })

  $('btn-forge').addEventListener('click', function () { doForge() })
  $('prompt').addEventListener('keydown', function (event) {
    // Ctrl/Cmd+Enter 直接锻造；中文输入法组词时的回车不算 + Enter
    if (event.key !== 'Enter' || (event.ctrlKey !== true && event.metaKey !== true)) return
    if (event.isComposing === true) return
    event.preventDefault()
    doForge()
  })
  $('solo').title = '勾上后在描述末尾补一句「画面里只画一个人」，不改 tag 解析'
  $('solo').addEventListener('change', function () { state.ui.solo = $('solo').checked; saveUi() })
  $('maxTags').addEventListener('change', function () { state.ui.maxTags = intOf($('maxTags').value, 40, 8, 160); $('maxTags').value = String(state.ui.maxTags); saveUi() })
  $('level').addEventListener('change', function () {
    state.ui.level = LEVELS.indexOf($('level').value) >= 0 ? $('level').value : 'full'
    saveUi()
  })
  $('profile').addEventListener('change', function () {
    state.ui.profile = $('profile').value
    // 药丸读的是 state.profiles.current，先同步再画，否则永远显示启动时那个档案
    state.profiles.current = state.ui.profile
    paintProfilePill()
    saveUi()
    saveConfig({ forge: { profile: state.ui.profile } })
  })

  $('pos-copy').addEventListener('click', function () { copyText(state.forge.positive, '正向') })
  $('neg-copy').addEventListener('click', function () { copyText(state.forge.negative, '负向') })

  $('tab-pose').addEventListener('click', function () { showTab('pose') })
  $('tab-style').addEventListener('click', function () { showTab('style') })

  var qTimer = 0
  $('pose-q').addEventListener('input', function () {
    if (qTimer !== 0) window.clearTimeout(qTimer)
    qTimer = window.setTimeout(function () {
      // 只换筛选：已追加次数的角标（state.poses.picked）不该被搜索清掉
      state.poses.q = $('pose-q').value.trim()
      loadPoses(true)
    }, 250)
  })

  $('pose-sets').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.poses.set = hit.dataset.set
    state.poses.category = ''
    loadPoses(true)
  })
  $('pose-cats').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-category]')
    if (hit === null) return
    state.poses.category = hit.dataset.category
    loadPoses(true)
  })
  $('pose-angles').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-angle]')
    if (hit === null) return
    state.poses.angle = hit.dataset.angle
    loadPoses(true)
  })
  $('pose-more').addEventListener('click', function () { loadPoses(false) })
  $('pose-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.gcard')
    if (card === null) return
    pickPose(card.dataset.base, card)
  })

  $('tab-costume').addEventListener('click', function () { showTab('costume') })
  $('tab-portrait').addEventListener('click', function () { showTab('portrait') })

  const refTimer = { costume: 0, portrait: 0 }
  ;[['costume', 'costume-q'], ['portrait', 'portrait-q']].forEach(function (pair) {
    const kind = pair[0]
    const box = $(pair[1])
    if (box === null) return
    box.addEventListener('input', function () {
      if (refTimer[kind] !== 0) window.clearTimeout(refTimer[kind])
      refTimer[kind] = window.setTimeout(function () {
        state.refs[kind].q = box.value.trim()
        loadRefs(kind, true)
      }, 250)
    })
  })

  $('costume-cats').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.refs.costume.set = hit.dataset.set
    loadRefs('costume', true)
  })
  $('portrait-sets').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-set]')
    if (hit === null) return
    state.refs.portrait.set = hit.dataset.set
    loadRefs('portrait', true)
  })
  $('portrait-hairs').addEventListener('click', function (event) {
    const hit = event.target.closest('[data-hair]')
    if (hit === null) return
    state.refs.portrait.hair = hit.dataset.hair
    loadRefs('portrait', true)
  })
  $('portrait-popular').addEventListener('click', function () {
    state.refs.portrait.popular = state.refs.portrait.popular !== true
    paintPopular()
    loadRefs('portrait', true)
  })
  $('costume-more').addEventListener('click', function () { loadRefs('costume', false) })
  $('portrait-more').addEventListener('click', function () { loadRefs('portrait', false) })
  $('ref-costume-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.rcard')
    if (card === null) return
    pickRef('costume', card.dataset.refId)
  })
  $('ref-portrait-grid').addEventListener('click', function (event) {
    const card = event.target.closest('.rcard')
    if (card === null) return
    pickRef('portrait', card.dataset.refId)
  })
  $('ref-dock-copy').addEventListener('click', function () {
    if (state.dock.tags.length === 0) return
    copyText(dockTagText(), (REF_LABELS[state.dock.kind] || '参考') + ' tag')
  })
  $('ref-dock-fill').addEventListener('click', function () { fillDockTags() })
  $('ref-dock-clear').addEventListener('click', function () { closeDock() })
  $('ref-dock-tags').addEventListener('click', function (event) {
    const chip = event.target.closest('[data-index]')
    if (chip === null) return
    const index = Number(chip.dataset.index)
    if (!Number.isFinite(index)) return
    state.dock.tags.splice(index, 1)
    renderDock()
  })

  $('style-groups').addEventListener('click', function (event) {
    const card = event.target.closest('.scard')
    if (card === null) return
    toggleStyle(card.dataset.id)
  })
  $('style-apply').addEventListener('click', function () { applyStyles() })

  $('workflow').addEventListener('change', function () { state.ui.workflowId = $('workflow').value; saveUi() })
  ;['width', 'height', 'seed', 'steps', 'cfg'].forEach(function (id) {
    $(id).addEventListener('change', function () { saveUi() })
  })
  $('ref-file').addEventListener('change', function () { uploadRef($('ref-file').files[0]) })
  $('ref-clear').addEventListener('click', function () { clearRef() })
  $('btn-run').addEventListener('click', function () { doRun() })

  $('btn-settings').addEventListener('click', function () { openSettings() })
  $('settings-close').addEventListener('click', function () { closeSettings() })
  $('settings').addEventListener('click', function (event) {
    if (event.target.dataset.close !== undefined) closeSettings()
  })
  $('set-llm-preset').addEventListener('change', function () { applyLlmPreset() })
  $('set-llm-base').addEventListener('blur', function () {
    const box = $('set-llm-base')
    if (box !== null) box.value = normalizeLlmBase(box.value)
  })
  $('set-llm-probe').addEventListener('click', function () { probeLlm() })
  $('set-llm-save').addEventListener('click', function () { saveLlmSettings() })
  // 保存后配置要落盘再回读，给个小延迟把 LLM 药丸重新校准一遍
  $('set-llm-save').addEventListener('click', function () { window.setTimeout(syncLlmFromHealth, 600) })
  $('set-comfy-base').addEventListener('blur', function () {
    const box = $('set-comfy-base')
    if (box !== null) box.value = normalizeComfyBase(box.value)
  })
  $('set-comfy-dir').addEventListener('change', function () {
    const parsed = parseComfyInput($('set-comfy-dir').value)
    const dirBox = $('set-comfy-dir')
    const pyBox = $('set-comfy-python')
    const argsBox = $('set-comfy-args')
    if (dirBox !== null && parsed.dir !== '') dirBox.value = parsed.dir
    if (pyBox !== null && parsed.python !== '' && textOf(pyBox.value) === '') pyBox.value = parsed.python
    if (argsBox !== null && parsed.args !== '' && textOf(argsBox.value) === '') argsBox.value = parsed.args
  })
  $('set-comfy-ping').addEventListener('click', function () { probeComfy() })
  $('set-comfy-launch').addEventListener('click', function () { launchComfyFromSettings() })
  $('set-comfy-save').addEventListener('click', function () { saveComfySettings() })

  $('lightbox').addEventListener('click', function (event) {
    if (event.target.dataset.close !== undefined) closeLightbox()
  })
  $('lightbox-close').addEventListener('click', function () { closeLightbox() })
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    if (settingsOpen()) { closeSettings(); return }
    if ($('ref-dock') !== null && $('ref-dock').hidden === false) { closeDock(); return }
    closeLightbox()
  })
}

/* ---------------- 启动 ---------------- */

async function syncLlmFromHealth() {
  // /health 的 llmReady 是服务端实际判定（含内置服务与已存 key），比从 /state 推断准
  const res = await api('/health')
  const data = res.data || {}
  if (typeof data.llmReady !== 'boolean') return
  state.llm.ready = data.llmReady
  const llm = data.llm !== null && typeof data.llm === 'object' ? data.llm : {}
  if (textOf(llm.model) !== '') state.llm.model = textOf(llm.model)
  paintLlmPill()
}


export async function boot() {
  bindEvents()
  applyStored()
  autoGrow()
  selectWant('level', 'full')
  selectWant('profile', 'tag')
  state.ui.maxTags = intOf($('maxTags').value, 40, 8, 160)
  state.ui.level = LEVELS.indexOf($('level').value) >= 0 ? $('level').value : 'full'
  state.ui.solo = $('solo').checked
  showTab('pose')
  renderJudge()
  renderHistory()
  renderShots()
  setRunStage('idle', '就绪')

  const results = await Promise.all([api('/state'), api('/profiles')])
  applyState(results[0])
  applyProfiles(results[1])
  // localStorage 里存过旧档案时，selectWant 会拿它压住服务端配置（下拉与顶栏药丸就会各说各的）；
  // 以配置为准再设一次，顺手把那个旧期望值清掉。
  const profileBox = $('profile')
  if (profileBox !== null) {
    delete profileBox.dataset.want
    selectWant('profile', state.ui.profile || 'tag')
    state.profiles.current = profileBox.value
    paintProfilePill()
  }
  fillSettings(true)
  saveUi()
  await syncLlmFromHealth()
  await Promise.all([loadWorkflows(), loadStyles(), loadPoses(true)])
}

boot().catch(function (error) {
  const line = $('forge-status')
  if (line !== null) line.textContent = '面板初始化失败：' + (error && error.message ? error.message : String(error))
})
