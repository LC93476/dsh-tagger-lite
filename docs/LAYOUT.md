# 目录与分工（结构契约速览）

一份代码只放在一个地方，一类事情只放在一个目录。这份文件是**目录的权威说明**；
改结构先改这里，再动文件（`docs/CONTRACT.md` §1 是它的明细版，两份对不上以 CONTRACT 为准并回来修）。

## 运行时（独立服务）

| 路径 | 是什么 | 谁读它 |
| --- | --- | --- |
| `index.js` | 装配入口（`createRuntime` + HTTP 路由表） | `server/standalone.mjs` |
| `lib/` | 运行时库：`tags/` `forge/` `refine/` `postprocess/` `comfy.js` `workflow-import.js` `mcp.js` `spi.js` `routes.js` `config.js` … | index.js / server/ |
| `server/` | 独立 web 服务：`standalone.mjs`（入口）`shims.mjs`（可选服务垫片）`panel.html` + `public/`（锻造台面板与姿势画廊的静态资源：面板的 `panel.css` / `api.js` / `state.js` / `render.js` / `settings.js` / `history.js` / `app.js`，画廊的 `gallery.html` / `gallery.css` / `gallery.js`） | 浏览器 / 容器 |
| `data/tags/` | 随包补词表（四个主文件 + `seed/` 十三份） | `lib/tags/loader.js` |
| `data/danbooru/` | 全量词表快照（五份 jsonl + `manifest.json`，由 `scripts/tags/import-dict.mjs` 导入，约 20MB）；公开版这里是 `filter-dict.mjs` 过滤出的 SFW 四份（无 `groups.jsonl`，`manifest.sfw === true`） | `lib/tags/loader.js` 探测顺序里的仓库那一条 |
| `locale/` | 面板文案 `zh.json` / `en.json`（`server/public/i18n.js` 经 `GET /tagger/api/locale` 取） | 浏览器 |

## 入口（用户双击 / 命令行）

| 路径 | 干什么 |
| --- | --- |
| `bin/tagger.mjs` | **唯一命令行入口**：`node . --port 7789 --open`，也接受 `--data-dir` `--host` `--setup` `--version` |
| `start.cmd` / `start.sh` | **用户级一键启动**：找 node（没有就下便携版）→ 首次运行进向导 → 起服务 → 开面板 |
| `start-tagger.cmd` / `start-tagger-hidden.vbs` | 老入口，只做转发：前者 `call start.cmd %*`，后者无窗口跑 `start.cmd` |
| `stop-tagger.cmd` | 按端口停服务（`stop-tagger.cmd [端口]`），实现在 `scripts/win/` |
| `deploy.cmd` / `deploy.sh` | 兼容入口，转调 `start.cmd` / `start.sh` |
| `Dockerfile` `docker-compose.yml` `.dockerignore` `.env.example` | 容器部署 |

## 工具（运行时不需要，全部在 `scripts/`）

| 路径 | 干什么 | 什么时候跑 |
| --- | --- | --- |
| `scripts/setup.mjs` | 安装向导：问端口 / 模型接口 / ComfyUI 目录，写 `<数据目录>/settings.json` | 首次安装，`npm run setup` 或 `start.cmd` 自动调 |
| `scripts/dev/` | `run-tests.mjs`（串行跑全量）`bench.mjs`（性能基准）`check-layout.mjs`（结构体检） | 开发时 |
| `scripts/tags/` | `import-dict.mjs`（把本机全量词表导入仓库 `data/danbooru`）`filter-dict.mjs`（把全量快照过滤成公开可用 SFW 快照）`build-tags.mjs`（构建/统计词表）`check-tags.mjs`（结构自检）`check-overlay-tags.mjs`（补词表体检）`suggest-overlay.mjs`（取材） | 改 `data/tags/**` 后 |
| `scripts/release/` | `pack.mjs`（便携 zip）`pack-inject.mjs`（注入包）`make-public.mjs`（生成公开版）`inject-private.mjs`（私货注入）`ui2api.mjs`（工作流格式转换）`push-to-github.*` | 发版时 |
| `scripts/assets/make-pose-thumbs.py` | 姿势库 1439 张原图压成 220px 缩略图（需要 Python + PIL） | 换姿势库时 |
| `scripts/win/` | `stop-tagger.cmd`（按端口停服务）；启停实现已收进根目录 `start.cmd` | Windows |

## 测试与文档

| 路径 | 干什么 |
| --- | --- |
| `tests/*.test.mjs` | 21 个套件，`node --test --test-concurrency=1 tests/*.test.mjs`；**必须串行**（多套件共用默认词表目录） |
| `tests/_lib-guard.mjs` | 没装 Danbooru 词表的机器上让「需要真库」的用例 skip 而不是失败 |
| `docs/CONTRACT.md` | 唯一权威契约：运行时对象 / 配置键 / 路由 / refine / forge / tags / SPI / 门禁 |
| `docs/API.md` | HTTP 与 MCP 接口手册（含 curl 例子） |
| `docs/PERF.md` | 性能基准与健壮性清单 |
| `docs/LAYOUT.md` | 本文件：目录与分工速览 |
| `docs/TASKS-PENDING.md` | 补词表的完成记录与合并语义（改 `data/tags/**` 前必读） |
| `docs/AGENT-INJECT.md` | 私货注入的可执行提示词 |

## 三条硬规矩

1. **运行时零依赖**：只用 node 标准库，`npm install` 只在开发期装 `typescript` / `@types/node` 跑类型检查。
2. **外部契约不许改名**：HTTP 路由与响应形状、MCP 工具名与参数、`lib/config.js` 的 `DEFAULTS` 键名、面板 `data-testid` 前缀 `ptf-`。
3. **生成物不入库**：`dist/` `.data/` `.runtime/` `.inject-backups/` `tmp/` `*.msg.txt` `tagger.env.cmd` `settings.json` 都在 `.gitignore` 里。
