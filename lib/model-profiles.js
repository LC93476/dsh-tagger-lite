/**
 * 模型档案：不同模型的文本编码器吃不同的写法，这里把「一个开关」翻译成三个配置键。
 *
 * 为什么要有它：SDXL 动漫系微调（Illustrious / NoobAI / Anima / Pony）吃 Danbooru tag，
 * Flux / SD3.5 / 写实类吃自然语言句子，把 tag 串硬塞过去反而更差。差别只在三件事上：
 *   1) 串首要放什么质量词（masterpiece? score_9? 什么都不要?）
 *   2) 要不要自动补质量词
 *   3) 要不要按 14 段重排词序 —— 自然语言模型对句子顺序敏感，重排会毁掉语序。
 *
 * profile 只在 normalize 里生效：选定 tag / pony / natural 时，quality 与 qualityTags 由档案决定，
 * 面板上再改会被覆盖（面板看到的是生效值，不会出现"改了没反应"）；要自己调就切到 custom。
 */

/** 档案 id 的合法集合，顺序即面板下拉里的顺序。
 * @type {readonly string[]}
 */
export const PROFILE_IDS = ['tag', 'pony', 'natural', 'custom']

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   note: string,
 *   style: "tag" | "prose",
 *   quality: boolean | null,
 *   qualityTags: string[] | null,
 *   order: boolean | null,
 * }} ModelProfile
 */

/** 档案表。quality / qualityTags / order 为 null 表示「不接管、用配置里的值」（只有 custom 这样）。
 * @type {Record<string, ModelProfile>}
 */
export const PROFILES = {
  tag: {
    id: 'tag',
    title: 'Danbooru tag 系（SDXL 动漫微调）',
    note: 'Illustrious / NoobAI / Anima / Animagine 这类：逗号分隔 tag + 权重括号 + 质量词置顶，就是本项目的主场。',
    style: 'tag',
    quality: true,
    qualityTags: ['masterpiece', 'best_quality', 'highres'],
    order: true,
  },
  pony: {
    id: 'pony',
    title: 'Pony 系（SDXL 衍生）',
    note: 'Pony Diffusion V6 及其融合：写法同 tag 系，但开头必须是 score 标记，不是 masterpiece。',
    style: 'tag',
    quality: true,
    qualityTags: ['score_9', 'score_8_up', 'score_7_up', 'source_anime'],
    order: true,
  },
  natural: {
    id: 'natural',
    title: '自然语言系（Flux / SD3.5 / 写实）',
    note: 'T5 / LLM 文本编码器：整句优于标签堆砌，括号权重基本无效，质量词交给工作流。此档不补质量词、不重排词序。',
    style: 'prose',
    quality: false,
    qualityTags: [],
    order: false,
  },
  custom: {
    id: 'custom',
    title: '自定义（自己填质量词）',
    note: '质量词、质量开关、排序开关全部读配置里的 forge.quality / forge.order / tags.qualityTags。',
    style: 'tag',
    quality: null,
    qualityTags: null,
    order: null,
  },
}

/** 拿档案；不认识的 id 一律回 tag（面板永远拿得到可用值）。
 * @param {unknown} id
 * @returns {ModelProfile}
 */
export function profileOf(id) {
  const key = typeof id === "string" ? id.trim().toLowerCase() : ""
  return PROFILES[key] ?? PROFILES.tag
}

/** 面板 / API 用的档案清单（不含 null 实现细节，直接给生效值）。
 * @returns {Array<{ id: string, title: string, note: string, style: string, quality: boolean, qualityTags: string[], order: boolean }>}
 */
export function listProfiles() {
  return PROFILE_IDS.map((id) => {
    const p = PROFILES[id]
    return {
      id: p.id,
      title: p.title,
      note: p.note,
      style: p.style,
      quality: p.quality === true,
      qualityTags: Array.isArray(p.qualityTags) ? p.qualityTags.slice() : [],
      order: p.order !== false,
    }
  })
}

/**
 * 把档案落到配置上：返回本次真正生效的四个值。
 * custom（或档案缺这三个键）时原样回退到配置里的值。
 * @param {{ forge?: { profile?: unknown, quality?: unknown, order?: unknown }, tags?: { qualityTags?: unknown } }} cfg
 * @returns {{ id: string, style: "tag" | "prose", quality: boolean, qualityTags: string[], order: boolean }}
 */
export function applyProfile(cfg) {
  const profile = profileOf(cfg?.forge?.profile)
  const cfgTags = Array.isArray(cfg?.tags?.qualityTags)
    ? cfg.tags.qualityTags.map((v) => String(v).trim().toLowerCase().replace(/\s+/g, "_")).filter((v) => v !== "")
    : []
  return {
    id: profile.id,
    style: profile.style,
    quality: profile.quality === null ? cfg?.forge?.quality !== false : profile.quality,
    qualityTags: profile.qualityTags === null ? Array.from(new Set(cfgTags)).slice(0, 12) : profile.qualityTags.slice(),
    order: profile.order === null ? cfg?.forge?.order !== false : profile.order,
  }
}

/** 面板状态卡：当前档案 + 生效值。
 * @param {any} cfg
 */
export function profileState(cfg) {
  const profile = profileOf(cfg?.forge?.profile)
  const effective = applyProfile(cfg)
  return {
    id: profile.id,
    title: profile.title,
    note: profile.note,
    style: profile.style,
    quality: effective.quality,
    qualityTags: effective.qualityTags,
    order: effective.order,
    controlled: profile.quality !== null,
  }
}