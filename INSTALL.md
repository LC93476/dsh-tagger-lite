# 一键部署（DSh Tagger 独立 web 服务）

这个项目**没有任何运行时依赖**：只用 node 标准库，不需要 `npm install`，不需要编译，词表（`data/tags/*.jsonl`，约 740KB）已经一起打包。
所以「在任何环境一键部署」只有三件事要满足：**有 node 或有 docker**、一个可写的**数据目录**、以及（要真出图的）一个 **ComfyUI** 与模型接口。

## 四条路，挑一条

| 场景 | 一条命令 | 说明 |
| --- | --- | --- |
| Windows，本机随便跑 | 双击 `deploy.cmd` | 自动挑 node → docker → 便携 node（都没有就下 30MB 便携版，只下一次） |
| macOS / Linux | `./deploy.sh` | 先试 node，再试 docker |
| 服务器 / NAS / 群晖（有 Docker） | `docker compose up -d --build` | 数据进命名卷，`restart: unless-stopped` |
| 断网机器 / 拷 U 盘 | `node scripts/pack.mjs` 打 zip，拷过去解开跑 `deploy.sh` 或双击 `deploy.cmd` | 包自带 `data/`，解开即可跑，无需联网 |

起来之后打开 <http://127.0.0.1:7789/>（换端口就换 URL 里的端口）。

## Windows：双击 deploy.cmd

- 默认端口 7789，要换：`deploy.cmd 8090`。
- 数据落在包目录下的 `.data/`（`settings.json`、标签缓存），想换位置就设 `DSH_TAGGER_DATA`。
- 没有 node / docker 时会下便携版 Node v22 到 `.runtime/`，之后不再下载。
- 关窗口即停服务；要后台常驻用 `scripts/win/start-tagger.cmd`（带端口探测与防重复启动）或做成计划任务。

## macOS / Linux：./deploy.sh

```bash
chmod +x deploy.sh
./deploy.sh                 # http://127.0.0.1:7789/
./deploy.sh 8090            # 换端口
./deploy.sh 8090 0.0.0.0    # 对外监听（放进容器/局域网）
```

脚本会自己判断：有 `node` 直接跑；没有但装了 `docker` 就 `docker compose up --build`；两个都没有就打印安装方式后退出（不改你的系统）。

## Docker / docker compose（最省心的“任何环境”）

```bash
cp .env.example .env         # 填 BASE_URL / API_KEY / MODEL，按需改端口
docker compose up -d --build
docker compose logs -f       # 看启动日志
```

要点：

- 镜像基于 `node:22-alpine`，**构建不联网装包**（没有依赖），离线可构建。
- 数据在命名卷 `tagger-data`（容器内 `/data`），重建不丢配置。
- ComfyUI 跑在宿主机上时，容器里的回环地址指不到它：`.env` 里写 `DSH_TAGGER_COMFY_URL=http://host.docker.internal:8188`（compose 已加 `extra_hosts`）。
- 想让容器直接读宿主的工作流模板目录：取消 `docker-compose.yml` 里那条挂载注释，并把面板「设置 → 工作流模板目录」填容器内路径（如 `/workflows`）。
- 健康检查打的是 `/tagger/api/health`；`docker compose ps` 看到 `healthy` 就是起来了。

## 打包成便携 zip

```bash
node scripts/pack.mjs                 # dist/dsh-tagger-0.2.0/ 与 dist/dsh-tagger-0.2.0.zip
node scripts/pack.mjs --out D:/rel    # 换输出目录
node scripts/pack.mjs --no-zip        # 只要目录
```

包里是「起服务需要的全部」：`lib/ server/ client/ data/ locale/ types/` + 文档 + 部署脚本 + `Dockerfile`；不含 `tests/ tools/ public-src/ .git/`。
**包里自带全量词表快照**：打包时会从本机的 danbooru 导入目录（`dsh-comfyui-workbench/data/danbooru`）把
`general / characters / copyrights / artists` 四份 `.jsonl`（约 19MB）一起打进 `data/danbooru/`，
换台机器解开就有 99470 条词，不用再跑 `scripts/build-tags.mjs`。不想要这 19MB 就加 `--no-tags`
（包里只剩 `data/tags/` 那 198 行补词，锻造能用但常见词会大量缺失）。

清单在 zip 内的 `MANIFEST.txt`（每个文件的 sha256 前 16 位与字节数）。zip 是 store 方式（不压缩），任何解压工具都认。

## 配置模型接口与 ComfyUI

起来后是**没配状态**：锻造会如实回 `no-llm`，ComfyUI 灯是红的。两条配法：

1. 面板「设置 → 接口设置」填地址 / Key / 模型名 → 保存（写进数据目录的 `settings.json`，立刻生效）。
2. 环境变量（适合容器）：`DSH_TAGGER_BASE_URL` / `DSH_TAGGER_API_KEY` / `DSH_TAGGER_MODEL` / `DSH_TAGGER_WORKFLOW_DIR`。

ComfyUI 那边建议开 `--listen 0.0.0.0` 只在容器场景需要；本机跑默认 `127.0.0.1:8188` 就够。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `端口 7789 已被占用` | 换端口：`deploy.cmd 8090` / `./deploy.sh 8090` / `DSH_TAGGER_PORT=8090 docker compose up` |
| 面板能开，锻造回 `no-llm` | 没填模型接口；在面板设置里填，或用 `DSH_TAGGER_BASE_URL` + `DSH_TAGGER_API_KEY` |
| 出图回 `unreachable` | ComfyUI 没起，或地址不对；容器里要用 `host.docker.internal` |
| 出图回 `no-workflow-dir` / 下拉是空的 | 设置里「工作流模板目录」要指向放 `*.json` + `*.schema.json` 的目录 |
| 想看标签索引是否起来了 | `curl http://127.0.0.1:7789/tagger/api/health` 与 `/state`（`tags.index` 应是 99470） |
