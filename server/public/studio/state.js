/* 三栏工作台 · state 子模块（由 studio.js 拆分，逻辑与拆分前一致）。 */
export const API = '/tagger/api'

export const LS_KEY = 'dsh-tagger:studio.v1'

export const PAGE = 48

export const POLL_MS = 1200

export const HIST_MAX = 8

export const LEVELS = ['off', 'light', 'standard', 'full', 'max']

export const LEVEL_LABELS = { off: '关闭', light: '轻度', standard: '标准', full: '全开', max: '极限' }

export const PROFILE_LABELS = { tag: 'WD 标准', pony: 'Pony', natural: '自然语序', custom: '自定义' }

export const GROUP_LABELS = { look: '风格', light: '光线', scene: '场景', camera: '镜头', mood: '氛围' }

export const STAGE_LABELS = { idle: '就绪', queued: '排队中', running: '生成中', done: '完成', failed: '失败', unknown: '状态未知' }


export const $ = function (id) { return document.getElementById(id) }


export const state = {
  config: null,
  comfy: null,
  llm: { provider: '', model: '', ready: false },
  profiles: { list: [], current: '' },
  ui: { maxTags: 40, level: 'full', solo: false, profile: 'tag', workflowId: '' },
  poses: { groups: [], sets: [], categories: [], angles: [], total: 0, set: 'all', category: '', angle: '', q: '', offset: 0, picked: {}, loading: false },
  styles: { ok: false, message: '', styles: [], groups: [], selected: new Set(), filter: '' },
  refs: {
    costume: { items: [], total: 0, offset: 0, sets: [], categories: [], hairs: [], q: '', set: '', hair: '', popular: false, loading: false, tried: false, ok: false, message: '' },
    portrait: { items: [], total: 0, offset: 0, sets: [], categories: [], hairs: [], q: '', set: 'all', hair: '', popular: false, loading: false, tried: false, ok: false, message: '' },
  },
  dock: { kind: '', id: '', name: '', meta: '', thumb: '', tags: [], note: '' },
  forge: { running: false, positive: '', negative: '', cn: {}, ms: 0, error: '', warning: '' },
  run: { running: false, promptId: '', stage: 'idle', progress: 0, images: [], message: '', timer: 0 },
  history: [],
  ref: { name: '', busy: false },
}

/* ---------------- 小工具 ---------------- */

export function textOf(value) { return typeof value === 'string' ? value.trim() : '' }

// 参考库接口回的图是根相对路径（/ref-image?kind=…），要补上 API 前缀才打得开。
export function refSrc(value) {
  const src = textOf(value)
  if (src === '' || src.indexOf(API + '/') === 0) return src
  if (src.charAt(0) === '/') return API + src
  return src
}


export function intOf(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10)
  const base = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, base))
}


export function floatOf(value, fallback, min, max) {
  const parsed = Number.parseFloat(String(value))
  const base = Number.isFinite(parsed) ? parsed : fallback
  return Math.min(max, Math.max(min, base))
}


export function el(tag, props) {
  const node = document.createElement(tag)
  if (props) {
    Object.keys(props).forEach(function (key) {
      const value = props[key]
      if (value === undefined || value === null || value === false) return
      if (key === 'text') { node.textContent = String(value); return }
      if (key === 'class') { node.className = String(value); return }
      if (key === 'dataset') { Object.keys(value).forEach(function (k) { node.dataset[k] = String(value[k]) }); return }
      if (key.indexOf('on') === 0 && typeof value === 'function') { node.addEventListener(key.slice(2).toLowerCase(), value); return }
      node.setAttribute(key, String(value))
    })
  }
  for (let i = 2; i < arguments.length; i += 1) {
    const kid = arguments[i]
    if (kid === undefined || kid === null || kid === false) continue
    if (Array.isArray(kid)) {
      kid.forEach(function (item) {
        if (item === undefined || item === null || item === false) return
        node.append(item instanceof Node ? item : document.createTextNode(String(item)))
      })
      continue
    }
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}


export function clear(node) {
  if (node === null) return
  while (node.firstChild) node.removeChild(node.firstChild)
}


export async function api(path, init) {
  const opts = Object.assign({}, init)
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body)
    opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {})
  }
  if (!opts.method) opts.method = opts.body === undefined ? 'GET' : 'POST'
  try {
    const res = await fetch(API + path, opts)
    const raw = await res.text()
    let data = {}
    if (raw !== '') {
      try { data = JSON.parse(raw) } catch (err) { data = { ok: false, message: '返回不是 JSON' } }
    }
    return { status: res.status, data: data !== null && typeof data === 'object' ? data : {} }
  } catch (err) {
    return { status: 0, data: { ok: false, error: 'network', message: '连不上本地服务（' + API + '）' } }
  }
}


export var toastTimer = 0

export function flash(message) {
  const box = $('toast')
  if (box === null) return
  box.textContent = String(message)
  box.hidden = false
  if (toastTimer !== 0) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(function () { box.hidden = true }, 1800)
}


export async function copyText(value, label) {
  const body = String(value === undefined || value === null ? '' : value)
  if (body === '') { flash('还没有可复制的内容'); return }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(body)
      flash(label + '已复制')
      return
    }
  } catch (err) { /* 落到 textarea 兜底 */ }
  const box = el('textarea', { class: 'sr-only', style: 'position:fixed;left:-9999px;top:0;' })
  box.value = body
  document.body.append(box)
  box.select()
  try { document.execCommand('copy'); flash(label + '已复制') } catch (err) { flash('复制失败，请手动选择') }
  box.remove()
}

/* 拆 tag 串的分隔符：英文逗号、中文逗号、顿号、换行（面板里中英混排、手打换行都很常见） */
const SPLIT_SEPARATORS = [',', '\uFF0C', '\u3001', '\r', '\n']

const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}' }

/* 拆 tag 串：只按括号外的分隔符切，权重 / 转义括号都不拆坏 */
export function splitTags(value) {
  const source = typeof value === 'string' ? value : ''
  const out = []
  let depth = 0
  let buf = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    // 转义括号（\(night\)）是字面量，既不改变深度也不该被当成外层包裹
    if (ch === '\\' && i + 1 < source.length && '([]{})\uFF08\uFF09'.indexOf(source[i + 1]) >= 0) {
      buf += ch + source[i + 1]
      i += 1
      continue
    }
    if (BRACKET_PAIRS[ch] !== undefined) depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (depth === 0 && SPLIT_SEPARATORS.indexOf(ch) >= 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.trim() !== '') out.push(buf)
  return out.map(function (item) { return item.trim() }).filter(function (item) { return item !== '' })
}


const CORE_BRACKETS = [['(', ')'], ['{', '}'], ['[', ']']]

const CORE_WEIGHT = /^(.*?):{1,2}\s*[\d.]+$/

/**
 * 取 tag 的核心写法：(tag:1.2) / tag::1.2 / {{tag}} / ((tag)) 都要剥成 tag。
 * 口径与 lib/styles.js 的 bareTag 一致，只是这里保留原大小写（面板要原样显示）。
 */
export function tagCore(token) {
  let text = String(token === undefined || token === null ? '' : token).trim()
  if (text === '') return ''
  text = text.replace(/\\([()[\]{}])/g, '$1')
  for (let guard = 0; guard < 16; guard += 1) {
    const before = text
    const weighted = CORE_WEIGHT.exec(text)
    if (weighted !== null) text = weighted[1].trim()
    for (let k = 0; k < CORE_BRACKETS.length; k += 1) {
      const open = CORE_BRACKETS[k][0]
      const close = CORE_BRACKETS[k][1]
      if (text.length > open.length + close.length && text.charAt(0) === open && text.slice(-close.length) === close) {
        text = text.slice(open.length, -close.length).trim()
      }
    }
    if (text === before) break
  }
  return text
}


export function joinTags(list) { return (Array.isArray(list) ? list : []).join(', ') }


export function tagName(item) {
  if (typeof item === 'string') return textOf(item)
  if (item !== null && typeof item === 'object') return textOf(item.tag) || textOf(item.name)
  return ''
}


export function tagCn(item) {
  if (item !== null && typeof item === 'object') return textOf(item.cn) || textOf(item.zh) || textOf(item.chinese)
  return ''
}

/* ---------------- 参数记忆 ---------------- */

export const UI_IDS = ['maxTags', 'level', 'solo', 'profile', 'workflow', 'width', 'height', 'seed', 'steps', 'cfg']


export function readStored() {
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (raw === null || raw === '') return {}
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (err) { return {} }
}


export function saveUi() {
  const out = { prompt: $('prompt') === null ? '' : $('prompt').value }
  UI_IDS.forEach(function (id) {
    const node = $(id)
    if (node === null) return
    out[id] = node.type === 'checkbox' ? Boolean(node.checked) : node.value
  })
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(out)) } catch (err) { /* 存不下就算了 */ }
}


export function applyStored() {
  const saved = readStored()
  if (typeof saved.prompt === 'string') $('prompt').value = saved.prompt
  UI_IDS.forEach(function (id) {
    const node = $(id)
    if (node === null) return
    const value = saved[id]
    if (value === undefined || value === null) return
    if (node.type === 'checkbox') node.checked = value === true || value === 'true'
    else if (node.tagName === 'SELECT') { if (typeof value === 'string') node.dataset.want = value }
    else node.value = String(value)
  })
  state.ui.solo = $('solo').checked
}


/** 本地存过的偏好优先，其次才是服务端配置：刷新面板不该把用户调过的值拉回默认。 */
export function preferredUi(id, fallback) {
  const saved = readStored()
  const value = saved[id]
  if (typeof value === 'string' && textOf(value) !== '') return textOf(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return textOf(fallback)
}


/**
 * 下拉选中：显式传的值优先，applyStored 留下的 dataset.want 只做兜底。
 * 一旦用上就删掉标记——否则 localStorage 里的旧值会一直压住服务端配置
 * （真机表现：下拉显示 Pony，配置与顶栏药丸却是 tag）。
 */
export function selectWant(id, wanted) {
  const node = $(id)
  if (node === null) return
  const explicit = typeof wanted === 'number' ? String(wanted) : textOf(wanted)
  const want = explicit !== '' ? explicit : textOf(node.dataset.want)
  if (want === '') { delete node.dataset.want; return }
  const options = node.options
  // 不是下拉（数字框之类）就直写，同样把旧标记清掉
  if (options === undefined || options === null) { node.value = want; delete node.dataset.want; return }
  const hit = Array.prototype.some.call(options, function (opt) { return opt.value === want })
  // 选项还没建（下拉由数据后填）时先留着标记，等下一次渲染再落
  if (!hit) return
  node.value = want
  delete node.dataset.want
}

/* ---------------- 顶栏药丸 ---------------- */

export function setPill(id, kind, message) {
  const box = $(id)
  const label = $(id + '-text')
  if (box !== null) box.dataset.kind = kind
  if (label !== null) label.textContent = message
}


export function paintLlmPill() {
  const info = state.llm
  const model = info.model === '' ? '' : ' · ' + info.model
  if (info.ready !== true) {
    // provider 都没填 = 硬错；填了服务却缺 key / 地址 = 能修好的警告，别给绿灯
    if (info.provider === '') { setPill('pill-llm', 'err', 'LLM 未配置'); return }
    setPill('pill-llm', 'warn', 'LLM 缺 key 或地址' + model)
    return
  }
  setPill('pill-llm', 'ok', 'LLM ' + (info.provider || '就绪') + model)
}


export function paintComfyPill() {
  const comfy = state.comfy
  if (comfy === null || typeof comfy !== 'object') { setPill('pill-comfy', 'err', 'ComfyUI 未知'); return }
  if (comfy.ok === true) { setPill('pill-comfy', 'ok', 'ComfyUI 在线'); return }
  setPill('pill-comfy', 'warn', 'ComfyUI 离线')
}


export function paintProfilePill() {
  const id = state.profiles.current
  if (id === '') { setPill('pill-profile', 'idle', '模型档案未知'); return }
  setPill('pill-profile', 'ok', '档案 · ' + (PROFILE_LABELS[id] || id))
}

/* ---------------- 左栏：提示词 ---------------- */

export function autoGrow() {
  const box = $('prompt')
  if (box === null) return
  box.style.height = 'auto'
  const line = 22
  const min = line * 8 + 18
  const next = Math.max(min, Math.min(box.scrollHeight, 420))
  box.style.height = next + 'px'
}


export function imageUrl(item) {
  if (item === null || typeof item !== 'object') return ''
  const filename = textOf(item.filename)
  // 有 filename 就走服务端代理：预览接口要按 filename/subfolder/type 去 ComfyUI 取，
  // 直接用 item.url（ComfyUI 自己的 /view 地址）在面板里常常是死链。
  if (filename !== '') {
    const params = 'filename=' + encodeURIComponent(filename)
    const sub = textOf(item.subfolder)
    const type = textOf(item.type) || 'output'
    return API + '/image?' + params + '&subfolder=' + encodeURIComponent(sub) + '&type=' + encodeURIComponent(type)
  }
  return textOf(item.url)
}

/* ---------------- 灯箱 ---------------- */

export var lightboxFrom = null


export function openLightbox(src, name) {
  const box = $('lightbox')
  const img = $('lightbox-img')
  if (box === null || img === null) return
  img.src = src
  img.alt = name
  const label = $('lightbox-name')
  if (label !== null) label.textContent = name
  lightboxFrom = document.activeElement
  box.hidden = false
  const close = $('lightbox-close')
  if (close !== null) close.focus()
}


export function closeLightbox() {
  const box = $('lightbox')
  if (box === null || box.hidden) return
  box.hidden = true
  const img = $('lightbox-img')
  if (img !== null) img.src = ''
  if (lightboxFrom !== null && typeof lightboxFrom.focus === 'function') lightboxFrom.focus()
  lightboxFrom = null
}

/* ---------------- /state 与 /profiles ---------------- */

export function applyState(res) {
  const data = res.data || {}
  if (res.status === 0) {
    setPill('pill-llm', 'err', '连不上本地服务')
    setPill('pill-comfy', 'err', '连不上本地服务')
    return
  }
  const config = data.config !== null && typeof data.config === 'object' ? data.config : {}
  state.config = config
  state.comfy = data.comfy === null || typeof data.comfy !== 'object' ? null : data.comfy

  const llm = config.llm !== null && typeof config.llm === 'object' ? config.llm : {}
  state.llm = {
    provider: textOf(llm.provider),
    model: textOf(llm.model),
    baseUrl: textOf(llm.baseUrl),
    hasKey: llm.apiKeySet === true,
    // 只填了 provider 却既没有内置服务、也没存 key，实际点不着，不能算就绪
    ready: llm.hasLlmService === true || llm.apiKeySet === true,
  }

  // 这四项都以「本地存过的偏好」为先，服务端配置只在没存过时补位
  const tags = config.tags !== null && typeof config.tags === 'object' ? config.tags : {}
  const maxTagsWant = preferredUi('maxTags', Number.isFinite(tags.maxTags) ? String(tags.maxTags) : '')
  if (maxTagsWant !== '') {
    state.ui.maxTags = intOf(maxTagsWant, 40, 8, 160)
    if ($('maxTags') !== null) $('maxTags').value = String(state.ui.maxTags)
  }
  const purge = config.purge !== null && typeof config.purge === 'object' ? config.purge : {}
  const levelWant = preferredUi('level', purge.level)
  if (LEVELS.indexOf(levelWant) >= 0) { state.ui.level = levelWant; selectWant('level', levelWant) }
  const forge = config.forge !== null && typeof config.forge === 'object' ? config.forge : {}
  const profileWant = preferredUi('profile', forge.profile)
  if (profileWant !== '') { state.ui.profile = profileWant; selectWant('profile', profileWant) }
  const comfy = config.comfy !== null && typeof config.comfy === 'object' ? config.comfy : {}
  const workflowWant = preferredUi('workflow', comfy.defaultWorkflowId)
  if (workflowWant !== '') { state.ui.workflowId = workflowWant; selectWant('workflow', workflowWant) }
  state.llm.model = state.llm.model === '' ? textOf(forge.model) : state.llm.model
  paintLlmPill()
  paintComfyPill()
}


export function applyProfiles(res) {
  const data = res.data || {}
  const list = Array.isArray(data.profiles) ? data.profiles : []
  state.profiles.list = list
  const current = data.current !== null && typeof data.current === 'object' ? data.current : {}
  const id = textOf(current.id) || textOf(current.profile) || textOf(current.key)
  const box = $('profile')
  if (box !== null) {
    clear(box)
    const ids = list.map(function (item) { return typeof item === 'string' ? item : textOf(item.id) }).filter(function (item) { return item !== '' })
    ;(ids.length > 0 ? ids : ['tag', 'pony', 'natural', 'custom']).forEach(function (key) {
      const hit = list.find(function (item) { return item !== null && typeof item === 'object' && textOf(item.id) === key })
      const label = hit !== undefined && textOf(hit.title) !== '' ? textOf(hit.title) : (PROFILE_LABELS[key] || key)
      box.append(el('option', { value: key, text: label }))
    })
    selectWant('profile', textOf(state.config === null ? '' : (state.config.forge || {}).profile) || 'tag')
  }
  state.profiles.current = id !== '' ? id : ($('profile') === null ? 'tag' : $('profile').value)
  paintProfilePill()
}


export async function saveConfig(patch) {
  const res = await api('/config', { body: { patch: patch } })
  const data = res.data || {}
  if (res.status === 0 || data.ok === false) { flash(textOf(data.message) || '设置没存上'); return false }
  return true
}

export const LLM_V1_HOSTS = ['api.deepseek.com', 'api.openai.com', 'api.siliconflow.cn']


export function dropQuotes(value) {
  return textOf(value).replace(/^["'\u0060]+|["'\u0060]+$/g, '')
}


export function tidyPath(value) {
  const text = dropQuotes(value)
  if (text === '') return ''
  return text.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/** 取上一级目录（本工具内部统一用 /）。 */
export function parentDir(path) {
  const clean = tidyPath(path)
  const cut = clean.lastIndexOf('/')
  return cut > 0 ? clean.slice(0, cut) : clean
}

/** 只取最前一段（盘符或首个目录名），用来判断两个路径是不是同一套安装。 */
export function pathRoot(path) {
  const clean = tidyPath(path)
  const cut = clean.indexOf('/')
  return cut > 0 ? clean.slice(0, cut) : clean
}


/** LLM 接口地址：补协议、补已知服务的 /v1、去掉末尾斜杠。 */
export function normalizeLlmBase(value) {
  let text = dropQuotes(value)
  if (text === '') return ''
  if (/^[\w.-]+:\d{2,5}(\/.*)?$/.test(text)) text = 'http://' + text
  if (!/^(https?|wss?):\/\//i.test(text)) text = 'https://' + text
  try {
    const url = new URL(text)
    if ((url.pathname === '' || url.pathname === '/') && LLM_V1_HOSTS.indexOf(url.hostname) >= 0) url.pathname = '/v1'
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return (url.origin + path + url.search).replace(/\/+$/, '')
  } catch (error) {
    return text.replace(/\/+$/, '')
  }
}

/** ComfyUI 接口地址：只填端口 / 主机也能认。 */
export function normalizeComfyBase(value) {
  let text = dropQuotes(value)
  if (text === '') return ''
  if (/^\d{2,5}$/.test(text)) return 'http://127.0.0.1:' + text
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text
  return text.replace(/\/+$/, '')
}

/**
 * 按引号分组切词："D:\AI Tools\ComfyUI\main.py" --lowvram 会把带空格的路径当成一个词，
 * 而不是先按空白切碎再去引号（那样路径一定是断的）。
 */
export function lexCommand(value) {
  const text = textOf(value)
  const out = []
  let buf = ''
  let quote = ''
  let has = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) { quote = ''; continue }
      buf += ch
      has = true
      continue
    }
    if (ch === '"' || ch === "'" || ch === '\u0060') { quote = ch; has = true; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (has) { out.push(buf); buf = ''; has = false }
      continue
    }
    buf += ch
    has = true
  }
  if (has) out.push(buf)
  return out.filter(function (token) { return token !== '' })
}

/** 可执行名可能是 python / python.exe / python3 / py / D:/x/python_embeded/python.exe。 */
const PYTHON_TOKEN = /^(?:.*[\\/])?(?:python[0-9.]*(?:\.exe)?|py(?:\.exe)?)$/i

/** 目录输入：既收目录，也收 main.py 完整路径 / 整条启动命令，拆成目录 + python + 参数。 */
export function parseComfyInput(value) {
  const out = { dir: '', python: '', args: '' }
  const tokens = lexCommand(value)
  if (tokens.length === 0) return out
  const head = PYTHON_TOKEN.test(tokens[0]) ? tokens[0] : ''
  if (head !== '') out.python = tidyPath(head)
  const rest = head !== '' ? tokens.slice(1) : tokens
  const scriptAt = rest.findIndex(function (token) { return /\.py$/i.test(token) })
  if (scriptAt < 0) {
    // 没有 main.py：就是目录（或 python 命令后面跟了一堆参数）
    const first = rest.length > 0 ? rest[0] : ''
    if (first !== '') out.dir = tidyPath(first)
    if (rest.length > 1) out.args = rest.slice(1).join(' ')
    return out
  }
  // 路径常和脚本名粘在一起（D:/ComfyUI/main.py），先拆前缀；分开写时取 main.py 前最后一个非开关词
  const inline = /^(.*[\\/])([^\\/]*\.py)$/i.exec(rest[scriptAt])
  const before = rest.slice(0, scriptAt).filter(function (token) { return token.charAt(0) !== '-' })
  const candidate = inline !== null && inline[1] !== '' ? inline[1] : (before.length > 0 ? before[before.length - 1] : '')
  const clean = tidyPath(candidate)
  if (clean !== '') {
    // python_embeded/python.exe -s ComfyUI/main.py：相对目录按 python 上面两级推成绝对路径
    const relative = clean.indexOf('/') < 0 && out.python.indexOf('/') > 0
    out.dir = relative ? parentDir(parentDir(out.python)) + '/' + clean : clean
  }
  out.args = rest.slice(scriptAt + 1).join(' ')
  return out
}
