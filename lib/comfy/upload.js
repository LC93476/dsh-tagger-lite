/**
 * lib/comfy/upload.js —— 参考图上传：把字节写进 ComfyUI 的 input 目录，返回可给 LoadImage 用的文件名。
 *
 * 为什么单独一层：这条路不碰 ComfyUI 的 HTTP 接口，只碰本地文件系统（comfy.launchDir/input），
 * 出错码全是文件语义（no-launch-dir / bad-type / empty-file / too-large / write-failed），
 * 和投递/轮询的 network 语义混在一个文件里，改哪边都要重读另一边的字段。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { msgOf, toBuffer } from '../backend-common.js'

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
    const raw = typeof filename === 'string' ? filename : ''
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(raw).toLowerCase()) === false) return { ok: false, error: 'bad-type', message: '只收 png / jpg / webp 参考图' }
    if (typeof data !== 'string' || data.trim() === '') return { ok: false, error: 'empty-file', message: '参考图是空的' }
    const buffer = toBuffer(data)
    if (buffer.length === 0) return { ok: false, error: 'empty-file', message: '参考图是空的' }
    if (buffer.length > 24 * 1024 * 1024) return { ok: false, error: 'too-large', message: '参考图超过 24MB，先压一下' }
    const dir = path.join(launchDir, 'input', typeof subfolder === 'string' ? subfolder.trim() : '')
    const base = raw.replace(/[^\w.-]+/g, '_').replace(/^_+/, '').slice(0, 60) || 'ref'
    const name = 'tagger_ref_' + crypto.randomBytes(4).toString('hex') + '_' + base
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), buffer)
    } catch (error) {
      return { ok: false, error: 'write-failed', message: '写不进 ComfyUI 的 input 目录：' + msgOf(error) }
    }
    return { ok: true, name, bytes: buffer.length, dir, hint: '把 name 填进 vars.image' }
  }

  return { upload }
}
