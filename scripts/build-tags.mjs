#!/usr/bin/env node
// plan: scripts/build-tags.mjs 归一化 danbooru jsonl 到 <dir>/tags，并报告条目/分类/overlay/重复/缺中文统计
/**
 * scripts/build-tags.mjs — 把本机 danbooru jsonl 归一化到 <dir>/tags/*.jsonl。
 *
 * 为什么要有这一步：插件默认直接读本机原始数据；但如果用户把它挪走、
 * 或者想给别的东西一份干净数据，就得有一个稳定格式。归一化后每行是
 *   {"tag":"1girl","kind":"general","postCount":8314081,"names":["一个女孩",...],"note":"..."}
 * 去掉了 updatedAt、合并了同一个 tag、按 postCount 降序。
 *
 * 用法（本机没有 node 命令，用宿主自带的 node 运行时）：
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/build-tags.mjs
 *   ... --from D:/QUARK/dsh-comfyui-workbench/data/danbooru --out D:/tmp/tags
 *   ... --min-post 100 --quiet --json
 *
 * 统计口径（默认打印，--json 时整份 JSON）：
 *   总条目 / 四个分类计数 / 重复 tag（同名出现多次）/ 缺中文条数
 *   overlay（data/tags 与 <dir>/tags 的补词表）覆盖了多少输出词、还有多少没进输出
 *
 * 纯可选：不跑它插件照样工作（lib/tags.js 会直接读原始 jsonl）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { discoverDataDir, normalizeKind, primaryChineseName } from '../lib/tags.js'
import { addRecord, listAllJsonlFiles, overlayDirs, readJsonl } from '../lib/tags/loader.js'

const OUT_FILES = {
  general: 'general.jsonl',
  character: 'characters.jsonl',
  copyright: 'copyrights.jsonl',
  artist: 'artists.jsonl',
}

export function usage() {
  return [
    '用法: build-tags.mjs [--from <dir>] [--out <dir>] [--min-post <n>] [--quiet] [--json]',
    '',
    '  --from  源目录（默认自动探测本机 comfyui workbench 的 danbooru 数据）',
    '  --out   输出目录（默认 ~/.dsh-prompt-forge/tags）',
    '  --min-post 低于该 postCount 的 tag 丢掉（默认 0，全收）',
    '  --quiet 只打印结果',
    '  --json  打印机器可读的统计（含 byKind / duplicates / missingChinese / overlay）',
  ].join('\n')
}

export function parseArgs(argv) {
  const out = { from: '', out: '', minPost: 0, quiet: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--quiet' || arg === '-q') out.quiet = true
    else if (arg === '--json') out.json = true
    else if (arg === '--from') out.from = String(argv[++i] ?? '')
    else if (arg === '--out') out.out = String(argv[++i] ?? '')
    else if (arg === '--min-post') out.minPost = Number.parseInt(String(argv[++i] ?? '0'), 10) || 0
    else if (arg.startsWith('--from=')) out.from = arg.slice(7)
    else if (arg.startsWith('--out=')) out.out = arg.slice(6)
    else if (arg.startsWith('--min-post=')) out.minPost = Number.parseInt(arg.slice(11), 10) || 0
    else {
      console.error('不认识的参数: ' + arg)
      console.error(usage())
      process.exit(2)
    }
  }
  if (!Number.isFinite(out.minPost) || out.minPost < 0) out.minPost = 0
  return out
}

function normKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_')
}

function pushName(list, value) {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (text === '' || list.includes(text)) return
  list.push(text)
}

/** 读一个 jsonl 文件，把记录合并进 buckets: Map<kind, Map<tag, record>>。 */
async function readInto(file, buckets, minPost, stats) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  let first = true
  try {
    for await (const line of reader) {
      stats.lines++
      const text = first ? line.replace(/^\uFEFF/, '') : line
      first = false
      if (text.trim() === '') continue
      let record
      try {
        record = JSON.parse(text)
      } catch {
        stats.bad++
        continue
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        stats.bad++
        continue
      }
      const key = normKey(typeof record.tag === 'string' ? record.tag : record.name)
      if (key === '') {
        stats.bad++
        continue
      }
      const kind = normalizeKind(record.kind)
      const postCount = Number.isFinite(record.postCount)
        ? record.postCount
        : Number.isFinite(record.count) ? record.count : 0
      if (postCount < minPost) {
        stats.dropped++
        continue
      }
      stats.seen.set(key, (stats.seen.get(key) ?? 0) + 1)
      const bucket = buckets.get(kind)
      const existing = bucket.get(key)
      const names = existing === undefined ? [] : existing.names
      if (Array.isArray(record.names)) for (const name of record.names) pushName(names, name)
      else if (Array.isArray(record.aliases)) for (const name of record.aliases) pushName(names, name)
      pushName(names, record.cn)
      pushName(names, record.chinese)
      const note =
        typeof record.note === 'string' ? record.note
          : typeof record.description === 'string' ? record.description : ''
      if (existing === undefined) {
        bucket.set(key, { tag: key, kind, postCount, names, note })
        stats.kept++
      } else {
        if (postCount > existing.postCount) existing.postCount = postCount
        if (existing.note === '' && note !== '') existing.note = note
        if (existing.kind === 'general' && kind !== 'general') existing.kind = kind
      }
    }
  } finally {
    reader.close()
    stream.destroy()
  }
}

async function writeBucket(file, rows) {
  const temp = file + '.tmp'
  const handle = await fsp.open(temp, 'w')
  try {
    let chunk = []
    let bytes = 0
    for (const row of rows) {
      const line = JSON.stringify(row) + '\n'
      chunk.push(line)
      bytes += line.length
      if (chunk.length >= 2000) {
        await handle.write(chunk.join(''))
        chunk = []
      }
    }
    if (chunk.length > 0) await handle.write(chunk.join(''))
    await handle.close()
    await fsp.rename(temp, file)
    return bytes
  } catch (error) {
    try {
      await handle.close()
    } catch {}
    try {
      await fsp.unlink(temp)
    } catch {}
    throw error
  }
}

/**
 * 读 overlay 词表（插件自带 data/tags 与 <out 的上级>/tags），只取 tag 名字集合。
 * 用来回答「补的词表覆盖了多少归一化结果、还有多少没落到输出里」。
 */
async function readOverlayTags(destination) {
  const dirs = overlayDirs(path.dirname(destination))
  const files = []
  const entries = new Map()
  for (const dir of dirs) {
    for (const file of await listAllJsonlFiles(dir)) {
      try {
        await readJsonl(file, record => addRecord(entries, record, undefined))
        files.push(file)
      } catch {
        // 读不动就当没有，统计不因此失败
      }
    }
  }
  return { dirs, files, tags: new Set(entries.keys()) }
}

/** 归一化的全部工作；返回 summary（含 ok 字段），供 CLI 与测试共用。 */
export async function runNormalize(options = {}) {
  const args = {
    from: typeof options.from === 'string' ? options.from : '',
    out: typeof options.out === 'string' ? options.out : '',
    minPost: Number.isFinite(options.minPost) ? Math.max(0, options.minPost) : 0,
    quiet: options.quiet === true,
  }
  const destination = args.out !== ''
    ? path.resolve(args.out)
    : path.join(os.homedir(), '.dsh-prompt-forge', 'tags')

  const discovery = args.from !== ''
    ? await discoverDataDir({ dataDirs: [args.from], probeDefaults: false })
    : await discoverDataDir({ probeDefaults: true })

  if (discovery.files.length === 0) {
    return {
      ok: false,
      reason: 'no-data',
      destination,
      candidates: discovery.candidates,
      total: 0,
      byKind: { general: 0, character: 0, copyright: 0, artist: 0 },
      files: [],
      lines: 0,
      bad: 0,
      kept: 0,
      dropped: 0,
      duplicates: { tags: 0, rows: 0 },
      missingChinese: 0,
      overlay: { dirs: overlayDirs(path.dirname(destination)), files: 0, tags: 0, covered: 0, missing: 0 },
      minPost: args.minPost,
    }
  }

  const buckets = new Map(Object.keys(OUT_FILES).map(kind => [kind, new Map()]))
  const stats = { lines: 0, bad: 0, kept: 0, dropped: 0, seen: new Map() }
  for (const file of discovery.files) {
    if (!args.quiet) console.log('读 ' + file)
    await readInto(file, buckets, args.minPost, stats)
  }

  await fsp.mkdir(destination, { recursive: true })
  const written = []
  const byKind = { general: 0, character: 0, copyright: 0, artist: 0 }
  let missingChinese = 0
  const outputTags = new Set()
  for (const [kind, name] of Object.entries(OUT_FILES)) {
    const bucket = buckets.get(kind)
    if (bucket.size === 0) continue
    const rows = [...bucket.values()].sort((a, b) => b.postCount - a.postCount || a.tag.localeCompare(b.tag))
    for (const row of rows) {
      outputTags.add(row.tag)
      if (primaryChineseName(row.names) === '') missingChinese++
    }
    const file = path.join(destination, name)
    const bytes = await writeBucket(file, rows)
    byKind[kind] = rows.length
    written.push({ kind, file, rows: rows.length, bytes })
  }

  let duplicateTags = 0
  let duplicateRows = 0
  for (const count of stats.seen.values()) {
    if (count > 1) {
      duplicateTags++
      duplicateRows += count - 1
    }
  }

  const overlay = await readOverlayTags(destination)
  let covered = 0
  for (const tag of overlay.tags) if (outputTags.has(tag)) covered++

  const total = written.reduce((sum, item) => sum + item.rows, 0)
  const meta = {
    builtAt: new Date().toISOString(),
    source: discovery.dir,
    sourceFiles: discovery.files,
    counts: byKind,
    total,
    lines: stats.lines,
    badLines: stats.bad,
    dropped: stats.dropped,
    duplicates: { tags: duplicateTags, rows: duplicateRows },
    missingChinese,
    overlay: { files: overlay.files.length, tags: overlay.tags.size, covered, missing: overlay.tags.size - covered },
    minPost: args.minPost,
  }
  await fsp.writeFile(path.join(destination, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')

  return {
    ok: true,
    destination,
    source: discovery.dir,
    sourceFiles: discovery.files,
    total,
    byKind,
    files: written,
    lines: stats.lines,
    bad: stats.bad,
    kept: stats.kept,
    dropped: stats.dropped,
    duplicates: { tags: duplicateTags, rows: duplicateRows },
    missingChinese,
    overlay: {
      dirs: overlay.dirs,
      files: overlay.files.length,
      fileList: overlay.files,
      tags: overlay.tags.size,
      covered,
      missing: overlay.tags.size - covered,
    },
    minPost: args.minPost,
  }
}

/** 人读版统计。 */
export function summaryToText(summary) {
  if (summary.ok === false) {
    const lines = ['没找到 danbooru jsonl。试过的目录：']
    for (const candidate of summary.candidates ?? []) lines.push('  - ' + candidate)
    lines.push('用 --from 指定目录再试。')
    return lines.join('\n')
  }
  const lines = ['']
  lines.push('源目录: ' + (summary.source || summary.sourceFiles.join(', ')))
  lines.push('输出目录: ' + summary.destination)
  for (const item of summary.files) {
    lines.push('  ' + item.kind.padEnd(10) + String(item.rows).padStart(7) + ' 条  '
      + (item.bytes / 1048576).toFixed(2) + ' MB  ' + path.basename(item.file))
  }
  lines.push('合计 ' + summary.total + ' 条'
    + '（general ' + summary.byKind.general + ' / character ' + summary.byKind.character
    + ' / copyright ' + summary.byKind.copyright + ' / artist ' + summary.byKind.artist + '）')
  lines.push('读 ' + summary.lines + ' 行，坏行 ' + summary.bad + '，低于阈值丢弃 ' + summary.dropped
    + '，重复 tag ' + summary.duplicates.tags + ' 个（多 ' + summary.duplicates.rows + ' 行）'
    + '，缺中文 ' + summary.missingChinese + ' 条')
  lines.push('overlay：' + summary.overlay.files + ' 个文件 / ' + summary.overlay.tags + ' 个词，覆盖输出 '
    + summary.overlay.covered + ' 个，未进输出 ' + summary.overlay.missing + ' 个')
  return lines.join('\n')
}

/** 机器读版统计（--json）。 */
export function summaryToJson(summary) {
  return JSON.stringify(summary, null, 2)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return 0
  }
  const summary = await runNormalize(args)
  if (summary.ok === false) {
    console.error(summaryToText(summary))
    return 1
  }
  console.log(args.json ? summaryToJson(summary) : summaryToText(summary))
  return summary.total === 0 ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  process.exitCode = await main()
}
