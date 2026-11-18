// plan: history.json 的读写 —— 首次读懒加载、按 cfg.ui.keepHistory 截断、写盘失败只 warn 不打断锻造。
import fs from 'node:fs'
import { isRecord } from './util.js'

/**
 * @param {{ file: string, dir: string, keepCount: () => number, log: object }} deps
 */
export function createHistoryStore({ file, dir, keepCount, log }) {
  let rows

  function load() {
    if (Array.isArray(rows)) return rows
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      rows = Array.isArray(parsed) ? parsed.filter(isRecord) : []
    } catch {
      rows = []
    }
    return rows
  }

  function push(entry) {
    const keep = keepCount()
    if (keep <= 0) return
    const list = load()
    list.unshift(entry)
    if (list.length > keep) list.length = keep
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
    } catch (error) {
      log.warn('history.json 写入失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  return { load, push, file }
}
