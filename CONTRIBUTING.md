# 参与贡献

感谢你愿意一起改 DSh Tagger。这个仓库的规矩不多，但三条是硬的。

## 先跑起来

```bash
npm run setup     # 首次运行向导：端口 / 模型接口 / API Key / ComfyUI 地址
npm start         # 起服务并打开面板（默认 http://127.0.0.1:7789/）
```

Windows 上没有 node 也可以直接双击 `start.cmd`；装了 Docker 就 `docker compose up`。

## 三条硬规矩

1. **运行时零依赖**。`index.js` / `lib/` / `server/` / `bin/` 只用 Node 标准库。要拉第三方包，先开 issue 说明为什么。
2. **外部契约不许改名**。HTTP 路由（`/tagger/api/*`）、MCP 工具名与参数（`prompt_forge` / `prompt_forge_run` / `prompt_forge_status`）、`lib/config.js` 的 DEFAULTS 键名、面板 `data-testid`（`ptf-*`）都是别人依赖的接口。要改必须先改 `docs/CONTRACT.md` 并在 PR 里说明兼容方案。
3. **生成物不入库**。`D:/DSh tagger-lite-lite`（公开版）、`dist/`、`tmp/`、各种 zip 都是脚本生成的，别提交。

## 提交前必须跑

```bash
npm run check     # check:tags → check:overlay → check:layout → typecheck → test
```

五道门禁全绿才算完。只想跑一部分：`npm run check:tags` / `npm run typecheck` / `npm test`。

> 测试要**串行**跑（`npm test` 已经是串行的）。几个套件会读写同一份词表目录，并行会互相踩。

## 目录怎么分

见 [`docs/LAYOUT.md`](docs/LAYOUT.md)：`lib/` 是业务逻辑，`server/` 是 HTTP 与独立服务，`client/` 是 DSH 侧边栏面板，`scripts/` 是开发期工具（按 `dev/` `tags/` `release/` `assets/` `win/` 分组），`data/` 是词表。

## 分支与提交信息

- 分支：`main` 保持可发布；一个 PR 一个分支（`feat/xxx`、`fix/xxx`）。
- 提交信息用 `<type>: <一句话>`，type 取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `perf`。
- 一个 PR 只做一件事；带行为变化就要带测试。

## PR 里请写清楚

用 `.github/PULL_REQUEST_TEMPLATE.md` 的清单：改了什么、为什么、门禁输出、有没有碰契约。

## 看哪里

| 想了解 | 看 |
| --- | --- |
| 接口怎么调的 | [`docs/API.md`](docs/API.md) |
| 哪些东西不能改名 | [`docs/CONTRACT.md`](docs/CONTRACT.md) |
| 目录与分工 | [`docs/LAYOUT.md`](docs/LAYOUT.md) |
| 性能预算 | [`docs/PERF.md`](docs/PERF.md) |
