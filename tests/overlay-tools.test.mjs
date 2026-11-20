// tests/overlay-tools.test.mjs — 补词表工具链的两个脚本（闸门 + 取材）
// 这两个脚本是「补词表」这件事的护栏：一个负责拦下库里没有的 tag / 缺中文 / 跨文件重复，
// 一个负责从真词表里挑候选词。它们坏掉时补词表会静默降质（锻造时 warn 丢弃），所以要有回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverDataDir } from '../lib/tags/loader.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 跑脚本：本机没有裸 node，用宿主 Electron 当 node（测试本身可能就跑在里面）。 */
/** @param {string[]} args */
function runScript(name, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const dictionary = await discoverDataDir({})
const hasDictionary = Boolean(dictionary?.dir) && (await import('node:fs')).existsSync(String(dictionary.dir))

test("补词表闸门：干净的 overlay 通过，坏行被逐类点名", { skip: hasDictionary ? false : "没有本地词表，跳过" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "overlay-gate-"))
  try {
    mkdirSync(path.join(dir, 'seed'), { recursive: true })
    // 用两个真实存在的词：1girl / solo（danbooru general 里必然有）
    writeFileSync(path.join(dir, "clean.jsonl"), [
      JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 8314081, kind: "general", aliases: ["少女"] }),
      JSON.stringify({ tag: "solo", cn: "单人", postCount: 498022, kind: "general", aliases: ["一个人"] }),
      "",
    ].join("\n"), "utf8")
    const ok = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--json"])
    assert.equal(ok.status, 0, ok.stderr || ok.stdout)
    const parsed = JSON.parse(ok.stdout)
    assert.equal(parsed.rows, 2)
    assert.equal(parsed.violations.notInDict.length, 0)
    assert.equal(parsed.violations.duplicated.length, 0)

    writeFileSync(path.join(dir, "bad.jsonl"), [
      JSON.stringify({ tag: "zzz_not_a_real_tag", cn: "不存在的词", postCount: 1 }),
      JSON.stringify({ tag: "solo", cn: "", postCount: 498022 }),
      "",
    ].join("\n"), "utf8")
    const bad = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--json"])
    assert.equal(bad.status, 1)
    const report = JSON.parse(bad.stdout)
    assert.equal(report.violations.notInDict.length, 1)
    assert.match(report.violations.notInDict[0], /zzz_not_a_real_tag/)
    assert.equal(report.violations.duplicated.length, 1)
    assert.match(report.violations.duplicated[0], /solo/)
    assert.equal(report.violations.missingCn.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("补词表取材：suggest-overlay 只吐词库里真有的词，且能按热度/分组筛", { skip: hasDictionary ? false : "没有本地词表，跳过" }, () => {
  const result = runScript("tags/suggest-overlay.mjs", ["--json", "--min-count", "100000", "--limit", "5"])
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.ok(Array.isArray(parsed.items))
  assert.ok(parsed.items.length <= 5)
  for (const item of parsed.items) assert.ok(item.postCount >= 100000)
  assert.ok(parsed.matched >= parsed.items.length)

  const bad = runScript("tags/suggest-overlay.mjs", ["--json", "--kind", "nope"])
  assert.equal(bad.status, 2)
})

test("补词表闸门 --strict-dict：干净 overlay 通过，并给出 strict 统计", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "overlay-strict-"))
  const dict = mkdtempSync(path.join(tmpdir(), "overlay-dict-"))
  try {
    // 主词表用一份自造的最小快照：测试不依赖本机有没有 9.9 万条 danbooru 数据
    writeFileSync(path.join(dict, "general.jsonl"), [
      JSON.stringify({ tag: "1girl", postCount: 8314081, kind: "general" }),
      JSON.stringify({ tag: "solo", postCount: 498022, kind: "general" }),
      "",
    ].join("\n"), "utf8")
    mkdirSync(path.join(dir, "seed"), { recursive: true })
    writeFileSync(path.join(dir, "clean.jsonl"), [
      JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 8314081, kind: "general", aliases: ["少女"] }),
      JSON.stringify({ tag: "solo", cn: "单人", postCount: 498022, kind: "general", aliases: ["一个人"] }),
      "",
    ].join("\n"), "utf8")

    const human = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--dict-dir", dict, "--strict-dict"])
    assert.equal(human.status, 0, human.stderr || human.stdout)
    assert.match(human.stdout, /strict：主词表 2 条/)
    assert.match(human.stdout, /0 条仅存在于 overlay/)

    const json = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--dict-dir", dict, "--strict-dict", "--json"])
    assert.equal(json.status, 0, json.stderr || json.stdout)
    const parsed = JSON.parse(json.stdout)
    assert.equal(parsed.rows, 2)
    assert.equal(parsed.strict.enabled, true)
    assert.equal(parsed.strict.primaryTotal, 2)
    assert.equal(parsed.strict.dictMissing, false)
    assert.deepEqual(parsed.strict.onlyInOverlay, [])
    assert.equal(parsed.violations.notInDict.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dict, { recursive: true, force: true })
  }
})


test("补词表闸门：自造词表下，词库外 / 缺中文 / 跨文件重复照样被点名（不依赖本机快照）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "overlay-gate-"))
  const dict = mkdtempSync(path.join(tmpdir(), "overlay-dict-"))
  try {
    writeFileSync(path.join(dict, "general.jsonl"), [
      JSON.stringify({ tag: "1girl", postCount: 8314081, kind: "general" }),
      "",
    ].join("\n"), "utf8")
    writeFileSync(path.join(dir, "a.jsonl"), [
      JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 8314081, kind: "general" }),
      JSON.stringify({ tag: "zzz_not_a_real_tag", cn: "不存在的词", postCount: 1 }),
      "",
    ].join("\n"), "utf8")
    writeFileSync(path.join(dir, "b.jsonl"), [
      JSON.stringify({ tag: "1girl", cn: "重复行", postCount: 8314081, kind: "general" }),
      "",
    ].join("\n"), "utf8")
    const bad = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--dict-dir", dict, "--json"])
    assert.equal(bad.status, 1, bad.stderr || bad.stdout)
    const report = JSON.parse(bad.stdout)
    assert.equal(report.violations.notInDict.length, 1)
    assert.match(report.violations.notInDict[0], /zzz_not_a_real_tag/)
    assert.equal(report.violations.duplicated.length, 1)
    assert.match(report.violations.duplicated[0], /1girl/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dict, { recursive: true, force: true })
  }
})

test("补词表闸门 --strict-dict：主词表一条都没探测到时明说「无法判定」，不刷全量噪音", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "overlay-strict-"))
  const dict = mkdtempSync(path.join(tmpdir(), "overlay-dict-"))
  try {
    mkdirSync(path.join(dir, "seed"), { recursive: true })
    writeFileSync(path.join(dir, "clean.jsonl"),
      JSON.stringify({ tag: "1girl", cn: "一个女孩", postCount: 8314081, kind: "general" }) + "\n", "utf8")
    const result = runScript("tags/check-overlay-tags.mjs", ["--dir", dir, "--dict-dir", dict, "--strict-dict", "--json"])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.strict.dictMissing, true)
    assert.equal(parsed.strict.primaryTotal, 0)
    assert.deepEqual(parsed.strict.onlyInOverlay, [])
    assert.equal(parsed.strict.suppressed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dict, { recursive: true, force: true })
  }
})