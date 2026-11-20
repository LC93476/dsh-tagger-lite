#!/usr/bin/env node
// plan: 唯一命令行入口 —— 解析参数 → （可选）首次向导 → 转调 server/standalone.mjs 起服务 → 端口就绪后开浏览器

/**
 * bin/tagger.mjs — DSh Tagger 的命令行入口（package.json 的 bin 指这里）。
 *
 * 为什么要有这一层：安装只需要认一个命令。参数解析 parseArgs 是纯函数，测试能脱离真实进程单测；
 * 真正干活的是 server/standalone.mjs —— 这里改写好 process.argv 再同进程 import 它，所以体验与
 * 直接跑 standalone 完全一致（同一进程、同一份 SIGINT/SIGTERM 处理、日志直出、退出码一致）。
 *
 * 用法：dsh-tagger [--port 7789] [--host 127.0.0.1] [--data-dir DIR] [--open|--no-open]
 *                  [--setup] [--version] [--help]
 * 其余服务参数（--base-url / --api-key / --model / --workflow-dir / --provider）原样转给独立服务。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const STANDALONE = path.join(ROOT, 'server', 'standalone.mjs')
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs')
const PKG = path.join(ROOT, 'package.json')

export const DEFAULT_PORT = 7789
export const DEFAULT_HOST = '127.0.0.1'

/** 直接转给独立服务的参数（带值）。 */
const SERVED = new Set(['base-url', 'api-key', 'model', 'workflow-dir', 'provider'])

/**
 * 解析命令行。纯函数：只吃 argv 数组，不读 process / 不碰磁盘。
 * @param {string[]} argv 不含 node 与脚本名的参数
 * @returns {{ port: number, portSet: boolean, host: string, dataDir: string, setup: boolean,
 *   open: boolean, openSet: boolean, help: boolean, version: boolean, extra: string[], warnings: string[] }}
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : []
  const out = {
    port: DEFAULT_PORT,
    portSet: false,
    host: DEFAULT_HOST,
    dataDir: '',
    setup: false,
    open: true,
    openSet: false,
    help: false,
    version: false,
    extra: [],
    warnings: [],
  }
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]
    if (typeof token !== 'string' || token === '') continue
    if (token === '--help' || token === '-h') { out.help = true; continue }
    if (token === '--version' || token === '-v') { out.version = true; continue }
    if (token === '--setup') { out.setup = true; continue }
    if (token === '--open') { out.open = true; out.openSet = true; continue }
    if (token === '--no-open') { out.open = false; out.openSet = true; continue }
    // 位置参数不认（端口只走 --port），免得误把文件名当端口
    if (token.slice(0, 2) !== '--') continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    let value = eq >= 0 ? body.slice(eq + 1) : undefined
    if (key !== 'port' && key !== 'host' && key !== 'data-dir' && !SERVED.has(key)) {
      out.warnings.push('未知参数已忽略：' + token)
      continue
    }
    if (value === undefined) {
      const next = list[index + 1]
      if (typeof next === 'string' && next !== '' && next.slice(0, 2) !== '--') {
        value = next
        index += 1
      } else {
        out.warnings.push('参数缺值：' + token)
        continue
      }
    }
    if (key === 'port') {
      const port = Number.parseInt(value, 10)
      if (!Number.isFinite(port) || port < 0 || port > 65535 || String(port) !== String(value).trim()) {
        out.warnings.push('--port 不是有效端口（0-65535）：' + value + '，改用 ' + DEFAULT_PORT)
        continue
      }
      out.port = port
      out.portSet = true
      continue
    }
    if (key === 'host') { out.host = value; continue }
    if (key === 'data-dir') { out.dataDir = value; continue }
    out.extra.push('--' + key, value)
  }
  return out
}

/**
 * 拼给 server/standalone.mjs 的参数（纯函数，测试能用）。
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {string[]}
 */
export function buildServerArgs(options) {
  const args = ['--port', String(options.port), '--host', options.host]
  if (options.dataDir !== '') args.push('--data-dir', options.dataDir)
  return args.concat(options.extra)
}

/** 6 行以内的用法。 */
export function usageText() {
  return [
    'DSh Tagger · 白话 → WD + Camie 标签 → ComfyUI（独立服务 + 面板）',
    '用法：dsh-tagger [--port ' + DEFAULT_PORT + '] [--host ' + DEFAULT_HOST + '] [--data-dir DIR]',
    '                 [--open|--no-open] [--setup] [--version] [--help]',
    '      其余参数（--base-url --api-key --model --workflow-dir --provider）原样转给独立服务。',
    '面板：http://' + DEFAULT_HOST + ':' + DEFAULT_PORT + '/    接口：/tagger/api    MCP：/tagger/api/mcp',
  ].join('\n')
}

/** package.json 的 version（读不到就给 0.0.0，不抛）。 */
export function versionText() {
  try {
    const raw = JSON.parse(fs.readFileSync(PKG, 'utf8'))
    return typeof raw.version === 'string' && raw.version !== '' ? raw.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 起服务：改 process.argv 后同进程加载 standalone —— 参数透传、信号与退出码都跟直接跑一模一样。
 * @param {ReturnType<typeof parseArgs>} options
 */
async function serve(options) {
  const args = buildServerArgs(options)
  process.argv = [process.argv[0] ?? 'node', STANDALONE].concat(args)
  if (options.open) openWhenReady({ host: options.host, port: options.port })
  await import(pathToFileURL(STANDALONE).href)
}

/**
 * 跑首次向导（同一份 node，stdio 直连，退出码原样带回）。
 * @param {ReturnType<typeof parseArgs>} options
 * @param {string[]} rest 原始参数里除了 --setup 的部分（向导也认 --port 等）
 * @returns {Promise<number>}
 */
function runSetup(options, rest) {
  const args = [SETUP]
  if (options.dataDir !== '') args.push('--data-dir', options.dataDir)
  if (options.portSet) args.push('--port', String(options.port))
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === '--setup') continue
    args.push(token)
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    child.on('error', error => {
      process.stderr.write('[tagger] 向导起不来：' + (error instanceof Error ? error.message : String(error)) + '\n')
      resolve(1)
    })
    child.on('exit', code => resolve(typeof code === 'number' ? code : 0))
  })
}

/** 探一下端口是否已经在听（服务就绪再开浏览器，别抢在前面）。 */
function probeOnce(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port })
    const done = value => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** 500ms 一轮等端口就绪，就绪后开浏览器；没图形环境就静默跳过。 */
function openWhenReady({ host, port, timeoutMs = 30000 }) {
  if (!Number.isFinite(port) || port <= 0) return
  const url = 'http://' + (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host) + ':' + port + '/'
  const startedAt = Date.now()
  const tick = async () => {
    if (await probeOnce(host, port)) {
      openUrl(url)
      return
    }
    if (Date.now() - startedAt < timeoutMs) setTimeout(() => { tick() }, 500)
    else process.stderr.write('[tagger] 服务 30 秒内没起来，浏览器没自动打开，等日志里出现 STANDALONE_READY 后手动访问 ' + url + '\n')
  }
  setTimeout(() => { tick() }, 500)
}

/** 系统默认浏览器；起不来就当没有图形环境，静默跳过。 */
function openUrl(url) {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
      return
    }
    if (platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return
    }
    if (String(process.env.DISPLAY ?? '') === '') return
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 没图形环境：静默跳过，服务照跑
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv) {
  const rest = Array.isArray(argv) ? argv : []
  const options = parseArgs(rest)
  for (const warning of options.warnings) process.stderr.write('[tagger] ' + warning + '\n')
  if (options.help) {
    process.stdout.write(usageText() + '\n')
    return 0
  }
  if (options.version) {
    process.stdout.write(versionText() + '\n')
    return 0
  }
  if (options.setup) return runSetup(options, rest)
  if (!fs.existsSync(STANDALONE)) {
    process.stderr.write('[tagger] 找不到服务入口：' + STANDALONE + '\n')
    return 1
  }
  await serve(options)
  return 0
}

const invoked = process.argv[1] === undefined ? '' : path.resolve(process.argv[1])
if (invoked !== '' && invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code
  }).catch(error => {
    process.stderr.write('[tagger] 启动失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exitCode = 1
  })
}
