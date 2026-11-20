#!/usr/bin/env node
/**
 * scripts/check-overlay-tags.mjs — 补词表（overlay）与中文意图词的**质量闸门**。
 *
 * scripts/check-tags.mjs 只看结构（JSON 合法、字段类型、同文件重复）。
 * 这个脚本多查三件真正会导致锻造失败/降质的事：
 *   1. 词库外：tag 在真实 danbooru 词表（99k 条）里不存在 —— 锻造时会 warn「不在库里」并被丢弃；
 *   2. 缺中文：cn 为空，面板的中英对照与中文检索都会瞎；
 *   3. 跨文件重复：同一个 tag 在 general-nsfw / pose-view / seed-* 里各写一份，权重与中文会打架。
 * 另外核对 lib/zh-intent.js 的 POSE_HINTS：意图里补的每个 tag 也必须在库里，否则补词等于没补。
 *
 * 用法：
 *   node scripts/check-overlay-tags.mjs                 # 全查，有违规 exit 1
 *   node scripts/check-overlay-tags.mjs --quiet         # 只报汇总与违规清单
 *   node scripts/check-overlay-tags.mjs --json           # 机器可读
 *   node scripts/check-overlay-tags.mjs --max-report 50  # 每类最多列几条（默认 20）
 *
 * 退出码：0 全部通过；1 有违规；2 词表加载失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTagIndex } from '../lib/tags/index.js'
import { POSE_HINTS } from '../lib/zh-intent.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
/** @param {string} name @returns {string | undefined} */
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DIR = path.resolve(argOf("--dir") ?? path.join(ROOT, "data", "tags"))
const MAX_REPORT = Number(argOf("--max-report") ?? 20)
const QUIET = argv.includes("--quiet")
const JSON_OUT = argv.includes("--json")

/** 收集要体检的文件：data/tags/*.jsonl + data/tags/seed/*.jsonl */
function overlayFiles() {
  const out = []
  const top = existsSync(DIR) ? readdirSync(DIR) : []
  for (const name of top.sort()) if (name.endsWith(".jsonl")) out.push(path.join(DIR, name))
  const seedDir = path.join(DIR, "seed")
  const seed = existsSync(seedDir) ? readdirSync(seedDir).sort() : []
  for (const name of seed) if (name.endsWith(".jsonl")) out.push(path.join(seedDir, name))
  return out
}

/** @param {string} file */
function relOf(file) { return path.relative(path.join(ROOT), file).replace(/\\/g, "/") }

const index = createTagIndex({ logger: { info() {}, warn() {}, error() {} } })
await index.ready()
const stats = index.stats()
if (!stats || !stats.total) { console.error("× 词表没加载起来（" + JSON.stringify(stats) + "）"); process.exit(2) }

/** 词库里是否真有这个 tag（返回权威写法或 null）。 @param {string} raw */
function lookup(raw) {
  if (typeof index.get === "function") {
    const hit = index.get(raw)
    if (!hit) return null
    return typeof hit === "string" ? hit : String(hit.tag ?? raw)
  }
  const res = index.canonicalize(raw, { syntax: "comfy" })
  if (!res) return null
  const matched = typeof res === "object" ? res.matched !== false : true
  return matched ? String(typeof res === "object" ? res.tag ?? raw : res) : null
}

const files = overlayFiles()
const seen = new Map()
const report = []
const missingCn = []
const notInDict = []
const duplicated = []
const badAlias = []
let totalRows = 0

for (const file of files) {
  const text = readFileSync(file, "utf8")
  const rows = text.split(/\r?\n/)
  let rows_ = 0
  rows.forEach((line, i) => {
    if (line.trim() === "") return
    rows_ += 1
    totalRows += 1
    const where = relOf(file) + ":" + (i + 1)
    let row
    try { row = JSON.parse(line) } catch { badAlias.push(where + " JSON 坏了"); return }
    const tag = String(row.tag ?? "")
    if (tag === "") return
    if (seen.has(tag)) duplicated.push(where + " " + tag + "（已在 " + seen.get(tag) + "）")
    else seen.set(tag, where)
    if (String(row.cn ?? "").trim() === "") missingCn.push(where + " " + tag)
    if (row.aliases !== undefined) {
      if (!Array.isArray(row.aliases)) badAlias.push(where + " " + tag + " aliases 不是数组")
      else if (row.aliases.some(a => typeof a !== "string" || a.trim() === "")) badAlias.push(where + " " + tag + " aliases 有空项")
    }
    const real = lookup(tag)
    if (!real) notInDict.push(where + " " + tag)
    else if (real !== tag) badAlias.push(where + " " + tag + " 词库权威写法是 " + real)
  })
  report.push({ file: relOf(file), rows: rows_ })
}

// POSE_HINTS 里补的 tag 也必须在库里
const hintTags = new Set()
for (const hint of POSE_HINTS) for (const item of hint.tags ?? []) hintTags.add(String(item.tag ?? ""))
const hintMissing = [...hintTags].filter(t => t !== "" && !lookup(t))

const violations = missingCn.length + notInDict.length + duplicated.length + badAlias.length + hintMissing.length
const result = {
  dictionary: { total: stats.total, dir: stats.dir ?? "" },
  files: report,
  rows: totalRows,
  uniqueTags: seen.size,
  poseHintTags: hintTags.size,
  violations: { missingCn, notInDict, duplicated, badAlias, hintMissing },
}

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2))
} else {
  if (!QUIET) {
    console.log("词库：" + stats.total + " 条")
    console.log("文件" + " ".repeat(30) + "行数")
    for (const item of report) console.log(item.file.padEnd(34) + String(item.rows).padStart(6))
    console.log("")
  }
  const line = (title, list) => {
    if (list.length === 0) return
    console.log("× " + title + "（" + list.length + "）")
    for (const item of list.slice(0, MAX_REPORT)) console.log("    " + item)
    if (list.length > MAX_REPORT) console.log("    …… 还有 " + (list.length - MAX_REPORT) + " 条（--max-report 调整）")
  }
  line("不在词库里（锻造时会被丢弃）", notInDict)
  line("缺中文名", missingCn)
  line("跨文件重复", duplicated)
  line("别名/写法问题", badAlias)
  line("POSE_HINTS 里不在词库的 tag", hintMissing)
  console.log("")
  console.log("合计 " + totalRows + " 行 / " + seen.size + " 个 tag / POSE_HINTS " + hintTags.size + " 个 tag")
  if (violations === 0) console.log("✓ 补词表体检通过")
  else console.log("× 有 " + violations + " 处问题")
}
process.exitCode = violations === 0 ? 0 : 1