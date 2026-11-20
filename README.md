# DSh Tagger（公开版）

> 白话描述 → WD（Danbooru）标准标签 → 投递 ComfyUI。省掉「再找一个 LLM 把话转成 tag」那一跳。

自带一个独立 web 服务，浏览器打开就是锻造台。锻造走 OpenAI 兼容的模型接口，出 tag 之后叠三道本地后处理（规范对齐 / 修复未知词 / 中文意图映射），同一段白话反复锻造结果不飘。

## 快速开始

| 你在哪 | 怎么起 |
| --- | --- |
| Windows | 双击 `start.cmd`（换端口 `start.cmd 8090`） |
| macOS / Linux | `chmod +x start.sh && ./start.sh` |
| Docker | `docker compose up -d` |

首次运行会问几个问题（端口 / 模型接口 / API Key / 模型名 / ComfyUI 地址 / 工作流目录），**回车 = 保持默认或跳过该键**，答案写进数据目录的 `settings.json`（默认 `.data/settings.json`）。重填用 `npm run setup`。

## 目录

```
dsh-tagger/
├─ bin/tagger.mjs          命令行入口（dsh-tagger [--port] [--host] [--data-dir] [--open]）
├─ index.js               装配入口：createRuntime + createHandlers
├─ server/                 独立 web 服务与 web 面板静态资源
├─ lib/                    锻造、后处理、词表索引、ComfyUI 客户端、路由、MCP
├─ data/tags/              词表（jsonl）与大词库快照
├─ scripts/                setup.mjs 与 dev/ tags/ release/ assets/ win/
├─ tests/                  node:test 套件
├─ docs/                   文档索引见 docs/README.md
├─ start.cmd  start.sh     一键启动
└─ Dockerfile  docker-compose.yml
```

`server/` 里除锻造台面板外还有 `public/gallery.html`：姿势画廊页（`/gallery`），挑一个姿势就能拿到该补的 tag，不做骨架控制。

## 命令行

```bash
npm start                                             # = node bin/tagger.mjs，127.0.0.1:7789
node bin/tagger.mjs --port 8090 --host 0.0.0.0 --open
```

参数：`--port` / `--host` / `--data-dir` / `--open|--no-open` / `--setup` / `--version` / `--help`；`--base-url`、`--api-key`、`--model`、`--workflow-dir`、`--provider` 原样透传给服务，临时覆盖 `settings.json`。

## 配置

`settings.json` 里只有三组键：`server.{port,host}`、`llm.{baseUrl,apiKey,model}`、`comfy.{baseUrl,workflowDir}`，其余全有默认值。也可以给环境变量 `DSH_TAGGER_DATA / BASE_URL / API_KEY / MODEL / COMFY_URL / WORKFLOW_DIR`。数据目录按 `--data-dir` → `DSH_TAGGER_DATA` → `~/.dsh-tagger` 探测。

## 检查与测试

```bash
npm install      # 只有类型检查需要
npm run check    # 词表 → 目录 → 类型 → 测试，五道门禁一次跑完
npm test         # 单跑测试（node:test，零依赖）
```

本机没有 node 时，`ELECTRON_RUN_AS_NODE=1 <DSH 的 DeepSeek Harness.exe> scripts/dev/run-tests.mjs` 等价可用。

## 打包

```bash
npm run pack     # → dist/dsh-tagger-<版本>/ 与同名 zip，解开就能跑
```

## 参与贡献

先看 [CONTRIBUTING.md](CONTRIBUTING.md)，并保证 `npm run check` 全绿；改词表至少跑一次 `npm run check:overlay`。

---

文档索引：[docs/README.md](docs/README.md)；接口：`docs/API.md`；模块契约：`docs/CONTRACT.md`。
