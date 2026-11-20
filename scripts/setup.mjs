#!/usr/bin/env node
// plan: 首次运行向导 —— 六个问题写进 <dataDir>/settings.json；回车 = 跳过 = 不写那个键，回落到 lib/config.js 的内置默认

/**
 * scripts/setup.mjs — 零依赖安装向导。
 *
 * 口径（重要）：向导**不替用户拍板模型**。
 *   - 端口 [7789] 与 ComfyUI 地址 [http://127.0.0.1:8188] 是本机可推断的，问了就写；
 *   - baseUrl / apiKey / model / 工作流目录一律「回车 = 跳过 = 不写这个键」，
 *     不写就自然回落到 lib/config.js 里 DEFAULTS.llm 的内置 provider/model 与空 baseUrl ——
 *     这样面板不会假装用户已经选了 OpenAI。
 *
 * 三条设计线：
 *   1. 纯函数可单测：detectDataDir / defaultsFor / buildSettingsPatch / mergeSettings / skippedKeys 都不碰 stdin/stdout。
 *   2. 不 import lib/config.js：独立安装包里可能没有 lib/，这里自己复刻同一套数据目录探测规则
 *      （DSH_TAGGER_DATA → DSH_PROMPT_FORGE_DATA → ~/.dsh-tagger，旧目录有配置就沿用旧目录）。
 *   3. 只覆盖填了的字段：已有 settings.json 先读进来再深合并，没问到的键（llm.apiKey、ui.* 等）原样保留。
 *
 * 用法：
 *   node scripts/setup.mjs            交互（逐条问，回车 = 跳过）
 *   node scripts/setup.mjs --yes      全跳过，只写 server.port 与 comfy.baseUrl（脚本 / CI 用）
 *   node scripts/setup.mjs --print    只打印将写入的 JSON，不落盘
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 7789
export const DEFAULT_HOST = '127.0.0.1'
// ComfyUI 默认跑在本机这个口上，值得作为默认值写进配置
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'
// 内置模型只出现在提示里（归 lib/config.js 的 DEFAULTS.llm 所有），向导不写它
export const BUILTIN_MODEL = 'deepseek-v4.1-flash'
// 「回车就跳过」的统一提示文案
export const SKIP_HINT = '(跳过)'

export const USAGE = [
  'DSh Tagger 首次配置向导（回车 = 跳过 = 不写这个键，回落到内置默认）',
  '',
  '用法：node scripts/setup.mjs [--yes] [--print] [--port N] [--base-url URL] [--api-key KEY]',
  '                             [--model NAME] [--comfy-url URL] [--workflow-dir DIR] [--data-dir DIR]',
  '  --yes        什么都不问、全部跳过（只写端口与 ComfyUI 地址）',
  '  --print      只打印将写入的 settings.json，不落盘',
].join('\n')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function trimSlash(value) {
  return value.replace(/\/+$/, '')
}

function portOf(raw, fallback = DEFAULT_PORT) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(n) || n < 0 || n > 65535) return fallback
  return n
}

function existsDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 数据目录：与 lib/config.js 的 dataDir() 同一套规则（这里不 import，安装包里也能单跑）。
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [explicit] 命令行 --data-dir
 * @returns {string}
 */
export function detectDataDir(env = process.env, explicit = '') {
  const given = text(explicit, text(env.DSH_TAGGER_DATA, text(env.DSH_PROMPT_FORGE_DATA, '')))
  if (given !== '') return path.resolve(given)
  const next = path.join(os.homedir(), '.dsh-tagger')
  const legacy = path.join(os.homedir(), '.dsh-prompt-forge')
  // 从 dsh-prompt-forge 迁移：新目录还没建而旧目录有配置时先接着用旧的，别丢用户设置
  if (existsDir(next)) return next
  if (existsDir(legacy)) return legacy
  return next
}

/**
 * 向导的默认答案：空字符串一律表示「跳过，不写这个键」。
 * @param {string} [dataDir]
 */
export function defaultsFor(dataDir = detectDataDir()) {
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    dataDir,
    baseUrl: '',
    apiKey: '',
    model: '',
    comfyUrl: DEFAULT_COMFY_URL,
    workflowDir: '',
  }
}

/**
 * 答案 → settings.json 的补丁。
 * 只有 server.{port,host} 与 comfy.baseUrl 一定会写；其余填了才写（空 = 跳过）。
 * @param {Record<string, string | number>} [answers]
 * @returns {Record<string, any>}
 */
export function buildSettingsPatch(answers = {}) {
  const source = isRecord(answers) ? answers : {}
  const base = defaultsFor(text(source.dataDir, detectDataDir()))
  const patch = {
    // 启动参数也存一份：下次 start.cmd / bin/tagger.mjs 不带 --port 时按这个来
    server: { port: portOf(source.port, base.port), host: text(source.host, base.host) || base.host },
    comfy: { baseUrl: trimSlash(text(source.comfyUrl, base.comfyUrl)) || base.comfyUrl },
  }
  const llm = {}
  const baseUrl = text(source.baseUrl, '')
  if (baseUrl !== '') llm.baseUrl = trimSlash(baseUrl)
  const model = text(source.model, '')
  if (model !== '') llm.model = model
  const apiKey = text(source.apiKey, '')
  if (apiKey !== '') llm.apiKey = apiKey
  // 一个都没填就别写 llm 段：没有 llm 段 = 完全回落到内置默认
  if (Object.keys(llm).length > 0) patch.llm = llm
  const workflowDir = text(source.workflowDir, '')
  if (workflowDir !== '') patch.comfy.workflowDir = workflowDir
  return patch
}

/**
 * 这次不会写哪些「回落到内置」的键 —— --print 时把话说清楚，别让人以为已经配好了模型。
 * @param {Record<string, any>} [patch]
 * @returns {string[]}
 */
export function skippedKeys(patch) {
  const llm = isRecord(patch) && isRecord(patch.llm) ? patch.llm : {}
  const missing = ['baseUrl', 'model', 'apiKey'].filter(key => !(key in llm))
  return missing.map(key => 'llm.' + key)
}

/**
 * 深合并：对象逐层合，数组 / 标量直接替换，undefined 跳过 —— 已有配置里没被问到的键原样留着。
 * @param {Record<string, any>} [existing]
 * @param {Record<string, any>} [patch]
 * @returns {Record<string, any>}
 */
export function mergeSettings(existing, patch) {
  const base = isRecord(existing) ? existing : {}
  if (!isRecord(patch)) return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isRecord(value) && isRecord(base[key])) out[key] = mergeSettings(base[key], value)
    else out[key] = value
  }
  return out
}

/**
 * 向导的问题清单（顺序即提问顺序）：hint 是方括号里显示的文字，'' 表示跳过。
 * @param {ReturnType<typeof defaultsFor>} initial
 */
export function questionsFor(initial) {
  return [
    { key: 'port', label: '监听端口', hint: String(initial.port) },
    { key: 'baseUrl', label: '模型接口 baseUrl（OpenAI 兼容）', hint: '(跳过：沿用内置)' },
    { key: 'apiKey', label: 'API Key', hint: SKIP_HINT },
    { key: 'model', label: '模型名', hint: '(跳过：沿用内置 ' + BUILTIN_MODEL + ')' },
    { key: 'comfyUrl', label: 'ComfyUI 地址', hint: initial.comfyUrl },
    { key: 'workflowDir', label: '工作流模板目录', hint: SKIP_HINT },
  ]
}

/**
 * 逐条提问；回车 = 跳过（空字符串，之后不写这个键）。
 * @param {ReturnType<typeof defaultsFor>} initial
 * @returns {Promise<Record<string, string>>}
 */
export async function interview(initial, io = {}) {
  const input = io.input ?? process.stdin
  const output = io.output ?? process.stdout
  const rl = readline.createInterface({ input, output })
  /** @type {Record<string, string>} */
  const answers = {}
  const ask = question => new Promise(resolve => {
    rl.question(question + ' ', answer => resolve(typeof answer === 'string' ? answer.trim() : ''))
  })
  try {
    for (const item of questionsFor(initial)) {
      const answer = await ask('  ' + item.label + ' [' + item.hint + ']')
      answers[item.key] = answer
    }
  } finally {
    rl.close()
  }
  process.stdout.write('\n')
  return answers
}

/** 「下一步」提示：三条起服务的方式 + 面板地址。 */
export function nextStepsText(answers) {
  const port = portOf(answers.port, DEFAULT_PORT)
  return [
    '',
    '下一步（任选一条起服务）：',
    '  Windows：双击 start.cmd（或 start.cmd ' + port + ' 换端口）',
    '  macOS / Linux：./start.sh',
    '  容器：docker compose up',
    '面板：http://' + DEFAULT_HOST + ':' + port + '/',
  ].join('\n')
}

/** 向导命令行参数（纯函数）。 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : []
  const out = { yes: false, print: false, help: false, values: {}, warnings: [] }
  const takes = new Set(['port', 'host', 'base-url', 'api-key', 'model', 'comfy-url', 'workflow-dir', 'data-dir'])
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index]
    if (typeof token !== 'string' || token === '') continue
    if (token === '--yes' || token === '-y') { out.yes = true; continue }
    if (token === '--print') { out.print = true; continue }
    if (token === '--help' || token === '-h') { out.help = true; continue }
    if (token.slice(0, 2) !== '--') continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    let value = eq >= 0 ? body.slice(eq + 1) : undefined
    if (!takes.has(key)) { out.warnings.push('未知参数已忽略：' + token); continue }
    if (value === undefined) {
      const next = list[index + 1]
      if (typeof next === 'string' && next !== '' && next.slice(0, 2) !== '--') { value = next; index += 1 }
      else { out.warnings.push('参数缺值：' + token); continue }
    }
    out.values[key] = value
  }
  return out
}

export function settingsPathOf(dataDir) {
  return path.join(dataDir, 'settings.json')
}

/** 读已有 settings.json；没有 / 坏文件都当空对象（别拦着用户装）。 */
export function readSettings(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPathOf(dataDir), 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 把 settings 写盘（2 空格缩进，父目录自动建）。 */
export function writeSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(settingsPathOf(dataDir), JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return settingsPathOf(dataDir)
}

/**
 * 把命令行给的值合进默认答案（命令行优先于向导默认值；给空串仍算跳过）。
 * @param {ReturnType<typeof defaultsFor>} initial
 * @param {Record<string, string>} values
 */
export function answersFromFlags(initial, values) {
  const answers = { ...initial }
  const map = {
    port: 'port',
    host: 'host',
    'base-url': 'baseUrl',
    'api-key': 'apiKey',
    model: 'model',
    'comfy-url': 'comfyUrl',
    'workflow-dir': 'workflowDir',
    'data-dir': 'dataDir',
  }
  for (const [flag, key] of Object.entries(map)) {
    const value = values[flag]
    if (typeof value === 'string' && value !== '') answers[key] = value
  }
  return answers
}

/** 把「这次没写哪些键」说给人听。 */
function skippedLine(skipped) {
  return skipped.length === 0
    ? '[setup] 模型接口三项都写了。'
    : '[setup] 没写（跳过 → 沿用内置默认）：' + skipped.join('、')
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  const options = parseArgs(argv)
  for (const warning of options.warnings) process.stderr.write('[setup] ' + warning + '\n')
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const dataDir = detectDataDir(process.env, options.values['data-dir'] ?? '')
  const initial = defaultsFor(dataDir)
  const preset = answersFromFlags(initial, options.values)
  const existing = readSettings(dataDir)
  const interactive = options.yes !== true && options.print !== true && process.stdin.isTTY === true

  let answers = preset
  if (interactive) {
    process.stdout.write('[setup] DSh Tagger 首次配置（回车 = 跳过，不写那个键）\n')
    answers = { ...preset, ...(await interview(preset)) }
  } else if (options.yes !== true && options.print !== true) {
    process.stdout.write('[setup] 没检测到交互终端，按 --yes 处理（全部跳过，只写端口与 ComfyUI 地址）。\n')
  }

  const patch = buildSettingsPatch(answers)
  const settings = mergeSettings(existing, patch)
  const skipped = skippedKeys(patch)

  if (options.print) {
    // --print 只吐 JSON（提示都走 stderr），方便管道 / 测试直接 JSON.parse
    process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
    process.stderr.write(skippedLine(skipped) + '\n')
    return 0
  }

  try {
    const written = writeSettings(dataDir, settings)
    process.stdout.write('[setup] 已写入 ' + written + '\n')
    process.stdout.write(skippedLine(skipped) + '\n')
    process.stdout.write(nextStepsText(answers) + '\n')
    return 0
  } catch (error) {
    process.stderr.write('[setup] 写不进去：' + (error instanceof Error ? error.message : String(error)) + '\n')
    return 1
  }
}

const invoked = process.argv[1] === undefined ? '' : path.resolve(process.argv[1])
if (invoked !== '' && invoked === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code
  }).catch(error => {
    process.stderr.write('[setup] 失败：' + (error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exitCode = 1
  })
}
