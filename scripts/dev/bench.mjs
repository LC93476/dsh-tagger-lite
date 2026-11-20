#!/usr/bin/env node
/**
 * 本地纯计算层基准：索引构建、检索、归一、三道后处理。
 *
 * 为什么单独有这个脚本：锻造的真实耗时 90% 花在模型上，本地这三道是「白送也不能拖慢」的部分。
 * 出问题时的判据：索引构建（一次）> 3s、单次 canonicalize 40 条 > 30ms、单次 postprocess > 5ms，
 * 就说明有人往热路径里塞了 IO 或正则回溯。
 *
 * 用法：node scripts/dev/bench.mjs [--json] [--rounds ³N]
 */
import { createTagIndex } from '../../lib/tags.js'
import { createPostProcessor } from '../../lib/postprocess.js'
import { createRepairer } from '../../lib/repair.js'
import { detectPoseHints, applyPoseHints } from '../../lib/zh-intent.js'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const roundsArg = argv[argv.indexOf('--rounds') + 1]
const ROUNDS = Number.parseInt(String(roundsArg ?? '20'), 10) || 20

const SAMPLE = [
  '1girl', 'solo', 'silver hair', 'blue eyes', 'wet shirt', 'top_down_bottom_up',
  'one_leg_up', 'hair_long', 'from_behind', 'on_bed', 'bedroom', 'night',
  'looking_back', 'see-through clothes', 'clothes_pulled_down', 'medium shot',
  'backlight', 'sweat on skin', 'nude', 'spread legs',
]

const QUERIES = ['银发', '跪趴', '俯拍', '逆光', '特写', '裸体', '回头', '膝']

/** 跑 fn 取中位数（避免偶发 GC 峰值误导）。 */
function medianMs(fn, rounds = ROUNDS) {
  const samples = []
  for (let i = 0; i < rounds; i++) {
    const start = process.hrtime.bigint()
    fn(i)
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const mid = samples[Math.floor(samples.length / 2)]
  return { median: Math.round(mid * 100) / 100, max: Math.round(samples[samples.length - 1] * 100) / 100 }
}

const logger = { info() {}, warn() {}, error() {} }

const t0 = process.hrtime.bigint()
const tags = createTagIndex({ logger })
await tags.ready()
const stats = tags.stats()
const loadMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6)

const search = medianMs(i => tags.search(QUERIES[i % QUERIES.length], 8))
const canon = medianMs(() => tags.canonicalizeMany(SAMPLE))
const post = createPostProcessor({ tags, logger })
const postMs = medianMs(() => post.apply(tags.canonicalizeMany(SAMPLE), { described: '银发少女跪趴回头，俯拍特写', maxTags: 40 }))
const repair = createRepairer({ tags, logger })
// 修复是 async：每轮串行 await 再记账，不能像同步函数那样连发
const repairMs = await (async () => {
  const samples = []
  for (let i = 0; i < ROUNDS; i++) {
    const start = process.hrtime.bigint()
    await repair.fix(tags.canonicalizeMany(SAMPLE), { described: '银发少女跪趴回头' })
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const mid = samples[Math.floor(samples.length / 2)]
  return { median: Math.round(mid * 100) / 100, max: Math.round(samples[samples.length - 1] * 100) / 100 }
})()
const hintsMs = medianMs(() => applyPoseHints([], detectPoseHints('少女跪趴翘臀，从正后方俯拍，回头看镜头')))

const report = {
  index: { tags: stats.total ?? stats.tags ?? null, files: stats.files ?? null, loadMs },
  search,
  canonicalize: canon,
  postprocess: postMs,
  repair: repairMs,
  poseHints: hintsMs,
  rounds: ROUNDS,
  verdict: [],
}
if (loadMs > 3000) report.verdict.push('索引构建 > 3s')
if (canon.median > 30) report.verdict.push('canonicalize 40 条 > 30ms')
if (postMs.median > 5) report.verdict.push('postprocess > 5ms')
if (repairMs.median > 20) report.verdict.push('repair > 20ms')

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('索引：' + (report.index.tags ?? '?') + ' 条，构建 ' + loadMs + 'ms')
  console.log('检索 8 条      中位 ' + search.median + 'ms（峰值 ' + search.max + '）')
  console.log('归一 20 条     中位 ' + canon.median + 'ms（峰值 ' + canon.max + '）')
  console.log('三道后处理     中位 ' + postMs.median + 'ms（峰值 ' + postMs.max + '）')
  console.log('词形修复 20 条 中位 ' + repairMs.median + 'ms（峰值 ' + repairMs.max + '）')
  console.log('姿势意图       中位 ' + hintsMs.median + 'ms（峰值 ' + hintsMs.max + '）')
  console.log(report.verdict.length === 0 ? '判定：都在预算内' : '判定：' + report.verdict.join('、'))
}
process.exit(report.verdict.length === 0 ? 0 : 1)
