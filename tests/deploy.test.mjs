// plan: 一键部署产物的护栏——打包清单、容器文件、部署脚本分支、zip 结构与真实打包
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { crc32, listPortableFiles, makeDist, makeZip, readVersion } from "../scripts/release/pack.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = rel => readFileSync(path.join(ROOT, rel), "utf8")

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
  // 第一条本地头里的 CRC 与长度要和原文对得上
  const crc0 = zip.readUInt32LE(14)
  const size0 = zip.readUInt32LE(18)
  assert.equal(crc0, crc32(entries[0].data))
  assert.equal(size0, entries[0].data.length)
  const nameLen0 = zip.readUInt16LE(26)
  const data0 = zip.subarray(30 + nameLen0, 30 + nameLen0 + size0)
  assert.equal(data0.toString(), "hello 世界")
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
