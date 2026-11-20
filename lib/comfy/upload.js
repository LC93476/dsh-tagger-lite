/**
 * lib/comfy/upload.js —— 参考图上传：把字节写进 ComfyUI 的 input 目录，返回可给 LoadImage 用的文件名。
 *
 * 为什么单独一层：这条路不碰 ComfyUI 的 HTTP 接口，只碰本地文件系统（comfy.launchDir/input），
 * 出错码全是文件语义（no-launch-dir / bad-type / bad-path / empty-file / too-large / write-failed），
 * 和投递/轮询的 network 语义混在一个文件里，改哪边都要重读另一边的字段。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { msgOf, toBuffer } from '../backend-common.js'

/** 只收这几种扩展名，其余一律 bad-type */
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp']
/** stem 截断长度：够辨识（语义前缀 + 时间戳），又不至于把 input 目录刷爆 */
const STEM_MAX = 48
/** 文件名 stem 与子目录段里允许留下的字符，其余换成下划线 */
const UNSAFE = /[^\w.-]+/g

/**
 * 把一段名字压成安全字符：非法字符换下划线，去掉开头的点/下划线，超长截断。
 * 只对 stem 与子目录段用 —— 扩展名单独保留，绝不参与截断。
 * @param {string} raw @param {number} max @returns {string}
 */
function safeStem(raw, max) {
  const cleaned = String(raw).replace(UNSAFE, '_').replace(/^[._]+/, '')
  const cut = cleaned.slice(0, max)
  return cut === '' || cut === '.' || cut === '..' ? 'ref' : cut
}

/**
 * 规范化客户端给的 subfolder：统一分隔符成 / ，逐段剔掉空段与单个点。
 * 任何上级目录段、绝对路径、盘符、NUL 都是越界信号，整条请求直接拒掉
 * （宁可少一层目录，也不让写到 input 外面）。
 * @param {unknown} raw
 * @returns {{ ok: true, segments: string[] } | { ok: false }}
 */
function cleanSubfolder(raw) {
  if (typeof raw !== 'string') return { ok: true, segments: [] }
  const text = raw.trim()
  if (text === '') return { ok: true, segments: [] }
  if (text.includes('\u0000') === true) return { ok: false }
  const unified = text.replace(/[\\/]+/g, '/')
  if (unified.startsWith('/') === true) return { ok: false }
  if (/^[a-zA-Z]:/.test(unified) === true) return { ok: false }
  const segments = []
  for (const piece of unified.split('/')) {
    if (piece === '' || piece === '.') continue
    if (piece === '..') return { ok: false }
    segments.push(safeStem(piece, 32))
  }
  return { ok: true, segments }
}

/**
 * 从客户端给的文件名里剥掉路径、拆出扩展名与 stem。
 * 先剥路径再判断扩展名：不管传进来的是 .. 相对路径还是盘符路径，都只看最后一段。
 * @param {string} raw
 * @returns {{ ext: string, stem: string }}
 */
function splitName(raw) {
  const slash = String(raw).replace(/[\\/]+/g, '/')
  const base = slash.slice(slash.lastIndexOf('/') + 1)
  const ext = path.posix.extname(base).toLowerCase()
  const stem = ext === '' ? base : base.slice(0, base.length - ext.length)
  return { ext, stem }
}

/**
 * @param {{ config?: Record<string, any>, logger?: any }} deps 配置对象每次现读（面板改完立刻生效），不要闭包捕获旧引用
 */
export function createUploader({ config } = {}) {
  /**
   * 上传参考图：写进 ComfyUI 的 input 目录，返回可给 LoadImage 用的文件名。
   * @param {{ filename?: string, data?: string, subfolder?: string }} [options]
   */
  async function upload({ filename, data, subfolder } = {}) {
    const launchDir = typeof config?.comfy?.launchDir === 'string' ? config.comfy.launchDir.trim() : ''
    if (launchDir === '') return { ok: false, error: 'no-launch-dir', message: '还没配 comfy.launchDir，找不到 ComfyUI 的 input 目录' }
    const { ext, stem } = splitName(typeof filename === 'string' ? filename : '')
    if (ALLOWED_EXT.includes(ext) === false) return { ok: false, error: 'bad-type', message: '只收 png / jpg / webp 参考图' }
    const sub = cleanSubfolder(subfolder)
    if (sub.ok === false) return { ok: false, error: 'bad-path', message: 'subfolder 只能是 input 目录下的相对子目录' }
    const inputRoot = path.resolve(launchDir, 'input')
    const dir = sub.segments.length === 0 ? inputRoot : path.resolve(inputRoot, sub.segments.join('/'))
    if (dir !== inputRoot && dir.startsWith(inputRoot + path.sep) === false) return { ok: false, error: 'bad-path', message: 'subfolder 只能是 input 目录下的相对子目录' }
    if (typeof data !== 'string' || data.trim() === '') return { ok: false, error: 'empty-file', message: '参考图是空的' }
    const buffer = toBuffer(data)
    if (buffer.length === 0) return { ok: false, error: 'empty-file', message: '参考图是空的' }
    if (buffer.length > 24 * 1024 * 1024) return { ok: false, error: 'too-large', message: '参考图超过 24MB，先压一下' }
    const fileName = 'tagger_ref_' + crypto.randomBytes(4).toString('hex') + '_' + safeStem(stem, STEM_MAX) + ext
    // 返回给 LoadImage 的是 input 目录内的 POSIX 相对路径（带子目录时形如 refs/xxx.png）
    const name = sub.segments.length === 0 ? fileName : sub.segments.join('/') + '/' + fileName
    try {
      await fs.promises.mkdir(dir, { recursive: true })
      await fs.promises.writeFile(path.join(dir, fileName), buffer)
    } catch (error) {
      return { ok: false, error: 'write-failed', message: '写不进 ComfyUI 的 input 目录：' + msgOf(error) }
    }
    return { ok: true, name, bytes: buffer.length, dir, hint: '把 name 填进 vars.image' }
  }

  return { upload }
}
