// plan: 纯字符串构造 —— user prompt 拼装（含本地词库候选段）与单个 tag 的最终写法（plain / comfy / a1111）。
import { clampNumber, trimNumber } from './util.js'

/** 单个 tag 的最终写法。plain 语法丢掉权重；comfy/a1111 用 (tag:1.2)。 */
export function formatEntry(tag, weight, syntax) {
  if (syntax === 'plain') return tag
  const w = clampNumber(weight, 0.1, 2.5, 1)
  if (Math.abs(w - 1) < 0.005) return tag
  return '(' + tag + ':' + trimNumber(w) + ')'
}

/**
 * user prompt：画面描述 + 本次要求 + 本地词库候选（RAG）。
 * 候选段只放"库里真有的词"，让模型照抄拼写，别自己回忆。
 */
export function buildUserPrompt(text, opts, candidates) {
  const lines = [
    '【画面描述】',
    text,
    '',
    '【本次要求】',
    '- 标准：' + opts.standards.join(' + '),
    '- 正向 tag 上限：' + opts.maxTags + ' 条',
    '- 权重语法：' + opts.syntax,
  ]
  if (opts.negative !== '') lines.push('- 必须并入 negative 的额外负向词：' + opts.negative)
  if (opts.notes !== '') lines.push('- 额外说明：' + opts.notes)
  // RAG：本地词库按白话检索出的真 tag，直接给模型抄，比它自己回忆拼写靠谱。
  if (Array.isArray(candidates) && candidates.length > 0) {
    lines.push(
      '',
      '【本地词库候选（这些是库里真有的词，描述对得上就直接用，拼写照抄）】',
      candidates.map(item => (typeof item.cn === 'string' && item.cn !== '' ? item.tag + '（' + item.cn + '）' : item.tag)).join('、'),
    )
  }
  lines.push('', '只输出 JSON 对象。')
  return lines.join('\n')
}
