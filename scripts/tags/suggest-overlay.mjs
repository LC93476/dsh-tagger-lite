#!/usr/bin/env node
/**
 * scripts/tags/suggest-overlay.mjs — 从真实 danbooru 词表里掏出「值得补进 overlay 的词」。
 *
 * 为什么需要它：补词表最容易犯的错是凭印象写 tag（写出来库里没有，锻造时被丢弃），
 * 或者补一堆冷门词（postCount 个位数，模型根本没学过）。这个脚本按热度排序，
 * 只吐库里真有、而 overlay 还没收录的词，并把 danbooru 自己的分组（Pose / Camera / Clothing…）
 * 与已有中文说明一并带出来 —— 直接照着挑，照抄拼写。
 *
 * 用法：
 *   node scripts/tags/suggest-overlay.mjs                            # general，热度前 300
 *   node scripts/tags/suggest-overlay.mjs --group Pose --limit 120   # 只看姿势分组
 *   node scripts/tags/suggest-overlay.mjs --group Camera --grep view # 视角类
 *   node scripts/tags/suggest-overlay.mjs --kind character --min-count 5000
 *   node scripts/tags/suggest-overlay.mjs --out /tmp/cand.jsonl      # 落成可编辑的行
 *   node scripts/tags/suggest-overlay.mjs --json
 *
 * 参数：--dir <词表目录> --kind general|character|copyright|artist|all
 *       --group <分组名，子串匹配> --min-count <默认 300> --limit <默认 300>
 *       --grep <tag 子串> --out <文件> --json --overlay <overlay 目录>
 *
 * 退出码：0 正常（哪怕 0 条）；2 词表目录找不到。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverDataDir } from '../../lib/tags/loader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
/** @param {string} name */
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const KIND = String(argOf("--kind") ?? "general")
const GROUP = argOf("--group")
const GREP = argOf("--grep")
const MIN_COUNT = Number(argOf("--min-count") ?? 300)
const LIMIT = Number(argOf("--limit") ?? 300)
const OUT = argOf("--out")
const JSON_OUT = argv.includes("--json")

const discovered = await discoverDataDir({})
const DICT = path.resolve(argOf("--dir") ?? String(discovered.dir ?? ""))
if (!DICT || !existsSync(DICT)) { console.error("× 词表目录不存在：" + DICT); process.exit(2) }
const OVERLAY = path.resolve(argOf("--overlay") ?? path.join(ROOT, "data", "tags"))

const KIND_FILE = { general: "general.jsonl", character: "characters.jsonl", copyright: "copyrights.jsonl", artist: "artists.jsonl" }
const kindFiles = KIND === "all" ? Object.values(KIND_FILE) : [KIND_FILE[/** @type {keyof typeof KIND_FILE} */ (KIND)]]
if (kindFiles.some(f => !f)) { console.error("× --kind 只认 " + Object.keys(KIND_FILE).join(" / ") + " / all"); process.exit(2) }

/** overlay 已收录的 tag（递归 data/tags） */
function overlayTags() {
  const set = new Set()
  /** @param {string} dir */
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith(".jsonl")) continue
      for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
        if (line.trim() === "") continue
        try { const row = JSON.parse(line); if (row.tag) set.add(String(row.tag)) } catch { /* 坏行留给 check-tags */ }
      }
    }
  }
  walk(OVERLAY)
  return set
}

/** tag → danbooru 分组 */
const groups = new Map()
const groupsFile = path.join(DICT, "groups.jsonl")
if (existsSync(groupsFile)) {
  for (const line of readFileSync(groupsFile, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue
    try { const row = JSON.parse(line); if (row.tag) groups.set(String(row.tag), Array.isArray(row.groups) ? row.groups : []) } catch { /* 忽略 */ }
  }
}

const taken = overlayTags()
const picked = []
for (const file of kindFiles) {
  const full = path.join(DICT, String(file))
  if (!existsSync(full)) { console.error("× 缺文件：" + full); continue }
  for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const tag = String(row.tag ?? "")
    if (tag === "" || taken.has(tag)) continue
    const count = Number(row.postCount ?? 0)
    if (!(count >= MIN_COUNT)) continue
    if (GREP && !tag.includes(GREP)) continue
    const gs = groups.get(tag) ?? []
    if (GROUP && !gs.some(g => g.toLowerCase().includes(GROUP.toLowerCase()))) continue
    const names = Array.isArray(row.names) ? row.names : []
    const cn = names.find(n => /[\u4e00-\u9fff]/.test(String(n))) ?? ""
    picked.push({ tag, kind: String(row.kind ?? KIND), postCount: count, cn: String(cn), groups: gs, note: String(row.note ?? ""), aliases: names.slice(0, 8).map(String) })
  }
}
picked.sort((a, b) => b.postCount - a.postCount)
const top = picked.slice(0, LIMIT)

if (OUT) {
  const lines = top.map(item => JSON.stringify({ tag: item.tag, cn: item.cn, postCount: item.postCount, kind: item.kind, aliases: [] }))
  writeFileSync(OUT, lines.join("\n") + "\n", "utf8")
}

if (JSON_OUT) {
  console.log(JSON.stringify({ dict: DICT, kind: KIND, group: GROUP ?? null, minCount: MIN_COUNT, matched: picked.length, shown: top.length, items: top }, null, 2))
} else {
  console.log("词表：" + DICT + "（" + kindFiles.join(", ") + "）")
  console.log("筛选：kind=" + KIND + (GROUP ? " group≈" + GROUP : "") + (GREP ? " grep=" + GREP : "") + " ≥" + MIN_COUNT + " 次")
  console.log("命中 " + picked.length + " 条，列出前 " + top.length + "：")
  console.log("")
  const header = "#".padEnd(5) + "tag".padEnd(34) + "postCount".padStart(10) + "  分组 / 中文"
  console.log(header)
  top.forEach((item, i) => {
    const meta = [item.groups.slice(0, 3).join("+"), item.cn].filter(Boolean).join(" · ")
    console.log(String(i + 1).padEnd(5) + item.tag.padEnd(34) + String(item.postCount).padStart(10) + "  " + meta)
  })
  if (OUT) console.log("\n已写入 " + OUT + "（" + top.length + " 行，cn 已预填，aliases 留空待补）")
}