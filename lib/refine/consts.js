// plan: 精修引擎的共享常量（模式表、模型默认值、权重上下限、索引等待）—— 没有逻辑，只被 refine/ 其余模块 import。
import {
  PURGE_LEVELS,
} from '../purge.js'

export const MODES = ['add', 'edit', 'prune', 'weights']
export const MODE_SET = new Set(MODES)
export const PURGE_LEVEL_SET = new Set(PURGE_LEVELS)

export const DEFAULT_PROVIDER = 'opencode-go'
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'
export const DEFAULT_TIMEOUT_MS = 120000
export const DEFAULT_TEMPERATURE = 0.4
export const DEFAULT_MAX_TOKENS = 3000
export const DEFAULT_MAX_NEW_TAGS = 12
export const MAX_NEW_CEILING = 40
export const MAX_TOKEN_CEILING = 16000
export const MIN_WEIGHT = 0.1
export const MAX_WEIGHT = 2.5
export const INDEX_WAIT_MS = 3000
export const INDEX_WAIT_TIMEOUT = '\u0000index-wait'
export const COLD_INDEX_WARNING = '标签库未就绪，未校对'

/** 四种模式各自允许模型做什么 —— 直接写进 user prompt，别让模型自己猜。 */
export const MODE_RULES = {
  add: '补齐模式：在现有串上补缺失的标签；**不动**已有标签、不改已有权重、不删任何标签（remove 留空）。',
  edit: '改写模式：按指令换画面内容 —— 删掉与新画面冲突的标签（remove），补新标签（add）；没冲突的标签不动。',
  prune: '去冗余模式：只删冗余 / 互相冲突的标签（remove）；**不新增**（add 必须是空数组），不动权重。',
  weights: '权重模式：只调整现有标签的权重（weights）；**不新增也不删除**，标签集合与顺序都不变。',
}

