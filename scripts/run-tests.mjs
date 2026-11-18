/**
 * scripts/run-tests.mjs — npm test 的统一入口。
 *
 * 为什么要包一层：几个套件会读写同一份词表目录，必须串行跑；但串行参数
 * --test-concurrency 是 Node 20.11 才有的，写死在 package.json 里会让 Node 18
 * 上的 `npm test` 直接报「bad option」。这里按版本决定加不加，老版本给出提示。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const testsDir = path.join(root, 'tests')

const files = readdirSync(testsDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join('tests', name))

if (files.length === 0) {
  console.error('没有找到 tests/*.test.mjs，检查一下目录。')
  process.exit(1)
}

const [major, minor] = process.versions.node.split('.').map(Number)
const supportsSerial = major > 20 || (major === 20 && minor >= 11)
if (!supportsSerial) {
  console.warn('[test] 当前 Node ' + process.versions.node + ' 没有 --test-concurrency，用例会并行跑；建议 Node >= 20.11。')
}

const args = ['--test', ...(supportsSerial ? ['--test-concurrency=1'] : []), ...files]
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error('[test] 起不来：' + result.error.message)
  process.exit(1)
}
process.exit(result.status === null ? 1 : result.status)