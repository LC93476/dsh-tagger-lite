#!/usr/bin/env node
// plan: DSh Tagger 的独立入口——不依赖 DSH 进程，纯 node 起 HTTP 服务（web 版 / 其它宿主的接入点）
/**
 * server/standalone.mjs — dsh-tagger 独立运行入口。
 *
 * 复用 lib/ 下的全部核心（标签索引、锻造、精修、ComfyUI、MCP），只把宿主的三件服务
 * （llm / webServer / tools）换成 server/shims.mjs 里的替身，然后用 createRuntime +
 * createHandlers + createDispatch 把 /tagger/api/* 整套接口挂到一个 node:http 服务上。
 *
 * 用法：
 *   node server/standalone.mjs --port 7789 --base-url https://api.example.com --api-key sk-xxx --model gpt-4o-mini
 *   环境变量：DSH_TAGGER_API_KEY / DSH_TAGGER_MODEL / DSH_TAGGER_BASE_URL / DSH_TAGGER_DATA / DSH_TAGGER_WORKFLOW_DIR
 *
 * 两条硬线：
 *   1. 没有内置 key、没有内置地址：缺配置就如实报 llmReady:false，接口回清晰错误。
 *   2. SIGINT / SIGTERM 关服务走 gracefully：不再接新连接，等在飞的请求收尾，超时再来硬的。
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createRuntime, createHandlers } from '../index.js'
import { LEGACY_PREFIX, PREFIX, createDispatch } from '../lib/routes.js'
import { createContext, createLlmShim, createToolsShim, createWebServerShim } from './shims.mjs'

const DEFAULT_PORT = 7789
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_SHUTDOWN_MS = 4000
const MCP_PATH = PREFIX + '/mcp'

const USAGE = [
  'DSh Tagger 独立服务',
  '',
  '用法：dsh-tagger-server [options]',
  '',
  '  --port <n>            监听端口（默认 7789；给 0 表示随机空闲端口）',
  '  --host <addr>         监听地址（默认 127.0.0.1）',
  '  --base-url <url>      OpenAI 兼容接口地址，如 https://api.openai.com（也可带 /v1）',
  '  --api-key <key>       接口密钥（也可用 DSH_TAGGER_API_KEY）',
  '  --model <name>        默认模型名（也可用 DSH_TAGGER_MODEL）',
  '  --data-dir <dir>      数据目录（settings.json / 标签缓存）',
  '  --workflow-dir <dir>  ComfyUI 工作流目录',
  '  --provider <name>     llm provider 名（默认 openai-compatible，只影响展示）',
  '  -h, --help            打印这份说明',
  '',
  '环境变量：DSH_TAGGER_API_KEY / DSH_TAGGER_MODEL / DSH_TAGGER_BASE_URL / DSH_TAGGER_DATA / DSH_TAGGER_WORKFLOW_DIR',
].join('\n')

/** 一个非常小的参数解析：够用即可，不引依赖。 */
function parseArgs(argv) {
  const out = { help: false }
  const takes = new Set([
    'port',
    'host',
    'base-url',
    'api-key',
    'model',
    'data-dir',
    'workflow-dir',
    'provider',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') {
      out.help = true
      continue
    }
    if (!token.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    if (!takes.has(key)) continue
    if (eq >= 0) {
      out[key] = body.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      index += 1
    }
  }
  return out
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function portOf(raw, fallback) {
  const text = str(raw).trim()
  if (text === '') return fallback
  const n = Number.parseInt(text, 10)
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback
  return n
}

function escapeHtml(value) {
  return str(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function makeLogger() {
  const prefix = '[tagger] '
  const write = (level, args) => {
    const line = args.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')
    const stream = level === 'error' ? process.stderr : process.stdout
    stream.write(prefix + line + '\n')
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: () => {},
  }
}

const argv = parseArgs(process.argv.slice(2))
if (argv.help === true) {
  process.stdout.write(USAGE + '\n')
  process.exit(0)
}

const logger = makeLogger()

// dataDir() 读 env，所以在 createRuntime 之前落地：--data-dir 优先级最高。
const dataDirArg = str(argv['data-dir']).trim()
if (dataDirArg !== '') process.env.DSH_TAGGER_DATA = dataDirArg

const baseUrl = str(argv['base-url']).trim() || str(process.env.DSH_TAGGER_BASE_URL).trim()
const apiKey = str(argv['api-key']).trim() || str(process.env.DSH_TAGGER_API_KEY).trim()
const model = str(argv.model).trim() || str(process.env.DSH_TAGGER_MODEL).trim()
const workflowDir = str(argv['workflow-dir']).trim() || str(process.env.DSH_TAGGER_WORKFLOW_DIR).trim()
const provider = str(argv.provider).trim() || 'openai-compatible'
const host = str(argv.host).trim() || DEFAULT_HOST
const port = portOf(argv.port, DEFAULT_PORT)

// CLI / 环境变量没给的，从 settings.json 的 llm.baseUrl / llm.apiKey 现取 —— 面板填完立刻生效，不用重启。
let runtime
const llm = createLlmShim({
  baseUrl,
  apiKey,
  model,
  provider,
  logger,
  resolve: () => {
    const live = runtime?.config?.llm ?? {}
    return {
      baseUrl: baseUrl !== '' ? baseUrl : str(live.baseUrl),
      apiKey: apiKey !== '' ? apiKey : str(live.apiKey),
      model: model !== '' ? model : str(live.model),
      provider,
      // 超时也现读：面板把 llm.timeoutMs 调大后立刻生效，不然长提示词还是会按 120s 掐断。
      timeoutMs: Number(live.timeoutMs) > 0 ? Number(live.timeoutMs) : undefined,
    }
  },
})
const webServer = createWebServerShim({ host, port, logger })
const tools = createToolsShim()
const ctx = createContext({ llm, webServer, tools })

// 只把「独立运行时确实变了的」那些配置传进去；其余交给 lib/config.js 的默认值与 settings.json。
const rawConfig = {
  llm: {
    provider,
    model: model === '' ? undefined : model,
  },
  comfy: workflowDir === '' ? undefined : { workflowDir },
}

runtime = createRuntime(ctx, rawConfig)
const rt = runtime
// 宿主插件路径下 ctx 里有 llm，这里换成 shim；mcp 的 refine 需要迟到绑定（createRuntime 没传）。
if (rt !== undefined && rt.mcp !== undefined && typeof rt.mcp.attach === 'function') {
  rt.mcp.attach({ refine: rt.refine })
}

function describeHealth() {
  const llmInfo = typeof llm.describe === 'function' ? llm.describe() : { configured: llm.configured }
  const address = webServer.address()
  return {
    plugin: 'dsh-tagger',
    version: '0.2.0',
    mode: 'standalone',
    dataDir: rt.dir,
    host: address.host,
    port: address.port,
    basePath: PREFIX,
    mcp: { endpoint: MCP_PATH, protocol: rt.mcp === undefined ? undefined : rt.mcp.protocolVersion },
    llmReady: llmInfo.configured === true,
    llm: llmInfo,
    refineModes: Array.isArray(rt.refine?.modes) ? rt.refine.modes : ['add', 'edit', 'prune', 'weights'],
    comfy: {
      baseUrl: rt.config?.comfy?.baseUrl,
      workflowDir: rt.config?.comfy?.workflowDir,
    },
  }
}

/** 用独立版的 /health 顶掉 createHandlers 里那份（那份没有 llmReady / 端口信息）。 */
function standaloneRoutes() {
  const routes = createHandlers(rt)
  const health = {
    path: '/health',
    methods: ['GET'],
    handler: async () => ({ json: describeHealth() }),
  }
  const index = routes.findIndex(route => route.path === '/health')
  if (index >= 0) routes[index] = health
  else routes.unshift(health)
  return routes
}

/** GET / 的 HTML 壳：给人看的入口页（标题、健康状态、MCP 端点、接口清单）。 */
function htmlShell() {
  const health = describeHealth()
  const ready = health.llmReady === true
  const badgeText = ready ? 'llm 就绪' : 'llm 未配置'
  const badgeColor = ready ? '#1f8f4e' : '#b45309'
  const modelText = str(health.llm?.model) === '' ? '（未指定）' : health.llm.model
  const endpointText = str(health.llm?.endpoint) === '' ? '（未配置）' : health.llm.endpoint
  const rows = [
    ['插件', health.plugin + ' ' + health.version],
    ['模式', 'standalone（web 版入口）'],
    ['监听', health.host + ':' + health.port],
    ['数据目录', health.dataDir],
    ['MCP 端点', health.mcp.endpoint],
    ['模型', modelText],
    ['接口地址', endpointText],
    ['ComfyUI', str(health.comfy?.baseUrl) === '' ? '（默认）' : health.comfy.baseUrl],
    ['工作流目录', str(health.comfy?.workflowDir) === '' ? '（默认）' : health.comfy.workflowDir],
  ]
  const table = rows
    .map(row => '<tr><th>' + escapeHtml(row[0]) + '</th><td>' + escapeHtml(row[1]) + '</td></tr>')
    .join('')
  const items = [
    ['GET ' + PREFIX + '/health', '健康检查（含 llmReady）', PREFIX + '/health'],
    ['GET ' + PREFIX + '/spi', 'SPI 注册表与槽位', ''],
    ['GET ' + PREFIX + '/state', '面板状态：配置 / ComfyUI / 工作流 / 历史', ''],
    ['GET ' + PREFIX + '/tags?q=', '本地标签库检索', ''],
    ['POST ' + PREFIX + '/forge', '锻造标签串', ''],
    ['POST ' + PREFIX + '/refine', '对已有标签串增量精修', ''],
    ['POST ' + MCP_PATH, 'MCP（JSON-RPC over HTTP）', ''],
  ]
  const list = items
    .map(item => {
      const code = '<code>' + escapeHtml(item[0]) + '</code>'
      const label = item[2] === '' ? code : '<a href="' + escapeHtml(item[2]) + '">' + code + '</a>'
      return '<li>' + label + ' —— ' + escapeHtml(item[1]) + '</li>'
    })
    .join('')
  const lines = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>DSh Tagger</title>',
    '<style>',
    '  :root { color-scheme: light dark }',
    '  body { margin: 0; padding: 40px 20px; font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif }',
    '  main { max-width: 720px; margin: 0 auto }',
    '  h1 { font-size: 26px; margin: 0 0 6px }',
    '  h2 { font-size: 18px; margin: 24px 0 8px }',
    '  .sub { opacity: .72; margin-bottom: 20px }',
    '  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; color: #fff; background: ' + badgeColor + '; font-size: 13px }',
    '  table { border-collapse: collapse; width: 100%; margin: 18px 0 8px }',
    '  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(128,128,128,.28); vertical-align: top }',
    '  th { width: 120px; font-weight: 600; opacity: .8 }',
    '  code { padding: 1px 5px; border-radius: 4px; background: rgba(128,128,128,.16) }',
    '  ul { padding-left: 20px }',
    '  li { margin: 4px 0 }',
    '  a { color: #2563eb }',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '  <h1>DSh Tagger</h1>',
    '  <div class="sub">标签锻造台的独立服务入口 —— 这是 <strong>web 版</strong>，插件接口都在 <code>' + PREFIX + '</code> 下。</div>',
    '  <div><span class="badge">' + escapeHtml(badgeText) + '</span></div>',
    '  <table>' + table + '</table>',
    '  <h2>接口</h2>',
    '  <ul>' + list + '</ul>',
    '  <p class="sub">没配模型接口时，锻造 / 精修会回 <code>no-llm</code>；给 <code>--base-url</code> 与 <code>--api-key</code> 后重启即可。</p>',
    '</main>',
    '</body>',
    '</html>',
  ]
  return lines.join('\n') + '\n'
}

const routes = standaloneRoutes()
const dispatch = createDispatch(routes, rt.log, PREFIX)

const disposers = []
disposers.push(webServer.register({ kind: 'prefix', path: PREFIX, handler: dispatch }))
// 旧前缀兼容：与 DSH 宿主里 index.js 的行为对齐，老脚本不用改地址。
try {
  const legacyDispatch = createDispatch(routes, rt.log, LEGACY_PREFIX)
  disposers.push(webServer.register({ kind: 'prefix', path: LEGACY_PREFIX, handler: legacyDispatch }))
} catch (error) {
  rt.log.info('旧前缀 ' + LEGACY_PREFIX + ' 未注册（不影响）：' + (error instanceof Error ? error.message : String(error)))
}
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const PANEL_FILE = path.join(SELF_DIR, 'panel.html')
// 面板拆出来的静态资源（样式 / 脚本）：只从这里读，别的目录一律不认。
const PUBLIC_DIR = path.resolve(SELF_DIR, 'public')
// 只放行面板真正用到的这几种类型；未知扩展名当 404，不猜。
const PUBLIC_MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * 把 /public/xxx 映射到 PUBLIC_DIR 下的普通文件。
 *
 * 三重防线，任何一条不过就返回 error，绝不把盘上别的东西吐出去：
 *   1. 解码后不允许出现 '..' 段或空段（'//' 这类）；
 *   2. path.resolve 之后必须仍在 PUBLIC_DIR 里面（挡住 '..\' 这种 Windows 分隔符绕过）；
 *   3. statSync 必须是普通文件（目录、符号链接到别处都不算）。
 */
function resolvePublicPath(rawUrl) {
  const text = str(rawUrl) || '/'
  const cut = text.search(/[?#]/)
  const rawPath = cut >= 0 ? text.slice(0, cut) : text
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { error: 'bad-path' }
  }
  if (!decoded.startsWith('/public/')) return { error: 'bad-path' }
  const rel = decoded.slice('/public/'.length)
  if (rel === '' || rel.includes('\u0000')) return { error: 'bad-path' }
  const segments = rel.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return { error: 'bad-path' }
  }
  const full = path.resolve(PUBLIC_DIR, rel)
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return { error: 'bad-path' }
  const type = PUBLIC_MIME.get(path.extname(full).toLowerCase())
  if (type === undefined) return { error: 'not-found' }
  let stat
  try {
    stat = statSync(full)
  } catch {
    return { error: 'not-found' }
  }
  if (stat.isFile() !== true) return { error: 'not-found' }
  return { file: full, type, size: stat.size }
}

/** /public/* 的静态响应：no-store（改完刷新就生效），坏路径 400，找不到 404，其余方式 405。 */
async function servePublic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' })
    res.end(JSON.stringify({ ok: false, error: 'method-not-allowed', message: '/public/* 只支持 GET。' }))
    return
  }
  const found = resolvePublicPath(req.url)
  if (found.error !== undefined) {
    const status = found.error === 'bad-path' ? 400 : 404
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(
      JSON.stringify({
        ok: false,
        error: found.error,
        message: found.error === 'bad-path' ? '路径不合法（只允许 server/public 下的普通文件）。' : '没有这个静态资源：' + str(req.url),
      }),
    )
    return
  }
  let body
  try {
    body = readFileSync(found.file)
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: 'not-found', message: msgOfStatic(error) }))
    return
  }
  res.writeHead(200, {
    'Content-Type': found.type,
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function msgOfStatic(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 面板 HTML：每次读盘，改完刷新浏览器就生效（不重启）。读不到就退回信息页，别 500。 */
function panelHtml() {
  try {
    return readFileSync(PANEL_FILE, 'utf8')
  } catch (error) {
    rt.log.info('读不到 server/panel.html，退回信息页：' + (error instanceof Error ? error.message : String(error)))
    return htmlShell()
  }
}

/** 注册一个只读 HTML 页面（GET / HEAD，no-store）。 */
function registerHtmlPage(routePath, getHtml) {
  disposers.push(
    webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' })
          res.end(JSON.stringify({ ok: false, error: 'method-not-allowed', message: routePath + ' 只支持 GET。' }))
          return
        }
        const html = getHtml()
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      },
    }),
  )
}

// 面板的样式与脚本：server/public/ 下的普通文件，带 MIME 与路径穿越防护。
disposers.push(webServer.register({ kind: 'prefix', path: '/public', handler: servePublic }))

// 面板：/ 与 /panel 都是锻造台；/about 是原来的信息页（健康状态 + 接口清单）。
registerHtmlPage('/', panelHtml)
registerHtmlPage('/panel', panelHtml)
registerHtmlPage('/panel.html', panelHtml)
registerHtmlPage('/about', htmlShell)

let shuttingDown = false

async function shutdown(reason, code) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info('收到 ' + reason + '，关闭服务…')
  const force = setTimeout(() => {
    logger.warn('优雅退出超时，强制结束。')
    process.exit(code)
  }, DEFAULT_SHUTDOWN_MS)
  if (typeof force.unref === 'function') force.unref()
  try {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // 单个路由卸载失败不影响收尾
      }
    }
    await webServer.close()
    if (ctx !== undefined && typeof ctx.disposeAll === 'function') await ctx.disposeAll()
  } catch (error) {
    logger.warn('关闭过程出错：' + (error instanceof Error ? error.message : String(error)))
  } finally {
    clearTimeout(force)
  }
  process.exit(code)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal, 0)
  })
}
process.on('uncaughtException', error => {
  logger.error('未捕获异常：' + (error instanceof Error ? String(error.stack ?? error.message) : String(error)))
})
process.on('unhandledRejection', reason => {
  logger.error('未处理的 Promise 拒绝：' + (reason instanceof Error ? reason.message : String(reason)))
})

try {
  const address = await webServer.listen()
  const info = describeHealth()
  logger.info('DSh Tagger 独立服务已启动：' + address.url)
  logger.info('  面板 / web 入口：' + address.url + '/')
  logger.info('  接口前缀：' + PREFIX + '    MCP：' + MCP_PATH)
  logger.info('  数据目录：' + info.dataDir)
  if (info.llmReady === true) {
    logger.info('  模型：' + (str(info.llm?.model) === '' ? '（未指定，调用时按配置取）' : info.llm.model) + ' @ ' + info.llm.endpoint)
  } else {
    logger.info('  模型：未配置（llmReady:false）—— 给 --base-url 与 --api-key，或用 DSH_TAGGER_BASE_URL / DSH_TAGGER_API_KEY')
  }
  // 机器可读的一行：测试与守护脚本据此拿真实端口（--port 0 时尤其有用）
  process.stdout.write('STANDALONE_READY url=' + address.url + ' basePath=' + PREFIX + ' llmReady=' + (info.llmReady === true) + '\n')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  logger.error('启动失败：' + message)
  if (message.includes('EADDRINUSE')) logger.error('端口 ' + port + ' 已被占用，换一个 --port 试试。')
  process.exit(1)
}
