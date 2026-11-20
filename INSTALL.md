# 安装与启动

零运行时依赖：只要有 node（≥18.18.0），`npm start` 就能跑。四种装法挑一种，每种都是独立起 web 服务，没有别的运行形态。

## 1. Windows：双击 `start.cmd`

- 会依次找 `node`、`%ProgramFiles%\nodejs\node.exe`，都没有就下便携 node 到 `.runtime/`（约 30 MB，仅一次）。
- 首次运行先进向导（`scripts\setup.mjs`），问 6 个问题，回车 = 默认 / 跳过该键。
- 端口已在监听就只开浏览器，不会再起第二个进程。`start.cmd 8090` 换端口。

## 2. macOS / Linux：`./start.sh`

- 同样三级兜底：`node` → `nodejs` → `.runtime/node/bin/node`；都没有但有 docker 就 `docker compose up`。
- `./start.sh 8090 0.0.0.0` 换端口并对外监听。

## 3. Docker

```bash
docker compose up -d          # 端口 7789，数据在卷 tagger-data
```

改端口用 `.env` 里的 `DSH_TAGGER_PORT`；容器里 ComfyUI 走 `host.docker.internal:8188`。

## 4. 手动 / 装成依赖

```bash
npm install && npm start      # 或 node bin/tagger.mjs --port 7789 --open
npm link && dsh-tagger --help # 用 bin 名，参数同 bin/tagger.mjs
```

## 配置模型与 ComfyUI

向导写的是数据目录里的 `settings.json`（默认 `.data/settings.json`）：`server.port/host`、`llm.baseUrl/apiKey/model`、`comfy.baseUrl/workflowDir`。重填用 `npm run setup`；面板里也能直接改。不想写文件就给环境变量 `DSH_TAGGER_BASE_URL / API_KEY / MODEL / COMFY_URL / WORKFLOW_DIR`。

## 数据目录在哪

`--data-dir` 指定 > `DSH_TAGGER_DATA` > `DSH_PROMPT_FORGE_DATA` > `~/.dsh-tagger`（老目录 `~/.dsh-prompt-forge` 有配置就沿用）；`start.cmd` / `start.sh` 默认用仓库下的 `.data`，docker 里是卷 `tagger-data`。运行历史、备份、`settings.json` 都在里面，删掉等于恢复出厂。

## 常见问题

| 症状 | 处理 |
| --- | --- |
| 起不来、报端口占用 | 换端口（`start.cmd 8090`），或先关掉上一个实例 |
| 出图为空 / ComfyUI 连不上 | 确认 ComfyUI 在 `127.0.0.1:8188`（docker 用 `host.docker.internal:8188`），面板设置里点一次「测试连接」 |
| 锻造报模型错误 | 检查 `llm.baseUrl` 与 `apiKey`；`npm run setup --print` 看当前值，`npm run setup` 重填 |
