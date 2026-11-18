// plan: lib/tags.js 保留为统一入口，只做转发
/**
 * lib/tags.js — WD（Danbooru）+ Camie 标签索引的统一入口。
 *
 * 实现在 lib/tags/ 里分四层：
 *   text.js    纯文本件（kind 归一、查表键、转义、中文主名、权重写法）
 *   loader.js  数据层（找目录、流式读 jsonl、overlay 合并、seed、overlay 指纹）
 *   matcher.js 查询层（parse / search / canonicalize / format / toStandard / 近邻建议）
 *   index.js   组装（状态、懒加载、进程内单例、热重载）
 *
 * 这个文件只负责把老路径上的导出原样转发 —— 所有 import './lib/tags.js' 的调用方
 * 一个字都不用改。新增能力请加在子模块里，并在这里补一行 re-export。
 */
export {
  createTagIndex,
  resetTagIndexCache,
  suggestTags,
  default,
} from './tags/index.js'

export {
  discoverDataDir,
  loadTagEntries,
  pluginRoot,
  overlayDirs,
} from './tags/loader.js'

export {
  escapeParens,
  normalizeKind,
  primaryChineseName,
  unescapeTag,
} from './tags/text.js'

export { parseTerm } from './tags/matcher.js'
