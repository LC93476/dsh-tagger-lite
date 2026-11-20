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
import { readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'server', 'standalone.mjs')
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

    // 根路径 = 能直接用的锻造台面板；样式与脚本已拆到 /public，骨架只留引用
    const rootRes = await fetch(url + '/')
    assert.equal(rootRes.status, 200)
    assert.match(rootRes.headers.get('content-type') ?? '', /text\/html/)
    const panel = await rootRes.text()
    assert.ok(panel.includes('DSh Tagger'), '面板标题里要有产品名')
    assert.ok(panel.includes('锻造台'), '根路径要直接是面板，不是信息页')
    assert.ok(panel.includes('二次精修'), '面板要有二次精修区块')
    assert.ok(panel.includes('/public/panel.css'), '骨架要引用拆出去的样式表')
    assert.ok(panel.includes('/public/app.js'), '骨架要引用拆出去的脚本')
    assert.ok(Buffer.byteLength(panel) < 10240, 'panel.html 只留骨架，必须小于 10KB')

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
    const panel = await (await fetch(url + '/')).text()
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
