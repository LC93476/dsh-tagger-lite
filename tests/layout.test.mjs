/**
 * tests/layout.test.mjs — 结构体检脚本 scripts/dev/check-layout.mjs 的用例。
 *
 * 每个用例在临时目录里造一个最小仓库，然后 spawn 一次真 CLI（不是 import 里直调），
 * 断言退出码与 stdout 文案 —— 退出码是脚本的对外契约，必须真跑一次才作数。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL("../scripts/dev/check-layout.mjs", import.meta.url))
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const ACCEPT_DIRS = [".dockerignore", ".gitignore", ".github", "package.json", "README.md", "icon.svg"]

/** 造一个干净的临时仓库：一级目录齐备、package.json 指真文件、一份不重复的 data/tags。 */
function makeRepo(options) {
  const opts = options || {}
  const dir = mkdtempSync(path.join(os.tmpdir(), "ptf-layout-"))
  for (const name of ["bin", "lib", "server", "data", "docs", "scripts", "tests"]) {
    mkdirSync(path.join(dir, name), { recursive: true })
  }
  mkdirSync(path.join(dir, "data", "tags"), { recursive: true })
  mkdirSync(path.join(dir, "docs"), { recursive: true })
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "bin", "tagger.mjs"), "// fixture entry\n")
  writeFileSync(path.join(dir, "docs", "LAYOUT.md"), "# 目录布局\n")
  writeFileSync(path.join(dir, "docs", "README.md"), "# 文档索引\n\n- [LAYOUT.md](LAYOUT.md) 目录布局\n")
  const scriptCfg = { start: "node bin/tagger.mjs", typecheck: "tsc --noEmit -p tsconfig.json" }
  if (opts.scripts) Object.assign(scriptCfg, opts.scripts)
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module", scripts: scriptCfg }, null, 2) + "\n")
  const rows = opts.rows || [
    JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 10, aliases: ["单人"] }),
    JSON.stringify({ tag: "smile", cn: "微笑", postCount: 9, aliases: ["笑"] }),
  ]
  writeFileSync(path.join(dir, "data", "tags", "x.jsonl"), rows.join("\n") + "\n")
  return dir
}

/** 真跑一次 CLI（子进程），返回 {status, stdout, stderr}。 */
function runCli(args, options) {
  const res = spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: (options && options.cwd) || ROOT,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  return { status: res.status, stdout: String(res.stdout || ""), stderr: String(res.stderr || ""), signal: res.signal }
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响断言 */ }
}

test("干净 fixture：退出码 0，统计里 tag 数与行数一致", () => {
  const dir = makeRepo()
  try {
    const out = runCli(["--root", dir])
    assert.equal(out.status, 0, "干净 fixture 必须通过：\n" + out.stdout + out.stderr)
    assert.match(out.stdout, /目录结构体检通过/)
    assert.match(out.stdout, /data\/tags 1 份 \/ 2 行 \/ 2 个 tag/)
  } finally { cleanup(dir) }
})

test("多余文件 + tools/ + scripts 指向不存在的文件：退出码 1，三类违规各出现一次", () => {
  const dir = makeRepo({ scripts: { bench: "node scripts/dev/nope.mjs" } })
  try {
    writeFileSync(path.join(dir, "foo.txt"), "junk\n")
    mkdirSync(path.join(dir, "tools"), { recursive: true })
    const out = runCli(["--root", dir])
    assert.equal(out.status, 1)
    assert.match(out.stdout, /根目录多出：foo\.txt/)
    assert.match(out.stdout, /tools\/ 目录必须不存在/)
    assert.match(out.stdout, /scripts\.bench 指向不存在的文件：scripts\/dev\/nope\.mjs/)
    assert.match(out.stdout, /目录结构体检失败：违规 3 条/)
  } finally { cleanup(dir) }
})

test("data/tags 同一文件里重复 tag：退出码 1 并点名重复的 tag", () => {
  const dir = makeRepo({
    rows: [
      JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 10, aliases: ["单人"] }),
      JSON.stringify({ tag: "smile", cn: "微笑", postCount: 9, aliases: ["笑"] }),
      JSON.stringify({ tag: "1girl", cn: "重复行", postCount: 10, aliases: ["重新补的一份"] }),
    ],
  })
  try {
    const out = runCli(["--root", dir])
    assert.equal(out.status, 1)
    assert.match(out.stdout, /data\/tags\/x\.jsonl 有重复 tag：1girl×2/)
  } finally { cleanup(dir) }
})

test("--root 指向不存在的目录：退出码 2，stderr 说清楚；--json 只输出结构", () => {
  const missing = path.join(os.tmpdir(), "ptf-layout-does-not-exist-" + process.pid)
  const bad = runCli(["--root", missing])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /目录不存在或不是目录/)
  const dir = makeRepo()
  try {
    const out = runCli(["--root", dir, "--json"])
    assert.equal(out.status, 0, out.stderr)
    const data = JSON.parse(out.stdout)
    assert.equal(data.ok, true)
    assert.deepEqual(data.violations, [])
    assert.ok(Array.isArray(data.warnings))
    assert.equal(data.stats.tags.files, 1)
    assert.equal(data.stats.tags.rows, 2)
    assert.equal(data.stats.tags.tags, 2)
    assert.ok(!existsSync(path.join(dir, "tools")), "fixture 不该带 tools/")
  } finally { cleanup(dir) }
})

test("真仓库体检：scripts/dev/check-layout.mjs 在 DSh tagger 根目录退出码 0", () => {
  const out = runCli(["--quiet"])
  assert.equal(out.status, 0, "真仓库结构必须干净：\n" + out.stdout + out.stderr)
  assert.match(out.stdout, /目录结构体检通过/)
  assert.deepEqual(ACCEPT_DIRS.filter(name => !existsSync(path.join(ROOT, name))), [])
})
