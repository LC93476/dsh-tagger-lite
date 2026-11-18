// 常量：注册 id、接口前缀、档位、轮询间隔。纯常量，无依赖。
export const NS = 'dsh-tagger'
// 主注册前缀是 lib/routes.js 的 PREFIX（/tagger/api）；/prompt-forge/api 只是旧前缀别名。
export const API = '/tagger/api'
export const PANEL_ID = 'prompt-forge'
export const TAB_ID = 'prompt-forge:forge'
export const LEVELS = ['off', 'light', 'standard', 'full', 'max']
export const REFINE_MODES = ['add', 'edit', 'prune', 'weights']
export const JOB_KEY = { idle: 'idle', submitting: 'submitting', queued: 'queued', running: 'running', done: 'done', failed: 'failed', unknown: 'unknown' }
export const DEFAULT_POLL_MS = 1200
