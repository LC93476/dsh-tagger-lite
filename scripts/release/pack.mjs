#!/usr/bin/env node
// plan: 把仓库打成便携包 dist/dsh-tagger-<版本>/ 与同名 .zip（零依赖、离线可用、任何环境解开就能跑）
/**
 * scripts/release/pack.mjs — 便携包打包器。
 *
 * 为什么自己写 zip：目标机器可能连 node 都没有（Windows 双击 deploy.cmd 会临时下载一份便携 node），
 * 所以打包这一步不能依赖 npm / zip 命令 / 7z。这里只用 node 标准库：
 *   - 目录复制：fs.cpSync
 *   - 压缩包：store（不压缩）方式的 ZIP，自己算 CRC32 写中央目录
 * 好处是产物字节确定、任何解压工具都认（Windows 资源管理器 / macOS 归档实用工具 / unzip）。
 *
 * 用法：
 *   node scripts/release/pack.mjs                  # 打包到 dist/
 *   node scripts/release/pack.mjs --out /tmp/rel   # 换输出目录
 *   node scripts/release/pack.mjs --no-zip         # 只要目录，不打 zip
 *   node scripts/release/pack.mjs --quiet          # 只报结果
 *
 * 包里有什么：能独立起 web 服务所需的一切（lib/ server/ data/ locale/ 文档与部署脚本），
 * 不含 tests/ scripts/（只带 scripts/win）/ public-src/ .git/ —— 那些是开发期的东西，公开版另有一条 make-public 流水线。
 */
import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { discoverDataDir } from "../../lib/tags/loader.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, "..", "..")

/** 整目录收进包里（相对仓库根） */
export const INCLUDE_DIRS = ["lib", "server", "data", "locale", "scripts/win"]

/** 单文件收进包里（相对仓库根） */
export const INCLUDE_FILES = [
  "package.json",
  "index.js",
  "icon.svg",
  "README.md",
  "INSTALL.md",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
  ".env.example",
  "deploy.cmd",
  "deploy.sh",
  "docs/API.md",
  "docs/PERF.md",
]

/** 目录里遇到这些就不往下走 */
const SKIP_NAMES = new Set(["node_modules", ".git", ".github", "tmp", "dist", "tests", "public-src", ".data", ".runtime"])

/**
 * 找到本机的全量词表目录（一般来自 dsh-comfyui-workbench 的 danbooru 导入）。
 * 复用运行时的探测顺序，避免打包脚本和加载器各有一套路径规则。
 * @param {string} [root]
 * @returns {Promise<{ dir: string, files: string[] } | null>}
 */
export async function resolveDictionary(root = ROOT) {
  void root
  const found = await discoverDataDir({ dir: "", probeDefaults: true })
  if (!found || !found.dir || !Array.isArray(found.files) || found.files.length === 0) return null
  return { dir: found.dir, files: found.files }
}

export function readVersion(root = ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  return String(pkg.version ?? "0.0.0")
}

/** 递归列目录，返回 posix 相对路径（相对 root） */
export function walk(root, rel = "") {
  const out = []
  const abs = path.join(root, rel)
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_NAMES.has(name)) continue
    const childRel = rel === "" ? name : rel + "/" + name
    const st = statSync(path.join(root, childRel))
    if (st.isDirectory()) out.push(...walk(root, childRel))
    else if (st.isFile()) out.push(childRel)
  }
  return out
}

/** 便携包里该有的全部相对路径（排序、去重） */
export function listPortableFiles(root = ROOT) {
  const files = new Set()
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(root, dir)
    if (!existsSync(abs)) continue
    for (const rel of walk(root, dir)) files.add(rel)
  }
  for (const file of INCLUDE_FILES) {
    if (existsSync(path.join(root, file))) files.add(file)
  }
  return [...files].sort()
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 生成 store 方式的 ZIP。
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8")
    const data = entry.data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // 需要的解压版本 2.0
    local.writeUInt16LE(0x0800, 6) // 标志：文件名按 UTF-8
    local.writeUInt16LE(0, 8) // 压缩方式：store
    local.writeUInt16LE(0, 10) // 修改时间 00:00
    local.writeUInt16LE(0x21, 12) // 修改日期 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // 制作版本
    central.writeUInt16LE(20, 6) // 需要版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attr
    central.writeUInt32LE(0o644 << 16, 38) // external attr：普通文件 644
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, end])
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

/**
 * 打成便携目录（可选再打 zip）。
 * @param {{ root?: string, outDir?: string, zip?: boolean, quiet?: boolean, dictionary?: { dir: string, files: string[] } | null }} [options]
 * @returns {{ dir: string, zip: string | null, version: string, files: number, bytes: number }}
 */
export function makeDist(options = {}) {
  const root = options.root ?? ROOT
  const dictionary = options.dictionary ?? null
  const outDir = path.resolve(options.outDir ?? path.join(root, "dist"))
  const wantZip = options.zip !== false
  const quiet = options.quiet === true
  const version = readVersion(root)
  const name = "dsh-tagger-" + version
  const dir = path.join(outDir, name)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const files = listPortableFiles(root)
  const manifest = ["# DSh Tagger 便携包清单 " + name, "# 路径  sha256  字节"]
  let bytes = 0
  for (const rel of files) {
    const from = path.join(root, rel)
    const to = path.join(dir, rel)
    mkdirSync(path.dirname(to), { recursive: true })
    cpSync(from, to)
    const data = readFileSync(from)
    bytes += data.length
    manifest.push(rel + "  " + createHash("sha256").update(data).digest("hex").slice(0, 16) + "  " + data.length)
  }
  // 全量词表快照：解开包后 <包>/data/danbooru/*.jsonl 会被加载器当主数据源（见 lib/tags/loader.js 的探测顺序），
  // 少了它也能跑，只是只剩包内 198 行补词，锻造会丢大量常见词。
  // 词表快照现在也在仓库里（data/danbooru），listPortableFiles 已经把它拷进去了；
  // 那时这里只需要记清单，别再拷第二遍（重复写同一路径既慢又会让 MANIFEST 数字翻倍）。
  const copied = new Set(files)
  let dictionaryFiles = 0
  if (dictionary && Array.isArray(dictionary.files) && dictionary.files.length > 0) {
    for (const file of dictionary.files) {
      const base = path.basename(file)
      if (copied.has("data/danbooru/" + base)) {
        const data = readFileSync(path.join(root, "data", "danbooru", base))
        dictionaryFiles += 1
        manifest.push("data/danbooru/" + base + "  " + createHash("sha256").update(data).digest("hex").slice(0, 16) + "  " + data.length)
        continue
      }
      const to = path.join(dir, "data", "danbooru", base)
      mkdirSync(path.dirname(to), { recursive: true })
      cpSync(file, to)
      const data = readFileSync(file)
      bytes += data.length
      dictionaryFiles += 1
      manifest.push("data/danbooru/" + base + "  " + createHash("sha256").update(data).digest("hex").slice(0, 16) + "  " + data.length)
    }
  }
  manifest.push("", "# 共 " + (files.length + dictionaryFiles) + " 个文件，" + fmtSize(bytes))
  if (dictionaryFiles > 0) manifest.push("# 其中词表快照 " + dictionaryFiles + " 个文件（data/danbooru/，来自 " + dictionary.dir + "）")
  writeFileSync(path.join(dir, "MANIFEST.txt"), manifest.join("\n") + "\n")

  // 解压后 Linux/macOS 上这两个脚本要能直接执行（zip 里也记了 644）
  for (const script of ["deploy.sh", "start.sh", "scripts/win/stop-tagger.cmd"]) {
    const abs = path.join(dir, script)
    if (existsSync(abs) && process.platform !== "win32") chmodSync(abs, 0o755)
  }

  let zipPath = null
  if (wantZip) {
    // walk(dir) 已经把 MANIFEST.txt 一起扫进来了（它是一开始就写好的），这里不用再补一次
    const entries = walk(dir).map(rel => ({ name: name + "/" + rel, data: readFileSync(path.join(dir, rel)) }))
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    zipPath = path.join(outDir, name + ".zip")
    mkdirSync(outDir, { recursive: true })
    writeFileSync(zipPath, makeZip(entries))
  }

  if (!quiet) {
    console.log("便携包：" + dir)
    if (zipPath) console.log("压缩包：" + zipPath + "（" + fmtSize(statSync(zipPath).size) + "）")
    console.log("文件 " + files.length + " 个，" + fmtSize(bytes) + "；解开后跑 deploy.sh（Windows 双击 deploy.cmd）就起来了")
  }
  return { dir, zip: zipPath, version, files: files.length, bytes }
}

function parseArgs(argv) {
  const out = { outDir: undefined, zip: true, quiet: false, tags: true }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    const next = argv[i + 1]
    if (token === "--out" && next) { out.outDir = next; i += 1; continue }
    if (token === "--no-zip") { out.zip = false; continue }
    if (token === "--zip") { out.zip = true; continue }
    if (token === "--quiet") { out.quiet = true; continue }
    if (token === "--no-tags") { out.tags = false; continue }
    if (token === "--with-tags") { out.tags = true; continue }
    if (token === "--help" || token === "-h") {
      console.log("用法：node scripts/release/pack.mjs [--out <目录>] [--no-zip] [--no-tags] [--quiet]")
      console.log("  --no-tags   不打包 data/danbooru 全量词表快照（包会小 20MB，但只剩 198 行补词）")
      process.exit(0)
    }
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2))
  const dictionary = args.tags ? await resolveDictionary() : null
  if (args.tags && dictionary === null) {
    console.warn("没找到全量词表目录（dsh-comfyui-workbench 的 danbooru 导入），这次只打补词表；要用全量词表先跑 scripts/tags/build-tags.mjs 或设 DSH_DANBOORU_DIR。")
  }
  const result = makeDist({ outDir: args.outDir, zip: args.zip, quiet: args.quiet, dictionary })
  if (!args.quiet && dictionary !== null) console.log("词表快照：" + dictionary.files.length + " 个文件（" + dictionary.dir + "）")
  process.exitCode = result.files > 0 ? 0 : 1
}
