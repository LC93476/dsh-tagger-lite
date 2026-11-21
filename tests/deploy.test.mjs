// plan: 一键部署产物的护栏——打包清单、容器文件、部署脚本分支、zip 结构与真实打包
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import { inflateRawSync } from "node:zlib"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { COMPRESSIBLE_EXT, compressEntry, crc32, listPortableFiles, makeDist, makeZip, readVersion } from "../scripts/release/pack.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = rel => readFileSync(path.join(ROOT, rel), "utf8")

/**
 * 顺着本地头把 zip 里的条目走一遍（本工程不写数据描述符，所以 size 字段就是真值）。
 * @param {Buffer} buf
 * @returns {Array<{ name: string, method: number, crc: number, compressed: number, uncompressed: number, data: Buffer }>}
 */
function readLocalEntries(buf) {
  const out = []
  let offset = 0
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8)
    const crc = buf.readUInt32LE(offset + 14)
    const compressed = buf.readUInt32LE(offset + 18)
    const uncompressed = buf.readUInt32LE(offset + 22)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLen + extraLen
    out.push({
      name: buf.subarray(nameStart, nameStart + nameLen).toString("utf8"),
      method,
      crc,
      compressed,
      uncompressed,
      data: buf.subarray(dataStart, dataStart + compressed),
    })
    offset = dataStart + compressed
  }
  return out
}

/** 条目原文：method 8 解压，method 0 直接取。 */
function entryBytes(entry) {
  return entry.method === 8 ? inflateRawSync(entry.data) : entry.data
}

test("部署文件齐全：Docker / compose / 一键脚本 / 安装说明", () => {
  for (const rel of ["Dockerfile", ".dockerignore", "docker-compose.yml", ".env.example", "deploy.cmd", "deploy.sh", "INSTALL.md", "scripts/release/pack.mjs"]) {
    assert.ok(existsSync(path.join(ROOT, rel)), rel + " 应该存在")
  }
  const pkg = JSON.parse(read("package.json"))
  assert.equal(pkg.scripts.pack, "node scripts/release/pack.mjs")
})

test("Dockerfile：非 root、暴露 7789、带健康检查、CMD 用 standalone 入口", () => {
  const docker = read("Dockerfile")
  assert.match(docker, /^FROM node:22-alpine$/m)
  assert.match(docker, /^USER node$/m)
  assert.match(docker, /^EXPOSE 7789$/m)
  assert.match(docker, /HEALTHCHECK[\s\S]*\/tagger\/api\/health/)
  assert.match(docker, /CMD \["node", "server\/standalone\.mjs"/)
  // 零依赖：构建过程不该有 npm install（离线可构建）
  assert.doesNotMatch(docker, /RUN npm (i|install|ci)\b/)
})

test("docker-compose：端口、数据卷、重启策略与宿主 ComfyUI 通道", () => {
  const compose = read("docker-compose.yml")
  assert.match(compose, /\$\{DSH_TAGGER_PORT:-7789\}:7789/)
  assert.match(compose, /tagger-data:\/data/)
  assert.match(compose, /restart: unless-stopped/)
  assert.match(compose, /host\.docker\.internal:host-gateway/)
})

test("一键脚本都有三条路：本机 node / docker / 便携 node", () => {
  // deploy.sh / deploy.cmd 是保留的老入口，只做转发；真正实现三条路的在 start.sh / start.cmd 里。
  assert.match(read("deploy.sh"), /start\.sh/)
  assert.match(read("deploy.cmd"), /start\.cmd/)

  const sh = read("start.sh")
  assert.match(sh, /command -v node/)
  assert.match(sh, /command -v nodejs/)
  assert.match(sh, /docker compose up --build/)
  assert.match(sh, /bin\/tagger\.mjs/)

  const cmd = read("start.cmd")
  // 脚本是 UTF-8 存的：不切代码页，936 控制台里中文 echo 全是乱码（node 的日志同理）
  assert.match(cmd, /chcp 65001/, "start.cmd 必须先切 UTF-8 代码页")
  assert.match(read("scripts/win/stop-tagger.cmd"), /chcp 65001/, "stop 脚本也会 echo 中文，同样要切")
  assert.match(cmd, /where node/)
  assert.match(cmd, /where docker/)
  assert.match(cmd, /:ensureNode/)
  assert.match(cmd, /node-v%NODEVER%-win-x64\\node\.exe/)
  assert.match(cmd, /bin\\tagger\.mjs/)
})

test("便携包清单：带上跑起来要的一切，不带开发期杂物", () => {
  const files = listPortableFiles(ROOT)
  for (const must of ["package.json", "index.js", "server/standalone.mjs", "lib/forge/index.js", "lib/tags/loader.js", "data/tags/pose-view.jsonl", "server/public/app.js", "locale/zh.json", "Dockerfile", "deploy.cmd", "deploy.sh", "INSTALL.md"]) {
    assert.ok(files.includes(must), "清单里应该有 " + must)
  }
  for (const banned of files.filter(f => f.startsWith("tests/") || f.startsWith("scripts/release/") || f.startsWith("scripts/assets/") || f.startsWith("public-src/") || f.startsWith(".git/"))) {
    assert.fail("清单里不该有 " + banned)
  }
  assert.ok(files.length > 80, "清单不该只有几个文件，实际 " + files.length)
})

test("CRC32 与 ZIP 结构：标准值、中央目录条目数、内容可回读", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926)
  const entries = [
    { name: "a.txt", data: Buffer.from("hello 世界") },
    { name: "dir/b.txt", data: Buffer.from("") },
  ]
  const zip = makeZip(entries)
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd > 0)
  assert.equal(zip.readUInt16LE(eocd + 10), entries.length)
  assert.ok(zip.readUInt32LE(eocd + 12) > 0, "中央目录长度应大于 0")
  // 第一条本地头里的 CRC 与两个尺寸要和原文对得上（文本会被 deflate，尺寸字段就不是 data.length 了）
  const crc0 = zip.readUInt32LE(14)
  const method0 = zip.readUInt16LE(8)
  assert.equal(crc0, crc32(entries[0].data))
  assert.ok(method0 === 0 || method0 === 8, "method 只能是 store 或 deflate，实际 " + method0)
  const first = readLocalEntries(zip)[0]
  assert.equal(first.uncompressed, entries[0].data.length)
  if (method0 === 8) assert.ok(first.compressed < entries[0].data.length, "deflate 过的条目压缩后应更小")
  else assert.equal(first.compressed, entries[0].data.length)
  assert.equal(entryBytes(first).toString(), "hello 世界")
})

test("compressEntry：文本压到 deflate、压不小就回退 store、二进制不折腾", () => {
  const text = Buffer.from("1girl, solo, long hair, ".repeat(200))
  const textHit = compressEntry("a.jsonl", text)
  assert.equal(textHit.method, 8)
  assert.ok(textHit.payload.length < text.length)
  assert.equal(inflateRawSync(textHit.payload).toString(), text.toString())

  // 一个字符压不动：deflate 至少多几字节头，必须回退 store，包不能反而变大
  const tiny = compressEntry("b.md", Buffer.from("x"))
  assert.equal(tiny.method, 0)
  assert.equal(tiny.payload.length, 1)

  // 图片这类扩展名不在白名单里，直接 store
  assert.equal(compressEntry("c.webp", Buffer.from("RIFFxxxxWEBP")).method, 0)
  assert.equal(COMPRESSIBLE_EXT.has(".jsonl"), true)
  assert.equal(COMPRESSIBLE_EXT.has(".webp"), false)
  // 空文件即使扩展名可压也要 store（省一次 deflate）
  assert.equal(compressEntry("d.json", Buffer.alloc(0)).method, 0)
})

test("真打一次包：目录里文件数与 MANIFEST 行数一致，zip 与目录同源", () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "tagger-pack-"))
  try {
    const result = makeDist({ root: ROOT, outDir, zip: true, quiet: true, dictionary: null })
    assert.equal(result.version, readVersion(ROOT))
    assert.ok(result.files > 80)
    const manifest = readFileSync(path.join(result.dir, "MANIFEST.txt"), "utf8")
    const rows = manifest.split("\n").filter(line => line !== "" && !line.startsWith("#"))
    assert.equal(rows.length, result.files)
    assert.match(manifest, /data\/tags\/pose-view\.jsonl  [0-9a-f]{16}  \d+/)
    assert.ok(statSync(path.join(result.dir, "server", "standalone.mjs")).isFile())
    const zipBuf = readFileSync(result.zip)
    const eocd = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    // 目录里的每个文件都在 zip 里（包名目录 + 相对路径）；MANIFEST.txt 本身也算一条
    assert.equal(zipBuf.readUInt16LE(eocd + 10), result.files + 1)
    assert.ok(zipBuf.includes(Buffer.from("dsh-tagger-" + result.version + "/server/standalone.mjs")))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
test("词表快照：加载器探测包内 data/danbooru，makeDist 会把它整份带上", async () => {
  const loader = read("lib/tags/loader.js")
  assert.match(loader, /push\(path\.join\(pluginRoot\(\), 'data', 'danbooru'\)\)/, "加载器要探测包内词表快照")

  const outDir = mkdtempSync(path.join(os.tmpdir(), "tagger-pack-dict-"))
  const dictDir = mkdtempSync(path.join(os.tmpdir(), "tagger-dict-"))
  try {
    writeFileSync(path.join(dictDir, "general.jsonl"), '{"tag":"1girl","kind":"general","postCount":1,"names":[]}\n')
    writeFileSync(path.join(dictDir, "artists.jsonl"), '{"tag":"dairi","kind":"artist","postCount":2,"names":["ダイリ"]}\n')
    const result = makeDist({ root: ROOT, outDir, zip: false, quiet: true, dictionary: { dir: dictDir, files: [path.join(dictDir, "general.jsonl"), path.join(dictDir, "artists.jsonl")] } })
    const manifest = readFileSync(path.join(result.dir, "MANIFEST.txt"), "utf8")
    assert.match(manifest, /data\/danbooru\/general\.jsonl/)
    assert.match(manifest, /data\/danbooru\/artists\.jsonl/)
    assert.match(manifest, /其中词表快照 2 个文件/)
    assert.equal(result.files, listPortableFiles(ROOT).length, "词表快照不该改变 files 计数（单独记账）")
  } finally {
    rmSync(outDir, { recursive: true, force: true })
    rmSync(dictDir, { recursive: true, force: true })
  }
})

test("真打一次包：zip 体积 < 便携目录的 60%，deflate 条目占比 > 50%", () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "tagger-pack-ratio-"))
  try {
    const result = makeDist({ root: ROOT, outDir, zip: true, quiet: true, dictionary: null })
    const zipBytes = statSync(result.zip).size
    assert.ok(result.bytes > 0, "便携目录不该是空的")
    const limit = Math.round(result.bytes * 0.6)
    assert.ok(
      zipBytes < limit,
      "zip " + zipBytes + " 字节应小于未压缩 " + result.bytes + " 的 60%（" + limit + " 字节）",
    )

    const entries = readLocalEntries(readFileSync(result.zip))
    assert.ok(entries.length > 80, "zip 条目不该只有几个，实际 " + entries.length)
    const deflated = entries.filter(entry => entry.method === 8)
    assert.ok(
      deflated.length / entries.length > 0.5,
      "文本包应有过半条目走 deflate，实际 " + deflated.length + "/" + entries.length,
    )
    for (const entry of entries) {
      assert.ok(entry.method === 0 || entry.method === 8, entry.name + " 的 method 只能是 0 或 8")
      if (entry.method === 8) assert.ok(entry.compressed < entry.uncompressed, entry.name + " deflate 之后应更小")
      else assert.equal(entry.compressed, entry.uncompressed, entry.name + " store 时两个尺寸必须相等")
      // 抽查解压：长度一定对得上，有内容的再核 CRC
      const raw = entryBytes(entry)
      assert.equal(raw.length, entry.uncompressed, entry.name + " 解压后长度应等于原始长度")
      if (raw.length > 0) assert.equal(crc32(raw), entry.crc, entry.name + " 的 CRC 应与解压后的内容一致")
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("包里带齐开箱启动入口：package.json bin + 四个启动脚本 + 脚本引用的依赖", () => {
  const files = listPortableFiles(ROOT)
  const pkg = JSON.parse(read("package.json"))
  for (const rel of Object.values(pkg.bin ?? {})) {
    const clean = String(rel).replace(/^\.\//, "")
    assert.ok(files.includes(clean), "清单里应该有 package.json bin 指向的 " + clean)
  }
  // 双击就能起的三条路 + 唯一 CLI 入口 + 首次向导
  for (const must of ["bin/tagger.mjs", "scripts/setup.mjs", "start.cmd", "start.sh", "start-tagger.cmd", "start-tagger-hidden.vbs", "stop-tagger.cmd"]) {
    assert.ok(files.includes(must), "清单里应该有 " + must)
  }
  // 不允许「只有 stop 没有 start」
  assert.ok(!(files.includes("stop-tagger.cmd") && !files.includes("start.cmd")), "有 stop-tagger.cmd 就必须有 start.cmd")
  assert.ok(!(files.includes("scripts/win/stop-tagger.cmd") && !files.includes("start.cmd")), "有 stop 实现就必须有 start.cmd")
  // 启动脚本真正调用的东西也必须在包里，否则解开后第一次双击就报错
  assert.match(read("start.cmd"), /scripts\\setup\.mjs/, "start.cmd 会调 scripts\\setup.mjs")
  assert.match(read("start.sh"), /bin\/tagger\.mjs/, "start.sh 会调 bin/tagger.mjs")
  assert.match(read("stop-tagger.cmd"), /scripts\\win\\stop-tagger\.cmd/, "stop-tagger.cmd 只是转发")
  assert.ok(files.includes("scripts/win/stop-tagger.cmd"), "转发目标也要在包里")
})
