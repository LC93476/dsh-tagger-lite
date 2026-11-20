// plan: 门面 —— 老入口 lib/postprocess.js 保持原路径与原导出面；数据在 ./postprocess/rules.js，流程在 ./postprocess/index.js。
/**
 * lib/postprocess.js — 后处理的稳定入口（门面）。
 *
 * 拆分后：
 *   lib/postprocess/rules.js  14 段桶表 / 段内二级序 / 上下位对 / 同义组 / 词表（纯数据）
 *   lib/postprocess/index.js  归一化、去重、上下位降权、补人数、裁剪、排序、格式化
 * 其它模块与测试继续 import '../lib/postprocess.js' 就行，导出名与签名与拆分前一致。
 */
export * from './postprocess/index.js'
export { default } from './postprocess/index.js'
