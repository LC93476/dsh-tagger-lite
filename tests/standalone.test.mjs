// plan: server/standalone.mjs 的端到端测试——真起进程、真发 HTTP、真关掉
/**
 * 独立入口的冒烟测试。
 *
 * 为什么起真进程：standalone 的职责就是「没有 DSH 也能跑」，直接拿 createRuntime 测不到
 * CLI 解析、端口绑定、SIGTERM 收尾这些真正容易坏的地方。
 *
 * 两条约束：
 *   1. 不联网：llm 不配置，health 里 llmReady 必须是 false，任何一个请求都不该出网。
 *   2. 不碰用户数据：--data-dir 指向临时目录，用完删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'server', 'standalone.mjs')

/**
 * 工作台脚本的全文：studio.js 是薄入口，实现搬到了 studio/*.js。
 * 断言按「整份源码」写，所以这里拼起来读，别只读入口那一份。
 * @returns {string}
 */
function readStudioSources() {
  const dir = path.join(here, '..', 'server', 'public')
  const entryFile = path.join(dir, 'studio.js')
  /** @type {string[]} */
  const parts = [readFileSync(entryFile, 'utf8')]
  try {
    for (const name of readdirSync(path.join(dir, 'studio')).sort()) {
      if (name.endsWith('.js')) parts.push(readFileSync(path.join(dir, 'studio', name), 'utf8'))
    }
  } catch {
    // 还没拆模块时只有 studio.js，读不到 studio/ 目录不算错
  }
  return parts.join('\n')
}
const READY = /STANDALONE_READY url=(\S+)/

/** 等子进程打印 STANDALONE_READY（--port 0 时真实端口只有它知道）。 */
function waitForReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('standalone 启动超时，已收到输出：' + output.slice(0, 800)))
    }, timeoutMs)
    const onOut = chunk => {
      output += String(chunk)
      const hit = READY.exec(output)
      if (hit === null) return
      cleanup()
      resolve(hit[1])
    }
    const onErr = chunk => {
      output += String(chunk)
    }
    const onExit = code => {
      cleanup()
      reject(new Error('standalone 提前退出（code=' + code + '）：' + output.slice(0, 800)))
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off('data', onOut)
      child.stderr.off('data', onErr)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onOut)
    child.stderr.on('data', onErr)
    child.on('exit', onExit)
  })
}

/** SIGTERM 优雅退出：超时就硬杀，测试别吊死。 */
function stop(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
    child.kill('SIGTERM')
  })
}

/** 等它自己退出（--help 这种跑完就走的场景，别抢着发信号）。 */
function waitExit(child, timeoutMs = 15000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, timeoutMs)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

/** @param {import('node:net').Server} server @returns {number} */
function portOf(server) {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

function spawnStandalone(args, env) {
  return spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 发原始路径请求。
 * fetch / undici 会按 URL 规范把 '/public/../index.js' 折叠成 '/index.js'，路径穿越根本测不出来；
 * 只有裸 http.request 才能把 '..' 原样送到服务器。
 */
function rawRequest(port, rawPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), path: rawPath, method: 'GET', headers: headers ?? {} }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('standalone：health / spi / spi.version / 根路径 HTML 都能对外提供', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-standalone-'))
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  // 明确「没配模型接口」：health 必须如实说 llmReady:false，且不许联网
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL

  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)

    const healthRes = await fetch(url + '/tagger/api/health')
    assert.equal(healthRes.status, 200)
    const health = await healthRes.json()
    assert.equal(health.ok, true)
    assert.equal(health.plugin, 'dsh-tagger')
    assert.equal(health.mode, 'standalone')
    assert.equal(health.llmReady, false)
    assert.equal(health.basePath, '/tagger/api')
    assert.equal(health.mcp.endpoint, '/tagger/api/mcp')
    assert.equal(typeof health.port, 'number')

    const spiRes = await fetch(url + '/tagger/api/spi')
    assert.equal(spiRes.status, 200)
    const spi = await spiRes.json()
    assert.equal(spi.ok, true)
    assert.equal(typeof spi.spi.version, 'number')
    assert.ok(Array.isArray(spi.spi.slots.tagProviders))

    // 根路径 = 三栏工作台（默认页）；锻造台挪到 /panel，样式与脚本都走 /public
    const rootRes = await fetch(url + '/')
    assert.equal(rootRes.status, 200)
    assert.match(rootRes.headers.get('content-type') ?? '', /text\/html/)
    const rootHtml = await rootRes.text()
    assert.ok(rootHtml.includes('/public/studio.js'), '根路径要直接是三栏工作台，不是锻造台')
    assert.ok(rootHtml.includes('三栏工作台'), '默认页标题写明三栏工作台')

    const panelRes = await fetch(url + '/panel')
    assert.equal(panelRes.status, 200)
    const panel = await panelRes.text()
    assert.ok(panel.includes('DSh Tagger'), '面板标题里要有产品名')
    assert.ok(panel.includes('锻造台'), '/panel 要直接是面板，不是信息页')
    assert.ok(panel.includes('二次精修'), '面板要有二次精修区块')
    assert.ok(panel.includes('/public/panel.css'), '骨架要引用拆出去的样式表')
    assert.ok(panel.includes('/public/app.js'), '骨架要引用拆出去的脚本')
    assert.ok(Buffer.byteLength(panel) < 12288, 'panel.html 只留骨架，必须小于 12KB')

    // 拆出去的静态资源：200 + 正确 MIME + no-cache + 强 ETag（内容确实搬过去了）
    const cssRes = await fetch(url + '/public/panel.css')
    assert.equal(cssRes.status, 200)
    assert.match(cssRes.headers.get('content-type') ?? '', /text\/css/)
    assert.equal(cssRes.headers.get('cache-control'), 'no-cache', '静态资源要可协商缓存，不能 no-store')
    const cssEtag = String(cssRes.headers.get('etag'))
    assert.match(cssEtag, /^"[0-9a-f]+-[0-9a-f]+"$/, 'ETag 要是 size-mtime 的强校验值')
    assert.ok((await cssRes.text()).includes('--brand'), '样式表要有主题变量')

    // 带 If-None-Match 再来一次：304 + 空 body，仍然带 ETag / no-cache（否则浏览器下回又整份重下）
    const revalidated = await fetch(url + '/public/panel.css', { headers: { 'if-none-match': cssEtag } })
    assert.equal(revalidated.status, 304)
    assert.equal(await revalidated.text(), '')
    assert.equal(revalidated.headers.get('etag'), cssEtag, '304 也要回 ETag')
    assert.equal(revalidated.headers.get('cache-control'), 'no-cache')

    // 文件动了（哪怕只是 mtime），ETag 必须跟着变，否则用户改完刷新还是旧脚本
    const cssFile = path.join(here, '..', 'server', 'public', 'panel.css')
    const cssStat = statSync(cssFile)
    utimesSync(cssFile, cssStat.atime, new Date(cssStat.mtimeMs + 2000))
    const touched = await fetch(url + '/public/panel.css')
    assert.equal(touched.status, 200)
    assert.notEqual(touched.headers.get('etag'), cssEtag, 'mtime 变了 ETag 要变')
    utimesSync(cssFile, cssStat.atime, cssStat.mtime)

    // 反例：HTML 页面与接口数据仍是不许缓存的（别把上面那条顺手改成全局 no-cache）
    assert.equal(rootRes.headers.get('cache-control'), 'no-store', 'HTML 页面必须 no-store')
    const apiRes = await fetch(url + '/tagger/api/health')
    assert.equal(apiRes.headers.get('cache-control'), 'no-store', '接口数据必须 no-store')

    // 面板脚本按职责拆成六个文件（外加 i18n），逐文件读回来再断言（原来都塞在 app.js 里）
    const publicFiles = ['/public/api.js', '/public/i18n.js', '/public/state.js', '/public/render.js', '/public/settings.js', '/public/history.js', '/public/app.js']
    /** @type {Record<string, string>} */
    const src = {}
    for (const p of publicFiles) {
      const res = await fetch(url + p)
      assert.equal(res.status, 200, p + ' 要能取到')
      assert.match(res.headers.get('content-type') ?? '', /javascript/, p + ' 要按 JS 提供')
      src[p] = await res.text()
    }
    const appJs = src['/public/app.js']
    const renderJs = src['/public/render.js']
    const settingsJs = src['/public/settings.js']
    const historyJs = src['/public/history.js']
    const stateJs = src['/public/state.js']
    const apiJs = src['/public/api.js']
    const i18nJs = src['/public/i18n.js']

    // app.js 只做编排：三个动作 + boot，渲染/设置/预览都各自成文件
    assert.ok(appJs.includes('doRefine'), '精修动作留在 app.js')
    assert.ok(appJs.includes('doForge') && appJs.includes('doRun'), '三个动作都在 app.js')
    assert.ok(appJs.includes('bootInner'), 'boot 编排在 app.js')
    assert.ok(appJs.includes('loadUi()'), 'boot 要把上次的参数读回来')
    // boot 只该打 /state 一个状态接口，不再分别打 /workflows、/config、/comfy
    assert.ok(appJs.includes('api("/state")'), 'boot 要打 /state')
    // /comfy 只有用户点「探活」时才打，可以留；/workflows 完全该由 /state 提供，不许再有
    for (const p of publicFiles) {
      assert.equal(src[p].includes('api("/workflows")'), false, p + ' 不许再单独打 /workflows')
    }
    // boot 里必须真的调一次 loadUi，reloadState 里也要有（曾经就是漏了 boot 那一行）
    const loadUiCalls = (appJs + settingsJs + historyJs).split('loadUi()').length - 1
    assert.ok(loadUiCalls >= 2, 'boot 与 reloadState 都要调用 loadUi()')

    // 渲染层：结果卡 + 状态灯 + 错误码表（表里只放「码 → 字典键」，人话在 locale 里）
    assert.ok(renderJs.includes('renderResult'), 'renderResult 在 render.js')
    assert.ok(renderJs.includes('setLamp'), '状态灯在 render.js')
    assert.ok(renderJs.includes('ERR_TEXT'), 'render.js 要有错误码表')
    assert.ok(renderJs.includes('"bad-type": "err.bad-type"'), 'bad-type 要映射到字典键')
    assert.ok(renderJs.includes('"no-launch-dir": "err.no-launch-dir"'), 'no-launch-dir 要映射到字典键')

    // 设置层：/state 之后回填表单，工作流换成 CN 强度联动
    assert.ok(settingsJs.includes('api("/state")'), 'reloadState 在 settings.js')
    assert.ok(settingsJs.includes('fillWorkflows') && settingsJs.includes('applyCnStrength'), '工作流与 CN 强度在 settings.js')

    // 历史/预览层：参数记忆与轮询
    assert.ok(historyJs.includes('localStorage.setItem(LS_KEY'), '要记住出图参数')
    assert.ok(historyJs.includes('function loadUi'), '启动时要把上次的参数读回来')
    assert.ok(historyJs.includes('pollJob'), '出图轮询在 history.js')

    // 表单层：state.js 只读 DOM 默认值，不再自己抄一份 1200/1800/30；配置默认值走 applyUiDefaults
    assert.ok(stateJs.includes('positiveText'), 'state.js 要带表单读写')
    assert.ok(stateJs.includes('applyUiDefaults'), '配置里的默认值要用 applyUiDefaults 回填')
    assert.ok(stateJs.includes('fieldNum') && stateJs.includes('defaultValue'), '空输入要回落到 defaultValue 与 DEFAULT_VARS')

    // 出图变量的兜底只允许有一处：state.js 的 DEFAULT_VARS 单张常量表（别处不许再抄 1200/1800/30）
    const table = /var DEFAULT_VARS = \{([^}]*)\}/.exec(stateJs)
    assert.ok(table !== null, 'state.js 要有唯一的 DEFAULT_VARS 常量表')
    /** @type {Record<string, string>} */
    const fallback = {}
    for (const hit of table[1].matchAll(/([a-zA-Z]+)\s*:\s*([0-9.]+)/g)) fallback[hit[1]] = hit[2]
    assert.deepEqual(Object.keys(fallback).sort(), ['cfg', 'height', 'seed', 'steps', 'width'], '兜底表要覆盖全部出图变量')
    // 表里的值必须与 panel.html 上同名 input 的 value 一致（HTML 是 defaultValue，两边漂移会互相打脸）
    for (const key of Object.keys(fallback)) {
      const htmlVal = new RegExp('id="' + key + '"[^>]*value="([^"]+)"').exec(panel)
      assert.ok(htmlVal !== null, 'panel.html 的 ' + key + ' 要有 value')
      assert.equal(Number(htmlVal[1]), Number(fallback[key]), 'panel.html 与 DEFAULT_VARS 的 ' + key + ' 必须一致')
    }
    // 除了这张表，任何 public 脚本里都不许再出现这几个字面量默认值
    for (const literal of ['1200', '1800', '20261108', '5.03']) {
      const owners = publicFiles.filter(p => src[p].includes(literal))
      assert.deepEqual(owners, ['/public/state.js'], literal + ' 只许出现在 state.js 的 DEFAULT_VARS 里，实际：' + owners.join(', '))
    }

    // DEFAULT_VARS 与 lib/config.js 的 DEFAULTS 同源：有配置的字段一律不在这里另立一份，靠注释锚点对齐键名
    assert.ok(stateJs.includes('DEFAULTS-SOURCE: lib/config.js DEFAULTS'), 'state.js 要标注兜底的来源')
    const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj)
    for (const key of ['tags.maxTags', 'refine.mode', 'purge.level', 'comfy.baseUrl']) {
      assert.notEqual(pick(DEFAULTS, key), undefined, 'lib/config.js DEFAULTS 里要有 ' + key)
      assert.ok(stateJs.includes(key), '锚点要把 ' + key + ' 记为「以 config 为准」')
    }
    // 这几个键不许被抄成前端常量：值只能来自 /state 的 config（maxTags 走 applyUiDefaults，档位走 setLamp）
    assert.equal(/maxTags\s*:\s*40/.test(stateJs), false, 'maxTags 的 40 只能来自 DEFAULTS / config')
    assert.equal(/mode\s*:\s*["']add["']/.test(stateJs), false, 'refine.mode 只能来自 DEFAULTS / config')

    assert.ok(apiJs.includes('"/tagger/api"'), '面板要打到自己这个前缀上')

    // 界面文案一律走字典：public 脚本去掉注释后不许再有中文字符（唯一例外是 i18n.js 里的内置字典）
    for (const p of publicFiles) {
      if (p === '/public/i18n.js') continue
      // 先统一换行再剥注释：CI 的 Windows 检出可能是 CRLF，而 `//.*$` 里的 `.` 不吃 `\r`，
      // 会在行尾留一个 \r 让 `$` 失配 —— 注释整行剥不掉、假报「硬编码中文」。
      const code = src[p]
        .split(/\r?\n/)
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
        .join('\n')
      assert.equal(/[\u4e00-\u9fff]/.test(code), false, p + ' 的文案要走 T()，不许硬编码中文')
    }

    // 字典本身：中英 key 必须完全一致，脚本里用到的每个 key 两边都要有
    const localeDir = path.join(here, '..', 'locale')
    const zhDict = JSON.parse(readFileSync(path.join(localeDir, 'zh.json'), 'utf8'))
    const enDict = JSON.parse(readFileSync(path.join(localeDir, 'en.json'), 'utf8'))
    assert.deepEqual(Object.keys(zhDict).sort(), Object.keys(enDict).sort(), 'locale/zh.json 与 locale/en.json 的 key 必须完全一致')
    const usedKeys = new Set()
    for (const p of publicFiles) for (const hit of src[p].matchAll(/T\("([^"]+)"/g)) usedKeys.add(hit[1])
    assert.ok(usedKeys.size > 50, '桌面端文案要真从字典取，实际只用到 ' + usedKeys.size + ' 个 key')
    for (const key of usedKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(zhDict, key), true, key + ' 要在 locale/zh.json 里')
      assert.equal(Object.prototype.hasOwnProperty.call(enDict, key), true, key + ' 要在 locale/en.json 里')
    }
    // 错误码表里的每个 err.* 键都得在字典里有对应人话（不许出现裸键）
    const errKeys = Array.from(renderJs.matchAll(/"([a-z0-9-]+)": "(err\.[a-z0-9-]+)"/g), hit => hit[2])
    assert.ok(errKeys.length >= 20, '错误码表太小，实际 ' + errKeys.length + ' 条')
    for (const key of errKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(zhDict, key), true, '错误码 ' + key + ' 要在 locale/zh.json 里')
      assert.equal(Object.prototype.hasOwnProperty.call(enDict, key), true, '错误码 ' + key + ' 要在 locale/en.json 里')
    }

    // i18n 装配：T + 静态骨架重写 + 语言选择 + 切换后重渲染
    assert.ok(i18nJs.includes('I18N_KEY') && i18nJs.includes('function T('), 'i18n.js 要提供 T 与语言记忆')
    assert.ok(i18nJs.includes('"/locale?lang='), '字典要从 GET /locale 拿')
    assert.ok(i18nJs.includes('i18nApplyStatic') && i18nJs.includes('i18nStart'), '静态骨架要能跟着语言重写')
    assert.ok(panel.includes('<select id="lang"'), '面板要有语言选择')
    assert.ok(appJs.includes('i18nSetLang'), '换语言要真的切字典并重渲染')

    // 模型档案（质量词 / 词序）：面板要有下拉与说明行，脚本要真去取清单并落配置，文案全走 ui.profile.*
    assert.ok(panel.includes('<select id="model-profile"'), '面板要有模型档案下拉')
    assert.ok(panel.includes('id="profile-status"'), '档案说明行要有落脚点')
    assert.ok(panel.includes('id="level"'), '破甲档下拉不许被档案块挤掉')
    assert.ok(settingsJs.includes('function fillProfiles('), '档案下拉由 settings.js 填')
    assert.ok(settingsJs.includes('async function loadProfiles('), '要能取 GET /profiles')
    assert.ok(settingsJs.includes('async function changeProfile('), '切档要真的写配置')
    assert.ok(settingsJs.includes('function renderProfileStatus('), '生效值说明要能重画')
    assert.ok(settingsJs.includes('function mergeProfileState('), '服务端只回 id 时要能补齐质量词')
    assert.ok(appJs.includes('await loadProfiles()'), 'boot 要拉一次档案清单')
    assert.ok(appJs.includes('"model-profile"') && appJs.includes('changeProfile'), '下拉 change 要绑到 changeProfile')
    assert.ok(appJs.indexOf('await loadProfiles()') > appJs.indexOf('fillSettings(s.config)'), '档案清单要在配置回填之后拉（切档才算得出说明）')
    assert.ok(i18nJs.includes('"sel": "#model-profile"'), '档案标签要跟着语言走')
    for (const key of ['ui.profile.label', 'ui.profile.saved', 'ui.profile.failed', 'ui.profile.none', 'ui.profile.orderOn', 'ui.profile.orderOff', 'ui.profile.custom', 'ui.profile.quality']) {
      assert.equal(Object.prototype.hasOwnProperty.call(zhDict, key), true, key + ' 要在 locale/zh.json 里')
      assert.equal(Object.prototype.hasOwnProperty.call(enDict, key), true, key + ' 要在 locale/en.json 里')
    }
    // 内置字典是 /locale 缺席时的兜底：新键也得在，否则离线时说明行变裸键
    assert.ok(i18nJs.includes('"ui.profile.saved"'), '内置 zh 字典也要有 ui.profile.saved')
    assert.ok(Buffer.byteLength(panel) < 12288, '加了档案块，panel.html 仍然只留骨架（上限 12KB）')

    // GET /locale 由主服务提供，形状固定；前端在它缺席时降级到内置 zh（i18n.js 的 I18N_BUILTIN_ZH）
    const localeRes = await fetch(url + '/tagger/api/locale?lang=zh')
    assert.equal(localeRes.status, 200, '/locale 要由 /tagger/api 主线提供')
    assert.equal(localeRes.headers.get('cache-control'), 'no-store', '接口数据必须 no-store')
    const localeBody = await localeRes.json()
    assert.equal(localeBody.ok, true)
    assert.equal(localeBody.locale, 'zh')
    assert.deepEqual(localeBody.langs, ['zh', 'en'])
    assert.equal(typeof localeBody.dict, 'object')
    assert.deepEqual(Object.keys(localeBody.dict).sort(), Object.keys(zhDict).sort(), '/locale 与 locale/zh.json 必须同源')
    const enRes = await (await fetch(url + '/tagger/api/locale?lang=en')).json()
    assert.equal(enRes.locale, 'en')
    assert.equal(enRes.dict['ui.common.copy'], enDict['ui.common.copy'], '?lang=en 要回英文那份')
    const fallbackLang = await (await fetch(url + '/tagger/api/locale?lang=fr')).json()
    assert.equal(fallbackLang.locale, 'zh', '非法 lang 退回 zh')

    // 面板骨架必须按依赖顺序加载：api → i18n → state → render/settings/history → app（app.js 最后）
    const order = ['/public/api.js', '/public/i18n.js', '/public/state.js', '/public/render.js', '/public/settings.js', '/public/history.js', '/public/app.js'].map(p => panel.indexOf(p))
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i - 1] >= 0 && order[i - 1] < order[i], 'panel.html 里脚本顺序必须是 api → i18n → state → render/settings/history → app')
    }
    assert.ok(panel.lastIndexOf('<script') === panel.lastIndexOf('/public/app.js') - '<script src="'.length, 'app.js 必须是最后一个脚本')

    // 路径穿越：/public 下只放行普通文件，任何 '..' 都必须被挡（400 / 404 都算挡住）
    const port = new URL(url).port
    for (const evil of [
      '/public/../index.js',
      '/public/../lib/config.js',
      '/public/%2e%2e/index.js',
      '/public/sub/../../index.js',
      '/public/..%5cindex.js',
    ]) {
      const raw = await rawRequest(port, evil)
      assert.ok(raw.status === 400 || raw.status === 404, evil + ' 必须被挡下，实际 ' + raw.status)
      assert.equal(JSON.parse(raw.body).ok, false, evil + ' 要回结构化 JSON')
      assert.equal(raw.body.includes('createRuntime'), false, evil + ' 不能漏出源码')
    }
    // 不存在的资源、不在白名单里的扩展名，同样是结构化 404
    for (const miss of ['/public/nope.css', '/public/panel.html', '/public/shims.mjs']) {
      const res = await fetch(url + miss)
      assert.equal(res.status, 404, miss + ' 应该 404')
      assert.equal((await res.json()).ok, false)
    }

    const panelAlias = await fetch(url + '/panel')
    assert.equal(panelAlias.status, 200)
    assert.equal(await panelAlias.text(), panel, '/panel 与 / 必须是同一份面板')

    // 信息页挪到 /about，仍然保留健康状态与接口清单
    const aboutRes = await fetch(url + '/about')
    assert.equal(aboutRes.status, 200)
    const html = await aboutRes.text()
    assert.ok(html.includes('DSh Tagger'))
    assert.ok(html.includes('/tagger/api/health'))
    assert.ok(html.includes('/tagger/api/mcp'))

    // 旧前缀要跟 DSH 宿主里保持一致，老脚本不用改地址
    const legacyRes = await fetch(url + '/prompt-forge/api/health')
    assert.equal(legacyRes.status, 200)
    const legacy = await legacyRes.json()
    assert.equal(legacy.plugin, 'dsh-tagger')

    // 没有的路径仍然是结构化的 404，不是裸崩
    const missing = await fetch(url + '/tagger/api/nope')
    assert.equal(missing.status, 404)
    const missingBody = await missing.json()
    assert.equal(missingBody.ok, false)
    assert.equal(missingBody.error, 'unknown-route')
  } finally {
    await stop(child)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('standalone：--help 打印用法后退出 0，不占端口', { timeout: 30000 }, async () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const child = spawnStandalone(['--help'], env)
  let output = ''
  child.stdout.on('data', chunk => {
    output += String(chunk)
  })
  const code = await waitExit(child, 15000)
  assert.equal(code, 0)
  assert.ok(output.includes('--port'))
  assert.ok(output.includes('DSH_TAGGER_BASE_URL'))
})

test('standalone：面板能填接口与 ComfyUI，保存后立刻生效（不用重启）', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-standalone-'))
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL

  // 一个假模型服务：/v1/models 列一个模型，用来验证 /llm/probe 真能连通
  const stub = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: "stub-model" }] }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve()))
  const stubUrl = 'http://127.0.0.1:' + portOf(stub)

  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)
    const panel = await (await fetch(url + '/panel')).text()
    for (const id of ['接口设置', 'llm-baseurl', 'llm-key', 'llm-model', 'comfy-baseurl', 'comfy-dir', 'comfy-python', 'comfy-workflows', 'comfy-default', '测试连接', '启动 ComfyUI']) {
      assert.ok(panel.includes(id), '面板要能填 ' + id)
    }

    // 初始：没配 key，且 /config 里绝不出现明文 key
    const before = await (await fetch(url + '/tagger/api/config')).json()
    assert.equal(before.config.llm.apiKeySet, false)
    assert.equal(Object.prototype.hasOwnProperty.call(before.config.llm, 'apiKey'), false)

    // 面板保存接口 → settings.json → 下一次请求就用新值（standalone 不重启）
    const saved = await fetch(url + '/tagger/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { llm: { baseUrl: stubUrl + '/v1', apiKey: 'sk-standalone-test', model: 'stub-model' } } }),
    })
    const savedBody = await saved.json()
    assert.equal(savedBody.config.llm.apiKeySet, true)
    assert.equal(savedBody.config.llm.apiKeyHint, '…test')
    assert.equal(JSON.stringify(savedBody).includes('sk-standalone-test'), false, '配置视图不能漏明文 key')

    const health = await (await fetch(url + '/tagger/api/health')).json()
    assert.equal(health.llmReady, true, '保存接口后 health 立刻就该说 ready')
    assert.equal(health.llm.endpoint, stubUrl + '/v1/chat/completions')
    assert.equal(health.llm.model, 'stub-model')
    // 面板存的值就是 settings 层来的：llm.source 要能说清楚（面板改完没生效，一般是 env/cli 盖住了）
    assert.deepEqual(health.llm.source, { baseUrl: 'settings', apiKey: 'settings', model: 'settings' })

    // 测试连接：拿面板填的地址与 key 打 /models
    const probe = await fetch(url + '/tagger/api/llm/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: stubUrl, apiKey: 'sk-standalone-test' }),
    })
    assert.equal(probe.status, 200)
    const probeBody = await probe.json()
    assert.equal(probeBody.ok, true)
    assert.deepEqual(probeBody.models, ['stub-model'])
    assert.equal(probeBody.endpoint, stubUrl + '/v1/models')

    // 面板字段留空时用「已经保存的」配置去探活：测试连接不该逼用户重敲 key
    const fallback = await fetch(url + '/tagger/api/llm/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: '', apiKey: '' }),
    })
    assert.equal(fallback.status, 200)
    assert.deepEqual((await fallback.json()).models, ['stub-model'])

    // ComfyUI 设置同样能存能回读（这里只验证落配置，不真连）
    const comfySaved = await fetch(url + '/tagger/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { comfy: { baseUrl: 'http://127.0.0.1:9', launchDir: 'D:/tmp/comfy', pythonPath: 'D:/tmp/comfy/python/python.exe', defaultWorkflowId: 'stub-wf' } } }),
    })
    const comfyCfg = (await comfySaved.json()).config.comfy
    assert.equal(comfyCfg.baseUrl, 'http://127.0.0.1:9')
    assert.equal(comfyCfg.launchDir, 'D:/tmp/comfy')
    assert.equal(comfyCfg.defaultWorkflowId, 'stub-wf')
  } finally {
    await stop(child)
    await new Promise(resolve => stub.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('standalone：/public 拒软链逃逸，If-None-Match 认弱校验与多值', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-static-'))
  const secretDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-secret-'))
  const secretFile = path.join(secretDir, 'secret.css')
  await writeFile(secretFile, 'body { color: #SECRETLEAK }', 'utf8')
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL
  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  // 软链必须落在 public 里才测得出逃逸（解析器只认这个目录），测完删掉
  const linkName = '__escape-' + Date.now().toString(36) + '.css'
  const linkPath = path.join(here, '..', 'server', 'public', linkName)
  /** @type {string[]} 测试期间在 public 里造的链接，收尾一律拆掉 */
  const escapeRoot = []
  try {
    const url = await waitForReady(child)
    const port = Number(new URL(url).port)

    const first = await rawRequest(port, '/public/panel.css')
    assert.equal(first.status, 200)
    const etag = String(first.headers.etag)
    assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/)
    assert.ok(first.body.length > 0)

    // 弱校验：W/ 前缀只表示强弱，内容没变就得 304
    const weak = await rawRequest(port, '/public/panel.css', { 'if-none-match': 'W/' + etag })
    assert.equal(weak.status, 304, 'W/ 前缀也要命中')
    assert.equal(weak.body, '')

    // 多值：浏览器与代理会一次带好几条，命中任意一条都算
    const multi = await rawRequest(port, '/public/panel.css', { 'if-none-match': '"stale-0", ' + etag + ', "stale-1"' })
    assert.equal(multi.status, 304, '多值里有一条命中就 304')

    // 通配
    const star = await rawRequest(port, '/public/panel.css', { 'if-none-match': '*' })
    assert.equal(star.status, 304, '星号表示任何版本都新鲜')

    // 都不匹配：老实回内容，别乱 304
    const miss = await rawRequest(port, '/public/panel.css', { 'if-none-match': '"stale-0"' })
    assert.equal(miss.status, 200)
    assert.match(String(miss.headers['content-type']), /text\/css/)
    assert.ok(miss.body.includes('--brand'))

    // 软链逃逸：public 里放个指向外部文件的链接，必须当「没有」，更不许把目标内容吐出去
    let escapePath = ''
    try {
      await symlink(secretFile, linkPath, 'file')
      escapeRoot.push(linkPath)
      escapePath = '/public/' + linkName
      t.diagnostic('逃逸用例：用文件软链')
    } catch {
      // Windows 没开开发者模式时文件软链要管理员权限：退一级用 junction（目录级，普通账号能建）
      const linkDir = path.join(here, '..', 'server', 'public', '__escape-dir-' + Date.now().toString(36))
      try {
        await symlink(secretDir, linkDir, 'junction')
        escapeRoot.push(linkDir)
        escapePath = '/public/' + path.basename(linkDir) + '/secret.css'
        t.diagnostic('逃逸用例：用目录 junction')
      } catch (error) {
        t.diagnostic('本机建不了软链 / junction（' + String(error?.code) + '），跳过逃逸用例')
      }
    }
    if (escapePath !== '') {
      const escape = await rawRequest(port, escapePath)
      assert.equal(escape.status, 404, '指向 public 外的软链一律 404')
      assert.equal(escape.body.includes('SECRETLEAK'), false, '软链目标的内容绝不能吐出去')
    }
  } finally {
    for (const link of escapeRoot) {
      await unlink(link).catch(() => {})
      await rm(link, { recursive: false, force: true }).catch(() => {})
    }
    await rm(dataDir, { recursive: true, force: true })
    await rm(secretDir, { recursive: true, force: true })
    await stop(child)
  }
})

test('standalone：未知参数告警不拦启动，health.version 跟 package.json 一致', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-meta-'))
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env,
    DSH_TAGGER_DATA: dataDir,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_TAGGER_BASE_URL: 'http://127.0.0.1:9/v1',
    DSH_TAGGER_MODEL: 'env-model',
  }
  delete env.DSH_TAGGER_API_KEY
  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir, '--not-a-flag'], env)
  let log = ''
  child.stdout.on('data', chunk => {
    log += String(chunk)
  })
  child.stderr.on('data', chunk => {
    log += String(chunk)
  })
  try {
    const url = await waitForReady(child)
    const health = await (await fetch(url + '/tagger/api/health')).json()
    assert.equal(health.version, pkg.version, 'version 必须来自根 package.json，不许硬编码')
    // 字段来源要如实：baseUrl / model 来自环境变量，key 谁都没给
    assert.deepEqual(health.llm.source, { baseUrl: 'env', apiKey: 'none', model: 'env' })
    assert.equal(health.llmReady, false, '只有地址没有 key，仍然不算就绪')
  } finally {
    await stop(child)
    await rm(dataDir, { recursive: true, force: true })
  }
  assert.ok(log.includes('未知参数：--not-a-flag'), '白名单外的参数要告警，不许静默吞掉')
  const warnAt = log.indexOf('未知参数：')
  // 告警要在服务就绪前就出现（不是等到退出才补一句）；真 node 下再要求它早于 shutdown 日志
  assert.ok(warnAt >= 0 && warnAt < log.indexOf('STANDALONE_READY'), '告警要在启动阶段就出现')
  const shutAt = log.indexOf('关闭服务')
  if (shutAt >= 0) assert.ok(shutAt > warnAt, '告警要出现在 shutdown 之前')
})

test('面板：模型档案下拉（#model-profile）取清单、说明生效值、切档落 config', async () => {
  const root = path.join(here, '..')
  const zhDict = JSON.parse(readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'))
  const source = readFileSync(path.join(root, 'server', 'public', 'settings.js'), 'utf8')
  /** 假 select：只要 option 列表 / value / disabled 三样，够覆盖下拉逻辑。 */
  const makeSelect = () => ({
    id: 'model-profile',
    value: '',
    disabled: false,
    children: [],
    set innerHTML(v) { if (v === '') this.children = [] },
    get innerHTML() { return '' },
    appendChild(node) { this.children.push(node) },
  })
  const select = makeSelect()
  const statusSpan = { id: 'profile-status', className: 'hint', textContent: '' }
  const els = { 'model-profile': select, 'profile-status': statusSpan }
  const calls = []
  const statuses = []
  const sandbox = {
    state: {},
    document: { createElement: tag => ({ tagName: tag, value: '', textContent: '' }) },
    $: id => els[id] ?? null,
    // 真字典渲染：{name} 占位替换，断言看到的就是用户看到的那句话
    T: (key, vars) => {
      assert.equal(typeof zhDict[key], 'string', key + ' 要在 locale/zh.json 里')
      const text = zhDict[key]
      if (typeof vars !== 'object' || vars === null) return text
      return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole))
    },
    api: async (p, init) => { calls.push({ path: p, init }); return sandbox.__next },
    errText: () => 'E',
    setStatus: (id, text, bad) => statuses.push({ id, text, bad }),
    fillSettings: config => statuses.push({ id: 'fillSettings', config }),
  }
  sandbox.__next = { status: 200, data: { ok: true } }
  vm.runInNewContext(source, sandbox)

  const list = [
    { id: 'tag', title: 'Tag', quality: true, qualityTags: ['masterpiece', 'best_quality', 'highres'], order: true },
    { id: 'pony', title: 'Pony', quality: true, qualityTags: ['score_9', 'score_8_up'], order: true },
    { id: 'natural', title: 'Natural', quality: false, qualityTags: [], order: false },
    { id: 'custom', title: 'Custom', quality: null, qualityTags: null, order: null },
  ]

  // ① 填下拉：顺序照服务端，当前档选中；空清单时不许把下拉清成空白
  sandbox.fillProfiles(list, { id: 'pony' })
  assert.deepEqual(select.children.map(o => o.value), ['tag', 'pony', 'natural', 'custom'])
  assert.deepEqual(select.children.map(o => o.textContent), ['Tag', 'Pony', 'Natural', 'Custom'])
  assert.equal(select.value, 'pony', '当前档要选中')
  sandbox.fillProfiles([], { id: 'tag' })
  assert.equal(select.children.length, 0, '清单为空时下拉留空，别崩')
  sandbox.fillProfiles(list, { id: 'nope' })
  assert.deepEqual(select.children.map(o => o.value), ['tag', 'pony', 'natural', 'custom'], '不存在的当前档不能把列表清空')

  // ② 说明行：只回 id 时用清单补齐质量词；natural 明确「不补质量词」；词序按档给话
  select.value = 'pony'
  const ponyText = sandbox.renderProfileStatus({ id: 'pony' })
  assert.ok(ponyText.includes('score_9'), '生效质量词要露出来：' + ponyText)
  assert.ok(ponyText.includes(zhDict['ui.profile.orderOn']), 'pony 要按分段重排')
  assert.equal(statusSpan.textContent, ponyText, '说明行要真的写进 #profile-status')
  assert.deepEqual(sandbox.state.profile, { id: 'pony' }, '生效值要记在 state.profile 上（换语言时重画用）')
  const naturalText = sandbox.renderProfileStatus({ id: 'natural' })
  assert.ok(naturalText.includes(zhDict['ui.profile.none']), 'natural 不补质量词：' + naturalText)
  assert.ok(naturalText.includes(zhDict['ui.profile.orderOff']), 'natural 保留模型顺序')
  assert.equal(naturalText.includes(zhDict['ui.profile.custom']), false, '非自定义档不点配置')
  const customText = sandbox.renderProfileStatus({ id: 'custom' })
  assert.ok(customText.includes(zhDict['ui.profile.custom']), '自定义档要提示读配置')
  // 服务端给了完整字段时以服务端为准（不被清单覆盖）
  const fromServer = sandbox.renderProfileStatus({ id: 'pony', quality: true, qualityTags: ['score_9'], order: false })
  assert.ok(fromServer.includes(zhDict['ui.profile.orderOff']), '服务端说 order=false 就按 false 显示')
  assert.ok(fromServer.includes('score_9'), '服务端给了质量词就用它：' + fromServer)
  assert.equal(fromServer.includes('score_8_up'), false, '服务端给了完整字段就不许再拿清单的拼进来')

  // ③ GET /profiles：一次拿清单 + 当前档，失败静默（不抛、不把面板搞挂）
  select.children = []
  sandbox.__next = { status: 200, data: { ok: true, profiles: list, current: { id: 'natural' } } }
  await sandbox.loadProfiles()
  assert.equal(calls[0].path, '/profiles')
  assert.deepEqual(select.children.map(o => o.value), ['tag', 'pony', 'natural', 'custom'])
  assert.equal(select.value, 'natural', '当前档要选中')
  assert.ok(statusSpan.textContent.includes(zhDict['ui.profile.none']), '说明行跟着当前档')
  const beforeFail = calls.length
  sandbox.__next = { status: 500, data: { ok: false, error: 'internal' } }
  await sandbox.loadProfiles()
  assert.equal(calls.length, beforeFail + 1)
  assert.equal(select.value, 'natural', '取清单失败不许动当前选择')
  // 宿主只回 config 里的 profile id（没有清单）时，也要把当前档显示出来
  sandbox.__next = { status: 200, data: { ok: true, profile: 'pony' } }
  await sandbox.loadProfiles()
  assert.deepEqual(select.children.map(o => o.value), ['pony'], '没有清单就退回当前档')
  assert.equal(select.value, 'pony')

  // ④ 切档：POST /config 只带 forge.profile；成功按服务端回的生效值刷新，失败红字且放开下拉
  // （先把完整清单装回去：上一段只回 profile id 的兜底会把清单换成一条占位）
  sandbox.fillProfiles(list, { id: 'pony' })
  select.value = 'pony'
  // /config 的真实回包只有 { ok, config }（没有生效值），说明行得靠清单补齐
  sandbox.__next = { status: 200, data: { ok: true, config: { forge: { profile: 'pony' } } } }
  await sandbox.changeProfile()
  const post = calls[calls.length - 1]
  assert.equal(post.path, '/config')
  assert.equal(post.init.method, 'POST')
  assert.deepEqual(JSON.parse(post.init.body), { patch: { forge: { profile: 'pony' } } }, '只改 forge.profile，别顺手整份写回')
  assert.ok(statusSpan.textContent.startsWith(zhDict['ui.profile.saved']), '成功要写「已保存」：' + statusSpan.textContent)
  assert.ok(statusSpan.textContent.includes('score_9'), '保存后说明行按新档重画')
  assert.ok(statuses.some(s => s.id === 'fillSettings' && s.config && s.config.forge), '配置回包要回填表单')
  assert.equal(select.disabled, false, '成功也要把下拉放开')

  select.value = 'natural'
  sandbox.__next = { status: 502, data: { ok: false, message: 'boom' } }
  await sandbox.changeProfile()
  const last = statuses[statuses.length - 1]
  assert.equal(last.id, 'profile-status')
  assert.equal(last.bad, true, '切档失败要红字')
  assert.ok(String(last.text).startsWith(zhDict['ui.profile.failed'].replace('{text}', '')), '失败文案：' + last.text)
  assert.equal(select.disabled, false, '失败后下拉必须放开，否则用户再也切不回来')

  // ⑤ 下拉被禁用时重复触发不重发请求（连点/按住不回滚配置）
  select.disabled = true
  const beforeBusy = calls.length
  await sandbox.changeProfile()
  assert.equal(calls.length, beforeBusy, '下拉禁用期间不重复提交')
})

test('姿势画廊：/gallery 是独立页，脚本样式齐全且一个外链都没有', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-tagger-gallery-'))
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL

  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)

    const page = await fetch(url + '/gallery')
    assert.equal(page.status, 200)
    assert.ok((page.headers.get('content-type') ?? '').includes('text/html'), '/gallery 要按 HTML 提供')
    assert.equal(page.headers.get('cache-control'), 'no-store', '画廊是页面，必须 no-store')
    const html = await page.text()
    assert.ok(html.includes('/public/gallery.js'), '画廊骨架要引用拆出去的脚本')
    assert.ok(html.includes('/public/gallery.css'), '画廊骨架要引用拆出去的样式')
    assert.ok(html.includes('动作姿势库'), '画廊 h1 是动作姿势库')
    assert.ok(html.includes('tag 版'), '要标明这是 tag 版（不跑 ControlNet）')
    for (const id of ['set-list', 'system-seg', 'count-badge', 'pills', 'q', 'category', 'angles', 'reset', 'grid', 'empty', 'more', 'dock', 'dock-chips', 'dock-copy', 'dock-fill', 'dock-clear']) {
      assert.ok(html.includes('id="' + id + '"'), '画廊骨架要有 #' + id)
    }
    assert.equal(html.includes('http://') || html.includes('https://'), false, '画廊不许引外部域名（字体 CDN 之类）')

    const jsRes = await fetch(url + '/public/gallery.js')
    assert.equal(jsRes.status, 200)
    assert.ok((jsRes.headers.get('content-type') ?? '').includes('javascript'), 'gallery.js 要按 JS 提供')
    const jsText = await jsRes.text()
    assert.equal(jsText.includes('http://') || jsText.includes('https://'), false, 'gallery.js 里不许出现外部地址')
    assert.ok(jsText.includes("'/pose-gallery?'"), '主路径是 /tagger/api/pose-gallery')
    assert.ok(jsText.includes("'/pose-tags?'"), 'tag 走 /tagger/api/pose-tags')
    assert.ok(jsText.includes("'/pose-thumb?id='"), '缩略图走 /pose-thumb')
    assert.ok(jsText.includes("'/poses?'"), '接口缺席时退回 /poses 分组（只做兜底）')
    assert.ok(jsText.includes('dsh-tagger:pending-prompt'), '填入面板要写面板认的 localStorage 键')

    const cssRes = await fetch(url + '/public/gallery.css')
    assert.equal(cssRes.status, 200)
    assert.ok((cssRes.headers.get('content-type') ?? '').includes('text/css'), 'gallery.css 要按 CSS 提供')
    const cssText = await cssRes.text()
    assert.ok(cssText.includes('repeat(auto-fill, minmax(196px, 1fr))'), '网格是 196px 自适应列')
    assert.ok(cssText.includes('prefers-color-scheme'), '深色/浅色都要照顾')
    assert.equal(cssText.includes('http://') || cssText.includes('https://'), false, '样式表不许引外部字体')

    // 和白名单里其它页面一样：直连 .html 要 404，只能走 /gallery
    const direct = await fetch(url + '/public/gallery.html')
    assert.equal(direct.status, 404)
    assert.equal((await direct.json()).ok, false)

    const head = await fetch(url + '/gallery', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.ok((head.headers.get('content-type') ?? '').includes('text/html'))
  } finally {
    await stop(child)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('姿势画廊收尾：侧栏无死链、关于/来源走页内弹层、计数带单位、文案不露接口名', () => {
  const html = readFileSync(path.join(here, '..', 'server', 'public', 'gallery.html'), 'utf8')
  const js = readFileSync(path.join(here, '..', 'server', 'public', 'gallery.js'), 'utf8')
  const css = readFileSync(path.join(here, '..', 'server', 'public', 'gallery.css'), 'utf8')

  assert.equal(html.includes('href="#tags"'), false, '词库总览是死链，这一轮整项删掉')
  assert.equal(html.includes('词库总览'), false, '死链连同文案一起删')
  assert.equal(html.includes('href="#about"') || html.includes('href="#source"'), false, '关于/来源不能再是空锚点')
  assert.ok(html.includes('data-about="0"') && html.includes('data-about="1"'), '关于/来源改成按钮触发页内弹层')
  assert.ok(html.includes('id="about-modal"'), '页内要有关于弹层')
  assert.ok(html.includes('role="dialog"') && html.includes('aria-modal="true"'), '弹层要有对话框语义')
  assert.ok(html.includes('id="about-source"'), '来源段落要能定位（点「来源」高亮它）')
  for (const text of ['ai-pose-gallery-zh', 'ギア', 'たき', 'Anhao', '18+', '禁止打包倒卖', 'ControlNet']) {
    assert.ok(html.includes(text), '关于弹层要写清 ' + text)
  }
  assert.ok(css.includes('.modal[hidden]'), '弹层隐藏要压过 display:grid')
  assert.ok(css.includes('body.modal-on'), '打开弹层要锁住背景滚动')

  assert.ok(js.includes('function openAbout(') && js.includes('function closeAbout('), '弹层要有开/关函数')
  assert.ok(js.includes("ev.key === 'Escape'") && js.includes('closeAbout()'), 'Esc 要能关弹层')
  assert.ok(js.includes("group.count + ' 视角'"), '卡片计数要带「视角」单位')
  assert.equal(/gcard-count[^\n]*String\(group\.count\)/.test(js), false, '不要再直接显示裸数字')
  assert.ok(js.includes('aria-keyshortcuts'), '卡片要提示可用 Enter/Space')
  assert.equal(js.includes('（/tagger/api/pose-tags）'), false, '降级文案不许把接口名端给用户')
  assert.equal(js.includes('正用 /poses'), false, '降级文案不许露 /poses')
})

test('面板：出图卡片带姿势画廊入口，骨架仍 <10KB 且原有 id 未丢', async () => {
  const html = readFileSync(path.join(here, '..', 'server', 'panel.html'), 'utf8')
  assert.ok(Buffer.byteLength(html) < 12288, '加完入口仍要小于 12KB，实际 ' + Buffer.byteLength(html))
  assert.ok(html.includes('href="/gallery"'), '入口要指向 /gallery')
  assert.ok(html.includes('target="_blank"'), '入口在新窗口打开')
  assert.ok(html.includes('rel="noopener"'), '新窗口要带 noopener')
  assert.ok(html.includes('姿势画廊'), '入口文案是姿势画廊')
  for (const id of ['text', 'forge', 'positive', 'copy-pair', 'copy-pos', 'refine-text', 'refine', 'refine-delta', 'workflow', 'run', 'images', 'level', 'save-level', 'model-profile', 'pose-btn', 'cnstrength']) {
    assert.ok(html.includes('id="' + id + '"'), '加入口不许弄丢 #' + id)
  }
  assert.ok(html.includes('/public/app.js'), '脚本引用还在')
  assert.ok(html.includes('/public/i18n.js'), 'i18n 引用还在')
})

test('三栏工作台：/studio 走白名单路由，骨架只引用本地样式脚本', async () => {
  const html = readFileSync(path.join(here, '..', 'server', 'public', 'studio.html'), 'utf8')

  assert.ok(Buffer.byteLength(html) < 16384, 'studio.html 只留骨架（<16KB），实际 ' + Buffer.byteLength(html))
  assert.ok(html.includes('/public/studio.css'), '要引用拆出去的样式')
  assert.ok(html.includes('/public/studio.js'), '要引用拆出去的脚本')
  for (const id of ['col-prompt', 'col-ref', 'col-gen', 'prompt', 'btn-forge', 'positive', 'chips', 'negative', 'tab-pose', 'tab-style', 'pose-grid', 'style-groups', 'workflow', 'btn-run', 'results', 'history', 'lightbox']) {
    assert.ok(html.includes('id="' + id + '"'), '三栏骨架要有 #' + id)
  }
  for (const text of ['提示词', '参考样式', '生成结果']) {
    assert.ok(html.includes(text), '三栏标题要写清 ' + text)
  }
  // 零外链 = 不引外部资源（脚本 / 样式 / 图片）；接口地址出现在设置抽屉的占位符里是允许的
  const remoteAssets = html.match(/(?:src|href)\s*=\s*"[^"]*https?:\/\//gi) ?? []
  assert.equal(remoteAssets.length, 0, '工作台不许引外部资源：' + remoteAssets.join(' '))
  assert.equal(/url\(\s*['"]?https?:\/\//i.test(html), false, '样式里不许用外部 url()')
  for (const id of ['settings', 'btn-settings', 'set-llm-base', 'set-llm-key', 'set-llm-model', 'set-comfy-base', 'set-comfy-dir', 'set-comfy-python', 'set-comfy-args']) {
    assert.ok(html.includes('id="' + id + '"'), '设置抽屉要有 #' + id)
  }

  const js = readStudioSources()
  // 工作台脚本里出现的地址只能是本机或已知的模型服务（设置预设用）
  const allowedHosts = ['127.0.0.1', 'localhost', 'api.deepseek.com', 'api.openai.com', 'api.siliconflow.cn', 'dashscope.aliyuncs.com', 'opencode.ai']
  const urlsInJs = js.match(/https?:\/\/[^\s'"\)\],;]+/g) ?? []
  for (const url of urlsInJs) {
    let host = ''
    try { host = new URL(url).hostname } catch { host = 'bad:' + url }
    assert.ok(allowedHosts.includes(host), 'studio.js 出现了未登记的地址：' + url)
  }
  assert.ok(js.includes('"/tagger/api"') || js.includes("'/tagger/api'"), '接口统一走 /tagger/api')
  for (const p of ['/forge', '/run', '/job?id=', '/pose-gallery?', '/styles', '/workflows', '/image?', '/pose-tags?']) {
    assert.ok(js.includes(p), 'studio.js 要用到 ' + p)
  }

  const css = readFileSync(path.join(here, '..', 'server', 'public', 'studio.css'), 'utf8')
  assert.ok(css.includes('grid-template-columns'), '三栏用 grid 布局')
  assert.ok(css.includes('prefers-color-scheme'), '深色/浅色都要照顾')
  assert.equal(css.includes('http://') || css.includes('https://'), false, '样式表不许引外部字体')

  // 白名单：/studio 是页面，/public/studio.html 只是静态资源
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-studio-'))
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, DSH_TAGGER_DATA: dataDir, ELECTRON_RUN_AS_NODE: '1' }
  delete env.DSH_TAGGER_API_KEY
  delete env.DSH_TAGGER_BASE_URL
  delete env.DSH_TAGGER_MODEL
  const child = spawnStandalone(['--port', '0', '--data-dir', dataDir], env)
  try {
    const url = await waitForReady(child)
    const page = await fetch(url + '/studio')
    assert.equal(page.status, 200)
    assert.ok((page.headers.get('content-type') ?? '').includes('text/html'), '/studio 要按 HTML 提供')
    assert.equal(page.headers.get('cache-control'), 'no-store', '页面必须 no-store')
    const served = await page.text()
    assert.ok(served.includes('/public/studio.js'), '/studio 要返回真正的 studio.html，不是信息页兜底')
    assert.ok(served.includes('id="col-ref"'), '三栏骨架要真的送出去')

    const post = await fetch(url + '/studio', { method: 'POST' })
    assert.equal(post.status, 405, '只读页面只认 GET/HEAD')
    assert.equal(post.headers.get('allow'), 'GET, HEAD')

    const head = await fetch(url + '/studio', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.ok((head.headers.get('content-type') ?? '').includes('text/html'))

    for (const [file, type] of [['studio.css', 'text/css'], ['studio.js', 'javascript']]) {
      const res = await fetch(url + '/public/' + file)
      assert.equal(res.status, 200)
      assert.ok((res.headers.get('content-type') ?? '').includes(type), file + ' 的 MIME 要对')
    }
  } finally {
    await stop(child)
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('三栏工作台：服装 / 人像参考库页签、底部 dock 与只读接口都在位', async () => {
  const html = readFileSync(path.join(here, '..', 'server', 'public', 'studio.html'), 'utf8')
  const js = readStudioSources()
  const css = readFileSync(path.join(here, '..', 'server', 'public', 'studio.css'), 'utf8')

  const order = ['tab-pose', 'tab-costume', 'tab-portrait', 'tab-style'].map(id => html.indexOf('id="' + id + '"'))
  assert.ok(order.every(index => index > 0), '页签要有 ' + order.join(','))
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, '页签顺序要是 姿势 → 服装 → 人像 → 样式')

  const ids = [
    'tab-costume-count', 'tab-portrait-count',
    'panel-costume', 'costume-q', 'costume-cats', 'ref-costume-grid', 'costume-empty', 'costume-empty-line', 'costume-more',
    'panel-portrait', 'portrait-q', 'portrait-sets', 'portrait-hairs', 'portrait-popular', 'ref-portrait-grid', 'portrait-empty', 'portrait-more',
    'ref-dock', 'ref-dock-thumb', 'ref-dock-name', 'ref-dock-meta', 'ref-dock-tags', 'ref-dock-note',
    'ref-dock-copy', 'ref-dock-fill', 'ref-dock-clear',
  ]
  for (const id of ids) assert.ok(html.includes('id="' + id + '"'), '参考库要有 #' + id)
  for (const id of ['costume', 'portrait']) {
    assert.ok(html.includes('aria-controls="panel-' + id + '"'), 'tab-' + id + ' 要指向 panel-' + id)
  }
  assert.ok(html.includes('aria-label="服装分类"'), '服装面板要留筛选槽位')
  assert.ok(html.includes('id="portrait-popular"') && html.includes('aria-pressed="false"'), '「只看热门」要是可切换按钮')
  assert.ok(/id="ref-dock"[^>]*hidden/.test(html), 'dock 默认收起')

  assert.ok(js.includes("const TABS = ['pose', 'costume', 'portrait', 'style']"), 'showTab 要认四页签')
  for (const p of ["'/refs?'", "'/ref-tags?'", 'loadRefs', 'pickRef', 'renderRefGrid', 'openDock', 'closeDock', 'fillDockTags']) {
    assert.ok(js.includes(p), 'studio.js 要有 ' + p)
  }
  assert.ok(js.includes('REF_PAGE'), '分页要有页长常量')
  assert.ok(js.includes('标签接口还没上线'), '标签接口 501 时要给降级文案')
  assert.ok(js.includes("loading: 'lazy'"), '缩略图要懒加载')
  assert.ok(js.includes("referrerpolicy: 'no-referrer'"), '图片不带来源')
  assert.ok(js.includes("showTab('costume')") && js.includes("showTab('portrait')"), '页签点击要切面板')
  assert.ok(js.includes('function refSrc'), '参考图路径要过 refSrc 补 API 前缀')
  assert.ok((js.match(/refSrc\(/g) ?? []).length >= 3, 'refSrc 要用在卡片与 dock 缩略图上')
  assert.ok(js.includes('Array.isArray(data.positive)'), '/ref-tags 要按 positive / negative 取值')

  for (const rule of ['.ref-grid', '.ref-grid-portrait', '.rcard-name-one', '.rcard-tag', '.rcard-hot', '.rdock', '.rdock-tag', '.tab-count']) {
    assert.ok(css.includes(rule), 'studio.css 要有 ' + rule)
  }
  assert.ok(css.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'), '服装卡四列')
  assert.ok(css.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), '人像卡三列起步')
  assert.ok(css.includes('.rcard .gcard-badge { right: auto; left: 5px; }'), '选中角标要让开右上「热门」')
  assert.ok(css.includes('.rcard .gcard-meta'), '卡片 meta 要截断，别把网格撑歪')
  assert.equal(css.includes('http://') || css.includes('https://'), false, '样式表不许引外部字体')
  const remote = html.match(/(?:src|href)\s*=\s*"[^"]*https?:\/\//gi) ?? []
  assert.equal(remote.length, 0, '参考库不许引外部资源：' + remote.join(' '))

  for (const id of ['panel-pose', 'panel-style', 'pose-grid', 'style-groups', 'settings', 'btn-settings']) {
    assert.ok(html.includes('id="' + id + '"'), '不许弄丢 #' + id)
  }
  for (const p of ['/pose-gallery?', '/pose-tags?', '/styles', '/forge', '/run']) {
    assert.ok(js.includes(p), '不许弄丢 ' + p)
  }
})

