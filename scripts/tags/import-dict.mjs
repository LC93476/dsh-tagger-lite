#!/usr/bin/env node
/**
 * 把本机的全量 Danbooru 词表快照拷进仓库的 data/danbooru/。
 *
 * 为什么需要：lib/tags/loader.js 的探测顺序里 <仓库>/data/danbooru 排得很靠前——只要这几份
 * jsonl 躺在仓库里，任何一份 checkout / 下载版解压后都能直接拿到 99447 条词，不必再设
 * DSH_DANBOORU_DIR 或 tags.dataDirs，也不会退化成只剩 1247 行补词。
 *
 * 用法：
 *   node scripts/tags/import-dict.mjs                     自动探测源目录，拷进 data/danbooru
 *   node scripts/tags/import-dict.mjs --from <词表目录>    指定源目录
 *   node scripts/tags/import-dict.mjs --check              只校验仓库快照与源是否一致
 *   node scripts/tags/import-dict.mjs --dry                只看会做什么，不写盘
 *   node scripts/tags/import-dict.mjs --force              目标不一致时覆盖（默认拒绝）
 *
 * 退出码：0 成功或一致；1 校验不一致（--check）；2 用法或数据不合格。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 主词表四份 + 分组表（groups.jsonl 只给 suggest-overlay 用，缺了不算错）。 */
export const DICT_FILES = ["general.jsonl", "characters.jsonl", "copyrights.jsonl", "artists.jsonl", "groups.jsonl"]
export const REQUIRED_FILES = ["general.jsonl"]
/** general.jsonl 少于这么多行就当成拿错目录（只装了 seed 时一共才 1247 行）。 */
export const MIN_GENERAL_LINES = 20000

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 解析命令行。 */
export function parseArgs(argv) {
  const out = { from: "", to: "", force: false, check: false, dry: false, quiet: false, json: false, min: MIN_GENERAL_LINES, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) throw new Error("缺少参数值：" + arg)
      i += 1
      return v
    }
    if (arg === "--from") out.from = next()
    else if (arg === "--to") out.to = next()
    else if (arg === "--min") out.min = Number(next())
    else if (arg === "--force") out.force = true
    else if (arg === "--check") out.check = true
    else if (arg === "--dry") out.dry = true
    else if (arg === "--quiet") out.quiet = true
    else if (arg === "--json") out.json = true
    else if (arg === "--help" || arg === "-h") out.help = true
    else throw new Error("未知参数：" + arg)
  }
  if (!Number.isFinite(out.min) || out.min < 0) throw new Error("--min 必须是数字")
  return out
}

export function usageText() {
  return [
    "把全量 Danbooru 词表快照拷进仓库 data/danbooru/，让每份 checkout 开箱即用。",
    "",
    "用法：node scripts/tags/import-dict.mjs [选项]",
    "",
    "  --from <目录>   源词表目录（默认依次看 DSH_DANBOORU_DIR、DSH_COMFYUI_DATA_DIR、",
    "                  ~/.dsh-comfyui-workbench/data/danbooru）",
    "  --to <目录>     目标目录（默认 <仓库>/data/danbooru）",
    "  --min <行数>    general.jsonl 的行数下限，默认 " + MIN_GENERAL_LINES + "（防拿错目录）",
    "  --check         只校验一致性，不写盘；不一致退出码 1",
    "  --dry           只打印计划",
    "  --force         目标已存在且内容不同时覆盖",
    "  --json          输出机器可读结果",
    "  --quiet         只报错误",
    "  --help          这段说明",
    "",
    "拷完之后：main 词表 99447 条会直接从 <仓库>/data/danbooru 加载，",
    "不再需要 settings.json 里的 tags.dataDirs 或环境变量 DSH_DANBOORU_DIR。"
  ].join("\n")
}

/** 探测源目录：显式参数 > 环境变量 > 家目录的标准位置。 */
export function resolveSourceDir(explicit, env = process.env, home = os.homedir()) {
  const candidates = [
    explicit,
    env.DSH_DANBOORU_DIR,
    env.DSH_COMFYUI_DATA_DIR,
    path.join(home, ".dsh-comfyui-workbench", "data", "danbooru"),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return path.resolve(candidate.trim())
  }
  return ""
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

/**
 * 体检一个词表目录：文件在不在、每行能不能解析、行数与 tag 数、sha256。
 * 返回 { ok, dir, found, absent, problems }，problems[].code 取值见 checkDictDir 注释。
 */
export function inspectDictDir(dir, min = MIN_GENERAL_LINES) {
  const result = { ok: false, dir: dir || "", found: [], absent: [], problems: [] }
  const fail = (code, message) => { result.problems.push({ code, message }); return result }
  if (!dir || !existsSync(dir)) return fail("no-dir", "词表目录不存在：" + (dir || "(空)"))
  let stat
  try { stat = statSync(dir) } catch (err) { return fail("no-dir", "词表目录读不了：" + dir) }
  if (!stat.isDirectory()) return fail("no-dir", "不是目录：" + dir)
  for (const name of DICT_FILES) {
    const file = path.join(dir, name)
    if (!existsSync(file)) {
      result.absent.push(name)
      if (REQUIRED_FILES.includes(name)) fail("no-general", "缺少主词表文件：" + file)
      continue
    }
    const text = readFileSync(file, "utf8")
    const rows = text.split(/\r?\n/)
    let lines = 0
    let bad = 0
    let badSample = ""
    const seen = new Set()
    for (const row of rows) {
      const line = row.trim()
      if (line === "") continue
      lines += 1
      let parsed
      try { parsed = JSON.parse(line) } catch (err) { bad += 1; if (badSample === "") badSample = line.slice(0, 60); continue }
      const tag = typeof parsed.tag === "string" ? parsed.tag.trim() : ""
      if (tag !== "") seen.add(tag)
    }
    const entry = { name, file, lines, tags: seen.size, bytes: Buffer.byteLength(text, "utf8"), sha256: sha256(text) }
    if (lines === 0) { fail("empty-file", "文件是空的：" + file); }
    if (bad > 0) fail("bad-json", file + " 有 " + bad + " 行不是合法 JSON，例如：" + badSample)
    if (name === "general.jsonl" && lines < min) {
      fail("too-few-lines", file + " 只有 " + lines + " 行（下限 " + min + "），这大概不是全量词表")
    }
    result.found.push(entry)
  }
  result.ok = result.problems.length === 0
  return result
}

/** 逐个文件比对两份目录：same 为 true 表示所有源文件在目标里都有且 sha256 相同。 */
export function compareDict(source, target) {
  const out = { same: true, missing: [], differ: [] }
  for (const entry of source.found) {
    const file = path.join(target, entry.name)
    if (!existsSync(file)) { out.missing.push(entry.name); out.same = false; continue }
    let text = ""
    try { text = readFileSync(file, "utf8") } catch (err) { out.differ.push(entry.name); out.same = false; continue }
    if (sha256(text) !== entry.sha256) { out.differ.push(entry.name); out.same = false }
  }
  return out
}

function writeAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now()
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch (ignored) { void ignored }
    throw err
  }
}

/**
 * 主流程：体检源目录 → （可选）比对目标 → 写文件与 manifest.json。
 * 返回 { ok, code, message, source, target, files, written, skipped, check }。
 */
export function importDict(options = {}) {
  const {
    from = "",
    to = path.join(REPO_ROOT, "data", "danbooru"),
    force = false,
    check = false,
    dry = false,
    min = MIN_GENERAL_LINES,
  } = options
  const source = inspectDictDir(from, min)
  if (!source.ok) {
    return { ok: false, code: source.problems[0].code, message: source.problems[0].message, source: source.dir, target: to, files: [], written: [], skipped: [], check }
  }
  if (check) {
    const diff = compareDict(source, to)
    if (diff.same) return { ok: true, code: "same", message: "仓库快照与源一致", source: source.dir, target: to, files: source.found, written: [], skipped: [], check }
    const parts = []
    if (diff.missing.length > 0) parts.push("缺 " + diff.missing.join(" / "))
    if (diff.differ.length > 0) parts.push("不一致 " + diff.differ.join(" / "))
    return { ok: false, code: "different", message: "仓库快照与源不同：" + parts.join("；"), source: source.dir, target: to, files: source.found, written: [], skipped: [], check, diff }
  }
  const existing = []
  for (const entry of source.found) {
    if (existsSync(path.join(to, entry.name))) existing.push(entry.name)
  }
  if (existing.length > 0 && !force) {
    const diff = compareDict(source, to)
    if (diff.same) return { ok: true, code: "same", message: "目标已是最新，未改动", source: source.dir, target: to, files: source.found, written: [], skipped: source.found.map((f) => f.name), check }
    return { ok: false, code: "exists", message: "目标已有内容且与源不同：" + (diff.differ.concat(diff.missing).join(" / ")) + "；确认要覆盖请加 --force", source: source.dir, target: to, files: source.found, written: [], skipped: [], check }
  }
  if (dry) {
    return { ok: true, code: "dry", message: "只打印计划，未写盘", source: source.dir, target: to, files: source.found, written: source.found.map((f) => f.name), skipped: [], check }
  }
  mkdirSync(to, { recursive: true })
  const written = []
  for (const entry of source.found) {
    writeAtomic(path.join(to, entry.name), readFileSync(entry.file))
    written.push(entry.name)
  }
  const manifest = {
    source: source.dir,
    importedAt: new Date().toISOString(),
    minGeneralLines: min,
    files: source.found.map((f) => ({ name: f.name, lines: f.lines, tags: f.tags, bytes: f.bytes, sha256: f.sha256 })),
  }
  writeAtomic(path.join(to, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  return { ok: true, code: "imported", message: "已写入 " + written.length + " 份词表", source: source.dir, target: to, files: source.found, written, skipped: source.absent, check }
}

function fmtMB(bytes) { return (bytes / 1024 / 1024).toFixed(1) + "MB" }

export function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  let opts
  try { opts = parseArgs(argv) } catch (err) {
    io.err("参数错误：" + err.message)
    io.err(usageText())
    return 2
  }
  if (opts.help) { io.out(usageText()); return 0 }
  const from = resolveSourceDir(opts.from)
  if (from === "") {
    io.err("没找到词表目录：用 --from 指定，或设 DSH_DANBOORU_DIR，或把它放到 ~/.dsh-comfyui-workbench/data/danbooru")
    return 2
  }
  const result = importDict({ from, to: opts.to || path.join(REPO_ROOT, "data", "danbooru"), force: opts.force, check: opts.check, dry: opts.dry, min: opts.min })
  if (opts.json) { io.out(JSON.stringify(result, null, 2)); return result.ok ? 0 : result.code === "different" ? 1 : 2 }
  if (!opts.quiet && result.files.length > 0) {
    io.out("源：" + result.source)
    io.out("目标：" + result.target)
    const rows = result.files.map((f) => "  " + f.name.padEnd(18) + String(f.lines).padStart(7) + " 行  " + String(f.tags).padStart(6) + " tag  " + fmtMB(f.bytes).padStart(7) + "  " + f.sha256.slice(0, 12))
    io.out(rows.join("\n"))
  }
  if (result.ok) { if (!opts.quiet) io.out("✓ " + result.message); return 0 }
  io.err("✗ " + result.message)
  return result.code === "different" ? 1 : 2
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
