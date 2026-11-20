/**
 * 拉起本机 ComfyUI。
 *
 * 为什么放在插件里：面板上点了「启动」就该起，而不是让用户自己去开终端。
 * 但它只做「按配置拼命令行 + detach 启动」这一件事 —— 起来之后是否真活着，
 * 由 comfy.ping() 说话（进程起来了不等于服务在监听，尤其模型还在加载）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 常见安装位置，从环境变量到 aki 版默认路径再到家目录。 */
function candidates() {
  const list = [process.env.COMFYUI_DIR, 'C:/ComfyUI', 'C:/ComfyUI-aki/ComfyUI']
  const home = os.homedir()
  list.push(path.join(home, 'ComfyUI'), path.join(home, 'Documents', 'ComfyUI'), path.join(home, 'comfyui'))
  return list.filter(item => typeof item === 'string' && item.trim() !== '')
}

function isComfyDir(dir) {
  try {
    return fs.existsSync(path.join(dir, 'main.py'))
  } catch {
    return false
  }
}

function pythonIn(dir) {
  const guesses = [
    path.join(dir, '..', 'python', 'python.exe'),
    path.join(dir, '..', 'python', 'python'),
    path.join(dir, 'venv', 'Scripts', 'python.exe'),
    path.join(dir, 'venv', 'bin', 'python'),
    path.join(dir, '.venv', 'Scripts', 'python.exe'),
    path.join(dir, '.venv', 'bin', 'python'),
  ]
  for (const guess of guesses) {
    try {
      if (fs.existsSync(guess)) return guess
    } catch {
      // 权限问题当作没有
    }
  }
  return ''
}

function portOf(baseUrl) {
  try {
    const url = new URL(String(baseUrl ?? 'http://127.0.0.1:8188'))
    if (url.port !== '') return url.port
    return url.protocol === 'https:' ? '443' : '80'
  } catch {
    return '8188'
  }
}

/**
 * 解析「怎么启动」：目录优先用配置，其次按候选路径探测。
 * 返回 ok:false 时 message 说明是缺目录还是缺 python，面板直接显示。
 */
export function resolveLaunch(config) {
  const comfy = config?.comfy !== null && typeof config?.comfy === 'object' ? config.comfy : {}
  const configuredDir = typeof comfy.launchDir === 'string' ? comfy.launchDir.trim() : ''
  const tried = []
  let dir = ''
  if (configuredDir !== '') {
    tried.push(configuredDir)
    if (isComfyDir(configuredDir)) dir = configuredDir
  }
  if (dir === '') {
    for (const candidate of candidates()) {
      tried.push(candidate)
      if (isComfyDir(candidate)) {
        dir = candidate
        break
      }
    }
  }
  const configuredPython = typeof comfy.pythonPath === 'string' ? comfy.pythonPath.trim() : ''
  const python = configuredPython !== '' ? configuredPython : (dir === '' ? '' : pythonIn(dir)) || 'python'
  const port = portOf(comfy.baseUrl)
  const extra = typeof comfy.launchArgs === 'string' && comfy.launchArgs.trim() !== ''
    ? comfy.launchArgs.trim().split(/\s+/)
    : []
  const args = ['-s', 'main.py', '--port', port, '--preview-method', 'none', ...extra]
  if (dir === '') {
    return {
      ok: false,
      dir: '',
      python,
      port,
      args,
      tried,
      message: '找不到 ComfyUI 目录（要有 main.py）。在面板设置里填 ComfyUI 目录，或设环境变量 COMFYUI_DIR。试过：' + tried.join(' / '),
    }
  }
  return { ok: true, dir, cwd: dir, python, port, args, tried, command: python + ' ' + args.join(' ') }
}

/** 真的起进程。detach + unref：宿主退出不该带走 ComfyUI（模型加载很慢，别让它陪葬）。 */
/**
 * @param {{ config?: any, logger?: any }} [deps]
 */
export function launchComfy({ config, logger } = {}) {
  const plan = resolveLaunch(config)
  if (!plan.ok) return plan
  let child
  try {
    child = spawn(plan.python, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    return { ...plan, ok: false, message: '启动进程失败：' + (error instanceof Error ? error.message : String(error)) }
  }
  const failed = new Promise(resolve => {
    // 注意顺序：plan 里带着 ok:true，必须放在前面被覆盖，否则失败会被当成成功。
    child.once('error', error => resolve({ ...plan, ok: false, message: '启动失败：' + (error instanceof Error ? error.message : String(error)) }))
    setTimeout(() => resolve(null), 1500)
  })
  child.unref()
  logger?.info?.('[prompt-forge] 启动 ComfyUI：' + plan.command + '（cwd ' + plan.cwd + '）')
  return failed.then(error => error ?? { ...plan, ok: true, pid: child.pid ?? 0 })
}
