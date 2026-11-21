/* studio 面板回归测试：纯函数 + 假 DOM 下的渲染/探测行为（零依赖，不引 jsdom）。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, '..', 'server', 'public')
const STUDIO = path.join(PUBLIC, 'studio')

function makeClassList() {
  const set = new Set()
  return {
    add: function () { for (const name of arguments) set.add(name) },
    remove: function () { for (const name of arguments) set.delete(name) },
    toggle: function (name, force) {
      const on = force === undefined ? !set.has(name) : force === true
      if (on) set.add(name)
      else set.delete(name)
      return on
    },
    contains: function (name) { return set.has(name) },
    values: function () { return Array.from(set) },
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeName = this.tagName
    this.childNodes = []
    this.dataset = {}
    this.style = {}
    this.attributes = {}
    this.classList = makeClassList()
    this.className = ''
    this.textContent = ''
    this.nodeValue = ''
    this.value = ''
    this.hidden = false
    this.disabled = false
    this.checked = false
    this.options = []
    this.parent = null
    this.firstChild = null
  }

  get children() { return this.childNodes }

  append() {
    for (const kid of arguments) {
      const node = kid instanceof FakeNode ? kid : doc.createTextNode(String(kid))
      node.parent = this
      this.childNodes.push(node)
    }
    this.firstChild = this.childNodes[0] || null
    return this
  }

  appendChild(kid) { this.append(kid); return kid }

  removeChild(kid) {
    this.childNodes = this.childNodes.filter(function (item) { return item !== kid })
    this.firstChild = this.childNodes[0] || null
    kid.parent = null
    return kid
  }

  remove() { if (this.parent !== null) this.parent.removeChild(this) }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'id') registry.set(String(value), this)
  }

  getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name] }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  select() {}
}

const registry = new Map()

/** @type {any} */
const doc = {
  createElement: function (tag) { return new FakeNode(tag) },
  createTextNode: function (text) {
    const node = new FakeNode('#text')
    node.nodeValue = String(text)
    node.textContent = String(text)
    return node
  },
  getElementById: function (id) { return registry.get(id) || null },
  body: new FakeNode('body'),
  activeElement: null,
  addEventListener: function () {},
  execCommand: function () { return true },
}

const store = new Map()
/** @type {any} */
const storage = {
  getItem: function (key) { return store.has(key) ? store.get(key) : null },
  setItem: function (key, value) { store.set(key, String(value)) },
  removeItem: function (key) { store.delete(key) },
  clear: function () { store.clear() },
}

globalThis.document = /** @type {any} */ (doc)
globalThis.Node = /** @type {any} */ (FakeNode)
globalThis.window = /** @type {any} */ ({
  localStorage: storage,
  setTimeout: function (fn, ms) { return setTimeout(fn, ms) },
  clearTimeout: function (timer) { return clearTimeout(timer) },
  addEventListener: function () {},
})

/** 登记一个元素（相当于 html 里那个节点）。 */
function mk(tag, id) {
  const node = new FakeNode(tag)
  node.setAttribute('id', id)
  registry.set(id, node)
  return node
}

function mkSelect(id, values) {
  const node = mk('select', id)
  node.options = values.map(function (value) { return { value: value } })
  node.value = values.length > 0 ? values[0] : ''
  return node
}

function resetRegistry() { registry.clear() }

const stateMod = await import(pathToFileURL(path.join(STUDIO, 'state.js')).href)
const posesMod = await import(pathToFileURL(path.join(STUDIO, 'poses.js')).href)
const refsMod = await import(pathToFileURL(path.join(STUDIO, 'refs.js')).href)
const runnerMod = await import(pathToFileURL(path.join(STUDIO, 'runner.js')).href)
const settingsMod = await import(pathToFileURL(path.join(STUDIO, 'settings.js')).href)

const API = stateMod.API
const state = stateMod.state

/* ---------------- 纯函数 ---------------- */

test('parseComfyInput: 带空格的 main.py 路径按引号分组', function () {
  const hit = stateMod.parseComfyInput('"D:\\AI Tools\\ComfyUI\\main.py" --lowvram')
  assert.equal(hit.dir, 'D:/AI Tools/ComfyUI')
  assert.equal(hit.python, '')
  assert.equal(hit.args, '--lowvram')
})

test('parseComfyInput: python_embeded 的相对路径按 python 目录推', function () {
  const hit = stateMod.parseComfyInput('D:/AI/ComfyUI_windows_portable/python_embeded/python.exe -s ComfyUI/main.py --lowvram')
  assert.equal(hit.python, 'D:/AI/ComfyUI_windows_portable/python_embeded/python.exe')
  assert.equal(hit.dir, 'D:/AI/ComfyUI_windows_portable/ComfyUI')
  assert.equal(hit.args, '--lowvram')
})

test('parseComfyInput: 只给目录 / 只给 main.py 也认', function () {
  assert.deepEqual(stateMod.parseComfyInput('D:/ComfyUI'), { dir: 'D:/ComfyUI', python: '', args: '' })
  const hit = stateMod.parseComfyInput('D:/ComfyUI/main.py')
  assert.equal(hit.dir, 'D:/ComfyUI')
  assert.equal(hit.args, '')
})

test('splitTags: 中文逗号与换行也算分隔符，括号内不切', function () {
  const tokens = stateMod.splitTags('night, ((day:1.2)), {{moon}}\ncat，dog、bird')
  assert.deepEqual(tokens, ['night', '((day:1.2))', '{{moon}}', 'cat', 'dog', 'bird'])
})

test('tagCore: 剥权重尾、成对括号、转义括号', function () {
  assert.equal(stateMod.tagCore('(night:1.2)'), 'night')
  assert.equal(stateMod.tagCore('night::1.2'), 'night')
  assert.equal(stateMod.tagCore('{{night}}'), 'night')
  assert.equal(stateMod.tagCore('((night):1.1)'), 'night')
  assert.equal(stateMod.tagCore('\\(night\\)'), 'night')
  assert.equal(stateMod.tagCore('[moon]'), 'moon')
})

test('imageUrl: 有 filename 走 /image，缺了才回退 url', function () {
  const proxied = stateMod.imageUrl({ filename: 'a b.png', subfolder: 'sub', type: 'output', url: 'http://127.0.0.1:8188/view?x=1' })
  assert.equal(proxied, API + '/image?filename=a%20b.png&subfolder=sub&type=output')
  assert.equal(stateMod.imageUrl({ url: 'http://127.0.0.1:8188/view?x=1' }), 'http://127.0.0.1:8188/view?x=1')
  assert.equal(stateMod.imageUrl({ filename: 'f.png' }), API + '/image?filename=f.png&subfolder=&type=output')
  assert.equal(stateMod.imageUrl(null), '')
})

test('normalizeLlmBase / normalizeComfyBase 认裸域名与裸端口', function () {
  assert.equal(stateMod.normalizeLlmBase('api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(stateMod.normalizeLlmBase('127.0.0.1:11434'), 'http://127.0.0.1:11434')
  assert.equal(stateMod.normalizeComfyBase('8188'), 'http://127.0.0.1:8188')
  assert.equal(stateMod.normalizeComfyBase('http://127.0.0.1:8188///'), 'http://127.0.0.1:8188')
})

test('selectWant: 显式值优先，用完清掉 dataset.want 标记', function () {
  resetRegistry()
  const box = mkSelect('profile', ['tag', 'pony'])
  box.dataset.want = 'pony'
  stateMod.selectWant('profile', 'tag')
  assert.equal(box.value, 'tag')
  assert.equal(box.dataset.want, undefined)
  // 标记清掉之后再进 boot 那一轮，旧值不会反压回来
  stateMod.selectWant('profile', 'tag')
  assert.equal(box.value, 'tag')
  // 没有显式值时旧标记仍能兜底，兜完即删
  box.dataset.want = 'pony'
  stateMod.selectWant('profile', '')
  assert.equal(box.value, 'pony')
  assert.equal(box.dataset.want, undefined)
})

test('applyState: 本地存过的偏好优先，没存过才用服务端配置', function () {
  resetRegistry()
  mk('input', 'maxTags')
  mkSelect('level', ['off', 'light', 'standard', 'full', 'max'])
  mkSelect('profile', ['tag', 'pony', 'natural', 'custom'])
  mkSelect('workflow', ['wf-1', 'wf-2'])
  mk('span', 'pill-llm')
  mk('span', 'pill-llm-text')
  mk('span', 'pill-comfy')
  mk('span', 'pill-comfy-text')

  const res = {
    status: 200,
    data: {
      config: {
        tags: { maxTags: 40 },
        purge: { level: 'full' },
        forge: { profile: 'tag', model: 'deepseek-v4.1-flash' },
        comfy: { defaultWorkflowId: 'wf-1' },
        llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', apiKeySet: true },
      },
      comfy: { ok: true },
    },
  }

  store.clear()
  stateMod.applyState(res)
  assert.equal(state.ui.profile, 'tag')
  assert.equal(registry.get('profile').value, 'tag')
  assert.equal(state.ui.maxTags, 40)
  assert.equal(registry.get('workflow').value, 'wf-1')
  assert.equal(registry.get('pill-llm').dataset.kind, 'ok')

  store.set(stateMod.LS_KEY, JSON.stringify({ profile: 'pony', level: 'light', maxTags: '60', workflow: 'wf-2' }))
  stateMod.applyState(res)
  assert.equal(state.ui.profile, 'pony')
  assert.equal(registry.get('profile').value, 'pony')
  assert.equal(state.ui.level, 'light')
  assert.equal(registry.get('level').value, 'light')
  assert.equal(state.ui.maxTags, 60)
  assert.equal(registry.get('maxTags').value, '60')
  assert.equal(state.ui.workflowId, 'wf-2')
  assert.equal(registry.get('workflow').value, 'wf-2')
  store.clear()
})

/* ---------------- 假 DOM 下的渲染 ---------------- */

function poseGroup(base, code) {
  return { base: base, name: code + ' 姿势', code: code, variants: [{ thumb: '/ref-image?kind=pose&id=' + base }] }
}

test('renderPoseGrid: 加载更多只 append 新增切片，不重复卡片', function () {
  resetRegistry()
  const grid = mk('div', 'pose-grid')
  mk('div', 'pose-empty')
  const more = mk('button', 'pose-more')

  state.poses.groups = [poseGroup('p1', 'P001'), poseGroup('p2', 'P002')]
  state.poses.total = 3
  state.poses.offset = 2
  posesMod.renderPoseGrid()
  assert.equal(grid.childNodes.length, 2)
  assert.equal(more.hidden, false)

  state.poses.groups = [poseGroup('p1', 'P001'), poseGroup('p2', 'P002'), poseGroup('p3', 'P003')]
  state.poses.offset = 3
  posesMod.renderPoseGrid(true, [poseGroup('p3', 'P003')])
  assert.equal(grid.childNodes.length, 3, '累计数组 + append 不许把旧卡片再画一遍')
  assert.equal(grid.childNodes[2].dataset.base, 'p3')
  assert.equal(more.hidden, true)

  // append 但没给新增切片：退回整表重画，一样不许叠
  posesMod.renderPoseGrid(true, null)
  assert.equal(grid.childNodes.length, 3)
})

function refItem(id) {
  return { id: id, name: '服装 ' + id, category: '夏季穿搭', keywords: 'denim, skirt', thumb: '/ref-image?kind=costume&id=' + id }
}

test('renderRefGrid: 加载更多只 append 新增切片并刷新计数', function () {
  resetRegistry()
  const grid = mk('div', 'ref-costume-grid')
  mk('div', 'costume-empty')
  const more = mk('button', 'costume-more')
  const count = mk('span', 'tab-costume-count')

  state.refs.costume.items = [refItem('c1'), refItem('c2')]
  state.refs.costume.total = 3
  state.refs.costume.offset = 2
  refsMod.renderRefGrid('costume', false, null)
  assert.equal(grid.childNodes.length, 2)
  assert.equal(more.hidden, false)
  assert.equal(count.textContent, '3')

  state.refs.costume.items = [refItem('c1'), refItem('c2'), refItem('c3')]
  state.refs.costume.offset = 3
  refsMod.renderRefGrid('costume', true, [refItem('c3')])
  assert.equal(grid.childNodes.length, 3)
  assert.equal(grid.childNodes[2].dataset.refId, 'c3')
  assert.equal(more.hidden, true)
})

test('currentVars: 参考图变量叫 image，不是 refImage', function () {
  resetRegistry()
  mk('input', 'width').value = '1200'
  mk('input', 'height').value = '1800'
  mk('input', 'seed').value = '20261108'
  mk('input', 'steps').value = '30'
  mk('input', 'cfg').value = '5.03'
  state.ref.name = ''
  assert.equal(runnerMod.currentVars().image, undefined)
  state.ref.name = 'ref/pose.png'
  const vars = runnerMod.currentVars()
  assert.equal(vars.image, 'ref/pose.png')
  assert.equal(vars.refImage, undefined)
  assert.equal(vars.width, 1200)
  assert.equal(vars.cfg, 5.03)
  state.ref.name = ''
})

/* ---------------- settings：探测与药丸 ---------------- */

function stubFetch(payload) {
  globalThis.fetch = /** @type {any} */ (async function () {
    return {
      status: 200,
      ok: true,
      text: async function () { return JSON.stringify(payload) },
    }
  })
}

test('probeComfy: state.comfy 存 status 本体，药丸判在线', async function () {
  resetRegistry()
  mk('span', 'set-comfy-status')
  mk('div', 'set-comfy-plan')
  mk('input', 'set-comfy-dir')
  const pill = mk('span', 'pill-comfy')
  mk('span', 'pill-comfy-text')

  stubFetch({ ok: true, status: { ok: true, online: true, baseUrl: 'http://127.0.0.1:8188' }, launch: { ok: false, message: '还没有可用目录' } })
  await settingsMod.probeComfy()
  assert.equal(state.comfy.ok, true, 'state.comfy 必须是 status，不能是 { status } 外壳')
  assert.equal(state.comfy.status, undefined)
  assert.equal(pill.dataset.kind, 'ok')

  stubFetch({ ok: true, status: { ok: false, online: false }, launch: { ok: true, dir: 'D:/ComfyUI', command: 'python main.py' } })
  await settingsMod.probeComfy()
  assert.equal(state.comfy.ok, false)
  assert.equal(pill.dataset.kind, 'warn')
})

test('refreshState: /health 的 llmReady 为准重画 LLM 药丸', async function () {
  resetRegistry()
  mk('input', 'maxTags')
  mkSelect('level', ['off', 'light', 'standard', 'full', 'max'])
  mkSelect('profile', ['tag', 'pony'])
  mkSelect('workflow', ['wf-1'])
  const pill = mk('span', 'pill-llm')
  mk('span', 'pill-llm-text')
  mk('span', 'pill-comfy')
  mk('span', 'pill-comfy-text')

  globalThis.fetch = /** @type {any} */ (async function (url) {
    const body = url.indexOf('/health') >= 0
      ? { plugin: 'dsh-tagger', llmReady: false, llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }
      : { ok: true, config: { llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, comfy: { ok: true } }
    return { status: 200, ok: true, text: async function () { return JSON.stringify(body) } }
  })
  await settingsMod.refreshState()
  assert.equal(state.llm.ready, false)
  assert.equal(pill.dataset.kind, 'warn', '配了 provider 却没有 key：警告，不许绿灯')
})

/* ---------------- 面板脚本与 html 的 id 一致性 ---------------- */

test('studio.html 覆盖所有脚本引用的 id（单向）', function () {
  const html = fs.readFileSync(path.join(PUBLIC, 'studio.html'), 'utf8')
  const ids = new Set()
  for (const hit of html.matchAll(/id="([^"]+)"/g)) ids.add(hit[1])
  const files = ['studio.js'].concat(fs.readdirSync(STUDIO).filter(function (name) { return name.endsWith('.js') }).map(function (name) { return 'studio/' + name }))
  const missing = []
  for (const rel of files) {
    const src = fs.readFileSync(path.join(PUBLIC, rel), 'utf8')
    for (const hit of src.matchAll(/\$\('([^']+)'\)|\$\("([^"]+)"\)|getElementById\('([^']+)'\)|getElementById\("([^"]+)"\)/g)) {
      const id = hit[1] || hit[2] || hit[3] || hit[4]
      if (!ids.has(id)) missing.push(rel + ' -> ' + id)
    }
  }
  assert.deepEqual(missing, [])
})
