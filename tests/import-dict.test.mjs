import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkManifest, compareDict, importDict, inspectDictDir, main, parseArgs, resolveSourceDir } from '../scripts/tags/import-dict.mjs'

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dict-import-'))
}

function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}

function makeSource(lines = 3, extra = {}) {
  const dir = tmpDir()
  const general = []
  for (let i = 0; i < lines; i += 1) general.push({ tag: 'word_' + i, cn: '词' + i, postCount: 1000 + i })
  writeJsonl(path.join(dir, 'general.jsonl'), general)
  if (extra.characters !== false) writeJsonl(path.join(dir, 'characters.jsonl'), [{ tag: 'heroine', cn: '女主', postCount: 500 }])
  return dir
}

test('parseArgs：开关与取值，未知参数报错', () => {
  const opts = parseArgs(['--from', 'D:/a', '--to', 'D:/b', '--force', '--check', '--dry', '--min', '5'])
  assert.equal(opts.from, 'D:/a')
  assert.equal(opts.to, 'D:/b')
  assert.equal(opts.min, 5)
  assert.equal(opts.force, true)
  assert.equal(opts.check, true)
  assert.equal(opts.dry, true)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--from']), /缺少参数值/)
  assert.throws(() => parseArgs(['--min', 'abc']), /--min/)
})

test('resolveSourceDir：显式优先，其次环境变量，最后家目录', () => {
  const home = 'C:/Users/x'
  assert.equal(resolveSourceDir('D:/explicit', { DSH_DANBOORU_DIR: 'D:/env' }, home), path.resolve('D:/explicit'))
  assert.equal(resolveSourceDir('', { DSH_DANBOORU_DIR: 'D:/env' }, home), path.resolve('D:/env'))
  assert.equal(resolveSourceDir('', { DSH_COMFYUI_DATA_DIR: 'D:/comfy' }, home), path.resolve('D:/comfy'))
  const fallback = resolveSourceDir('', {}, home)
  assert.ok(fallback.endsWith(path.join('.dsh-comfyui-workbench', 'data', 'danbooru')))
})

test('inspectDictDir：干净目录通过，缺 general / 行数太少 / 坏 JSON 各有错误码', () => {
  const dir = makeSource(3)
  const ok = inspectDictDir(dir, 1)
  assert.equal(ok.ok, true)
  assert.equal(ok.found.length, 2)
  assert.deepEqual(ok.absent.sort(), ['artists.jsonl', 'copyrights.jsonl', 'groups.jsonl'])
  const general = ok.found.find(f => f.name === 'general.jsonl')
  assert.equal(general.lines, 3)
  assert.equal(general.tags, 3)
  assert.match(general.sha256, /^[0-9a-f]{64}$/)

  const empty = inspectDictDir(path.join(dir, 'nope'), 1)
  assert.equal(empty.ok, false)
  assert.equal(empty.problems[0].code, 'no-dir')

  const noGeneral = tmpDir()
  assert.equal(inspectDictDir(noGeneral, 1).problems[0].code, 'no-general')

  const tooFew = inspectDictDir(makeSource(2), 20000)
  assert.equal(tooFew.ok, false)
  assert.equal(tooFew.problems[0].code, 'too-few-lines')

  const broken = makeSource(3)
  writeFileSync(path.join(broken, 'general.jsonl'), '{"tag":"ok"}\nnot json\n')
  const bad = inspectDictDir(broken, 1)
  assert.equal(bad.ok, false)
  assert.equal(bad.problems[0].code, 'bad-json')
})

test('importDict：复制全部文件并写 manifest；再跑一次认成 same', () => {
  const from = makeSource(3)
  const to = path.join(tmpDir(), 'repo', 'data', 'danbooru')
  const first = importDict({ from, to, min: 1 })
  assert.equal(first.ok, true)
  assert.equal(first.code, 'imported')
  assert.deepEqual(first.written.sort(), ['characters.jsonl', 'general.jsonl'])
  assert.ok(existsSync(path.join(to, 'general.jsonl')))
  assert.ok(existsSync(path.join(to, 'characters.jsonl')))
  const manifest = JSON.parse(readFileSync(path.join(to, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.length, 2)
  assert.equal(manifest.files.find(f => f.name === 'general.jsonl').lines, 3)
  assert.equal(manifest.minGeneralLines, 1)
  assert.match(manifest.importedAt, /^\d{4}-\d{2}-\d{2}T/)

  const again = importDict({ from, to, min: 1 })
  assert.equal(again.ok, true)
  assert.equal(again.code, 'same')
  assert.deepEqual(again.written, [])
})

test('importDict：目标内容不同时默认拒绝，--force 才覆盖', () => {
  const from = makeSource(3)
  const to = path.join(tmpDir(), 'data', 'danbooru')
  assert.equal(importDict({ from, to, min: 1 }).code, 'imported')
  writeFileSync(path.join(to, 'general.jsonl'), '{"tag":"stale"}\n')
  const refused = importDict({ from, to, min: 1 })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'exists')
  assert.match(refused.message, /--force/)
  assert.match(readFileSync(path.join(to, 'general.jsonl'), 'utf8'), /stale/)

  const forced = importDict({ from, to, min: 1, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.code, 'imported')
  assert.doesNotMatch(readFileSync(path.join(to, 'general.jsonl'), 'utf8'), /stale/)
})

test('importDict：--dry 不写盘；源不合格时把错误码原样带回', () => {
  const from = makeSource(3)
  const to = path.join(tmpDir(), 'data', 'danbooru')
  const dry = importDict({ from, to, min: 1, dry: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.code, 'dry')
  assert.equal(existsSync(to), false)

  const bad = importDict({ from: makeSource(2), to, min: 20000 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'too-few-lines')
})

test('compareDict 与 main --check：一致退出 0，改一行退出 1', () => {
  const from = makeSource(3)
  const to = path.join(tmpDir(), 'data', 'danbooru')
  importDict({ from, to, min: 1 })
  const same = compareDict(inspectDictDir(from, 1), to)
  assert.equal(same.same, true)

  const io = { out: () => {}, err: () => {} }
  assert.equal(main(['--from', from, '--to', to, '--min', '1', '--check', '--quiet'], io), 0)
  writeFileSync(path.join(to, 'characters.jsonl'), '{"tag":"other"}\n')
  const diff = compareDict(inspectDictDir(from, 1), to)
  assert.equal(diff.same, false)
  assert.deepEqual(diff.differ, ['characters.jsonl'])
  assert.equal(main(['--from', from, '--to', to, '--min', '1', '--check', '--quiet'], io), 1)
  const errors = []
  const code = main(['--from', from, '--to', to, '--min', '1', '--check'], { out: () => {}, err: line => errors.push(line) })
  assert.equal(code, 1)
  assert.match(errors.join('\n'), /仓库快照与源不同/)
})

test('main：参数错与找不到源目录都退 2，--help 退 0', () => {
  const io = { out: () => {}, err: () => {} }
  assert.equal(main(['--nope'], io), 2)
  assert.equal(main(['--help'], io), 0)
  assert.equal(main(['--from', path.join(os.tmpdir(), 'definitely-missing-dict-' + Date.now())], io), 2)
})
test('--check 没有源目录时拿 manifest.json 自检：一致 0 / 被改过 1 / 缺 manifest 2', () => {
  const from = makeSource(3)
  const to = path.join(tmpDir(), 'data', 'danbooru')
  importDict({ from, to, min: 1 })
  const self = checkManifest(to)
  assert.equal(self.ok, true)
  assert.equal(self.code, 'manifest-ok')
  assert.equal(self.files.length, 2)
  const io = { out: () => {}, err: () => {} }
  assert.equal(main(['--to', to, '--check', '--quiet'], io), 0)
  writeFileSync(path.join(to, 'general.jsonl'), JSON.stringify({ tag: 'tampered' }) + '\n')
  const diff = checkManifest(to)
  assert.equal(diff.ok, false)
  assert.equal(diff.code, 'manifest-diff')
  assert.deepEqual(diff.differ, ['general.jsonl'])
  assert.equal(main(['--to', to, '--check', '--quiet'], io), 1)
  rmSync(path.join(to, 'manifest.json'))
  assert.equal(checkManifest(to).code, 'no-manifest')
  assert.equal(main(['--to', to, '--check', '--quiet'], io), 2)
})
