// plan: lib/tags/matcher.js 保持为薄门面，实现分散到 lib/tags/matcher/ 子模块
/**
 * lib/tags/matcher.js — 查询层的统一入口（门面）。
 *
 * 实现按职责拆在 lib/tags/matcher/ 下：
 *   parse.js   解析与顶层切分（wrapsWhole / splitTopLevel / parseTerm）
 *   exact.js   词条直查与近邻起点（toRow / lowerBound / queryVariants / lookup / suggest）
 *   score.js   打分（检索命中分、多词名次分、近邻建议候选分）
 *   filter.js  命中集合的去重与收尾排序
 *   format.js  三种写法的解析与格式化、WD/Camie 标准形态
 *   index.js   编排 createMatcher
 *
 * 这里的导出面是外部契约（lib/tags/index.js 与 lib/tags.js 都从这里取），
 * 只做原样转发，不新增也不减少导出键：createMatcher / parseTerm / splitTopLevel / wrapsWhole。
 */
export { createMatcher } from './matcher/index.js'
export { parseTerm, splitTopLevel, wrapsWhole } from './matcher/parse.js'
