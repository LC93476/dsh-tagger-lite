// plan: 精修引擎门面 —— 实现在 lib/refine/ 子模块，这里只 re-export，保证 index.js / tests 的 import 路径不变。
/**
 * 二次精修（refine）门面：实现在 lib/refine/ 下，本文件只做 re-export。
 *
 * 门面留着的理由：index.js、docs/CONTRACT.md 与 tests 都按 `lib/refine.js` 这个路径 import，
 * 拆分不能改外部契约。
 */
export { createRefiner } from './refine/index.js'
