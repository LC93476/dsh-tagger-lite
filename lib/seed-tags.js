/**
 * lib/seed-tags.js — 内置常用标签兜底（数据本体在 data/tags/seed/*.jsonl）。
 *
 * 用途：本机没有 danbooru jsonl 时，插件照样能查、能校对、能出图。
 * 为什么外置成 jsonl：词条是词表而不是代码 —— 补一个词不该动 JS，也不该让 diff 全是数组字面量；
 * 外置后 scripts/check-tags.mjs 能对同一批文件做结构自检，公开版生成器（make-public）也能按行过滤。
 *
 * 读取与缓存都在 lib/tags/loader.js（loadSeedRows）：本文件只保留「加载 + 导出」这一层，
 * 保证 createTagIndex().stats() 同步就能拿到 seed 条数，构造代价与抽取前一致（387 行、一次读盘）。
 *
 * 行格式（jsonl，一行一个词条）：{ tag, cn?, postCount?, kind?, aliases? }
 *   tag      —— WD 写法（小写、下划线）
 *   cn       —— 中文名
 *   postCount—— 热度，只用于排序；不是精确值
 *   kind     —— general / character / copyright / artist
 *   aliases  —— 中文、罗马字、常见英文拼写，都能查到
 *
 * 真数据（9.9 万条）由 lib/tags/loader.js 按「数据源优先」加载，加载成功后这里只补齐真数据里
 * 没有的词，不会覆盖真数据的 postCount 与中文名。
 */
import { loadSeedRows } from './tags/loader.js'

/**
 * 内置 seed 词条，元组形态 [tag, 中文名, postCount, kind, 别名[]]，顺序即 data/tags/seed/ 下文件名排序。
 * 保留元组形态是为了让 loader 的 buildSeedEntries 与既有断言（SEED_TAGS 逐行可读）都不用改。
 * @type {Array<[string, string, number, string, string[]]>}
 */
export const SEED_TAGS = loadSeedRows()