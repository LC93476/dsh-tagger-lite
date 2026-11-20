/**
 * tests/_lib-guard.mjs — 判断本机有没有 Danbooru 大词表。
 *
 * 干净机器 / CI 上 createTagIndex 只有 seed（1247 条），凡是拿真库断言行为的用例
 * 应当 skip 而不是变红：红了说明的是「环境没词库」，不是代码坏了。
 * 本地先跑 scripts/tags/build-tags.mjs 就有真库，这些用例照常执行。
 *
 * 两个判据缺一不可：
 * - seedOnly === false：索引自己说它读到的不只是 seed（seed 扩容到 1247 之后单看条数会误判）；
 * - loaded 大过门槛：防止某个只带几百条 fixture 的索引冒充真库。
 */

/** 低于这个条数就当作「只有 seed」。真库是 9 万多条，留两个数量级的余量。 */
export const REAL_LIB_MIN = 20000

/** @param {any} tags 索引实例，或它 stats() 的结果 */
function statsOf(tags) {
  return typeof tags?.stats === 'function' ? tags.stats() : tags
}

/** 有真库返回 true（用例继续跑） */
export function hasRealLibrary(tags) {
  const stats = statsOf(tags) || {}
  if (stats.seedOnly === true) return false
  return Number(stats.loaded ?? 0) > REAL_LIB_MIN
}

/** 没有真库就 skip 当前用例并返回 false，调用方 `if (!requireRealLibrary(t, tags)) return` */
export function requireRealLibrary(t, tags) {
  if (hasRealLibrary(tags)) return true
  const stats = statsOf(tags) || {}
  const loaded = Number(stats.loaded ?? 0)
  const why = stats.seedOnly === true ? '只有 seed' : 'loaded=' + loaded
  t.skip('本机没有 Danbooru 词库（' + why + '），先跑 scripts/tags/build-tags.mjs')
  return false
}