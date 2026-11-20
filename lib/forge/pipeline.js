// plan: 三道本地后处理（① 词形修复 → ② 中文姿势/视角意图 → ③ 去重合序）+ 画质词清理。
//
// 调用顺序固定，就在 generate 里「标签库校对之后、拼正/负向串之前」这一段：
//   ① fixer.fix(rows)              模型爱写 top_down_bottom_up / worm's-eye_view 这类"差一点就对"的词，
//                                  先在本地纠回库里真词（连字符、撇号、单复数、近邻），修不上的原样留着记账；
//   ② detectPoseHints + applyPoseHints  白话里说「跪趴」「从下面看」，模型常漏，本地补（只补缺失，不动已有词序），
//                                  补进来的行再过一次 canonicalizeAll；
//   ③ postprocessor.apply(rows)    质量词置顶、真同义只留一个、上位词降权、按 14 段排词序、超上限按段优先级裁剪，
//                                  整理会摘掉库里没有的词，restoreUnmatched 按原相对位置把它们插回来。
//
// 约定（改动时务必守住）：**任何一道失败只记一条 warning（log.warn）并继续跑下一道，绝不打断锻造**，
// 也不把已经处理好的行丢掉；三道可各自用 config.forge.repair / poseHints / postprocess 单独关掉。
// 处理痕迹 { repairs, poseHints, changes } 随结果返回，面板靠它显示"到底改了什么"。
import { createPostProcessor } from '../postprocess.js'
import { DEFAULT_QUALITY_TAGS } from '../postprocess/rules.js'
import { createRepairer } from '../repair.js'
import { applyPoseHints, detectPoseHints } from '../zh-intent.js'
import { dedupe, isRecord } from './util.js'

// 质量词由后处理统一加在串首；模型自己写的真评分词留着归位，现编的（extremely_detailed 之类）在这里丢掉。
export const QUALITY_TAGS = new Set([
  'masterpiece', 'best_quality', 'great_quality', 'good_quality', 'high_quality', 'ultra_quality',
  'highest_quality', 'amazing_quality', 'perfect_quality', 'highres', 'absurdres', 'ultra_detailed',
  'extremely_detailed', 'very_aesthetic', 'newest',
])

// 真正留在串里、交给后处理置顶的那批（本机词表快照里确实有这些条目）。
// QUALITY_TAGS 里其余名字（extremely_detailed / great_quality / ultra_quality…）多半是模型现编的，见下方按伪词处理。
export const REAL_QUALITY_TAGS = new Set([
  'masterpiece', 'best_quality', 'good_quality', 'normal_quality', 'highres', 'absurdres',
  'ultra_detailed', 'very_aesthetic', 'newest',
])

// 模型爱现编的画质词：highly_detailed / extremely_detailed / super_detailed…，全部按画质词处理。
export const QUALITY_PATTERN = /^(highly|very|ultra|extremely|super|absurdly|insanely|incredibly)_(detailed|quality|resolution)$|_detailed$|_quality$/

export function isQualityKey(key) {
  if (QUALITY_TAGS.has(key)) return true
  if (key === 'detailed' || key === 'detailed_background') return false
  return QUALITY_PATTERN.test(key)
}

/**
 * 质量词分两堆：
 *   - 库里真有的评分词（masterpiece / best_quality / highres / very_aesthetic…）**留着**，
 *     交给后处理的 ensureQuality 统一置顶（config.forge.quality 关掉时那边会把它们丢掉）；
 *   - 模型现编的（highly_detailed / super_quality / absurdly_detailed…）当伪词丢掉，它进串只会稀释权重。
 * described 参数保留是为了不破调用签名（以前用来判断「用户点名就留」）。
 * @returns {{ rows: Array<object>, dropped: Array<string> }}
 */
export function stripQuality(rows, described) {
  void described
  const kept = []
  const dropped = []
  for (const row of rows) {
    const key = String(row?.tag ?? '').toLowerCase().trim().replace(/\s+/g, '_').replace(/^\(+|\)+$/g, '')
    if (isQualityKey(key) && !REAL_QUALITY_TAGS.has(key)) {
      dropped.push(row.tag)
      continue
    }
    kept.push(row)
  }
  return { rows: kept, dropped }
}

/**
 * 三道本地处理的接线器：repairer / postProcessor 懒建一次（都靠标签索引），
 * 建失败只 warn 并把该道当"没有"，不影响其它两道。
 * @param {{ cfg: object, log: object, tags?: object, canonicalizeAll: Function }} deps
 */
export function createPipelineRunner({ cfg, log, tags, canonicalizeAll }) {
  let repairer
  let postProcessor

  function getRepairer() {
    if (repairer === undefined) {
      try {
        repairer = tags !== undefined && tags !== null ? createRepairer({ tags, logger: log }) : null
      } catch (error) {
        log.warn('词形修复器创建失败，本次跳过：' + (error instanceof Error ? error.message : String(error)))
        repairer = null
      }
    }
    return repairer
  }

  function getPostProcessor() {
    if (postProcessor === undefined) {
      try {
        postProcessor = createPostProcessor({ tags, logger: log })
      } catch (error) {
        log.warn('后处理管线创建失败，本次跳过：' + (error instanceof Error ? error.message : String(error)))
        postProcessor = null
      }
    }
    return postProcessor
  }

  /** 把后处理管线的 change 列表压成一句人话（只报用户看得懂的那几类）。 */
  function summarizeChanges(changes) {
    const label = { dedupe: '去掉重复/同义', superset: '上位词降权', fill: '补主体', trim: '裁掉超量' }
    const counts = new Map()
    for (const item of changes) {
      const kind = item !== null && typeof item === 'object' ? item.kind : undefined
      if (kind === undefined || label[kind] === undefined) continue
      if (item.reason === 'unmatched') continue
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    if (counts.size === 0) return ''
    return [...counts].map(([kind, n]) => label[kind] + (n > 1 ? '×' + n : '')).join('、')
  }

  /**
   * 本地补进来的行（比如自动补的 1girl）没有中文名，中英对照框会缺一格。
   * 这里回查一次标签库把中文补上，查不到就留空（对照框会只显示 tag）。
   */
  async function withCn(rows) {
    if (tags === undefined || tags === null || typeof tags.canonicalize !== 'function') return rows
    const out = []
    for (const row of rows) {
      if (typeof row.cn === 'string' && row.cn !== '') {
        out.push(row)
        continue
      }
      let cn = ''
      try {
        const hit = await tags.canonicalize(row.tag, { syntax: cfg.tags?.weightSyntax ?? 'comfy' })
        if (hit !== null && typeof hit === 'object' && typeof hit.cn === 'string') cn = hit.cn
      } catch (error) {
        log.warn('补中文名失败：' + (error instanceof Error ? error.message : String(error)))
      }
      out.push(cn === '' ? row : { ...row, cn })
    }
    return out
  }

  /**
   * 整理管线会把库里没有的词直接丢掉（免得污染 prompt），但那等于把用户看得见的东西
   * 静悄悄删了。这里把未收录的行按原来的相对位置插回去：用户自己删才叫删。
   */
  function restoreUnmatched(postRows, snapshot) {
    const position = new Map()
    snapshot.forEach((row, index) => { position.set(String(row.tag).toLowerCase(), index) })
    const present = new Set(postRows.map(row => String(row.tag).toLowerCase()))
    const missing = snapshot
      .map((row, index) => ({ row, index }))
      .filter(item => item.row.matched === false && present.has(String(item.row.tag).toLowerCase()) === false)
    if (missing.length === 0) return postRows

    const out = postRows.slice()
    for (const item of missing) {
      let at = out.length
      for (let index = 0; index < out.length; index++) {
        const origin = position.get(String(out[index].tag).toLowerCase())
        if (origin !== undefined && origin > item.index) {
          at = index
          break
        }
      }
      out.splice(at, 0, item.row)
    }
    return out
  }

  /**
   * 跑三道本地处理。rows 必须已经过标签库校对（matched 有值的行）。
   * 返回 { rows, info }：rows 是最终正序行，info 是面板要显示的处理痕迹。
   */
  async function run({ rows, described, opts, forgeCfg, warnings, warnOnce, quality }) {
    // 三道本地处理的痕迹：面板要显示"改了什么"，用户才有据可查（也方便排查词库缺词）。
    const pipelineInfo = { repairs: [], poseHints: [], changes: [] }

    let positiveRows = rows

    // ① 词形修复：模型爱写的 top_down_bottom_up / worm's-eye_view 这类"差一点就对"的词，
    //    先在本地纠回库里真词（连字符、撇号、单复数、近邻），修不上的原样留着由下面记账。
    if (forgeCfg.repair !== false) {
      const fixer = getRepairer()
      if (fixer !== null) {
        try {
          const fixed = await fixer.fix(positiveRows)
          positiveRows = fixed.rows
          pipelineInfo.repairs = fixed.fixes.map(item => ({ from: item.from, to: item.to, how: item.how }))
          if (fixed.fixes.length > 0) {
            warnOnce('词形修正：' + fixed.fixes.map(item => item.from + ' → ' + item.to).join('、'))
          }
        } catch (error) {
          log.warn('词形修复失败，按原样继续：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
    positiveRows = dedupe(positiveRows)

    // 未收录的先记账——整理阶段会把它们摘掉，别让它们无声消失。
    for (const row of positiveRows) {
      if (row.matched === false) warnOnce((row.raw ?? row.tag) + ' 不在库里')
    }

    // ② 中文姿势/视角意图：白话里说「跪趴」「从下面看」，模型常漏，本地补（只补缺失，不动已有词序）。
    if (forgeCfg.poseHints !== false) {
      try {
        const hints = detectPoseHints(described)
        if (hints.length > 0) {
          const applied = applyPoseHints(positiveRows, hints)
          if (applied.added.length > 0) {
            pipelineInfo.poseHints = applied.added.map(item => ({ tag: item.tag, weight: item.weight, hit: item.key }))
            positiveRows = dedupe(await canonicalizeAll(applied.rows, warnings))
            warnOnce('补了话里的姿势/视角：' + applied.added.map(item => item.tag).join(', '))
          }
        }
      } catch (error) {
        log.warn('姿势意图识别失败，跳过：' + (error instanceof Error ? error.message : String(error)))
      }
    }

    // ③ 去重合序：质量词置顶、真同义只留一个、上位词降权、按 14 段排词序、超上限按段优先级裁剪。
    if (forgeCfg.postprocess !== false) {
      const pipeline = getPostProcessor()
      if (pipeline !== null) {
        try {
          const snapshot = positiveRows.slice()
          const post = pipeline.apply(positiveRows, {
            described,
            maxTags: opts.maxTags,
            syntax: opts.syntax,
            standards: opts.standards,
            // 质量词置顶：默认那组放最前，模型自己写过的同名词只留一条（保留权重）。
            quality: quality !== undefined && quality !== null ? quality.enabled !== false : true,
            qualityTags: quality !== undefined && quality !== null && Array.isArray(quality.tags) ? quality.tags : undefined,
          })
          // 插回来的是库里没有的词（warnings 已点名）：按原位插入会打断段落顺序，再排一次桶序，
          // 能认出桶的（soft_lighting 这种词根明确的）归位，认不出的落最后。
          const restored = restoreUnmatched(post.rows, snapshot)
          const qualitySet = new Set(quality !== undefined && quality !== null && Array.isArray(quality.tags) ? quality.tags : DEFAULT_QUALITY_TAGS)
          positiveRows = await withCn(pipeline.orderRows(restored, qualitySet).rows)
          // 面板只需要"看得见的动作"：排序/分桶是内部步骤，unmatched 已经单独进 warnings，都不列。
          pipelineInfo.changes = post.changes
            .filter(item => item.kind !== 'order' && item.kind !== 'buckets' && item.reason !== 'unmatched')
            .map(item => ({ kind: item.kind, tag: item.tag, ...item.reason === undefined ? {} : { reason: item.reason } }))
          const summary = summarizeChanges(post.changes)
          if (summary !== '') warnOnce('整理：' + summary)
        } catch (error) {
          log.warn('后处理失败，按原样继续：' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }

    return { rows: positiveRows, info: pipelineInfo }
  }

  return { run, getRepairer, getPostProcessor, summarizeChanges, withCn, restoreUnmatched }
}
