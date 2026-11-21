/* 三栏工作台 · settings 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */

import { $, state, textOf, el, clear, api, flash, paintComfyPill, paintLlmPill, applyState, saveConfig, dropQuotes, tidyPath, pathRoot, normalizeLlmBase, normalizeComfyBase, parseComfyInput } from './state.js'
import { loadWorkflows } from './runner.js'
/* ---------------- 接口设置：LLM 与 ComfyUI ---------------- */

export const LLM_PRESETS = [
  { id: 'builtin', label: '本机内置 LLM（provider 照旧）', provider: '', baseUrl: '', model: '' },
  { id: 'deepseek', label: 'DeepSeek 官方', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'siliconflow', label: '硅基流动', provider: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'dashscope', label: '阿里百炼', provider: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'ollama', label: '本机 Ollama', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  { id: 'opencode', label: 'opencode 内置（订阅）', provider: 'opencode-go', baseUrl: 'https://opencode.ai/inference/go/v1', model: 'deepseek-v4.1-flash' },
]

export const COMFY_DIR_HINTS = ['C:/ComfyUI', 'D:/ComfyUI', 'D:/ComfyUI_windows_portable/ComfyUI', 'D:/AI/ComfyUI', 'C:/Users/Public/ComfyUI']


export function setSetStatus(id, message, kind) {
  const node = $(id)
  if (node === null) return
  node.textContent = String(message)
  node.dataset.kind = kind || ''
}


export function applyLlmPreset() {
  const box = $('set-llm-preset')
  if (box === null) return
  const hit = LLM_PRESETS.find(function (item) { return item.id === box.value })
  if (hit === undefined) return
  if (hit.baseUrl !== '') $('set-llm-base').value = hit.baseUrl
  if (hit.model !== '') $('set-llm-model').value = hit.model
  if (hit.baseUrl === '' && hit.model === '') {
    $('set-llm-base').value = ''
    $('set-llm-model').value = ''
    setSetStatus('set-llm-status', '内置服务：地址留空，provider 用配置里那个', '')
  } else {
    setSetStatus('set-llm-status', '已套用预设，填 key 后测试', '')
  }
}


export function fillSettings(force) {
  const config = state.config !== null && typeof state.config === 'object' ? state.config : {}
  const llm = config.llm !== null && typeof config.llm === 'object' ? config.llm : {}
  const comfy = config.comfy !== null && typeof config.comfy === 'object' ? config.comfy : {}

  const preset = $('set-llm-preset')
  if (preset !== null && preset.options.length <= 1) {
    LLM_PRESETS.forEach(function (item) {
      preset.append(el('option', { value: item.id, text: item.label, dataset: { provider: item.provider } }))
    })
  }
  const dirs = $('set-comfy-dirs')
  if (dirs !== null && dirs.children.length === 0) {
    COMFY_DIR_HINTS.forEach(function (item) { dirs.append(el('option', { value: item })) })
  }

  const typing = function (id) { const node = $(id); return node !== null && document.activeElement === node }
  if (force === true || !typing('set-llm-base')) { const node = $('set-llm-base'); if (node !== null) node.value = textOf(llm.baseUrl) }
  if (force === true || !typing('set-llm-model')) { const node = $('set-llm-model'); if (node !== null) node.value = textOf(llm.model) }
  if (force === true) { const node = $('set-llm-key'); if (node !== null) node.value = '' }

  // 已存的地址能对上某个预设，就把预设顺手选中，省得用户自己回查用了哪家
  if (preset !== null && textOf(llm.baseUrl) !== '') {
    const hit = LLM_PRESETS.find(function (item) { return item.baseUrl !== '' && normalizeLlmBase(item.baseUrl) === normalizeLlmBase(llm.baseUrl) })
    if (hit !== undefined) preset.value = hit.id
  }

  const keyHint = $('set-llm-keyhint')
  if (keyHint !== null) {
    keyHint.textContent = llm.apiKeySet === true
      ? '已保存 ' + (textOf(llm.apiKeyHint) || '（掩码）') + '，留空就不改'
      : '还没有保存过 key'
  }

  if (force === true || !typing('set-comfy-base')) { const node = $('set-comfy-base'); if (node !== null) node.value = textOf(comfy.baseUrl) || 'http://127.0.0.1:8188' }
  if (force === true || !typing('set-comfy-dir')) { const node = $('set-comfy-dir'); if (node !== null) node.value = textOf(comfy.launchDir) }
  if (force === true || !typing('set-comfy-python')) { const node = $('set-comfy-python'); if (node !== null) node.value = textOf(comfy.pythonPath) }
  if (force === true || !typing('set-comfy-args')) { const node = $('set-comfy-args'); if (node !== null) node.value = textOf(comfy.launchArgs) }
}


export function settingsOpen() {
  const box = $('settings')
  return box !== null && box.hidden === false
}


export function openSettings() {
  fillSettings(true)
  const box = $('settings')
  if (box === null) return
  box.hidden = false
  document.body.classList.add('drawer-on')
  const first = $('set-llm-base')
  if (first !== null) first.focus()
}


export function closeSettings() {
  const box = $('settings')
  if (box === null || box.hidden === true) return
  box.hidden = true
  document.body.classList.remove('drawer-on')
  const back = $('btn-settings')
  if (back !== null) back.focus()
}


export async function refreshState() {
  // /state 里没有 llmReady（只有独立服务版 /health 才有），两边并发查一次再合并
  const [res, health] = await Promise.all([api('/state'), api('/health')])
  applyState(res)
  const h = health.status === 0 ? {} : (health.data || {})
  if (typeof h.llmReady !== 'boolean') return
  // 服务端实际判定优先于从 /state 推断出来的结果
  state.llm.ready = h.llmReady === true
  const llm = h.llm !== null && typeof h.llm === 'object' ? h.llm : {}
  if (textOf(llm.model) !== '') state.llm.model = textOf(llm.model)
  if (textOf(llm.baseUrl) !== '') state.llm.baseUrl = textOf(llm.baseUrl)
  if (textOf(llm.provider) !== '') state.llm.provider = textOf(llm.provider)
  paintLlmPill()
}


export async function probeLlm() {
  const baseUrl = normalizeLlmBase($('set-llm-base').value)
  $('set-llm-base').value = baseUrl
  const key = dropQuotes(textOf($('set-llm-key').value))
  // 地址没改：不传 baseUrl，让服务端用配置里的地址与已存的 key，省得每次重贴 key
  const storedBase = normalizeLlmBase(state.config?.llm?.baseUrl ?? '')
  const sameStored = baseUrl !== '' && storedBase === baseUrl
  const body = { apiKey: key }
  if (!sameStored) body.baseUrl = baseUrl
  setSetStatus('set-llm-status', '测试中…', 'busy')
  const button = $('set-llm-probe')
  if (button !== null) button.disabled = true
  let res = { status: 0, data: {} }
  try {
    res = await api('/llm/probe', { body: body })
  } catch (error) {
    setSetStatus('set-llm-status', '测试失败：' + (error && error.message ? error.message : String(error)), 'err')
    return
  } finally {
    // 异常路径也必须把按钮放回来，否则一次失败就点不动了
    if (button !== null) button.disabled = false
  }
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-llm-status', '连不上本地服务', 'err'); return }
  if (data.ok !== true) {
    if (data.error === 'no-api-key') {
      setSetStatus('set-llm-status', sameStored ? '这个地址还没存 key：在上面填一个再测' : '换了地址就得重填 key（存下的 key 只在本机同一地址复用）', 'err')
      return
    }
    setSetStatus('set-llm-status', textOf(data.message) || textOf(data.error) || '连不上', 'err')
    return
  }
  const list = $('set-llm-models')
  if (list !== null) {
    clear(list)
    const models = Array.isArray(data.models) ? data.models : []
    models.forEach(function (id) { list.append(el('option', { value: id })) })
    const current = $('set-llm-model')
    if (current !== null && textOf(current.value) === '' && models.length > 0) current.value = models[0]
  }
  setSetStatus('set-llm-status', (textOf(data.message) || '连上了') + '（' + (textOf(data.endpoint) || baseUrl) + '）', 'ok')
}


export async function saveLlmSettings() {
  const baseUrl = normalizeLlmBase($('set-llm-base').value)
  $('set-llm-base').value = baseUrl
  const key = dropQuotes(textOf($('set-llm-key').value))
  const patch = { llm: { baseUrl: baseUrl, model: textOf($('set-llm-model').value) } }
  const presetBox = $('set-llm-preset')
  const chosen = presetBox !== null && presetBox.selectedOptions.length > 0 ? presetBox.selectedOptions[0] : null
  const provider = chosen !== null && chosen.dataset !== undefined ? textOf(chosen.dataset.provider) : ''
  if (provider !== '') patch.llm.provider = provider
  if (key !== '') patch.llm.apiKey = key
  setSetStatus('set-llm-status', '保存中…', 'busy')
  const ok = await saveConfig(patch)
  if (!ok) { setSetStatus('set-llm-status', '没存上，检查本地服务', 'err'); return }
  if ($('set-llm-key') !== null) $('set-llm-key').value = ''
  await refreshState()
  fillSettings(false)
  setSetStatus('set-llm-status', '已保存，下次锻造就用它', 'ok')
  flash('LLM 设置已保存')
}


export async function probeComfy() {
  setSetStatus('set-comfy-status', '探测中…', 'busy')
  const res = await api('/comfy')
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-comfy-status', '连不上本地服务', 'err'); return }
  const status = data.status !== null && typeof data.status === 'object' ? data.status : {}
  const launch = data.launch !== null && typeof data.launch === 'object' ? data.launch : {}
  const plan = $('set-comfy-plan')
  if (plan !== null) {
    if (launch.ok === true) {
      plan.textContent = '可以自动启动：' + (textOf(launch.command) || textOf(launch.python) + ' main.py')
    } else {
      plan.textContent = textOf(launch.message) || '还没有可用的安装目录（要能找到 main.py）'
    }
  }
  const dirBox = $('set-comfy-dir')
  if (launch.ok === true && dirBox !== null && textOf(dirBox.value) === '') dirBox.value = tidyPath(launch.dir)
  const online = status.ok === true
  setSetStatus('set-comfy-status', online ? '在线，可以直接出图' : '离线：先「启动 ComfyUI」或手动开', online ? 'ok' : 'warn')
  // 药丸认的是 state.comfy.ok：这里必须放 status 本体，放整个 data 会让 paintComfyPill 永远判离线
  state.comfy = status
  paintComfyPill()
}


export async function launchComfyFromSettings() {
  setSetStatus('set-comfy-status', '启动中…（第一次加载模型会慢）', 'busy')
  const button = $('set-comfy-launch')
  if (button !== null) button.disabled = true
  let res = { status: 0, data: {} }
  try {
    res = await api('/comfy/launch', { body: { waitMs: 60000 } })
  } catch (error) {
    setSetStatus('set-comfy-status', '启动失败：' + (error && error.message ? error.message : String(error)), 'err')
    return
  } finally {
    // 同 probeLlm：异常也要复位，不然「启动 ComfyUI」按钮会永久禁用
    if (button !== null) button.disabled = false
  }
  const data = res.data || {}
  if (res.status === 0) { setSetStatus('set-comfy-status', '连不上本地服务', 'err'); return }
  const plan = $('set-comfy-plan')
  if (plan !== null && (data.error === 'no-launch-dir' || data.error === 'launch')) {
    plan.textContent = textOf(data.message) || '启动失败：先把安装目录填对'
  }
  if (data.ok !== true) {
    setSetStatus('set-comfy-status', textOf(data.message) || '启动失败', 'err')
    return
  }
  setSetStatus('set-comfy-status', data.alreadyRunning === true ? '本来就在跑' : '已启动，等它就绪…', 'ok')
  await probeComfy()
  await loadWorkflows()
}


export async function saveComfySettings() {
  const parsed = parseComfyInput($('set-comfy-dir').value)
  const baseUrl = normalizeComfyBase($('set-comfy-base').value) || 'http://127.0.0.1:8188'
  const python = textOf($('set-comfy-python').value) || parsed.python
  const args = textOf($('set-comfy-args').value) || parsed.args
  const baseBox = $('set-comfy-base')
  const dirBox = $('set-comfy-dir')
  const pyBox = $('set-comfy-python')
  const argsBox = $('set-comfy-args')
  if (baseBox !== null) baseBox.value = baseUrl
  if (dirBox !== null) dirBox.value = parsed.dir
  if (pyBox !== null) pyBox.value = python
  if (argsBox !== null) argsBox.value = args
  setSetStatus('set-comfy-status', '保存中…', 'busy')
  const ok = await saveConfig({ comfy: { baseUrl: baseUrl, launchDir: parsed.dir, pythonPath: python, launchArgs: args } })
  if (!ok) { setSetStatus('set-comfy-status', '没存上，检查本地服务', 'err'); return }
  const mixed = python !== '' && parsed.dir !== '' && pathRoot(python) !== pathRoot(parsed.dir)
  await refreshState()
  await probeComfy()
  await loadWorkflows()
  flash('ComfyUI 设置已保存')
  if (mixed) {
    setSetStatus('set-comfy-status', '已保存。但 python（' + pathRoot(python) + '）和 ComfyUI 目录（' + pathRoot(parsed.dir) + '）不像同一套安装，启动多半失败；不确定就把 python 路径留空', 'warn')
  }
}
