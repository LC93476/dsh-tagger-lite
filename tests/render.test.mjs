/**
 * client.js 渲染测试：假 React（createElement 只产出 {type, props}）+ 假 fetch。
 *
 * 为什么不用 jsdom：面板的全部逻辑都在「状态 → 元素树」这一层，元素树足够验证
 * 空态/锻造中/结果态/投递/轮询/设置保存；DOM 渲染交给宿主去做。
 *
 * 跑：ELECTRON_RUN_AS_NODE=1 "<Harness.exe>" tests/render.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const clientPath = path.join(root, 'client.js')
const zhPath = path.join(root, 'locale', 'zh.json')
const enPath = path.join(root, 'locale', 'en.json')
const clientDir = path.join(root, 'client')

/* ── 子模块预载 ─────────────────────────────────────────────────────────────
 * client.js 只是门面：面板实现拆成 client/ 下的 ESM 子模块，由宿主按
 * {PREFIX}/_mod/client/<name>.js 提供。测试里用 file:// 基址喂 __DSH_TAGGER_MODBASE__，
 * 再把 panel.js 提前 import 好塞进 __DSH_TAGGER_MODS__ —— 于是 loadClient() 仍
 * 保持同步、__internals 立即可用、apply 走「模块已缓存」的同步注册分支，
 * 与宿主二次挂载时的路径完全一致。
 */
const MODBASE = new URL('../client/', import.meta.url).href
globalThis.__DSH_TAGGER_MODBASE__ = MODBASE
globalThis.__DSH_TAGGER_MODS__ = await import(MODBASE + 'panel.js')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ── 假 React ─────────────────────────────────────────────────────────── */

function createFakeReact() {
  const state = { hooks: [], cursor: 0, pending: [], dirty: false }

  function ensure(index, create) {
    if (!(index in state.hooks) || state.hooks[index] === undefined) state.hooks[index] = create()
    return state.hooks[index]
  }

  function depsChanged(prev, deps) {
    if (prev === undefined || prev.deps === null || prev.deps === undefined) return true
    if (deps === null || deps === undefined) return true
    if (prev.deps.length !== deps.length) return true
    return deps.some((value, index) => !Object.is(value, prev.deps[index]))
  }

  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const out = { ...(props ?? {}) }
      const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== true)
      if (flat.length === 1) out.children = flat[0]
      else if (flat.length > 1) out.children = flat
      return { type: String(type), props: out }
    },
    useState(initial) {
      const index = state.cursor++
      const hook = ensure(index, () => ({ kind: 'state', value: typeof initial === 'function' ? initial() : initial }))
      const set = next => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        state.dirty = true
      }
      return [hook.value, set]
    },
    useEffect(effect, deps) {
      const index = state.cursor++
      const prev = state.hooks[index]
      const changed = depsChanged(prev, deps)
      state.hooks[index] = {
        kind: 'effect',
        deps: deps === undefined || deps === null ? null : deps.slice(),
        cleanup: prev ? prev.cleanup : null,
      }
      if (changed) state.pending.push({ index, effect })
    },
    useMemo(create, deps) {
      const index = state.cursor++
      const prev = state.hooks[index]
      if (prev !== undefined && !depsChanged(prev, deps)) return prev.value
      const value = create()
      state.hooks[index] = { kind: 'memo', deps: deps === undefined || deps === null ? null : deps.slice(), value }
      return value
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps)
    },
    useRef(initial) {
      const index = state.cursor++
      return ensure(index, () => ({ kind: 'ref', value: { current: initial } })).value
    },
    memo(component) {
      return component
    },
  }

  Object.defineProperty(React, '__state', { value: state, enumerable: false })
  return React
}

function createView(React, Component, props) {
  const state = React.__state
  let tree = null

  const render = () => {
    state.cursor = 0
    state.pending = []
    tree = Component(props)
    return tree
  }

  const runEffects = () => {
    const pending = state.pending.splice(0)
    for (const item of pending) {
      const hook = state.hooks[item.index]
      if (hook !== undefined && typeof hook.cleanup === 'function') {
        try { hook.cleanup() } catch (error) { /* 清理失败不影响断言 */ }
        hook.cleanup = null
      }
      let cleanup = null
      try { cleanup = item.effect() } catch (error) { cleanup = null }
      if (hook !== undefined) hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  const settle = async (rounds = 24) => {
    for (let round = 0; round < rounds; round++) {
      state.dirty = false
      await sleep(0)
      runEffects()
      render()
      await sleep(0)
      if (!state.dirty && state.pending.length === 0) break
    }
    return tree
  }

  const mount = async () => {
    render()
    await settle()
    return tree
  }

  const unmount = () => {
    for (const hook of state.hooks) {
      if (hook !== undefined && typeof hook.cleanup === 'function') {
        try { hook.cleanup() } catch (error) { /* noop */ }
        hook.cleanup = null
      }
    }
    state.hooks = []
  }

  return {
    get tree() { return tree },
    render,
    settle,
    mount,
    unmount,
  }
}

/* ── 树遍历 ───────────────────────────────────────────────────────────── */

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ type: '#text', props: { value: String(node) } })
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props?.children, visit)
}

function findAll(tree, predicate) {
  const out = []
  walk(tree, node => { if (predicate(node)) out.push(node) })
  return out
}

function findOne(tree, predicate) {
  const all = findAll(tree, predicate)
  return all.length === 0 ? null : all[0]
}

function byTestId(tree, id) {
  return findOne(tree, node => node.props?.['data-testid'] === id)
}

function testIds(tree) {
  return findAll(tree, node => typeof node.props?.['data-testid'] === 'string').map(node => node.props['data-testid'])
}

/** 界面上不允许出现字典裸键（state.empty / job.done 之类）。 */
function rawKeys(tree) {
  const out = []
  walk(tree, node => {
    if (node.type !== '#text') return
    if (/^[a-z]+(\.[a-zA-Z]+)+$/.test(node.props.value)) out.push(node.props.value)
  })
  return out
}

function textOf(node) {
  let out = ''
  walk(node, item => { if (item.type === '#text') out += item.props.value })
  return out
}

/* ── 假 fetch ─────────────────────────────────────────────────────────── */

function createFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const raw = String(url)
    const [pathname, search = ''] = raw.split('?')
    // 客户端默认走 /tagger/api；旧前缀 /prompt-forge/api 也照样剥，测试不必关心面板用哪个。
    const routePath = pathname.replace(/^\/(?:prompt-forge|tagger)\/api/, '')
    let body = null
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch (error) { body = init.body }
    }
    const record = { url: raw, path: routePath, search, method, body }
    calls.push(record)
    const handler = routes[method + ' ' + routePath]
    if (handler === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, error: 'unknown-route', message: 'no route: ' + method + ' ' + routePath }),
      }
    }
    const result = typeof handler === 'function' ? await handler(record) : handler
    const status = result.status ?? 200
    return { ok: status < 400, status, json: async () => result.body }
  }
  return { fetch, calls }
}

/* ── 加载 client.js ───────────────────────────────────────────────────── */

function loadClient(React) {
  const source = readFileSync(clientPath, 'utf8')
  /** @type {any} */
  let captured = null
  const scope = { __ModuleLoader__: { load: (/** @type {any} */ module) => { captured = module } } }
  new Function('window', source)(scope)
  assert.ok(captured !== null, 'client.js 必须调用 window.__ModuleLoader__.load')
  const loaded = /** @type {any} */ (captured)
  const module = loaded.factory((/** @type {string} */ name) => {
    if (name === 'react') return React
    throw new Error('client.js 只应该 require("react")，多了：' + name)
  })
  return { module, internals: module.__internals, id: loaded.id }
}

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const forgePayload = {
  ok: true,
  positive: '1girl, silver hair, (wet shirt:1.2)',
  negative: 'lowres, bad hands',
  tags: [
    { tag: '1girl', weight: 1, kind: 'general' },
    { tag: 'silver hair', weight: 1, kind: 'general', cn: '银发' },
    { tag: 'wet shirt', weight: 1.2, kind: 'general' },
  ],
  negativeTags: [
    { tag: 'lowres', weight: 1 },
    { tag: 'bad hands', weight: 1 },
  ],
  standards: ['wd', 'camie'],
  raw: '{"positive":[{"tag":"1girl","weight":1}]}',
  model: 'deepseek-v4.1-flash',
  provider: 'opencode-go',
  ms: 1234,
  repaired: false,
  warnings: ['zzz 不在库里'],
  pipeline: {
    repairs: [{ from: 'top_down_bottom_up', to: 'top-down_bottom-up', how: 'hyphen' }],
    poseHints: [{ tag: 'all_fours', weight: 1.1, hit: '跪趴' }],
    changes: [{ kind: 'dedupe', tag: 'profile', reason: 'synonym' }],
  },
}

const refinePayload = {
  ok: true,
  positive: '1girl, silver hair, sweat, indoor light, (wet shirt:1.3)',
  negative: 'lowres, bad hands',
  tags: [
    { tag: '1girl', weight: 1, kind: 'general' },
    { tag: 'silver hair', weight: 1, kind: 'general', cn: '银发' },
    { tag: 'sweat', weight: 1, kind: 'general', cn: '汗水' },
    { tag: 'indoor light', weight: 1, kind: 'general', cn: '室内光' },
    { tag: 'wet shirt', weight: 1.3, kind: 'general', cn: '湿衬衫' },
  ],
  delta: {
    added: ['sweat', 'indoor light'],
    removed: ['rainy street'],
    weighted: [{ tag: 'wet shirt', from: 1.2, to: 1.3 }],
  },
  ops: [],
  notes: [],
  ms: 880,
  model: 'deepseek-v4.1-flash',
  purgeLevel: 'full',
  warnings: [],
}

const configPayload = {
  ok: true,
  config: {
    llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', hasLlmService: true },
    purge: { enabled: true, level: 'full' },
    tags: { standards: ['wd', 'camie'], maxTags: 40, weightSyntax: 'comfy' },
    forge: { repair: true, postprocess: true, poseHints: false, candidates: true, candidateLimit: 18 },
    comfy: { baseUrl: 'http://127.0.0.1:8188', workflowDir: 'C:/wf', defaultWorkflowId: 'wf-b', launchDir: '', pythonPath: '' },
  },
}

const workflowsPayload = {
  ok: true,
  dir: 'C:/wf',
  workflows: [{ id: 'wf-a', title: 'A workflow' }, { id: 'wf-b', title: 'B workflow' }],
}

// /state 是面板冷启动的唯一入口：config / purge / comfy / workflows / history 一次拿全。
const statePayload = {
  ok: true,
  config: configPayload.config,
  purge: { enabled: true, level: 'full', chars: 640, modules: ['direct-output', 'adult-allowed', 'no-refusal'] },
  comfy: { ok: true, reachable: true, version: '0.45.0', baseUrl: 'http://127.0.0.1:8188' },
  workflows: workflowsPayload.workflows,
  history: [],
}

function defaultRoutes(overrides = {}) {
  return {
    'GET /state': { body: statePayload },
    // /state 挂掉时的回退路由：正常路径不该被请求（有回归守着）。
    'GET /workflows': { body: workflowsPayload },
    'GET /config': { body: configPayload },
    'GET /comfy': {
      body: {
        ok: true,
        status: { ok: true, reachable: true, version: '0.45.0', baseUrl: 'http://127.0.0.1:8188' },
        launch: { ok: true, dir: 'D:/ComfyUI', command: 'python -s main.py --port 8188', args: ['-s', 'main.py'] },
        workflows: [],
      },
    },
    'POST /comfy/launch': {
      body: { ok: true, state: 'online', pid: 4242, dir: 'D:/ComfyUI', command: 'python -s main.py', status: { ok: true, version: '0.45.0' } },
    },
    'POST /config': record => ({
      body: { ok: true, config: { ...configPayload.config, ...(record.body?.patch ?? {}) } },
    }),
    'GET /spi': { body: { ok: true, spi: { version: 1, slots: 3, hooks: 2 } } },
    'POST /forge': { body: forgePayload },
    'POST /refine': { body: refinePayload },
    'POST /run': { body: { ok: true, promptId: 'pid-1', workflowId: 'wf-b', mapping: { positiveNode: '6', negativeNode: '7' } } },
    'GET /job': { body: { ok: true, promptId: 'pid-1', state: 'done', images: [{ filename: 'forge_0001.png', subfolder: '', type: 'output' }] } },
    ...overrides,
  }
}

function withFetch(routes, run) {
  const { fetch, calls } = createFetch(routes)
  const previous = globalThis.fetch
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (/** @type {any} */ (fetch))
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => { globalThis.fetch = previous })
}

/* ── 测试 ─────────────────────────────────────────────────────────────── */

test('模块形状：注册 id 与包名一致、单一 Panel、侧边栏图标 + main keyed slot、locale 字典就位', () => {
  const React = createFakeReact()
  const { module, internals, id } = loadClient(React)

  // 宿主按 package.json 的 name 建模块行，再按同名 id 找 __ModuleLoader__ 的工厂；
  // 两者不一致时页面报 `could not load "<pkg>": loaded without registering`。
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(id, pkg.name)
  assert.equal(module.name, pkg.name)
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof internals.Panel, 'function')
  assert.equal(typeof internals.PanelIcon, 'function')

  const registered = []
  const injected = []
  const locales = []
  const tabs = []
  const ctx = {
    locale: {
      register(namespace, tables) { locales.push({ namespace, tables }); return () => {} },
      bind: () => internals.createT('zh'),
    },
    slots: {
      inject(name, factory) { injected.push(name); factory() },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
    effect(fn) { return fn() },
    // 真 cordis 的 ctx.inject(deps, cb) 只把声明的服务投影进 scope，这里照此模拟。
    inject(dependencies, callback) {
      const scope = {
        effect(fn) { return fn() },
        betterSidebar: { registerTab(tab) { tabs.push(tab); return () => {} } },
      }
      for (const name of dependencies) if (Object.prototype.hasOwnProperty.call(ctx, name)) scope[name] = ctx[name]
      callback(scope)
    },
  }

  module.apply(ctx)

  assert.deepEqual(injected, ['sidebar.panellist', 'main'])
  assert.equal(registered.length, 2)

  const list = registered.find(item => item.options.name === 'sidebar.panellist')
  assert.equal(list.options.id, 'prompt-forge')
  assert.equal(list.options.order, 41)
  assert.equal(list.options.label(), '提示词')
  assert.equal(list.component, internals.PanelIcon)

  const main = registered.find(item => item.options.name === 'main')
  assert.equal(main.options.key, 'prompt-forge')
  assert.equal(main.component, internals.Panel)
  const injectedProps = main.options.inject()
  assert.equal(injectedProps.api, '/tagger/api')
  assert.equal(typeof injectedProps.t, 'function')

  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'prompt-forge:forge')
  assert.equal(tabs[0].component, internals.Panel)
  assert.equal(tabs[0].title, '提示词锻造台')
  assert.equal(tabs[0].single, true)

  assert.equal(locales.length, 1)
  assert.equal(locales[0].namespace, pkg.name)
  const zh = JSON.parse(readFileSync(zhPath, 'utf8'))
  const en = JSON.parse(readFileSync(enPath, 'utf8'))
  assert.deepEqual(locales[0].tables.zh, zh)
  assert.deepEqual(locales[0].tables.en, en)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal(zh.meta.title, '提示词锻造台')
  assert.ok(typeof en.meta.description === 'string' && en.meta.description.length > 10)
})

test('betterSidebar 缺席时不抛错，原生面板照样注册', () => {
  const React = createFakeReact()
  const { module } = loadClient(React)
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) { factory() },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
  }
  assert.doesNotThrow(() => module.apply(ctx))
  assert.equal(registered.length, 2)
  assert.equal(registered[0].options.label(), '提示词')
})

test('宿主 locale 查不到时退回内置字典，界面不出现裸键', () => {
  const React = createFakeReact()
  const { module, internals } = loadClient(React)
  const registered = []
  const ctx = {
    // 故意给一个只会回键的实现
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      inject(name, factory) { factory() },
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
  }
  module.apply(ctx)
  const main = registered.find(item => item.options.name === 'main')
  const injected = main.options.inject()
  assert.equal(injected.t('meta.title'), '提示词锻造台')
  assert.equal(injected.t('state.empty').startsWith('state.'), false)
  assert.equal(registered[0].options.label(), '提示词')
  assert.equal(internals.dict.zh['action.generate'], '锻造标签')
})

test('纯函数：权重只在非 1 时加括号', () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  assert.equal(internals.formatTag({ tag: '1girl', weight: 1 }), '1girl')
  assert.equal(internals.formatTag({ tag: 'wet shirt', weight: 1.2 }), '(wet shirt:1.2)')
  assert.equal(
    internals.formatTagLine([{ tag: 'a', weight: 1 }, { tag: 'b', weight: 0.8 }, { tag: '', weight: 1 }]),
    'a, (b:0.8)',
  )
  // 扁平键与嵌套键都要能查到，且不能把裸键漏到界面上
  assert.equal(internals.createT('zh')('state.empty').startsWith('state.'), false)
  assert.equal(internals.createT('zh')('settings.provider'), 'Provider')
  assert.equal(internals.createT('zh')('job.done'), '完成')
  assert.equal(internals.createT('zh')('meta.title'), '提示词锻造台')
  assert.equal(internals.createT('en')('meta.title'), 'Prompt Forge')
  assert.equal(internals.createT('zh')('不存在的键'), '不存在的键')
  assert.deepEqual(internals.chosenStandards({ wd: true, camie: false }), ['wd'])
  assert.deepEqual(internals.chosenStandards({ wd: false, camie: false }), ['wd', 'camie'])
  assert.equal(
    internals.apiUrl('/tagger/api', '/image', { filename: 'a b.png', subfolder: '', type: 'output' }),
    '/tagger/api/image?filename=a%20b.png&type=output',
  )
  assert.deepEqual(internals.normalizeTags(['1girl', { tag: 'x', weight: 1.1 }]).map(item => item.tag), ['1girl', 'x'])
})

test('面板：空态 → 锻造中 → 结果态 → 投递 → 轮询到出图', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  const jobStates = [
    { body: { ok: true, promptId: 'pid-1', state: 'running', images: [] } },
    { body: { ok: true, promptId: 'pid-1', state: 'done', images: [{ filename: 'forge_0001.png', subfolder: '', type: 'output' }] } },
  ]
  let jobIndex = 0

  await withFetch(defaultRoutes({
    'GET /job': () => jobStates[Math.min(jobIndex++, jobStates.length - 1)],
  }), async calls => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api', pollIntervalMs: 1 })
    await view.mount()

    // 1) 初始空态
    assert.equal(view.tree.props['data-state'], 'idle')
    assert.equal(view.tree.props['data-job'], 'idle')
    const empty = byTestId(view.tree, 'ptf-empty')
    assert.ok(empty, '空态提示必须在')
    assert.equal(textOf(empty), t('state.empty'))
    assert.equal(byTestId(view.tree, 'ptf-result'), null)
    assert.equal(byTestId(view.tree, 'ptf-generate').props.disabled, true)

    // 2) 挂载后拉到了工作流与配置
    const workflowSelect = byTestId(view.tree, 'ptf-workflow')
    assert.equal(workflowSelect.props.value, 'wf-b')
    assert.equal(workflowSelect.props.children.length, 3)
    assert.equal(workflowSelect.props.children[1].props.children, 'A workflow')
    assert.equal(byTestId(view.tree, 'ptf-set-provider').props.value, 'opencode-go')
    assert.equal(byTestId(view.tree, 'ptf-set-model').props.value, 'deepseek-v4.1-flash')
    assert.equal(byTestId(view.tree, 'ptf-level').props.value, 'full')
    assert.equal(byTestId(view.tree, 'ptf-standard-wd').props.checked, true)
    assert.equal(byTestId(view.tree, 'ptf-standard-camie').props.checked, true)
    assert.equal(byTestId(view.tree, 'ptf-maxtags').props.value, 40)

    // 3) 输入后按钮解锁
    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女站在雨夜霓虹街头' } })
    await view.settle()
    assert.equal(byTestId(view.tree, 'ptf-text').props.value, '银发少女站在雨夜霓虹街头')
    assert.equal(byTestId(view.tree, 'ptf-generate').props.disabled, false)

    // 4) 点生成 → 立刻是「锻造中」
    byTestId(view.tree, 'ptf-generate').props.onClick()
    view.render()
    assert.equal(view.tree.props['data-state'], 'forging')
    const loading = byTestId(view.tree, 'ptf-loading')
    assert.ok(loading, '锻造中要有 loading 态')
    assert.equal(textOf(loading), t('state.loading'))
    assert.equal(byTestId(view.tree, 'ptf-generate').props.disabled, true)

    // 5) 完成 → 结果卡
    await view.settle()
    assert.equal(view.tree.props['data-state'], 'done')
    assert.ok(byTestId(view.tree, 'ptf-result'), '结果卡必须渲染')
    assert.equal(byTestId(view.tree, 'ptf-empty'), null)

    const chips = findAll(view.tree, node => node.props?.['data-testid'] === 'ptf-chip')
    assert.deepEqual(chips.map(chip => chip.props['data-tag']), ['1girl', 'silver hair', 'wet shirt'])
    assert.equal(textOf(byTestId(view.tree, 'ptf-positive')), '1girl, silver hair, (wet shirt:1.2)')
    assert.match(textOf(byTestId(view.tree, 'ptf-warnings')), /不在库里/)
    assert.deepEqual(rawKeys(view.tree), [], '结果卡上不能漏字典裸键')
    assert.ok(byTestId(view.tree, 'ptf-negative'), '负向要折叠但节点在')
    assert.ok(byTestId(view.tree, 'ptf-raw'), 'raw 要折叠但节点在')

    const forgeCall = calls.find(call => call.method === 'POST' && call.path === '/forge')
    assert.deepEqual(forgeCall.body, {
      text: '银发少女站在雨夜霓虹街头',
      options: { standards: ['wd', 'camie'], maxTags: 40, purgeLevel: 'full' },
    })

    // 6) 点掉一个芯片 → 正向全文跟着变
    findAll(view.tree, node => node.props?.['data-testid'] === 'ptf-chip')[1].props.onClick()
    await view.settle()
    const chipsAfter = findAll(view.tree, node => node.props?.['data-testid'] === 'ptf-chip')
    assert.deepEqual(chipsAfter.map(chip => chip.props['data-tag']), ['1girl', 'wet shirt'])
    assert.equal(textOf(byTestId(view.tree, 'ptf-positive')), '1girl, (wet shirt:1.2)')

    // 7) 投递 → submitting → queued
    byTestId(view.tree, 'ptf-submit').props.onClick()
    view.render()
    assert.equal(view.tree.props['data-job'], 'submitting')
    assert.equal(textOf(byTestId(view.tree, 'ptf-submit')), t('action.submitting'))
    await view.settle()

    const runCall = calls.find(call => call.method === 'POST' && call.path === '/run')
    assert.equal(runCall.body.positive, '1girl, (wet shirt:1.2)')
    assert.equal(runCall.body.negative, 'lowres, bad hands')
    assert.equal(runCall.body.workflowId, 'wf-b')

    // 8) 轮询 → running → done，出现缩略图
    await sleep(40)
    await view.settle()
    assert.equal(view.tree.props['data-job'], 'done')
    const image = byTestId(view.tree, 'ptf-image')
    assert.ok(image, '完成后必须显示缩略图')
    assert.match(image.props.src, /^\/prompt-forge\/api\/image\?filename=forge_0001\.png/)
    assert.match(image.props.src, /type=output/)
    const jobCall = calls.find(call => call.method === 'GET' && call.path === '/job')
    assert.match(jobCall.search, /id=pid-1/)
    assert.equal(textOf(byTestId(view.tree, 'ptf-job')), t('job') + t('job.done') + 'pid-1')

    view.unmount()
  })
})

test('面板：空输入与 /forge 失败都在面板里显示可读错误', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes({
    'POST /forge': { status: 502, body: { ok: false, error: 'no-llm', message: '宿主没有 llm 服务，检查 provider 配置' } },
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
    await view.mount()

    // 空输入：按钮是禁用的，仍然点一下验证守卫
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()
    assert.equal(view.tree.props['data-state'], 'error')
    assert.match(textOf(byTestId(view.tree, 'ptf-error')), new RegExp(t('error.emptyText')))

    // 有输入但后端报错
    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '随便什么画面' } })
    await view.settle()
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()
    assert.equal(view.tree.props['data-state'], 'error')
    assert.match(textOf(byTestId(view.tree, 'ptf-error')), /宿主没有 llm 服务/)
    assert.equal(byTestId(view.tree, 'ptf-result'), null)

    view.unmount()
  })
})

test('面板：工作流读不到时显示错误但面板仍可用', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes({
    // 冷启动只打 /state：工作流列表空、失败原因单列在 workflowsError 里。
    'GET /state': { body: { ...statePayload, workflows: [], workflowsError: 'ComfyUI 连不上' } },
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
    await view.mount()
    assert.match(textOf(byTestId(view.tree, 'ptf-workflow-error')), /ComfyUI 连不上/)
    assert.equal(byTestId(view.tree, 'ptf-text') !== null, true)
    assert.equal(byTestId(view.tree, 'ptf-generate') !== null, true)
    view.unmount()
  })
})

test('面板：设置区保存写回 /config', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async calls => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
    await view.mount()

    byTestId(view.tree, 'ptf-set-model').props.onChange({ target: { value: 'deepseek-v4.1-pro' } })
    byTestId(view.tree, 'ptf-set-baseurl').props.onChange({ target: { value: 'http://127.0.0.1:8189' } })
    byTestId(view.tree, 'ptf-set-level').props.onChange({ target: { value: 'max' } })
    await view.settle()

    byTestId(view.tree, 'ptf-save-settings').props.onClick()
    await view.settle()

    const saveCall = calls.find(call => call.method === 'POST' && call.path === '/config')
    assert.deepEqual(saveCall.body.patch.llm, { provider: 'opencode-go', model: 'deepseek-v4.1-pro' })
    assert.equal(saveCall.body.patch.purge.level, 'max')
    assert.equal(saveCall.body.patch.comfy.baseUrl, 'http://127.0.0.1:8189')
    assert.ok(
      byTestId(view.tree, 'ptf-settings-saved'),
      '保存成功要给反馈；当前节点=' + testIds(view.tree).join(','),
    )
    assert.equal(byTestId(view.tree, 'ptf-level').props.value, 'max')
    assert.deepEqual(rawKeys(view.tree), [], '设置区与顶部区不能漏字典裸键')

    view.unmount()
  })
})

test('面板：复制按钮把正向全文交给剪贴板', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')
  let copied = null
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let patched = true
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async value => { copied = value } } },
    })
  } catch (error) {
    patched = false
  }

  try {
    await withFetch(defaultRoutes(), async () => {
      const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
      await view.mount()
      byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '雨夜霓虹街头的银发少女' } })
      await view.settle()
      byTestId(view.tree, 'ptf-generate').props.onClick()
      await view.settle()
      byTestId(view.tree, 'ptf-copy').props.onClick()
      await view.settle()
      if (patched) {
        assert.equal(copied, '1girl, silver hair, (wet shirt:1.2)')
        assert.equal(textOf(byTestId(view.tree, 'ptf-copy')), t('action.copied'))
      }
      view.unmount()
    })
  } finally {
    if (hadNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', hadNavigator)
  }
})

test('纯函数：normalizePurge 兜底与档位判定', () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)

  assert.deepEqual(
    internals.normalizePurge({ level: 'max', enabled: true, chars: 912, modules: ['a', 'b'] }),
    { level: 'max', enabled: true, chars: 912, modules: ['a', 'b'] },
  )
  // level=off 一定算关，哪怕 enabled 还写着 true
  assert.deepEqual(internals.normalizePurge({ level: 'off', enabled: true, chars: 0, modules: [] }),
    { level: 'off', enabled: false, chars: 0, modules: [] })
  // 档位拼错就退回 full，不把脏值塞给 CSS 的 data-level
  assert.deepEqual(internals.normalizePurge({ level: '谁知道' }), { level: 'full', enabled: true, chars: 0, modules: [] })
  assert.equal(internals.normalizePurge(null).level, 'full')
  assert.deepEqual(internals.normalizePurge(undefined).modules, [])
})

test('面板：中英对照文本框逐行对齐，缺中文只留 tag，可整段复制', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')
  let copied = null
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let patched = true
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async value => { copied = value } } },
    })
  } catch (error) {
    patched = false
  }

  try {
    await withFetch(defaultRoutes(), async () => {
      const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
      await view.mount()
      byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '雨夜霓虹街头的银发少女' } })
      await view.settle()
      byTestId(view.tree, 'ptf-generate').props.onClick()
      await view.settle()

      const box = byTestId(view.tree, 'ptf-bilingual')
      assert.ok(box, '中英对照文本框必须在结果卡里')
      assert.equal(box.props.readOnly, true)
      assert.equal(box.props.value, '1girl\nsilver hair — 银发\n(wet shirt:1.2)')
      assert.equal(box.props.rows, 4)
      // 库里没中文的 tag 不能编一个中文出来，也不能留个空破折号
      assert.equal(box.props.value.includes('1girl —'), false)
      // 权重跟正向串一致：1 不带括号，非 1 写成 (tag:权重)
      assert.equal(box.props.value.includes('(1girl:1)'), false)
      assert.equal(box.props.value.includes('(wet shirt:1.2)'), true)

      const negative = byTestId(view.tree, 'ptf-negative-pairs')
      assert.ok(negative, '负向也要有对照')
      assert.equal(negative.props.children, 'lowres\nbad hands')
      assert.equal(byTestId(view.tree, 'ptf-copy-bilingual').props.children, t('action.copy'))

      byTestId(view.tree, 'ptf-copy-bilingual').props.onClick()
      await view.settle()
      if (patched) {
        assert.equal(copied, '1girl\nsilver hair — 银发\n(wet shirt:1.2)')
        assert.equal(textOf(byTestId(view.tree, 'ptf-copy-bilingual')), t('action.copied'))
      }
      assert.deepEqual(rawKeys(view.tree), [])
      view.unmount()
    })
  } finally {
    if (hadNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', hadNavigator)
  }
})

test('面板：ComfyUI 灯显示连接状态，点一下重新探活，启动按钮真的打 POST', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')
  let status = { ok: true, reachable: true, version: '0.45.0', baseUrl: 'http://127.0.0.1:8188' }

  // 冷启动只打 /state：comfy 段是 ping 结果，启动目录取 config.comfy.launchDir（面板按 launch.dir 用）。
  const launchDir = 'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI'
  await withFetch(defaultRoutes({
    'GET /state': () => ({
      body: {
        ...statePayload,
        comfy: status,
        config: { ...configPayload.config, comfy: { ...configPayload.config.comfy, launchDir } },
      },
    }),
    'GET /comfy': () => ({
      body: { ok: true, status, launch: { ok: true, dir: launchDir, command: 'python -s main.py' }, workflows: [] },
    }),
  }), async calls => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
    await view.mount()

    const lamp = byTestId(view.tree, 'ptf-comfy-lamp')
    assert.ok(lamp, '顶部必须有 ComfyUI 状态灯')
    assert.equal(lamp.props['data-state'], 'online')
    assert.ok(textOf(lamp).includes(t('comfy.online')))
    assert.ok(textOf(lamp).includes('0.45.0'), '连上了就该带版本号')
    assert.ok(String(lamp.props.title).includes('D:/QUARK/ComfyUI-aki-v3.2/ComfyUI'), 'title 要说清是哪个目录：' + lamp.props.title)

    // ComfyUI 关了 → 点灯重新探活，灯变红并给出原因
    status = /** @type {any} */ ({ ok: false, reachable: false, message: '连接被拒绝，服务没在监听' })
    const before = calls.filter(item => item.path === '/comfy').length
    lamp.props.onClick()
    await view.settle()
    const after = calls.filter(item => item.path === '/comfy').length
    assert.ok(after > before, '点灯必须重新请求 /comfy')
    const offline = byTestId(view.tree, 'ptf-comfy-lamp')
    assert.equal(offline.props['data-state'], 'offline')
    assert.ok(textOf(offline).includes(t('comfy.offline')))
    assert.ok(String(offline.props.title).includes('连接被拒绝'), '离线原因要进 title：' + offline.props.title)

    // 设置区填目录 → 保存写回 /config 的 comfy.launchDir
    byTestId(view.tree, 'ptf-set-launchdir').props.onChange({ target: { value: 'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI' } })
    byTestId(view.tree, 'ptf-set-pythonpath').props.onChange({ target: { value: 'D:/QUARK/ComfyUI-aki-v3.2/python/python.exe' } })
    await view.settle()
    byTestId(view.tree, 'ptf-save-settings').props.onClick()
    await view.settle()
    const saved = calls.filter(item => item.method === 'POST' && item.path === '/config').pop()
    assert.equal(saved.body.patch.comfy.launchDir, 'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI')
    assert.equal(saved.body.patch.comfy.pythonPath, 'D:/QUARK/ComfyUI-aki-v3.2/python/python.exe')

    // 启动按钮：打 POST /comfy/launch，成功后灯变绿
    byTestId(view.tree, 'ptf-comfy-launch').props.onClick()
    await view.settle()
    const launched = calls.filter(item => item.method === 'POST' && item.path === '/comfy/launch')
    assert.equal(launched.length, 1, '启动按钮必须真的请求服务端去起进程')
    assert.equal(byTestId(view.tree, 'ptf-comfy-lamp').props['data-state'], 'online')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：破甲灯跟着 /state 与保存走', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')
  let purge = { enabled: true, level: 'max', chars: 912, modules: ['direct-output', 'override-upstream'] }

  await withFetch(defaultRoutes({
    'GET /state': () => ({ body: { ok: true, purge } }),
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: '/prompt-forge/api' })
    await view.mount()

    const lamp = byTestId(view.tree, 'ptf-purge-lamp')
    assert.ok(lamp, '顶部必须有破甲状态灯')
    assert.equal(lamp.props['data-level'], 'max')
    assert.equal(lamp.props['data-enabled'], 'on')
    assert.ok(textOf(lamp).includes(t('level.max')))
    assert.ok(String(lamp.props.title).includes('override-upstream'))
    // 下拉显示的是「配置里的档位」（这里是 full），灯显示的是服务端生效档位（max）：两者故意分开
    assert.equal(byTestId(view.tree, 'ptf-set-level').props.value, 'full')

    // 关掉档位并保存 → /state 回 off，灯跟着灭
    purge = { enabled: false, level: 'off', chars: 0, modules: [] }
    byTestId(view.tree, 'ptf-set-level').props.onChange({ target: { value: 'off' } })
    await view.settle()
    byTestId(view.tree, 'ptf-save-settings').props.onClick()
    await view.settle()

    const off = byTestId(view.tree, 'ptf-purge-lamp')
    assert.equal(off.props['data-level'], 'off')
    assert.equal(off.props['data-enabled'], 'off')
    assert.ok(textOf(off).includes(t('purge.off')) || textOf(off).includes(t('level.off')))
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：本地处理痕迹（修正/补词/整理）显示出来，四个开关按 /config 回填并写回', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async calls => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()

    // 开关回填：/config 里 poseHints=false，其余默认开
    assert.equal(byTestId(view.tree, 'ptf-forge-repair').props.checked, true)
    assert.equal(byTestId(view.tree, 'ptf-forge-postprocess').props.checked, true)
    assert.equal(byTestId(view.tree, 'ptf-forge-posehints').props.checked, false)
    assert.equal(byTestId(view.tree, 'ptf-forge-candidates').props.checked, true)

    // 锻造 → 结果卡里出现「本地处理」条，三段都在
    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女跪趴' } })
    await view.settle()
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()

    const strip = byTestId(view.tree, 'ptf-pipeline')
    assert.ok(strip, '结果卡必须有本地处理痕迹')
    const shown = textOf(strip)
    assert.ok(shown.includes('top_down_bottom_up→top-down_bottom-up'), '词形修正要显示 from→to：' + shown)
    assert.ok(shown.includes('all_fours'), '补进来的姿势词要显示：' + shown)
    assert.ok(shown.includes('profile'), '整理掉的同义词要显示：' + shown)
    assert.ok(shown.includes(t('pipeline.title')))

    // 关掉词形修复并保存 → patch.forge.repair === false
    byTestId(view.tree, 'ptf-forge-repair').props.onChange({ target: { checked: false } })
    await view.settle()
    byTestId(view.tree, 'ptf-save-settings').props.onClick()
    await view.settle()
    const saved = calls.filter(item => item.method === 'POST' && item.path === '/config').pop()
    assert.equal(saved.body.patch.forge.repair, false)
    assert.equal(saved.body.patch.forge.poseHints, false, '没动过的开关要按当前值一起写回')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：没结果时无二次精修卡，出结果后才有且默认 add 模式', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async () => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    assert.equal(byTestId(view.tree, 'ptf-refine-card'), null, '空态不该有精修卡')
    assert.deepEqual(rawKeys(view.tree), [])

    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女站在雨夜霓虹街头' } })
    await view.settle()
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()

    const card = byTestId(view.tree, 'ptf-refine-card')
    assert.ok(card, '有结果就要有精修卡')
    assert.equal(card.props['data-mode'], 'add')
    assert.equal(card.props['data-status'], 'idle')
    assert.equal(byTestId(view.tree, 'ptf-refine-input').props.placeholder, t('refine.placeholder'))
    assert.equal(byTestId(view.tree, 'ptf-refine-mode-add').props['data-on'], 'on')
    for (const mode of ['edit', 'prune', 'weights']) {
      assert.equal(byTestId(view.tree, 'ptf-refine-mode-' + mode).props['data-on'], 'off')
    }
    assert.equal(byTestId(view.tree, 'ptf-refine-delta'), null, '还没精修就不该有 delta')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：二次精修带上当前正负向与模式，成功后芯片与中英对照换成新标签', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async calls => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女站在雨夜霓虹街头' } })
    await view.settle()
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()

    byTestId(view.tree, 'ptf-refine-input').props.onChange({ target: { value: '再补点室内光线和汗水的细节' } })
    await view.settle()
    byTestId(view.tree, 'ptf-refine-mode-weights').props.onClick()
    await view.settle()
    assert.equal(byTestId(view.tree, 'ptf-refine-card').props['data-mode'], 'weights')

    byTestId(view.tree, 'ptf-refine-run').props.onClick()
    view.render()
    const running = byTestId(view.tree, 'ptf-refine-run')
    assert.equal(running.props.disabled, true, '请求中要禁用按钮')
    assert.equal(textOf(running), t('refine.running'))
    assert.equal(byTestId(view.tree, 'ptf-refine-card').props['data-status'], 'running')

    await view.settle()

    const call = calls.find(item => item.method === 'POST' && item.path === '/refine')
    assert.ok(call, '必须真的打到 /refine')
    assert.deepEqual(call.body, {
      positive: '1girl, silver hair, (wet shirt:1.2)',
      negative: 'lowres, bad hands',
      instruction: '再补点室内光线和汗水的细节',
      mode: 'weights',
      options: {},
    })

    const chips = findAll(view.tree, node => node.props?.['data-testid'] === 'ptf-chip')
    assert.deepEqual(chips.map(chip => chip.props['data-tag']), ['1girl', 'silver hair', 'sweat', 'indoor light', 'wet shirt'])
    assert.equal(textOf(byTestId(view.tree, 'ptf-positive')), '1girl, silver hair, sweat, indoor light, (wet shirt:1.3)')
    const bilingual = byTestId(view.tree, 'ptf-bilingual')
    assert.match(bilingual.props.value, /sweat — 汗水/)
    assert.match(bilingual.props.value, /\(wet shirt:1\.3\) — 湿衬衫/)
    assert.equal(bilingual.props.rows, 5)

    const delta = byTestId(view.tree, 'ptf-refine-delta')
    assert.ok(delta, 'delta 摘要要显示')
    const deltaText = textOf(delta)
    assert.ok(deltaText.includes('sweat, indoor light'), '新增要列出来，实际=' + deltaText)
    assert.ok(deltaText.includes('rainy street'), '删除要列出来，实际=' + deltaText)
    assert.ok(deltaText.includes('wet shirt 1.2→1.3'), '调权要带前后值，实际=' + deltaText)
    assert.equal(byTestId(view.tree, 'ptf-refine-error'), null)
    assert.equal(byTestId(view.tree, 'ptf-refine-card').props['data-status'], 'done')
    assert.equal(byTestId(view.tree, 'ptf-refine-run').props.disabled, false)
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：二次精修无改动显示 nochange，失败在卡内红字且保留原结果', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')
  let phase = 'same'

  await withFetch(defaultRoutes({
    'POST /refine': () => phase === 'same'
      ? {
        body: {
          ok: true,
          positive: '1girl, silver hair, (wet shirt:1.2)',
          negative: 'lowres, bad hands',
          tags: forgePayload.tags,
          delta: { added: [], removed: [], weighted: [] },
          ms: 300,
          model: 'deepseek-v4.1-flash',
          purgeLevel: 'full',
          warnings: [],
        },
      }
      : { status: 502, body: { ok: false, message: '精修上游超时' } },
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女站在雨夜霓虹街头' } })
    await view.settle()
    byTestId(view.tree, 'ptf-generate').props.onClick()
    await view.settle()

    byTestId(view.tree, 'ptf-refine-run').props.onClick()
    await view.settle()
    const same = byTestId(view.tree, 'ptf-refine-delta')
    assert.ok(same, 'delta 节点要在')
    assert.equal(textOf(same), t('refine.nochange'))
    assert.equal(byTestId(view.tree, 'ptf-refine-card').props['data-status'], 'done')

    phase = 'fail'
    byTestId(view.tree, 'ptf-refine-run').props.onClick()
    await view.settle()

    const error = byTestId(view.tree, 'ptf-refine-error')
    assert.ok(error, '失败要在卡片里显示红字')
    assert.ok(textOf(error).includes('精修上游超时'))
    assert.equal(byTestId(view.tree, 'ptf-refine-card').props['data-status'], 'failed')
    const chips = findAll(view.tree, node => node.props?.['data-testid'] === 'ptf-chip')
    assert.deepEqual(chips.map(chip => chip.props['data-tag']), ['1girl', 'silver hair', 'wet shirt'])
    assert.equal(textOf(byTestId(view.tree, 'ptf-positive')), '1girl, silver hair, (wet shirt:1.2)')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('面板：SPI 徽标显示版本与槽位，前缀跟 API 常量一致；/spi 失败就整块不显示', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async () => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    const badge = byTestId(view.tree, 'ptf-spi-badge')
    assert.ok(badge, '有 /spi 就要有徽标')
    const text = textOf(badge)
    assert.ok(text.includes('SPI v1'), '显示 SPI v1，实际=' + text)
    assert.ok(text.includes('3'), '显示槽位数，实际=' + text)
    assert.ok(text.includes('/tagger/api'), '接口前缀要在徽标里，实际=' + text)
    assert.equal(badge.props['data-version'], 1)
    assert.equal(badge.props['data-slots'], 3)
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })

  await withFetch(defaultRoutes({
    'GET /spi': { status: 500, body: { ok: false, message: 'no spi' } },
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    assert.equal(byTestId(view.tree, 'ptf-spi-badge'), null, '/spi 挂了就不显示徽标')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('子模块取不到：面板降级成错误卡，apply 照常返回、slot 照常注册', async () => {
  const React = createFakeReact()
  const previousBase = globalThis.__DSH_TAGGER_MODBASE__
  const previousMods = globalThis.__DSH_TAGGER_MODS__
  // 基址指到不存在的目录：三个候选基址（注入基址 / 主前缀 / 旧前缀）全都取不到。
  globalThis.__DSH_TAGGER_MODBASE__ = new URL('../client-missing/', import.meta.url).href
  delete globalThis.__DSH_TAGGER_MODS__
  try {
    const { module } = loadClient(React)
    assert.equal(module.__internals, undefined, '子模块没加载成功时不该有 __internals')

    const registered = []
    const ctx = {
      slots: {
        inject(name, factory) { factory() },
        register(options, component) { registered.push({ options, component }); return () => {} },
      },
    }

    const pending = module.apply(ctx)
    assert.ok(pending !== null && typeof pending.then === 'function', '模块未缓存时 apply 要返回 promise')
    await pending

    assert.equal(registered.length, 2, '加载失败也要把两个 slot 注册上，否则宿主判 missing slot')
    const list = registered.find(item => item.options.name === 'sidebar.panellist')
    assert.equal(list.options.label(), '提示词', '错误态也要有面板名（走门面内置兜底文案）')
    const main = registered.find(item => item.options.name === 'main')
    assert.equal(main.options.inject().api, '/tagger/api')

    const view = createView(React, main.component, {})
    view.render()
    const card = byTestId(view.tree, 'ptf-load-error')
    assert.ok(card, '加载失败要渲染错误卡，不能白屏')
    assert.ok(textOf(card).includes('子模块加载失败'))
    const detail = byTestId(view.tree, 'ptf-load-error-message')
    assert.ok(textOf(detail).length > '子模块加载失败：'.length, '要带上错误 message，实际=' + textOf(detail))
    assert.ok(textOf(card).includes('重启宿主'), '要提示重启宿主')
    assert.deepEqual(rawKeys(view.tree), [])

    // 图标也得能画出来，不然侧边栏那一行会报渲染错误。
    const icon = createView(React, registered[0].component, {})
    icon.render()
    assert.equal(icon.tree.type, 'svg')
  } finally {
    globalThis.__DSH_TAGGER_MODBASE__ = previousBase
    globalThis.__DSH_TAGGER_MODS__ = previousMods
  }
})

test('体积护栏：门面 < 12KB、client/ 每个子模块 < 30KB、文件名符合 _mod 路由白名单', () => {
  const facade = readFileSync(clientPath)
  assert.ok(facade.length < 12 * 1024, '门面要留在 12KB 内，实际 ' + facade.length + ' 字节')
  // 门面按 classic script 执行（new Function），出现顶层 import/export 会直接抛语法错。
  assert.equal(/^\s*(?:import|export)\s/m.test(facade.toString('utf8')), false, '门面不能有顶层 import/export')

  const files = readdirSync(clientDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name)
    .sort()
  assert.ok(files.length >= 8, '子模块至少 8 个，实际 ' + files.length + '：' + files.join(', '))
  for (const name of files) {
    // 宿主只认 client/ 根下这一层，且 name 必须过 /^[a-z0-9][a-z0-9-]*\.js$/。
    assert.match(name, /^[a-z0-9][a-z0-9-]*\.js$/, name + ' 不符合 _mod 路由白名单')
    const size = readFileSync(path.join(clientDir, name)).length
    assert.ok(size < 30 * 1024, name + ' 超 30KB：' + size + ' 字节')
  }
})

test('门面基址带 client/ 段：宿主的 _mod 白名单是 client/<name>.js，漏了就是 400 bad-module', async () => {
  const React = createFakeReact()
  const source = readFileSync(clientPath, 'utf8')
  // 静态护栏：两个前缀都必须拼成 {PREFIX}/_mod/client/，不能被改回裸 /_mod/。
  assert.ok(source.includes("API + '/_mod/client/'"), '主前缀基址要带 client/ 段')
  assert.ok(source.includes("LEGACY_API + '/_mod/client/'"), '旧前缀基址也要带 client/ 段')
  assert.equal(source.includes("+ '/_mod/'"), false, '不能再出现裸的 /_mod/ 基址')

  // 行为验证：没有注入基址时，加载失败的错误里要看得见真去请求的 client/ 路径。
  const previousBase = globalThis.__DSH_TAGGER_MODBASE__
  const previousMods = globalThis.__DSH_TAGGER_MODS__
  delete globalThis.__DSH_TAGGER_MODBASE__
  delete globalThis.__DSH_TAGGER_MODS__
  try {
    const { module } = loadClient(React)
    const registered = []
    const ctx = {
      slots: {
        inject(name, factory) { factory() },
        register(options, component) { registered.push({ options, component }); return () => {} },
      },
    }
    await module.apply(ctx)
    const main = registered.find(item => item.options.name === 'main')
    const view = createView(React, main.component, {})
    view.render()
    const detail = byTestId(view.tree, 'ptf-load-error-message')
    assert.ok(detail, '取不到子模块要有错误卡')
    assert.match(textOf(detail), /_mod[\\/]client[\\/]panel\.js/, '请求路径要带 client/ 段，实际=' + textOf(detail))
    assert.deepEqual(rawKeys(view.tree), [])
  } finally {
    globalThis.__DSH_TAGGER_MODBASE__ = previousBase
    globalThis.__DSH_TAGGER_MODS__ = previousMods
  }
})

test('面板：/spi 的 slots / hooks 是对象形状时按条数计数（不是 Number(obj)=NaN）', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes({
    'GET /spi': {
      body: {
        ok: true,
        spi: {
          version: 2,
          // describe() 的真实形状：槽位 → 该槽可注册的若干项；钩子 → 钩子 id 数组。
          slots: { 'sidebar.panellist': [{ id: 'prompt-forge', label: '提示词' }], main: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          hooks: { 'panel:after': ['h1', 'h2', 'h3'] },
        },
      },
    },
  }), async () => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()
    const badge = byTestId(view.tree, 'ptf-spi-badge')
    assert.ok(badge, '有 /spi 就要有徽标')
    assert.equal(badge.props['data-slots'], 2, '两个槽位，不是 0')
    const text = textOf(badge)
    assert.ok(text.includes('SPI v2'), '显示 SPI v2，实际=' + text)
    assert.ok(text.includes('2'), '显示槽位数 2，实际=' + text)
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('冷启动只打 /state：不再单独请求 /workflows、/config、/comfy', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes(), async calls => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()

    const gets = calls.filter(call => call.method === 'GET').map(call => call.path)
    assert.ok(gets.includes('/state'), '/state 是唯一入口，实际=' + gets.join(','))
    for (const path of ['/workflows', '/config', '/comfy']) {
      assert.equal(gets.includes(path), false, '冷启动不该再打 ' + path + '，实际=' + gets.join(','))
    }

    // 一次 /state 就把设置、工作流、ComfyUI 灯都点亮了。
    assert.equal(byTestId(view.tree, 'ptf-set-model').props.value, 'deepseek-v4.1-flash', '设置从 /state 的 config 回填')
    assert.equal(byTestId(view.tree, 'ptf-workflow-error'), null, '/state 说工作流正常就不该报错')
    const lamp = byTestId(view.tree, 'ptf-comfy-lamp')
    assert.equal(lamp.props['data-state'], 'online', '灯从 /state 的 comfy 段点亮')
    assert.ok(String(lamp.props.title).includes('0.45.0'), '版本号要进来：' + lamp.props.title)
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('冷启动回退：/state 整个挂了才回退 /config、/workflows、/comfy', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  await withFetch(defaultRoutes({
    'GET /state': { status: 500, body: { ok: false, error: 'state', message: '状态读不出来' } },
  }), async calls => {
    const view = createView(React, internals.Panel, { t, api: internals.API })
    await view.mount()

    const gets = calls.filter(call => call.method === 'GET').map(call => call.path)
    for (const path of ['/config', '/workflows', '/comfy']) {
      assert.ok(gets.includes(path), '/state 挂了要回退 ' + path + '，实际=' + gets.join(','))
    }
    // 回退路径也把面板填满了：设置、工作流、灯都在。
    assert.equal(byTestId(view.tree, 'ptf-set-model').props.value, 'deepseek-v4.1-flash')
    assert.equal(byTestId(view.tree, 'ptf-workflow-error'), null)
    assert.equal(byTestId(view.tree, 'ptf-comfy-lamp').props['data-state'], 'online')
    assert.deepEqual(rawKeys(view.tree), [])
    view.unmount()
  })
})

test('参考图上传失败按 ref.err.<code> 翻成中文，认不出的码退回原码', async () => {
  const React = createFakeReact()
  const { internals } = loadClient(React)
  const t = internals.createT('zh')

  const hadReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader')
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    writable: true,
    value: class FakeReader {
      constructor() {
        this.result = ''
        /** @type {null | (() => void)} */
        this.onload = null
        /** @type {null | (() => void)} */
        this.onerror = null
      }
      /** @param {string} [_url] */
      readAsDataURL(_url) {
        this.result = 'data:image/png;base64,AA=='
        Promise.resolve().then(() => { if (typeof this.onload === 'function') this.onload() })
      }
    },
  })

  try {
    // 参考图只在「带参考图」的工作流下启用，所以把默认工作流设成 wf-ref。
    const refConfig = {
      ...configPayload.config,
      comfy: { ...configPayload.config.comfy, defaultWorkflowId: 'wf-ref' },
    }
    const cases = [
      { code: 'too-large', expected: t('ref.err.too-large'), showsCode: false },
      { code: 'bad-type', expected: t('ref.err.bad-type'), showsCode: false },
      { code: 'no-launch-dir', expected: t('ref.err.no-launch-dir'), showsCode: false },
      { code: 'empty-file', expected: t('ref.err.empty-file'), showsCode: false },
      { code: 'weird-code', expected: 'weird-code', showsCode: true },
    ]

    for (const item of cases) {
      await withFetch(defaultRoutes({
        'GET /state': { body: { ...statePayload, config: refConfig } },
        'POST /upload': { status: 400, body: { ok: false, error: item.code } },
      }), async () => {
        const view = createView(React, internals.Panel, { t, api: internals.API })
        await view.mount()
        byTestId(view.tree, 'ptf-text').props.onChange({ target: { value: '银发少女在窗边回头' } })
        await view.settle()
        byTestId(view.tree, 'ptf-generate').props.onClick()
        await view.settle()

        const input = byTestId(view.tree, 'ptf-ref-file')
        assert.ok(input, '有结果后才有参考图输入')
        input.props.onChange({ target: { files: [{ name: 'a.png' }] } })
        await view.settle()

        const status = textOf(byTestId(view.tree, 'ptf-ref-status'))
        assert.ok(status.includes(item.expected), item.code + ' 要显示「' + item.expected + '」，实际=' + status)
        if (item.showsCode) assert.ok(status.includes(item.code), '认不出的码要原样露出来：' + status)
        else assert.equal(status.includes(item.code), false, '认得的码不该再把英文码露给用户：' + status)
        assert.deepEqual(rawKeys(view.tree), [])
        view.unmount()
      })
    }
  } finally {
    if (hadReader === undefined) delete globalThis.FileReader
    else Object.defineProperty(globalThis, 'FileReader', hadReader)
  }
})
