/**
 * lib/comfy.js — 兼容门面（薄）：实现已目录化到 lib/comfy/。
 *
 * 外部 import 路径保持不变：index.js 从 './lib/comfy.js' 拿 createComfyClient，测试从它拿
 * resolveWorkflowDir / isUiFormat / resolveTextMapping / applyVars —— 一行都不用改。
 */
export * from './comfy/index.js'
