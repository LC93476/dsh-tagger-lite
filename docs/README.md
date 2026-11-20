# 文档索引

这些是 DSh Tagger 的设计与契约文档。改代码前先看 `CONTRACT.md`；只想跑起来看根目录 [`README.md`](../README.md)。

| 文件 | 一句话 | 谁该读 |
| --- | --- | --- |
| [CONTRACT.md](CONTRACT.md) | **唯一权威外部契约**：目录职责、运行时对象、config DEFAULTS 全表、HTTP 路由、refine / forge / tags / SPI、门禁命令 | 任何要改 `lib/` `server/` 或对外接口的人，动手前必读 |
| [API.md](API.md) | HTTP 路由与 MCP 工具的逐个参数、返回形状、错误码、curl 例子 | 要接面板、写脚本、做二次开发的人 |
| [LAYOUT.md](LAYOUT.md) | 目录与分工速览（运行时 / 入口 / 工具 / 测试与文档）+ 三条硬规矩 | 第一次进仓库的人 |
| [PERF.md](PERF.md) | 性能预算与基准数字、`npm run bench` 怎么跑、已经做掉的健壮性、以及**有意识不做**的事 | 觉得「慢」或者想加缓存之前 |
| [AGENT-INJECT.md](AGENT-INJECT.md) | 把私有提示词注入公开版的操作流程（agent 可执行版） | 维护公开版的人 |
| [TASKS-PENDING.md](TASKS-PENDING.md) | 补词表的完成记录、合并语义实证、已知取舍与剩余可选工作 | 继续扩词表的人 |

## 读的顺序（新人）

1. 根目录 `README.md` 的「快速开始」——三条命令跑起来
2. `LAYOUT.md`——认清哪个目录管什么
3. `CONTRACT.md` 第 1、3、4 节——目录、配置、路由三张表
4. 要动接口再看 `API.md`，要动性能看 `PERF.md`

## 改动这些文档的规矩

- 契约变了（路由 / MCP 工具名与参数 / config 键 / testid）**先改 `CONTRACT.md`**，再改代码，PR 里说明兼容方案。
- 新增文档必须加进本索引：`npm run check:layout` 会校验「`docs/` 下每个 `.md` 都在本文件里出现」。
- 文档里的命令一律用 npm script 形式（`npm run check`、`npm start`），不要写死内部脚本路径。
