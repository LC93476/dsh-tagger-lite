/**
 * tests/frontend-i18n.test.mjs — 前端文案、i18n 骨架、品牌色与纯逻辑的守卫。
 *
 * 跑法（本机没有 node 命令）：
 *   cd "/d/DSh tagger-lite" && ELECTRON_RUN_AS_NODE=1 \
 *     "C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" \
 *     --test --test-concurrency=1 tests/frontend-i18n.test.mjs
 *
 * 为什么「内置字典」断言子集 + 全覆盖，而不是与 zh.json 三份完全相等：
 * zh.json 有 313 条，其中 120 条是服务端 / 历史键（meta.、panel、title、subtitle、standards、workflow.…），
 * 面板的 T() 一条都不碰；内置字典是「服务端拿不到时别白屏」的兜底，只装面板真会显示的键。
 * 硬求三份相等只会往客户端塞 120 条用不到的文案，还多一份漂移面。真正要守的是：
 *   ① zh 与 en 键集合完全一致；② 内置字典 ⊆ zh；③ 面板 T() 用到的键都有内置兜底；
 *   ④ render.js 的错误码表（T 用变量取键，正则抠不到）也逐条有兜底。
 *
 * 纯逻辑那几条用 node:vm 把 server/public/state.js 与 settings.js 原样加载进沙箱再调函数：
 * 这两份文件顶层只有声明、没有副作用，所以只给 document.getElementById 与几个空壳就能跑。
 * 别把它们 import 进来 —— 它们是浏览器脚本（没有 export），classic script 只能走 vm。
 *
 * 无外部依赖：node:test + node:assert + node:vm。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 读仓库里的相对路径文件（utf8）。 */
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

/** 读一份 locale json。 */
function loadJson(rel) {
  return JSON.parse(read(rel))
}

/** 把嵌套字典展平成 a.b.c 键列表；数组与 null 当叶子，别把它们再往下拆。 */
function flattenKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return prefix === '' ? [] : [prefix]
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix === '' ? key : prefix + '.' + key))
}

/** 展平成 键→值（值统一转成字符串，只用来查漏翻）。 */
function flattenPairs(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix !== '') out[prefix] = String(value)
    return out
  }
  for (const [key, child] of Object.entries(value)) flattenPairs(child, prefix === '' ? key : prefix + '.' + key, out)
  return out
}

/** i18n.js 里内置的 zh 兜底字典：那段赋值是合法 JSON，直接 parse，别 eval。 */
function builtinZh() {
  const src = read('server/public/i18n.js')
  const hit = src.match(/var I18N_BUILTIN_ZH = (\{[\s\S]*?\n\});/)
  assert.ok(hit, 'i18n.js 里找不到 I18N_BUILTIN_ZH 的定义')
  const parsed = JSON.parse(hit[1])
  assert.equal(typeof parsed, 'object', 'I18N_BUILTIN_ZH 必须是对象')
  return parsed
}

/** 面板 JS 里真正会用的键：T("key") 调用 + i18n.js 的 I18N_STATIC 清单。 */
function usedKeys() {
  const dir = path.join(repoRoot, 'server', 'public')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.js'))
  assert.ok(files.length >= 5, 'server/public 下的 js 太少，路径可能变了：' + files.join(','))
  const used = new Set()
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const hit of text.matchAll(/\bT\(\s*["']([\w.]+)["']/g)) used.add(hit[1])
  }
  const i18nSrc = read('server/public/i18n.js')
  for (const hit of i18nSrc.matchAll(/"key":\s*"([\w.]+)"/g)) used.add(hit[1])
  return [...used].sort()
}

test('locale/zh.json 与 locale/en.json 的键集合完全一致（展平后比较）', () => {
  const zh = loadJson('locale/zh.json')
  const en = loadJson('locale/en.json')
  const zhKeys = flattenKeys(zh).sort()
  const enKeys = flattenKeys(en).sort()
  const missingEn = zhKeys.filter(key => !enKeys.includes(key))
  const extraEn = enKeys.filter(key => !zhKeys.includes(key))
  assert.deepEqual(missingEn, [], '英文缺这些键：' + missingEn.slice(0, 8).join('、'))
  assert.deepEqual(extraEn, [], '英文多出这些键：' + extraEn.slice(0, 8).join('、'))
  assert.ok(zhKeys.length >= 300, '键数异常少（' + zhKeys.length + '），locale 可能被截断了')
  const pairs = flattenPairs(zh)
  for (const [key, value] of Object.entries(pairs)) {
    assert.equal(value.trim() === '', false, '中文文案是空的：' + key)
  }
})

test('内置 zh 兜底字典是 zh.json 的子集，且面板 T() 用到的键一个不缺', () => {
  const zhKeys = new Set(flattenKeys(loadJson('locale/zh.json')))
  const builtin = builtinZh()
  const builtinKeys = flattenKeys(builtin)
  assert.ok(builtinKeys.length >= 180, '内置字典条数异常少：' + builtinKeys.length)
  const ghost = builtinKeys.filter(key => !zhKeys.has(key))
  assert.deepEqual(ghost, [], '内置字典里有 zh.json 里不存在的键（会在切语言时露出中文）：' + ghost.slice(0, 8).join('、'))
  for (const [key, value] of Object.entries(flattenPairs(builtin))) {
    assert.equal(value.trim() === '', false, '内置字典的文案是空的：' + key)
  }
  const used = usedKeys()
  assert.ok(used.length >= 100, '从面板里抠到的键太少（' + used.length + '），正则或文件路径可能失效了')
  const uncovered = used.filter(key => !(key in flattenPairs(builtin)))
  assert.deepEqual(uncovered, [], '面板会用但没有内置兜底的键：' + uncovered.slice(0, 8).join('、'))
})

test('render.js 的错误码表逐条有内置兜底（缺键会退化成泛化的「出错」）', () => {
  const block = read('server/public/render.js').match(/var ERR_TEXT = \{[\s\S]*?\n\};/)
  assert.ok(block, 'render.js 里找不到 ERR_TEXT 定义')
  const keys = [...block[0].matchAll(/"[^"]+":\s*"([\w.$-]+)"/g)].map(hit => hit[1])
  assert.ok(keys.length >= 30, '错误码太少（' + keys.length + '），正则可能失效')
  // network 是后加的码：断网时没有它就只能显示 ui.error.generic
  assert.ok(keys.includes('error.network'), 'ERR_TEXT 里应该有 network → error.network')
  const builtin = flattenPairs(builtinZh())
  const zh = flattenPairs(loadJson('locale/zh.json'))
  const missing = keys.filter(key => !(key in builtin))
  assert.deepEqual(missing, [], '这些错误码在内置字典里没有文案：' + missing.join('、'))
  const missingZh = keys.filter(key => !(key in zh))
  assert.deepEqual(missingZh, [], '这些错误码在 locale/zh.json 里没有文案：' + missingZh.join('、'))
})

test('前端文案里没有个人盘符路径，示例统一指到 C:\\ComfyUI', () => {
  const files = [
    'server/public/i18n.js',
    'server/public/panel.css',
    'locale/zh.json',
    'locale/en.json',
    'server/panel.html',
  ]
  // 个人机器路径：D:\QUARK / D:/QUARK 这类，以及带版本号的安装目录名
  const personal = [/[A-Za-z]:[\\/]{1,2}QUARK/i, /ComfyUI-aki/i]
  for (const rel of files) {
    const text = read(rel)
    for (const pattern of personal) {
      const hit = text.match(pattern)
      assert.equal(hit === null, true, rel + ' 里还有本机路径：' + (hit ? hit[0] : ''))
    }
  }
  // 安装目录 / python 示例统一成通用的 C:\ComfyUI（json 里是双反斜杠）
  for (const rel of ['locale/zh.json', 'locale/en.json', 'server/public/i18n.js', 'server/panel.html']) {
    assert.match(read(rel), /C:[\\]{1,2}ComfyUI/, rel + ' 的安装目录示例应指到 C:\\ComfyUI')
  }
  for (const rel of ['locale/zh.json', 'locale/en.json', 'server/public/i18n.js', 'server/panel.html']) {
    assert.match(read(rel), /C:[\\]{1,2}ComfyUI[\\]{1,2}python[\\]{1,2}python\.exe/, rel + ' 的 python 示例应指到 C:\\ComfyUI\\python\\python.exe')
  }
})

test('i18n.js 读语言下拉用 document.getElementById("lang")，不再依赖 state.js 的 $', () => {
  const src = read('server/public/i18n.js')
  // i18n.js 可能先于 state.js 加载，$ 那时还不存在；两处取值都必须自己去 document 拿
  assert.equal(/\$\s*\(/.test(src), false, 'i18n.js 里不许再出现 $() 调用')
  const hits = src.match(/document\.getElementById\("lang"\)/g) || []
  assert.ok(hits.length >= 2, '切语言与启动两处都要写 getElementById("lang")，实际只有 ' + hits.length + ' 处')
  // 静态骨架的 #lang 选择器仍然走 querySelector（那是 CSS 选择器，跟 $ 无关）
  assert.ok(src.includes('"sel": "#lang"'), 'I18N_STATIC 里给语言下拉写 title 的那条不该被删')
})

test('panel.css 品牌色统一走 var(--brand)，没有硬编码 #4c6ef5', () => {
  const css = read('server/public/panel.css')
  assert.equal(/#4c6ef5/i.test(css), false, 'panel.css 里还有硬编码的品牌色 #4c6ef5')
  assert.match(css, /--brand:\s*#[0-9a-f]{6}/i, ':root 里要定义 --brand')
  assert.match(css, /prefers-color-scheme:\s*dark[\s\S]{0,600}--brand:\s*#[0-9a-f]{6}/i, '深色模式也要定义 --brand，否则暗色下用的是亮色品牌色')
  const uses = css.match(/var\(--brand\)/g) || []
  assert.ok(uses.length >= 8, '品牌色引用太少（' + uses.length + '），可能又写死了')
  // 这四处是本次从硬编码改过来的，改回去就该红
  assert.match(css, /\.pose-card:hover\s*\{\s*border-color:\s*var\(--brand\)\s*\}/)
  assert.match(css, /\.modal-grid figure\.on\s*\{[^}]*border-color:\s*var\(--brand\)[^}]*box-shadow:[^}]*var\(--brand\)/)
  assert.match(css, /\.sets button\.on\s*\{[^}]*background:\s*var\(--brand\)[^}]*border-color:\s*var\(--brand\)/)
})

test('locale/en.json 没有漏翻的中文', () => {
  const en = flattenPairs(loadJson('locale/en.json'))
  const bad = Object.entries(en).filter(([, value]) => /[\u4e00-\u9fff]/.test(value))
  assert.deepEqual(bad.map(([key]) => key), [], '这些英文文案里还有汉字：' + bad.map(([key]) => key).slice(0, 8).join('、'))
})

// ── 纯逻辑：node:vm 沙箱加载 state.js / settings.js ───────────────────────────

/** 造一个够用的表单控件替身：value / defaultValue / dataset / checked / options。 */
function mkInput(extra = {}) {
  return Object.assign(
    { value: '', defaultValue: '', dataset: {}, checked: false, className: '', textContent: '', style: {}, options: [], parentNode: { style: {} } },
    extra,
  )
}

/**
 * 把 state.js 与 settings.js 塞进同一个 vm 上下文跑起来。两份文件顶层只有声明，
 * 所以只要 document.getElementById 与一堆空壳；文案函数 T 一律回键名，断言只关心逻辑。
 * 返回的 els 是 getElementById 的取值表：测试按需往里塞控件，删掉就是「面板上没这个控件」。
 */
function loadPanel(files = ['server/public/state.js', 'server/public/settings.js']) {
  const els = {}
  const documentStub = {
    getElementById: id => els[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createTextNode: text => ({ nodeType: 3, nodeValue: text }),
    createElement: () => mkInput(),
    addEventListener() {},
    body: { appendChild() {} },
    documentElement: { style: {} },
  }
  const sandbox = {
    document: documentStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {}, info() {} },
    T: key => key,
    api: async () => ({ ok: true, status: 200, data: {} }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    setStatus() {},
    loadUi() {},
    saveUi() {},
    fillSettings() {},
    errText: () => 'ERR',
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const rel of files) vm.runInContext(read(rel), context, { filename: rel })
  return { context, els }
}

/**
 * 沙箱里造出来的对象属于另一个 realm：原型不同，deepStrictEqual 会报「结构相同但不是同一个引用」。
 * 断言前统一过一遍 JSON，洗成本 realm 的纯对象（这些返回值都是可 JSON 化的扁平结构）。
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('state.js cnStrengthPair 只认 defaultValue 与 data-boost；applyCnStrength 在两档之间往返', () => {
  const { context, els } = loadPanel()
  // 关键语义：base 取面板 HTML 上写的 defaultValue，不取用户当前值 —— 否则切回来会停在上一次的强度上
  els.cnstrength = mkInput({ value: '1.2', defaultValue: '1', dataset: { boost: '1.2' } })
  assert.deepEqual(plain(context.cnStrengthPair()), { base: 1, boost: 1.2 })

  // 切到参考图模板：当前值正停在 base 上 → 升到 boost
  els.cnstrength.value = '1'
  context.applyCnStrength(true, true)
  assert.equal(els.cnstrength.value, '1.2')
  // 切回普通模板：当前值正停在 boost 上 → 回落到骨架默认强度
  context.applyCnStrength(false, true)
  assert.equal(els.cnstrength.value, '1')
  // 用户手改过的强度（不落在两档任一端）不吃这一套
  els.cnstrength.value = '0.9'
  context.applyCnStrength(true, true)
  assert.equal(els.cnstrength.value, '0.9')
  els.cnstrength.value = '1.15'
  context.applyCnStrength(false, true)
  assert.equal(els.cnstrength.value, '1.15')
  // changed=false（同一个模板重复选中）：一律不动
  els.cnstrength.value = '1'
  context.applyCnStrength(true, false)
  assert.equal(els.cnstrength.value, '1')

  // data-boost 不是数字 → boost 回落到 base
  els.cnstrength.dataset.boost = 'abc'
  assert.deepEqual(plain(context.cnStrengthPair()), { base: 1, boost: 1 })
  // 没写 data-boost → 两档相同
  delete els.cnstrength.dataset.boost
  assert.deepEqual(plain(context.cnStrengthPair()), { base: 1, boost: 1 })
  // 面板上压根没有这个控件 / defaultValue 是空串：给 0/0，且 applyCnStrength 不炸
  delete els.cnstrength
  assert.deepEqual(plain(context.cnStrengthPair()), { base: 0, boost: 0 })
  context.applyCnStrength(true, true)
  context.applyCnStrength(false, true)
  els.cnstrength = mkInput({ value: '', defaultValue: '', dataset: { boost: '' } })
  assert.deepEqual(plain(context.cnStrengthPair()), { base: 0, boost: 0 })
})

test('state.js workflowCaps 认模板自己声明的 vars，没声明才按 id 子串回退', () => {
  const { context, els } = loadPanel()
  context.state.workflows = [
    { id: 'wf-image', vars: [{ name: 'image' }, { name: 'width' }] },
    { id: 'wf-pose', vars: [{ name: 'pose' }, { name: 'cnStrength' }] },
    { id: 'wf-plain', vars: [{ name: 'width' }, { name: 'seed' }] },
    { id: 'my-ref-template' },
    { id: 'sd15-posetags' },
    { id: 'ref-and-pose', vars: [{ name: 'image' }, { name: 'pose' }, { name: 'cnStrength' }] },
  ]
  // 声明了 vars：只看 vars（declared=true），id 里有 ref 也不再影响
  assert.deepEqual(plain(context.workflowCaps('wf-image')), { image: true, pose: false, cnStrength: false, declared: true })
  assert.deepEqual(plain(context.workflowCaps('wf-pose')), { image: false, pose: true, cnStrength: true, declared: true })
  assert.deepEqual(plain(context.workflowCaps('wf-plain')), { image: false, pose: false, cnStrength: false, declared: true })
  assert.deepEqual(plain(context.workflowCaps('ref-and-pose')), { image: true, pose: true, cnStrength: true, declared: true })
  // 没声明 vars（老模板 / 列表还没回来）：按 id 子串猜，declared=false
  assert.deepEqual(plain(context.workflowCaps('my-ref-template')), { image: true, pose: false, cnStrength: true, declared: false })
  assert.deepEqual(plain(context.workflowCaps('sd15-posetags')), { image: false, pose: true, cnStrength: false, declared: false })
  // 未知 id / 空 id / undefined：全 false，且不抛
  assert.deepEqual(plain(context.workflowCaps('nope')), { image: false, pose: false, cnStrength: false, declared: false })
  assert.deepEqual(plain(context.workflowCaps('')), { image: false, pose: false, cnStrength: false, declared: false })
  assert.deepEqual(plain(context.workflowCaps(undefined)), { image: false, pose: false, cnStrength: false, declared: false })

  // readVars 只塞模板声明过的变量：没声明的塞了也会被服务端丢掉
  els.workflow = mkInput({ value: 'wf-image' })
  els.width = mkInput({ value: '1200' })
  els.height = mkInput({ value: '1800' })
  els.seed = mkInput({ value: '42' })
  els.steps = mkInput({ value: '24' })
  els.cfg = mkInput({ value: '5.03' })
  els.pose = mkInput({ value: 'full_single_P012' })
  els.cnstrength = mkInput({ value: '1.2', defaultValue: '1', dataset: { boost: '1.2' } })
  context.state.refName = 'ref-01.png'
  assert.deepEqual(plain(context.readVars()), { width: 1200, height: 1800, seed: 42, steps: 24, cfg: 5.03, image: 'ref-01.png' })

  els.workflow.value = 'wf-pose'
  assert.deepEqual(plain(context.readVars()), { width: 1200, height: 1800, seed: 42, steps: 24, cfg: 5.03, pose: 'full_single_P012', cnStrength: 1.2 })

  els.workflow.value = 'wf-plain'
  assert.deepEqual(plain(context.readVars()), { width: 1200, height: 1800, seed: 42, steps: 24, cfg: 5.03 })

  // 输入框全空：回落到 panel.html 的 defaultValue，再回落到 DEFAULT_VARS（全前端唯一一张常量表）
  for (const id of ['width', 'height', 'seed', 'steps', 'cfg']) els[id] = mkInput({ value: '' })
  els.workflow.value = 'wf-plain'
  assert.deepEqual(plain(context.readVars()), { width: 1200, height: 1800, seed: 20261108, steps: 30, cfg: 5.03 })
})

test('state.js effectivePositive：#positive 手改优先，空则回退标签拼串（权重 1 不带括号）', () => {
  const { context, els } = loadPanel()
  context.state.result = { tags: [{ tag: '1girl', weight: 1 }, { tag: 'arched_back', weight: 1.1 }, { tag: 'smile', weight: 1, cn: '微笑' }] }
  els.positive = mkInput({ value: '   ' })
  assert.equal(context.effectivePositive(), '1girl, (arched_back:1.1), smile')
  els.positive.value = ' 手改过的串 '
  assert.equal(context.effectivePositive(), '手改过的串')
  // 没有 #positive 这个控件（旧面板）：直接回退，不抛
  delete els.positive
  assert.equal(context.effectivePositive(), '1girl, (arched_back:1.1), smile')
  // 一条标签都没有：空串
  context.state.result = { tags: [] }
  assert.equal(context.effectivePositive(), '')
})

test('settings.js slugName：文件名洗成合法模板 id（左截 64、中文只剩扩展名）', () => {
  const { context } = loadPanel()
  assert.equal(context.slugName('My Workflow (v2).json'), 'my-workflow-v2-json')
  assert.equal(context.slugName('  --Hello__World--  '), 'hello__world')
  assert.equal(context.slugName('ref_%$#@!'), 'ref')
  // 中文全被吃掉，只剩扩展名那一段：能过校验但不撞车才是重点
  assert.equal(context.slugName('中文模板.json'), 'json')
  assert.equal(context.slugName(''), '')
  assert.equal(context.slugName(undefined), '')
  assert.equal(context.slugName('a'.repeat(80)).length, 64)
  // 纯符号洗不出来：空串（调用方据此报 bad-name）
  assert.equal(context.slugName('!!!'), '')
})

test('settings.js classifyWfFile：workflow / schema / ui / bad 四种形状', () => {
  const { context } = loadPanel()
  assert.equal(context.classifyWfFile(JSON.stringify({ '1': { class_type: 'KSampler' }, '2': { class_type: 'SaveImage' } })), 'workflow')
  assert.equal(context.classifyWfFile(JSON.stringify({ vars: [{ name: 'image' }] })), 'schema')
  assert.equal(context.classifyWfFile(JSON.stringify({ nodes: [], links: [] })), 'ui')
  // 界面格式就算混了 class_type 也按 ui 判（nodes 优先）
  assert.equal(context.classifyWfFile(JSON.stringify({ nodes: [], '1': { class_type: 'KSampler' } })), 'ui')
  assert.equal(context.classifyWfFile('not json'), 'bad')
  assert.equal(context.classifyWfFile('[]'), 'bad')
  assert.equal(context.classifyWfFile('"x"'), 'bad')
  assert.equal(context.classifyWfFile('null'), 'bad')
  assert.equal(context.classifyWfFile(''), 'bad')
})
