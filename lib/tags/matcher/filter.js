// plan: lib/tags/matcher/filter.js 放结果合并与去重（同一 tag 只留最高分，多词按名次累加）
/**
 * lib/tags/matcher/filter.js — 命中集合的冲突过滤与收尾排序。
 *
 * runQuery 与 search 各自先攒一张 Map（tag → 候选），这里只负责「同一 tag 只留最好的那条」
 * 与最终的排序截断，纯函数、不碰 state。顺序就是对外结果的顺序，别在这里改语义。
 */
import { rankScore } from './score.js'

/**
 * 同一 tag 已被命中过时只保留分更高的一条。
 * @param {Map<string, {entry: any, score: number}>} hits 命中集合
 * @param {any} entry 待加入的词条
 * @param {number} score 该词条本次的分
 * @returns {void}
 */
export function pickHit(hits, entry, score) {
  const prev = hits.get(entry.tag)
  if (prev === undefined || prev.score < score) hits.set(entry.tag, { entry, score })
}

/**
 * 检索收尾：按分降序、同分按热度降序，截断后转成对外行。
 * @param {Map<string, {entry: any, score: number}>} hits 命中集合
 * @param {number} limit 最多几条
 * @param {(entry: any) => any} toRow 词条转对外行
 * @returns {any[]}
 */
export function finalizeHits(hits, limit, toRow) {
  return [...hits.values()]
    .sort((a, b) => b.score - a.score || b.entry.postCount - a.entry.postCount)
    .slice(0, limit)
    .map(item => toRow(item.entry))
}

/**
 * 多词检索的单条合并：命中词数累加、名次分累加、代表行取热度更高的那条。
 * @param {Map<string, {row: any, tokens: number, score: number}>} merged 合并集合
 * @param {any} row 本次命中的行
 * @param {number} index 该词在查询里的序号（从 0 开始）
 * @returns {void}
 */
export function mergeRanked(merged, row, index) {
  const rank = rankScore(index)
  const prev = merged.get(row.tag)
  if (prev === undefined) {
    merged.set(row.tag, { row, tokens: 1, score: rank })
    return
  }
  prev.tokens += 1
  prev.score += rank
  if (row.postCount > prev.row.postCount) prev.row = row
}

/**
 * 多词检索收尾：命中词数多的先，其次累加分，再其次热度。
 * @param {Map<string, {row: any, tokens: number, score: number}>} merged 合并集合
 * @param {number} limit 最多几条
 * @returns {any[]}
 */
export function finalizeMerged(merged, limit) {
  return [...merged.values()]
    .sort((a, b) => b.tokens - a.tokens || b.score - a.score || b.row.postCount - a.row.postCount)
    .slice(0, limit)
    .map(item => item.row)
}
