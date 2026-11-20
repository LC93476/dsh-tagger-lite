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
import { readFileSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createRuntime, createHandlers } from '../index.js'
import { LEGACY_PREFIX, PREFIX, createDispatch } from '../lib/routes.js'
import { createContext, createLlmShim, createWebServerShim } from './shims.mjs'

const DEFAULT_PORT = 7789
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_SHUTDOWN_MS = 4000
const MCP_PATH = PREFIX + '/mcp'
/** 根目录 package.json：health 的 version 从这里读，不硬编码。 */
const PACKAGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
let cachedVersion = ''

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
  const out = { help: false, unknown: [] }
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
    // 白名单外的参数不丢：收起来，启动时告警一条（别静默，也别拒启动）
    if (!takes.has(key)) {
      out.unknown.push('--' + key)
      continue
    }
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

// 未知参数：告警但不拦着启动（可能是留给未来版本的开关，用户也可能只是拼错了）。
if (argv.unknown.length > 0) {
  logger.warn('未知参数：' + argv.unknown.join(' ') + '（已忽略，不影响启动）')
}

// dataDir() 读 env，所以在 createRuntime 之前落地：--data-dir 优先级最高。
const dataDirArg = str(argv['data-dir']).trim()
if (dataDirArg !== '') process.env.DSH_TAGGER_DATA = dataDirArg

// 分层记清楚：cli 与 env 各自留原值，health 才能说出某个字段实际来自哪层。
const cliBaseUrl = str(argv['base-url']).trim()
const cliApiKey = str(argv['api-key']).trim()
const cliModel = str(argv.model).trim()
const envBaseUrl = str(process.env.DSH_TAGGER_BASE_URL).trim()
const envApiKey = str(process.env.DSH_TAGGER_API_KEY).trim()
const envModel = str(process.env.DSH_TAGGER_MODEL).trim()
const baseUrl = cliBaseUrl !== '' ? cliBaseUrl : envBaseUrl
const apiKey = cliApiKey !== '' ? cliApiKey : envApiKey
const model = cliModel !== '' ? cliModel : envModel
const workflowDir = str(argv['workflow-dir']).trim() || str(process.env.DSH_TAGGER_WORKFLOW_DIR).trim()
const provider = str(argv.provider).trim() || 'openai-compatible'
const host = str(argv.host).trim() || DEFAULT_HOST
const port = portOf(argv.port, DEFAULT_PORT)

// CLI / 环境变量没给的，从 settings.json 的 llm.baseUrl / llm.apiKey 现取 —— 面板填完立刻生效，不用重启。
let runtime

/** 现读一层：CLI > 环境变量 > settings.json（面板改完立刻生效，不用重启）。 */
function liveLlm() {
  const live = runtime?.config?.llm ?? {}
  return {
    baseUrl: baseUrl !== '' ? baseUrl : str(live.baseUrl),
    apiKey: apiKey !== '' ? apiKey : str(live.apiKey),
    model: model !== '' ? model : str(live.model),
    provider,
    // 超时也现读：面板把 llm.timeoutMs 调大后立刻生效，不然长提示词还是会按 120s 掐断。
    timeoutMs: Number(live.timeoutMs) > 0 ? Number(live.timeoutMs) : undefined,
  }
}

/** 某个字段到底来自哪一层：cli / env / settings / none。面板改了没生效，通常就是被 env 或 cli 盖住了。 */
function sourceOf(cliValue, envValue, liveValue) {
  if (str(cliValue) !== '') return 'cli'
  if (str(envValue) !== '') return 'env'
  if (str(liveValue) !== '') return 'settings'
  return 'none'
}

function llmSources() {
  const live = liveLlm()
  return {
    baseUrl: sourceOf(cliBaseUrl, envBaseUrl, str(live.baseUrl)),
    apiKey: sourceOf(cliApiKey, envApiKey, str(live.apiKey)),
    model: sourceOf(cliModel, envModel, str(live.model)),
  }
}

/** 根 package.json 的 version，模块级缓存一次（读不到就 0.0.0，不抛）。 */
function packageVersion() {
  if (cachedVersion !== '') return cachedVersion
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'))
    cachedVersion = str(pkg.version) === '' ? '0.0.0' : String(pkg.version)
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

const llm = createLlmShim({
  baseUrl,
  apiKey,
  model,
  provider,
  logger,
  resolve: liveLlm,
})
const webServer = createWebServerShim({ host, port, logger })
const ctx = createContext({ llm, webServer })

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
// mcp 的 refine 需要迟到绑定（createRuntime 没传）。
if (rt !== undefined && rt.mcp !== undefined && typeof rt.mcp.attach === 'function') {
  rt.mcp.attach({ refine: rt.refine })
}

function describeHealth() {
  // 两条分支的键必须完全一致：/health 的消费者（htmlShell、启动日志、测试）会直接读 model / endpoint，
  // 联合类型里少一个键就取不到值（tsc 也会报 TS2339）。describe() 永远存在，这里只是兜底。
  const llmInfo = typeof llm.describe === 'function'
    ? llm.describe()
    : {
        kind: 'shim',
        configured: llm.configured === true,
        provider: str(llm.provider),
        model: str(llm.model),
        endpoint: str(llm.endpoint),
        baseUrl: str(llm.baseUrl),
        timeoutMs: llm.timeoutMs,
        hint: undefined,
      }
  const address = webServer.address()
  return {
    plugin: 'dsh-tagger',
    version: packageVersion(),
    mode: 'standalone',
    dataDir: rt.dir,
    host: address.host,
    port: address.port,
    basePath: PREFIX,
    mcp: { endpoint: MCP_PATH, protocol: rt.mcp === undefined ? undefined : rt.mcp.protocolVersion },
    llmReady: llmInfo.configured === true,
    llm: { ...llmInfo, source: llmSources() },
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
const GALLERY_FILE = path.join(SELF_DIR, 'public', 'gallery.html')
// 面板拆出来的静态资源（样式 / 脚本）：只从这里读，别的目录一律不认。
const PUBLIC_DIR = path.resolve(SELF_DIR, 'public')
// public 的真实路径（解软链后），第一次用到时算一次；算不出来就退回落差
let realPublicDir = ''

async function publicRealDir() {
  if (realPublicDir !== '') return realPublicDir
  try {
    realPublicDir = await realpath(PUBLIC_DIR)
  } catch {
    realPublicDir = PUBLIC_DIR
  }
  return realPublicDir
}
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
 *   3. lstat 必须是普通文件（目录不算），且不能是软链；再拿 realpath 复核一遍真实位置。
 */
async function resolvePublicPath(rawUrl) {
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
  // lstat 不跟随软链：指向 public 外面的软链（哪怕它指向一个普通文件）一律当没有。
  let stat
  try {
    stat = await lstat(full)
  } catch {
    return { error: 'not-found' }
  }
  if (stat.isSymbolicLink() === true) return { error: 'not-found' }
  if (stat.isFile() !== true) return { error: 'not-found' }
  // 双保险：把真路径解出来，仍然必须落在 public 的真实目录里（父目录被换成软链也能挡住）。
  const realDir = await publicRealDir()
  let real
  try {
    real = await realpath(full)
  } catch {
    return { error: 'not-found' }
  }
  if (realDir === '' || real.startsWith(realDir + path.sep) !== true) return { error: 'not-found' }
  return { file: full, type, size: stat.size, mtimeMs: stat.mtimeMs }
}

/**
 * /public/* 的静态响应。缓存策略：no-cache + 强 ETag。
 *
 * 不用 no-store：面板每次刷新都重下 100KB 的 panel.css/app.js 没有必要。
 * 不用长 max-age：改完文件要能立刻生效，开发期不能被缓存骗。
 * 折中是 no-cache（可缓存，但每次带 If-None-Match 复验）：命中就 304，空 body；
 * 文件变了 size/mtime 跟着变，ETag 自然失效，浏览器拿到新内容。
 * 坏路径 400，找不到 404，其余方式 405。
 */
/** 弱 ETag 比对：'W/' 前缀只表示强弱，比对时先剥掉。 */
function normalizeEtag(value) {
  const text = str(value).trim()
  return text.startsWith('W/') ? text.slice(2) : text
}

/**
 * If-None-Match 比对（纯函数，便于单测）。
 * 支持：逗号分隔多值、弱校验（W/ 前缀）、以及通配 "*"。
 */
function etagMatches(header, etag) {
  const target = normalizeEtag(etag)
  if (target === '') return false
  for (const part of str(header).split(',')) {
    const token = part.trim()
    if (token === '') continue
    if (token === '*') return true
    if (normalizeEtag(token) === target) return true
  }
  return false
}

async function servePublic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, HEAD' })
    res.end(JSON.stringify({ ok: false, error: 'method-not-allowed', message: '/public/* 只支持 GET。' }))
    return
  }
  const found = await resolvePublicPath(req.url)
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
    body = await readFile(found.file)
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: 'not-found', message: msgOfStatic(error) }))
    return
  }
  const etag = '"' + found.size.toString(16) + '-' + Math.round(found.mtimeMs).toString(16) + '"'
  if (etagMatches(req.headers['if-none-match'], etag) === true) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': found.type,
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-cache',
    ETag: etag,
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

/** 姿势画廊页面：同样每次读盘，读不到退回信息页。 */
function galleryHtml() {
  try {
    return readFileSync(GALLERY_FILE, 'utf8')
  } catch (error) {
    rt.log.info('读不到 server/public/gallery.html，退回信息页：' + (error instanceof Error ? error.message : String(error)))
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

// 姿势画廊：单独的展示页（挑姿势拿 tag，不跑 ControlNet），HTML 与样式脚本都在 server/public 下。
registerHtmlPage('/gallery', galleryHtml)

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
// 未捕获异常不再让进程带伤继续对外服务：打日志 → 走同一条优雅退出路径 → 退码 1。
// shutdown 自带幂等（shuttingDown 闸）与 4s 兜底强退，和定时器 / 游标清理不冲突。
process.on('uncaughtException', async error => {
  logger.error('未捕获异常：' + (error instanceof Error ? String(error.stack ?? error.message) : String(error)))
  await shutdown('uncaughtException', 1)
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
