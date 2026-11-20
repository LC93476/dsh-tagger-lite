/**
 * 配置解析：默认值 < profile 里的 YAML config < 插件数据目录的 settings.json。
 *
 * 为什么要有 settings.json：面板上改模型 / 强度 / ComfyUI 地址要立刻生效，
 * 而改 DEFAULTS / 环境变量只能重启服务。所以面板写的是 settings.json，
 * YAML 只当"出厂默认"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROFILE_IDS, applyProfile } from './model-profiles.js'

export const PLUGIN_ID = 'dsh-tagger'

/**
 * 插件数据目录（持久状态：settings.json、日志、缩略图缓存）。
 *
 * DSH_PROMPT_FORGE_DATA 可以改掉它 —— 测试要隔离，不能把断言写进用户真实配置。
 */
export function dataDir() {
  const override = typeof process.env.DSH_TAGGER_DATA === 'string' ? process.env.DSH_TAGGER_DATA.trim() : ''
  if (override !== '') return override
  const legacyEnv = typeof process.env.DSH_PROMPT_FORGE_DATA === 'string' ? process.env.DSH_PROMPT_FORGE_DATA.trim() : ''
  if (legacyEnv !== '') return legacyEnv
  const next = path.join(os.homedir(), '.dsh-tagger')
  // 从 dsh-prompt-forge 迁移：新目录还不存在而旧目录有配置时，先接着用旧目录，别丢用户设置。
  const legacy = path.join(os.homedir(), '.dsh-prompt-forge')
  try {
    fs.accessSync(next)
    return next
  } catch {
    try {
      fs.accessSync(legacy)
      return legacy
    } catch {
      return next
    }
  }
}

export function settingsPath() {
  return path.join(dataDir(), 'settings.json')
}

export const DEFAULTS = {
  llm: {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: '',
    maxTokens: 4000,
    timeoutMs: 120000,
    // 只在「没有宿主 llm 服务」的场合用（独立服务 / web 版）：DSH 插件里走 ctx.get(llm)，这两项被忽略。
    baseUrl: '',
    apiKey: '',
  },
  purge: {
    enabled: true,
    level: 'full',
    extraDirectives: [],
  },
  tags: {
    standards: ['wd', 'camie'],
    maxTags: 40,
    weightSyntax: 'comfy',
    chineseAlias: true,
    // 真词表目录（Danbooru 的 *.jsonl）。空数组 = 按内置顺序探测：
    // 环境变量 DSH_DANBOORU_DIR / DSH_COMFYUI_DATA_DIR → ~/.dsh-comfyui-workbench/data/danbooru → 包内快照。
    // 探测不到就只加载 seed + overlay（1247 条），此时 forge 会把大量常见词判成「不在库里」。
    dataDirs: [],
    // 正向串开头那组质量词，顺序即输出顺序。置空数组 = 不自动加（模型写了的仍会归到最前）。
    qualityTags: ['masterpiece', 'best_quality', 'highres'],
  },
  // 锻造后处理的三道工序（都是本地纯计算，不花 token）：词形修复、去重合序、中文姿势意图补词。
  forge: {
    // 模型档案：tag（SDXL 动漫微调）/ pony（Pony 系）/ natural（Flux·SD3.5·写实）/ custom（自己填）。
    // 前三个会接管 quality 与 tags.qualityTags（切档后手改的质量词会被覆盖，面板看到的是生效值）；
    // 要自己挑质量词就切 custom。
    profile: 'tag',
    repair: true,
    postprocess: true,
    poseHints: true,
    candidates: true,
    candidateLimit: 18,
    // 质量词置顶（masterpiece / best_quality / highres 放最前）；关掉就回到「一律丢掉、交给工作流内置」。
    quality: true,
    // 词序重排（按 14 段桶序排）：只在 profile=custom 时生效 —— natural 档重排会毁掉语序，tag / pony 档恒为开。
    order: true,
  },
  // 二次精修：对已锻造的标签串做增量增删/调权重，而不是重跑一遍。
  refine: {
    mode: 'add',
    maxNewTags: 12,
    temperature: 0.4,
    maxTokens: 3000,
    timeoutMs: 120000,
    keepOrder: true,
  },
  comfy: {
    baseUrl: 'http://127.0.0.1:8188',
    // 面板「启动 ComfyUI」用的三件事：装在哪、用哪个 python、要不要追加参数
    launchDir: '',
    pythonPath: '',
    launchArgs: '',
    workflowDir: '',
    defaultWorkflowId: '',
    positiveNode: '',
    negativeNode: '',
    pollIntervalMs: 1000,
    // 单次 HTTP（提交 / 上传 / 探活）的等待上限；整张图的总等待看 timeoutMs
    submitTimeoutMs: 120000,
    timeoutMs: 900000,
  },
  ui: {
    keepHistory: 20,
  },
}

const LEVELS = new Set(['off', 'light', 'standard', 'full', 'max'])
const SYNTAX = new Set(['comfy', 'a1111', 'plain'])
const STANDARDS = new Set(['wd', 'camie'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function merge(base, patch) {
  if (!isRecord(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(base[key])) out[key] = merge(base[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

/** 读 settings.json；坏文件不阻止插件上线。 */
export function readPersisted() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 把一次面板修改合并进 settings.json，返回合并后的完整值。 */
export function writePersistedPatch(patch) {
  const next = merge(readPersisted(), patch)
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/** 归一化：任何非法值都被翻译回默认值，面板因此永远拿到可用配置。 */
export function normalize(input) {
  const cfg = merge(DEFAULTS, isRecord(input) ? input : {})
  const level = LEVELS.has(cfg.purge.level) ? cfg.purge.level : DEFAULTS.purge.level
  const standards = Array.isArray(cfg.tags.standards)
    ? cfg.tags.standards.map(v => String(v).toLowerCase()).filter(v => STANDARDS.has(v))
    : DEFAULTS.tags.standards
  const syntax = SYNTAX.has(cfg.tags.weightSyntax) ? cfg.tags.weightSyntax : DEFAULTS.tags.weightSyntax
  // 模型档案：合法 id 才认，其余一律回 tag（旧 settings.json 里没有 forge.profile，行为与以前完全一致）。
  const rawProfile = String(cfg.forge?.profile ?? '').trim().toLowerCase()
  const profile = PROFILE_IDS.includes(rawProfile) ? rawProfile : DEFAULTS.forge.profile
  // 档案接管 quality / qualityTags / order：这里就落地成生效值，下游（forge / 后处理）不用再判档案。
  const eff = applyProfile({
    forge: { profile, quality: cfg.forge?.quality, order: cfg.forge?.order },
    tags: { qualityTags: cfg.tags?.qualityTags },
  })
  return {
    llm: {
      provider: str(cfg.llm.provider, DEFAULTS.llm.provider).trim() || DEFAULTS.llm.provider,
      model: str(cfg.llm.model, DEFAULTS.llm.model).trim() || DEFAULTS.llm.model,
      reasoningEffort: str(cfg.llm.reasoningEffort, '').trim(),
      maxTokens: num(cfg.llm.maxTokens, DEFAULTS.llm.maxTokens, 256, 16000),
      timeoutMs: num(cfg.llm.timeoutMs, DEFAULTS.llm.timeoutMs, 10000, 600000),
      baseUrl: str(cfg.llm.baseUrl, '').trim().replace(/\/+$/, ''),
      apiKey: str(cfg.llm.apiKey, '').trim(),
    },
    purge: {
      enabled: cfg.purge.enabled !== false,
      level,
      extraDirectives: Array.isArray(cfg.purge.extraDirectives)
        ? cfg.purge.extraDirectives.map(v => String(v)).filter(v => v.trim() !== '')
        : [],
    },
    tags: {
      standards: standards.length > 0 ? standards : DEFAULTS.tags.standards,
      maxTags: num(cfg.tags.maxTags, DEFAULTS.tags.maxTags, 8, 160),
      weightSyntax: syntax,
      chineseAlias: cfg.tags.chineseAlias !== false,
      // 只做去空/去重/截断：路径合法性留给 discoverDataDir 判定（不存在的目录自然跳过）。
      dataDirs: Array.isArray(cfg.tags.dataDirs)
        ? Array.from(new Set(cfg.tags.dataDirs.map(v => str(v, '').trim()).filter(v => v !== ''))).slice(0, 8)
        : DEFAULTS.tags.dataDirs,
      // 档案优先（tag → masterpiece 组 / pony → score 组 / natural → 空 = 一组都不补），custom 档读配置自己的值。
      // 无论来源都照旧清洗：小写、空格转下划线、去空、去重、截 12 —— 面板拿到的一定是能直接用的词。
      qualityTags: Array.from(new Set(eff.qualityTags
        .map(v => String(v).trim().toLowerCase().replace(/\s+/g, '_'))
        .filter(v => v !== ''))).slice(0, 12),
    },
    forge: {
      profile,
      repair: cfg.forge?.repair !== false,
      postprocess: cfg.forge?.postprocess !== false,
      poseHints: cfg.forge?.poseHints !== false,
      candidates: cfg.forge?.candidates !== false,
      candidateLimit: num(cfg.forge?.candidateLimit, DEFAULTS.forge.candidateLimit, 4, 40),
      // 质量词开关与词序重排：档案说了算（custom 档才回读配置）。
      quality: eff.quality,
      order: eff.order,
    },
    refine: {
      mode: ['add', 'edit', 'prune', 'weights'].includes(cfg.refine?.mode) ? cfg.refine.mode : DEFAULTS.refine.mode,
      maxNewTags: num(cfg.refine?.maxNewTags, DEFAULTS.refine.maxNewTags, 1, 40),
      temperature: Math.min(1.2, Math.max(0, Number(cfg.refine?.temperature ?? DEFAULTS.refine.temperature) || 0)),
      maxTokens: num(cfg.refine?.maxTokens, DEFAULTS.refine.maxTokens, 256, 16000),
      timeoutMs: num(cfg.refine?.timeoutMs, DEFAULTS.refine.timeoutMs, 10000, 600000),
      keepOrder: cfg.refine?.keepOrder !== false,
    },
    comfy: {
      baseUrl: str(cfg.comfy.baseUrl, DEFAULTS.comfy.baseUrl).replace(/\/+$/, '') || DEFAULTS.comfy.baseUrl,
      launchDir: str(cfg.comfy.launchDir, '').trim(),
      pythonPath: str(cfg.comfy.pythonPath, '').trim(),
      launchArgs: str(cfg.comfy.launchArgs, '').trim(),
      workflowDir: str(cfg.comfy.workflowDir, '').trim(),
      defaultWorkflowId: str(cfg.comfy.defaultWorkflowId, '').trim(),
      positiveNode: str(cfg.comfy.positiveNode, '').trim(),
      negativeNode: str(cfg.comfy.negativeNode, '').trim(),
      pollIntervalMs: num(cfg.comfy.pollIntervalMs, DEFAULTS.comfy.pollIntervalMs, 200, 10000),
      submitTimeoutMs: num(cfg.comfy.submitTimeoutMs, DEFAULTS.comfy.submitTimeoutMs, 5000, 600000),
      timeoutMs: num(cfg.comfy.timeoutMs, DEFAULTS.comfy.timeoutMs, 30000, 3600000),
    },
    ui: {
      keepHistory: num(cfg.ui.keepHistory, DEFAULTS.ui.keepHistory, 0, 200),
    },
  }
}

/** 某层配置里是否显式写了值（用于判断「用户有没有自己动过这一项」）。 */
function hasOwnKey(source, section, key) {
  return isRecord(source) && isRecord(source[section]) && Object.prototype.hasOwnProperty.call(source[section], key)
}

/** 最终生效配置：YAML 覆盖默认值，settings.json 覆盖 YAML。
 *
 * 一处兼容处理：老用户可能手改过 tags.qualityTags / forge.quality 而没听说过 forge.profile，
 * 直接按默认 tag 档接管会把他的自定义悄悄冲掉。所以只要没显式选档案、又手改过这三个键之一，
 * 就把档案当 custom —— 手改的东西照旧生效，行为与加档案之前一致。
 */
export function resolveConfig(rawConfig) {
  const yaml = isRecord(rawConfig) ? rawConfig : {}
  const persisted = readPersisted()
  const merged = merge(merge(DEFAULTS, yaml), persisted)
  const pickedProfile = hasOwnKey(yaml, 'forge', 'profile') || hasOwnKey(persisted, 'forge', 'profile')
  const handTuned = ['qualityTags'].some(key => hasOwnKey(yaml, 'tags', key) || hasOwnKey(persisted, 'tags', key))
    || ['quality', 'order'].some(key => hasOwnKey(yaml, 'forge', key) || hasOwnKey(persisted, 'forge', key))
  if (!pickedProfile && handTuned) {
    merged.forge = { ...merged.forge, profile: 'custom' }
  }
  return normalize(merged)
}
