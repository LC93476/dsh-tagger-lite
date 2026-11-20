// plan: 安装入口回归 —— 向导与命令行的纯函数单测 + 真跑 spawn 验证写盘、--print、--help、--version

/**
 * 为什么这么测：
 *   1. parseArgs / buildSettingsPatch / mergeSettings 是「会不会把用户已有配置写坏」的唯一关口，值得脱进程单测；
 *   2. --print 与写盘走两条分支，只能真起子进程才看得见；
 *   3. start.cmd / start.sh 只是壳，真正的行为全压在 bin/tagger.mjs 上，所以这里测它而不是测 bat。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  BUILTIN_MODEL,
  DEFAULT_COMFY_URL,
  DEFAULT_HOST,
  DEFAULT_PORT,
  buildSettingsPatch,
  defaultsFor,
  detectDataDir,
  mergeSettings,
  questionsFor,
  settingsPathOf,
  skippedKeys,
} from '../scripts/setup.mjs'
import { parseArgs as parseBinArgs, usageText, versionText } from '../bin/tagger.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs')
const BIN = path.join(ROOT, 'bin', 'tagger.mjs')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 临时数据目录（用完删）。 */
function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tagger-setup-' + tag + '-'))
}

/** 跑一次 node 子进程，收齐 stdout / stderr 与退出码。 */
function runNode(args, options) {
  const opts = options ?? {}
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('子进程超时：' + args.join(' ') + '\n' + stdout.slice(0, 500) + stderr.slice(0, 500)))
    }, opts.timeoutMs ?? 30000)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('向导：六个问题、顺序与「回车=跳过」提示', () => {
  const initial = defaultsFor('/tmp/tagger-data')
  const questions = questionsFor(initial)
  assert.deepEqual(questions.map(item => item.key), ['port', 'baseUrl', 'apiKey', 'model', 'comfyUrl', 'workflowDir'])
  assert.equal(questions[0].hint, String(DEFAULT_PORT))
  assert.match(questions[1].hint, /跳过/)
  assert.match(questions[2].hint, /跳过/)
  assert.match(questions[3].hint, /跳过/)
  assert.ok(questions[3].hint.includes(BUILTIN_MODEL), '模型提示要说明内置是哪个')
  assert.equal(questions[4].hint, DEFAULT_COMFY_URL)
  assert.match(questions[5].hint, /跳过/)
  const bare = defaultsFor()
  assert.equal(bare.port, DEFAULT_PORT)
  assert.equal(bare.host, DEFAULT_HOST)
  assert.equal(bare.baseUrl, '', '不替用户选 baseUrl')
  assert.equal(bare.model, '', '不替用户选 model，回落到内置')
  assert.equal(bare.apiKey, '')
  assert.ok(bare.dataDir.endsWith('.dsh-tagger') || bare.dataDir.endsWith('.dsh-prompt-forge'))
})

test('detectDataDir：显式参数 > 环境变量 > 家目录', () => {
  assert.equal(detectDataDir({}, '/tmp/given'), path.resolve('/tmp/given'))
  assert.equal(detectDataDir({ DSH_TAGGER_DATA: '/tmp/env-data' }, ''), path.resolve('/tmp/env-data'))
  assert.equal(detectDataDir({ DSH_TAGGER_DATA: '/tmp/env-data' }, '/tmp/given'), path.resolve('/tmp/given'))
  assert.equal(detectDataDir({ DSH_PROMPT_FORGE_DATA: '/tmp/legacy-env' }, ''), path.resolve('/tmp/legacy-env'))
  const home = detectDataDir({}, '')
  assert.ok(home.startsWith(os.homedir()), '默认落在家目录：' + home)
  assert.ok(home.endsWith('.dsh-tagger') || home.endsWith('.dsh-prompt-forge'))
})

test('buildSettingsPatch：只写端口与 ComfyUI 地址，其余填了才写', () => {
  const empty = buildSettingsPatch({})
  assert.deepEqual(Object.keys(empty).sort(), ['comfy', 'server'], '全跳过时只写这两段')
  assert.deepEqual(empty.server, { port: DEFAULT_PORT, host: DEFAULT_HOST })
  assert.equal(empty.comfy.baseUrl, DEFAULT_COMFY_URL)
  assert.equal(empty.llm, undefined, '没有 llm 段 = 完全回落到内置')
  assert.deepEqual(skippedKeys(empty), ['llm.baseUrl', 'llm.model', 'llm.apiKey'])

  const patch = buildSettingsPatch({
    dataDir: '/tmp/tagger-data',
    port: '8090',
    baseUrl: 'https://gw.example.com/v1/',
    model: 'my-model',
    comfyUrl: 'http://127.0.0.1:8188/',
    apiKey: '   ',
    workflowDir: '',
  })
  assert.equal(patch.server.port, 8090)
  assert.equal(patch.server.host, DEFAULT_HOST)
  assert.equal(patch.llm.baseUrl, 'https://gw.example.com/v1')
  assert.equal(patch.llm.model, 'my-model')
  assert.equal(patch.llm.apiKey, undefined, '空白 apiKey 不写，免得清掉已有值')
  assert.equal(patch.comfy.baseUrl, 'http://127.0.0.1:8188', '地址去尾斜杠')
  assert.equal(patch.comfy.workflowDir, undefined)
  assert.deepEqual(skippedKeys(patch), ['llm.apiKey'])

  const filled = buildSettingsPatch({ apiKey: 'sk-test', workflowDir: '/w', comfyUrl: '  ' })
  assert.equal(filled.llm.apiKey, 'sk-test')
  assert.equal(filled.comfy.workflowDir, '/w')
  assert.equal(filled.comfy.baseUrl, DEFAULT_COMFY_URL, '空地址回落默认')
  assert.equal(buildSettingsPatch({ port: 'abc' }).server.port, DEFAULT_PORT)
})

test('mergeSettings：已有的 llm.apiKey 等未覆盖键必须原样保留', () => {
  const existing = {
    llm: { apiKey: 'sk-old', model: 'old-model', extra: { a: 1 } },
    ui: { keepHistory: 7 },
    tags: { standards: ['wd', 'camie'] },
    refine: { mode: 'edit' },
  }
  const merged = mergeSettings(existing, buildSettingsPatch({ dataDir: '/tmp/d', port: '8090', baseUrl: 'https://gw/v1', model: 'new-model' }))
  assert.equal(merged.llm.apiKey, 'sk-old')
  assert.equal(merged.llm.model, 'new-model')
  assert.deepEqual(merged.llm.extra, { a: 1 })
  assert.deepEqual(merged.ui, { keepHistory: 7 })
  assert.deepEqual(merged.tags.standards, ['wd', 'camie'])
  assert.equal(merged.refine.mode, 'edit')
  assert.equal(merged.server.port, 8090)
  assert.equal(existing.llm.model, 'old-model', '不能改入参对象')

  assert.deepEqual(mergeSettings({ tags: { standards: ['wd', 'camie'] } }, { tags: { standards: ['wd'] } }).tags.standards, ['wd'], '数组整体替换')
  assert.deepEqual(mergeSettings({ a: 1 }, { a: undefined }), { a: 1 }, 'undefined 跳过')
  assert.deepEqual(mergeSettings({ a: 1 }, { b: { c: 2 } }), { a: 1, b: { c: 2 } })
  assert.deepEqual(mergeSettings(undefined, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeSettings({ a: 1 }, null), { a: 1 })
})

test('bin/tagger.mjs parseArgs：默认值、显式端口、非法端口、--no-open、--setup', () => {
  const base = parseBinArgs([])
  assert.equal(base.port, DEFAULT_PORT)
  assert.equal(base.portSet, false)
  assert.equal(base.host, DEFAULT_HOST)
  assert.equal(base.open, true, '双击就该开面板，默认开')
  assert.equal(base.setup, false)
  assert.deepEqual(base.extra, [])

  const explicit = parseBinArgs(['--port', '8090', '--host', '0.0.0.0', '--data-dir', '/tmp/d', '--no-open'])
  assert.equal(explicit.port, 8090)
  assert.equal(explicit.portSet, true)
  assert.equal(explicit.host, '0.0.0.0')
  assert.equal(explicit.dataDir, '/tmp/d')
  assert.equal(explicit.open, false)
  assert.equal(explicit.openSet, true)

  const inline = parseBinArgs(['--port=8100', '--model=m1'])
  assert.equal(inline.port, 8100)
  assert.deepEqual(inline.extra, ['--model', 'm1'])

  const bad = parseBinArgs(['--port', 'abc'])
  assert.equal(bad.port, DEFAULT_PORT, '非法端口回落默认值')
  assert.equal(bad.portSet, false)
  assert.equal(bad.warnings.length, 1)

  const outOfRange = parseBinArgs(['--port', '70000'])
  assert.equal(outOfRange.port, DEFAULT_PORT)
  assert.equal(outOfRange.warnings.length, 1)

  assert.equal(parseBinArgs(['--setup']).setup, true)
  assert.equal(parseBinArgs(['--help']).help, true)
  assert.equal(parseBinArgs(['-v']).version, true)

  const unknown = parseBinArgs(['--nope', '1'])
  assert.equal(unknown.warnings.length, 1)
  assert.deepEqual(unknown.extra, [])

  // 用法文本要给出面板地址（默认端口）
  const usage = usageText()
  assert.ok(usage.includes(String(DEFAULT_PORT)))
  assert.ok(usage.split('\n').length <= 6, '用法不超过 6 行')
})

test('setup --yes --print：只打印 JSON、不落盘，且刻意不写 llm', async () => {
  const dir = tempDir('print')
  try {
    const result = await runNode([SETUP, '--yes', '--print', '--data-dir', dir])
    assert.equal(result.code, 0, 'stderr=' + result.stderr)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.comfy.baseUrl, DEFAULT_COMFY_URL)
    assert.equal(parsed.server.port, DEFAULT_PORT)
    assert.equal(parsed.llm, undefined, '--yes 不替用户选模型：llm 段不该出现')
    assert.match(result.stderr, /llm\.baseUrl/, '--print 要把「不会写哪些键」说清')
    assert.deepEqual(fs.readdirSync(dir), [], '--print 不该写 any 文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setup --yes：真写 settings.json，二次运行保留原有未覆盖键', async () => {
  const dir = tempDir('write')
  try {
    const first = await runNode([SETUP, '--yes', '--data-dir', dir])
    assert.equal(first.code, 0, 'stderr=' + first.stderr)
    const file = settingsPathOf(dir)
    assert.ok(fs.existsSync(file), '应当写出 ' + file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.comfy.baseUrl, DEFAULT_COMFY_URL)
    assert.equal(settings.server.host, DEFAULT_HOST)
    assert.equal(settings.llm, undefined, '--yes 不该写 llm 段')

    // 手工塞两个向导不会碰的键，再跑一次：必须还在
    settings.llm = { apiKey: 'sk-keep-me' }
    settings.ui = { keepHistory: 9 }
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')

    const second = await runNode([SETUP, '--yes', '--data-dir', dir, '--port', '8095'])
    assert.equal(second.code, 0, 'stderr=' + second.stderr)
    const again = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(again.llm.apiKey, 'sk-keep-me', '第二次运行不能清掉已填的 key')
    assert.deepEqual(again.ui, { keepHistory: 9 })
    assert.equal(again.server.port, 8095, '命令行给的端口覆盖旧值')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('全回车（没有终端）等同全跳过：settings.json 里不该冒出 llm 段', async () => {
  const dir = tempDir('skip')
  try {
    const result = await runNode([SETUP, '--data-dir', dir])
    assert.equal(result.code, 0, 'stderr=' + result.stderr)
    const settings = JSON.parse(fs.readFileSync(settingsPathOf(dir), 'utf8'))
    assert.equal(settings.llm, undefined, '全跳过时不该有 llm 段')
    assert.equal(settings.server.port, DEFAULT_PORT)
    assert.equal(settings.comfy.baseUrl, DEFAULT_COMFY_URL)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bin/tagger.mjs --help / --version', async () => {
  const help = await runNode([BIN, '--help'])
  assert.equal(help.code, 0, 'stderr=' + help.stderr)
  assert.ok(help.stdout.includes(String(DEFAULT_PORT)), '用法里要有默认端口')
  assert.ok(help.stdout.includes('/tagger/api'))

  const version = await runNode([BIN, '--version'])
  assert.equal(version.code, 0, 'stderr=' + version.stderr)
  assert.equal(version.stdout.trim(), PKG.version)
  assert.equal(versionText(), PKG.version)
})

test('一键脚本：三条运行时路径都在 start.* 里，deploy.* 只转发', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf8')
  assert.match(sh, /command -v node/)
  assert.match(sh, /command -v nodejs/)
  assert.match(sh, /\.runtime\/node\/bin\/node/, 'POSIX 便携版 node 路径')
  assert.match(sh, /command -v docker/)
  assert.match(sh, /docker compose up --build/)
  assert.match(sh, /bin\/tagger\.mjs/)

  const cmd = fs.readFileSync(path.join(ROOT, 'start.cmd'), 'utf8')
  assert.match(cmd, /where node/)
  assert.match(cmd, /where docker/)
  assert.match(cmd, /:ensureNode/)
  assert.match(cmd, /node-v%NODEVER%-win-x64\\node\.exe/)
  assert.match(cmd, /bin\\tagger\.mjs/)

  // deploy.* 只剩转发：三条路的判断和下载逻辑不许再抄一份
  for (const rel of ['deploy.sh', 'deploy.cmd']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    assert.ok(text.trimEnd().split('\n').length <= 5, rel + ' 应该只有转发这几行：' + text)
    assert.doesNotMatch(text, /Invoke-WebRequest|Expand-Archive|docker compose up/, rel + ' 不该重复运行时逻辑')
  }
})
