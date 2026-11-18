// plan: 门面 —— 保持 lib/forge.js 这个入口可用（index.js / tests 都从这里 import createForge）。
// 实现已按职责拆到 lib/forge/：
//   prompt.js    纯字符串构造（user prompt、tag 写法）
//   parse.js     模型回流解析（JSON 抽取 + 修复一次、权重拆解、正负向拾取）
//   stream.js    llm.stream 读取（text-delta 拼接、usage、超时/取消）
//   options.js   选项归一（破甲档位 / standards / syntax / maxTags / 模型 / 超时）
//   pipeline.js  三道本地后处理（词形修复 → 姿势意图 → 去重合序）+ 画质词清理
//   history.js   history.json 读写
//   index.js     createForge 主体
export { createForge } from './forge/index.js'
export { normalizeOptions, resolveLevel, cfgForLevel } from './forge/options.js'
export { parseForgeJson, normalizeList, normalizeEntry, pickPositive, pickNegative, pickNotes } from './forge/parse.js'
export { buildUserPrompt, formatEntry } from './forge/prompt.js'
export { stripQuality, createPipelineRunner } from './forge/pipeline.js'
