#!/usr/bin/env node
/**
 * scripts/dev/check-layout.mjs — 仓库结构体检（零依赖、纯 node、ESM）
 *
 * 用法：
 *   node scripts/dev/check-layout.mjs [--root DIR] [--quiet] [--json]
 *
 * 退出码：0 通过 / 1 有违规 / 2 用法错误（含 --root 指向不存在的目录）。
 *
 * 检查项：
 *   1. 根目录白名单：只留「用户会点、会看、会配置」的条目，多一个就报。
 *   2. 一级运行目录齐备：bin lib client server data docs scripts tests types。
 *   3. docs/ 下每个 .md 都要在 docs/README.md 索引里出现（README 本身除外）。
 *      docs/README.md 缺失时这一项降级成提示，不算失败。
 *   4. package.json 里形如「node <path> ...」的 scripts 必须指向真实存在的文件。
 *   5. data/tags 下每份 .jsonl（含 seed/ 子目录）行数 == 不重复 tag 数（同一文件内不许重复 tag）。
 *   6. tools/ 目录不许存在（结构优化后已并入 scripts/）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 根目录白名单：逐字照抄 docs/LAYOUT.md 的约定，多一个名字就是违规。 */
export const ROOT_ALLOW = new Set([
  '.dockerignore', '.env.example', '.gitignore', '.github', 'Dockerfile',
  'README.md', 'INSTALL.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'tsconfig.json',
  'cordis.patch.yml', 'docker-compose.yml', 'deploy.cmd', 'deploy.sh',
  'start.cmd', 'start.sh', 'start-tagger.cmd', 'stop-tagger.cmd', 'start-tagger-hidden.vbs',
  'icon.svg', 'index.js', 'client.js',
  'bin', 'client', 'data', 'docs', 'lib', 'locale', 'public-src', 'scripts', 'server', 'tests', 'types',
  'node_modules', '.git', '.data', '.runtime',
])

/** 一级运行目录：少了任何一个都跑不起来（client/ 是桌面端注入的客户端包）。 */
export const REQUIRED_DIRS = ['bin', 'lib', 'client', 'server', 'data', 'docs', 'scripts', 'tests', 'types']

/** 白名单之外唯一收编的条目：与 .gitignore 成对的行尾/编码约定文件。 */
export const EXTRA_ALLOW = new Set(['.gitattributes'])

function listDir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** 递归列出目录下的 .md（相对该目录，分隔符统一成 /）。 */
function listMarkdown(root, prefix) {
  const base = prefix === undefined ? "" : prefix
  const out = []
  for (const name of listDir(path.join(root, base))) {
    const rel = base ? base + "/" + name : name
    const full = path.join(root, rel)
    if (isDir(full)) out.push(...listMarkdown(root, rel))
    else if (name.toLowerCase().endsWith(".md")) out.push(rel)
  }
  return out.sort()
}

/** 递归列出目录下的 .jsonl（相对该目录，分隔符统一成 /），seed/ 这类子目录一并覆盖。 */
function listJsonl(dir, prefix) {
  const base = prefix === undefined ? "" : prefix
  const out = []
  for (const name of listDir(path.join(dir, base))) {
    const rel = base ? base + "/" + name : name
    const full = path.join(dir, rel)
    if (isDir(full)) out.push(...listJsonl(dir, rel))
    else if (name.toLowerCase().endsWith(".jsonl")) out.push(rel)
  }
  return out.sort()
}

/** 从 "node <path> [args]" 里抠出 script 真正要跑的脚本路径；不是 node 开头的返回 null。 */
export function nodeTarget(cmd) {
  if (typeof cmd !== "string") return null
  const parts = cmd.trim().split(/\s+/)
  if (parts.length < 2 || parts[0] !== "node") return null
  const target = parts[1]
  if (!target || target.startsWith("-")) return null
  return target
}

/** 从一行 jsonl 里取 tag；取不到返回 null（坏行）。 */
function tagOf(line) {
  try {
    const obj = JSON.parse(line)
    if (obj && typeof obj.tag === "string" && obj.tag.trim()) return obj.tag.trim()
    return null
  } catch {
    const m = /"tag"\s*:\s*"([^"]+)"/.exec(line)
    return m ? m[1] : null
  }
}

/**
 * 跑一遍体检，返回结构化结果，不打印、不退出。
 * @param {{root?: string}} opts
 * @returns {{ok: boolean, violations: {code: string, message: string}[], warnings: string[], stats: object}}
 */
export function checkLayout(opts) {
  const root = path.resolve(opts && opts.root ? opts.root : process.cwd())
  const violations = []
  const warnings = []
  const stats = { root, tags: { files: 0, rows: 0, tags: 0 } }
  const add = (code, message) => violations.push({ code, message })

  // 1) 根目录白名单（tools/ 交给第 6 项单独报，避免同一个目录报两条）
  for (const name of listDir(root).sort()) {
    if (ROOT_ALLOW.has(name) || EXTRA_ALLOW.has(name)) continue
    if (name === "tools" && isDir(path.join(root, name))) continue
    add("root-extra", "根目录多出：" + name)
  }
  // start-tagger.cmd / start-tagger-hidden.vbs / stop-tagger.cmd 是 start.cmd 的转发壳（历史双击习惯），
  // 实现只有一份，所以不再单独提醒。

  // 2) 一级运行目录齐备
  for (const dir of REQUIRED_DIRS) {
    if (!isDir(path.join(root, dir))) add("dir-missing", "缺少一级目录：" + dir + "/")
  }

  // 3) docs 索引
  const docsDir = path.join(root, "docs")
  const docsIndex = path.join(docsDir, "README.md")
  if (!isFile(docsIndex)) {
    warnings.push("docs/README.md 缺失，索引检查跳过")
  } else {
    const text = readFileSync(docsIndex, "utf8")
    for (const rel of listMarkdown(docsDir)) {
      if (rel === "README.md") continue
      const name = path.basename(rel)
      if (!text.includes(rel) && !text.includes(name)) {
        add("docs-unindexed", "docs 未索引：docs/" + rel)
      }
    }
  }

  // 4) package.json scripts 指向的文件必须存在
  const pkgFile = path.join(root, "package.json")
  if (!isFile(pkgFile)) {
    add("pkg-missing", "缺少 package.json")
  } else {
    let pkg = null
    try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")) } catch (err) {
      add("pkg-broken", "package.json 解析失败：" + err.message)
    }
    const scripts = (pkg && pkg.scripts) || {}
    for (const key of Object.keys(scripts).sort()) {
      const target = nodeTarget(scripts[key])
      if (!target) continue
      if (!existsSync(path.join(root, target))) {
        add("script-target", "scripts." + key + " 指向不存在的文件：" + target)
      }
    }
  }

  // 5) data/tags/*.jsonl 行数 == 不重复 tag 数
  const tagDir = path.join(root, "data", "tags")
  const files = listJsonl(tagDir)
  stats.tags.files = files.length
  for (const name of files) {
    const rel = "data/tags/" + name
    const text = readFileSync(path.join(tagDir, name), "utf8")
    const seen = new Map()
    let rows = 0
    let lineNo = 0
    for (const line of text.split(/\r?\n/)) {
      lineNo++
      if (!line.trim()) continue
      rows++
      const tag = tagOf(line)
      if (!tag) { add("tag-row", rel + " 第 " + lineNo + " 行没有 tag 字段"); continue }
      seen.set(tag, (seen.get(tag) || 0) + 1)
    }
    stats.tags.rows += rows
    stats.tags.tags += seen.size
    const dup = [...seen.entries()]
      .filter(pair => pair[1] > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (dup.length) {
      add("tag-dup", rel + " 有重复 tag：" + dup.map(pair => pair[0] + "×" + pair[1]).join("、"))
    }
    if (rows !== seen.size && !dup.length) {
      add("tag-count", rel + " 行数 " + rows + " 与不重复 tag 数 " + seen.size + " 不等")
    }
  }

  // 6) tools/ 必须不存在
  if (existsSync(path.join(root, "tools"))) {
    add("tools-exists", "tools/ 目录必须不存在（结构优化后已并入 scripts/）")
  }

  return { ok: violations.length === 0, violations, warnings, stats }
}

/** 人读输出：违规一行一条，末尾一行统计。 */
export function render(result, opts) {
  const quiet = !!(opts && opts.quiet)
  const lines = []
  if (!quiet) for (const w of result.warnings) lines.push("提示：" + w)
  for (const v of result.violations) lines.push(v.message)
  const t = result.stats.tags
  const tail = "结构统计：data/tags " + t.files + " 份 / " + t.rows + " 行 / " + t.tags + " 个 tag"
  if (result.ok) {
    lines.push("目录结构体检通过（" + tail.replace("结构统计：", "") + "）")
  } else {
    lines.push("目录结构体检失败：违规 " + result.violations.length + " 条（" + tail.replace("结构统计：", "") + "）")
  }
  return lines.join("\n")
}

export function usage() {
  return [
    "用法：node scripts/dev/check-layout.mjs [--root DIR] [--quiet] [--json]",
    "  --root DIR  体检哪个目录（默认当前工作目录）",
    "  --quiet     不打印提示类信息，只输出违规与统计",
    "  --json      输出 {ok, violations, warnings, stats} 结构",
    "退出码：0 通过 / 1 有违规 / 2 用法错误",
  ].join("\n")
}

/** 解析命令行；返回 {root, quiet, json, help} 或 {error}。 */
export function parseArgs(argv) {
  const out = { root: process.cwd(), quiet: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--quiet") { out.quiet = true; continue }
    if (arg === "--json") { out.json = true; continue }
    if (arg === "--help" || arg === "-h") { out.help = true; continue }
    if (arg === "--root") {
      const value = argv[++i]
      if (!value || value.startsWith("--")) return { error: "--root 需要一个目录参数" }
      out.root = value
      continue
    }
    if (arg.startsWith("--root=")) { out.root = arg.slice("--root=".length); continue }
    return { error: "未知参数：" + arg }
  }
  return out
}

/** CLI 入口：返回退出码，不直接 process.exit，方便测试里 import 出来直调。 */
export function main(argv) {
  const args = parseArgs(argv)
  if (args.error) {
    process.stderr.write(args.error + "\n" + usage() + "\n")
    return 2
  }
  if (args.help) {
    process.stdout.write(usage() + "\n")
    return 0
  }
  const root = path.resolve(args.root)
  if (!isDir(root)) {
    process.stderr.write("目录不存在或不是目录：" + root + "\n")
    return 2
  }
  const result = checkLayout({ root })
  if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  else process.stdout.write(render(result, args) + "\n")
  return result.ok ? 0 : 1
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (invoked && import.meta.url === invoked) process.exit(main(process.argv.slice(2)))
