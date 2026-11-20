# DSh Tagger · 契约

这份文档是**唯一权威的核心契约**：模块边界、运行时对象、配置键、路由返回形状、SPI、门禁命令。
HTTP/MCP 的逐条参数与示例不在这里，看 [`API.md`](./API.md)。

据此写扩展的人只需要记住一句：核心代码（`lib/tags.js` / `lib/forge.js` / `lib/refine.js` / `lib/comfy.js`）
**不 import 任何外部东西**，扩展只能从 SPI 注册表插进来 —— 卸载时整批 dispose，不会留尾巴。

历史沿革：曾被拆成 `CONTRACT.md`（并行开发分工）+ `CONTRACTS.md`（扩展契约）两份，现已合并为本文件，
`CONTRACTS.md` 已删除，内容全部在本文件第 5～9 节。

## 1. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `index.js` | 独立服务装配入口：`createRuntime(ctx, rawConfig)` 造运行时、`createHandlers(rt)` 出 HTTP 路由表；`server/standalone.mjs` 把路由挂到 `/tagger/api`（旧前缀 `/prompt-forge/api` 同时注册） |
| `lib/cordis/adapter.js` | 适配层（日志 / 连接 / 最小 ctx）：`createLogger` / `normalizeBaseUrl` / `apiUrl` / `chatCompletionsUrl` / `modelsUrl` / `clampTimeout` / `llmSettings` / `createContextAdapter`（`server/shims.mjs` 与 `index.js` 共用，端点拼接只此一处） |
| `lib/cordis/config.js` | `PLUGIN` / `VERSION` / `configView(rt)`（apiKey 只回 `apiKeySet` + `apiKeyHint`）/ `persistPatch(rt, patch)` |
| `lib/cordis/handlers.js` | `createHandlers(rt)`：HTTP 路由表（`/forge` `/refine` `/run` `/job` `/upload` `/pose-thumb` `/spi` `/config` `/purge` `/state` `/health` `/mcp` 等，逐条见 `docs/API.md`） |
| `lib/tags.js` | 标签索引**统一入口**（转发层）；实现拆在 `lib/tags/`：`text.js` 纯归一、`loader.js` 读盘/overlay/建索引、`matcher.js` 检索与 canonicalize、`index.js` 懒加载与单例 |
| `lib/forge.js` | 锻造器：白话 → 调 LLM → 解析 JSON → 词形修复 → 姿势补词 → 去重合序 → 标签串 |
| `lib/repair.js` | 词形修复：库里不存在的写法按 hyphen / apostrophe / spacing / plural / swap / suggest 阶梯纠回 |
| `lib/postprocess.js` | 后处理门面；实现拆在 `lib/postprocess/`：`rules.js` 纯数据（14 段桶表 / 段内二级序 / 上位词对 / 同义组），`index.js` 六步流程 |
| `lib/zh-intent.js` | 中文姿势/视角意图表（`POSE_HINTS`）与候选注入（`selectCandidates`） |
| `lib/refine.js` | 二次精修门面：在已有标签串上做增量增删/调权，**不重跑整串**；实现拆在 `lib/refine/`（`consts` / `diff` / `prompt` / `apply` / `index`） |
| `lib/purge.js` | 破甲系统提示词（档位 `off` / `light` / `standard` / `full` / `max`） |
| `lib/comfy.js` | ComfyUI 客户端**兼容门面**（`export * from './comfy/index.js'`），旧 import 路径不变 |
| `lib/comfy/index.js` | 编排 + HTTP：`ping` / `listWorkflows` / `submit` / `status` / `waitFor` / `image` |
| `lib/comfy/workflow.js` | 纯函数层：API/UI 格式判定、正负向节点映射、`vars`→节点输入、schema→变量面、history→状态摘要 |
| `lib/comfy/upload.js` | 参考图落到 ComfyUI 的 `input/`（扩展名白名单、24MB 上限、`tagger_ref_<8hex>_<name>` 命名） |
| `lib/comfy-workflow.js` | 旧路径门面（指向 `lib/comfy/workflow.js`，文档与外部代码仍可用这个名） |
| `lib/backend-common.js` | 后端公共层：HTTP 封装、超时、错误码归一、轮询等待（comfy / forge 共用） |
| `lib/mcp.js` | MCP 服务端（JSON-RPC over HTTP），供外部 MCP 客户端调用 |
| `lib/spi.js` | 扩展注册表（槽位 + 钩子） |
| `lib/routes.js` | 路由表与 dispatch（前缀可换，支持旧前缀共存） |
| `lib/config.js` | 默认配置与归一化（`DEFAULTS` + `normalize`） |
| `lib/poses.js` | 姿势目录与缩略图查找（`createPoseCatalog` / `poseImage`） |
| `server/standalone.mjs` | 独立 HTTP 服务入口（web 版）：起进程、挂 `/tagger/api` 路由、托管 `/public` |
| `server/shims.mjs` | **纯 Cordis 生命周期垫片**：`createContext` + 8 个传输层名字再导出，≤12KB（有测试护栏） |
| `lib/cordis/host.js` | 独立模式的 ctx 装配与织入：llm / webServer / tools 三个传输层的实现正文 |
| `server/public/` | Web 面板静态资源，由独立服务的 `/public` 前缀提供（白名单扩展名 + 三重防穿越 + `no-cache`/ETag）：`panel.css` / `api.js` / `state.js` / `render.js`（灯 / 结果卡 / 错误码表）/ `settings.js`（LLM 与 ComfyUI 设置、工作流下拉、参考图行）/ `history.js`（历史、姿势弹窗、出图轮询、`localStorage` 参数记忆）/ `app.js`（只管 boot 与事件绑定） |
| `lib/seed-tags.js` | 内置 seed 词条的薄入口（`SEED_TAGS = loadSeedRows()`）；词条本体在 `data/tags/seed/seed-01..13-*.jsonl` |
| `bin/tagger.mjs` | 唯一命令行入口 `dsh-tagger`：`--port` / `--host` / `--data-dir` / `--open|--no-open` / `--setup` / `--version` / `--help`，其余参数（`--base-url` 等）透传给 `server/standalone.mjs` |
| `scripts/setup.mjs` | 首次运行向导（`npm run setup`）：端口 / 模型接口 baseUrl / API Key / model / ComfyUI 地址 / 工作流目录，**回车 = 跳过不写该键**；`--yes` 全默认、`--print` 只打印 |
| `scripts/dev/` | `run-tests.mjs`（`npm test` 入口，按 Node 版本决定加不加 `--test-concurrency=1`）/ `check-layout.mjs`（`npm run check:layout`）/ `bench.mjs`（`npm run bench`） |
| `scripts/tags/` | `build-tags.mjs` / `check-tags.mjs`（`npm run check:tags`）/ `check-overlay-tags.mjs`（`npm run check:overlay`）/ `suggest-overlay.mjs`（从快照里挑未收录词） |
| `scripts/release/` | `pack.mjs`（便携包）/ `pack-inject.mjs`（注入包）/ `make-public.mjs`（公开版）/ `inject-private.mjs`（注入）/ `ui2api.mjs`（UI 工作流转 API 格式）/ `push-to-github.ps1`（唯一推送脚本：`-User -Repo -Private -UseSsh -RunCi -Both -LiteDir`）；对外入口是 `npm run pack` / `pack:inject` / `publish:lite` |
| `scripts/assets/make-pose-thumbs.py` | 姿势缩略图生成（一次性资产脚本，不进运行时、不进便携包） |
| `scripts/win/` | Windows 启停辅助：`stop-tagger.cmd [端口]` 按端口停服务（根目录 `start-tagger.cmd` / `start-tagger-hidden.vbs` 只是 `start.cmd` 的转发壳） |
| `start.cmd` / `start.sh` | 一键启动：找 node（→ 便携 node → docker）→ 首次跑向导 → 起服务并开浏览器；参数 `[端口 [host]]` |
| `deploy.cmd` / `deploy.sh` | 三行转发（`call start.cmd %*` / `exec start.sh "$@"`），只为兼容老入口 |
| `Dockerfile` / `docker-compose.yml` / `.env.example` | 容器镜像 `dsh-tagger:0.2.0`，端口 `DSH_TAGGER_PORT`，数据卷 `tagger-data`，`healthcheck` 打 `/tagger/api/health` |
| `data/tags/*.jsonl` | 随包词表补丁（overlay）；用户词表在 `<dataDir>/tags/`，改了热重载 |
| `data/danbooru/*.jsonl` | 全量词表快照（general / characters / copyrights / artists / groups + `manifest.json`），由 `scripts/tags/import-dict.mjs` 导入；加载器探测顺序里仓库这一条，命中即 99447 条。**公开版**放的是 `scripts/tags/filter-dict.mjs` 过滤出的 SFW 四份（无 `groups.jsonl`，`manifest.sfw === true`，约 97497 条） |
| `docs/CONTRACT.md` | **本文件**：唯一权威核心契约（目录 / 配置 / 路由 / refine / forge / tags / SPI / 门禁） |
| `docs/API.md` | 接口手册（HTTP 路由表 + MCP 工具 + 示例） |
| `docs/LAYOUT.md` | 目录与分工速览（运行时 / 入口 / 工具 / 测试与文档）+ 三条硬规矩 |
| `docs/PERF.md` | 实测性能数字、预算表、健壮性清单（`scripts/dev/bench.mjs`） |

## 2. 运行时对象

`createRuntime(ctx, rawConfig)` 产出（`index.js` 内的装配顺序即依赖顺序）：

```js
{
  ctx,        // 可选服务注入：独立服务下是 server/shims.mjs → lib/cordis/host.js 造的最小对象（llm 可缺席）
  config,     // 归一化后的配置，键见第 3 节
  log,        // { info, warn, error }
  dir,        // 数据目录，默认 ~/.dsh-tagger
  tags,       // createTagIndex(...) 的索引对象
  llm,        // 可选 llm 服务（ctx.get("llm")）；缺席时 forge / refine 按 config.llm 直连
  spi,        // createRegistry({ logger, config })
  poses,      // createPoseCatalog(...)
  forge,      // createForge({ config, llm, tags, logger, spi })
  comfy,      // createComfyClient({ config, logger })
  refine,     // createRefiner({ config, llm, tags, logger, spi })
  mcp,        // createMcpHandler({ forge, comfy, tags, config, logger, refine })
}
```

### 2.1 后端公共层 `lib/backend-common.js`（谁要发 HTTP 就用它，别自己写 fetch 包装）

comfy / forge / mcp 三个模块共用这一层；新增一个后端时必须复用它，否则超时与错误码会再次分叉。

| 导出 | 作用 |
| --- | --- |
| `ERROR_CODES` | 对外失败分类白名单：`network` / `timeout` / `bad-request` / `not-found` / `upstream` / `queue-timeout` |
| `BackendError` | 带 `code`（可附 `status` / `url` / `cause`）的错误类 |
| `isRecord` / `msgOf` | 普通对象判定 / 任意异常取一行 message |
| `clampInt` / `clampNumber` / `trimNumber` | 数值夹取与尾零裁剪（`1.20` → `1.2`） |
| `sleep(ms, signal)` / `abortPromise(signal)` | 可取消的等待 / signal 一响就 reject 的 promise |
| `createDeadline(timeoutMs, outerSignal)` | 统一超时与取消：`{ signal, timedOut, cancelled, dispose() }` |
| `normalizeError` / `describeError(err, {scope, target})` | 异常归一 / 面向人的一句话「谁 + 为什么（code）：在哪。原始 message」 |
| `request(target, {method, body, headers, timeoutMs, signal, retries, retryDelayMs, logger})` | 单次 HTTP 往返（原始 Buffer + status/headers/url）；幂等 GET 遇 network/5xx 退避重试 1 次，POST 与 timeout 不重试 |
| `httpJson` / `parseJson` / `parseJsonText` / `bodyPreview` | JSON 请求与容错解析、响应预览 |
| `readJsonFile(file)` | 读 JSON 文件 → `{ ok, kind:"io"\|"json", value\|error }` |
| `toBase64` / `toBuffer` | Buffer ↔ base64（剥 `data:` 前缀） |
| `pollUntil({fn, timeoutMs, intervalMs, shouldStop, signal})` | 轮询到条件成立或超时 → `{ ok, last, waitedMs, timedOut }` |

`lib/comfy-workflow.js` 是**纯函数层**：API/UI 格式判定、正负向节点映射、`vars` → 节点输入、schema → 变量面、history → 状态摘要，不碰网络。`lib/comfy.js` 把它整份 re-export（`WORKBENCH_DIR` / `resolveWorkflowDir` / `isUiFormat` / `resolveTextMapping` / `applyVars` 仍从 `lib/comfy.js` 引得到），所以外部 import 一行都不用改。
## 3. 配置契约（`lib/config.js` 的 `DEFAULTS`）

**键只能新增，不许改名** —— 面板回填、用户已有 `settings.json` 都按这些名字读。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `llm.provider` / `llm.model` | `opencode-go` / `deepseek-v4.1-flash` | 模型 provider 与模型 id |
| `llm.reasoningEffort` | `""` | 留空表示用服务默认 |
| `llm.maxTokens` / `llm.timeoutMs` | `4000` / `120000` | 截断会自动翻倍重试，天花板 16000 |
| `llm.baseUrl` / `llm.apiKey` | `""` | **独立服务的模型接口地址与 key**（OpenAI 兼容；`GET /config` 不回明文） |
| `purge.enabled` / `purge.level` | `true` / `full` | 破甲开关与档位（`off`/`light`/`standard`/`full`/`max`） |
| `purge.extraDirectives` | `[]` | 追加到破甲层的自定义指令 |
| `tags.standards` | `["wd","camie"]` | 标签标准 |
| `tags.maxTags` | `40` | 正向条数上限 |
| `tags.weightSyntax` | `comfy` | `comfy`(`(tag:1.2)`) / `a1111` / `plain` |
| `tags.chineseAlias` | `true` | 中文别名参与匹配 |
| `tags.dataDirs` | `[]` | 真词表目录（Danbooru 的 `*.jsonl`），最多 8 个；空数组 = 走内置探测（`DSH_DANBOORU_DIR` → `~/.dsh-comfyui-workbench/data/danbooru` → **仓库的 `data/danbooru`** → …）。仓库那份由 `scripts/tags/import-dict.mjs` 导入；全都探测不到时只剩 seed + overlay 1247 条，forge 会把常见词判成「不在库里」 |
| `tags.qualityTags` | `["masterpiece","best_quality","highres"]` | 自动加在正向串首的质量词；置空数组 = 不加 |
| `forge.repair` / `forge.postprocess` / `forge.poseHints` / `forge.candidates` | 全 `true` | 三道本地处理与候选注入的开关 |
| `forge.candidateLimit` | `18` | 注入给模型的词库候选条数 |
| `forge.quality` | `true` | 质量词置顶与真评分词保留；`false` = 回到「评分词一条都不留、交给 ComfyUI 工作流内置」 |
| `refine.mode` | `add` | `add` / `edit` / `prune` / `weights` |
| `refine.maxNewTags` / `refine.temperature` / `refine.maxTokens` / `refine.timeoutMs` / `refine.keepOrder` | `12` / `0.4` / `3000` / `120000` / `true` | 精修预算与顺序策略 |
| `comfy.baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `comfy.launchDir` / `comfy.pythonPath` / `comfy.launchArgs` | `""` | 面板「启动 ComfyUI」用 |
| `comfy.workflowDir` / `comfy.defaultWorkflowId` | `""` | 模板目录与默认模板 |
| `comfy.positiveNode` / `comfy.negativeNode` | `""` | 无 schema 时手工指定正/负向节点 id |
| `comfy.pollIntervalMs` / `comfy.timeoutMs` | `1000` / `900000` | 轮询间隔与出图超时（整张图的总预算） |
| `comfy.submitTimeoutMs` | `120000` | **单次** HTTP（提交 / 上传 / 探活）的等待上限，夹在 5000–600000；别拿它跟 `timeoutMs` 混用 |
| `ui.keepHistory` | `20` | 面板历史保留条数 |

## 4. 路由契约（`lib/routes.js`）

路由表是 `Map`，键是 `"METHOD /path"`。handler 是 `async ({ url, body, req }) => reply`，reply 只允许三种形状：

```js
{ json, status? }            // 普通 JSON
{ binary, contentType }      // 二进制（图片）
{ text, contentType? }       // 文本 / HTML
```

没匹配到就是 404。前缀由 `createDispatch(routes, log, prefix)` 决定，默认 `/tagger/api`，旧前缀
`/prompt-forge/api`（`LEGACY_PREFIX`）由同一个 dispatch 再注册一份，老脚本不用改。
新增路由一律加进 `lib/routes.js` 的注册函数，别在 `index.js` 里另起分支。

## 5. 二次精修契约（`lib/refine.js`）

```js
import { createRefiner } from "./lib/refine.js"
const refiner = createRefiner({ config, llm, tags, logger, spi })
const result = await refiner.refine({
  positive: "1girl, silver hair, on_bed",  // 已有正向串（必需，可为空串）
  negative: "",                            // 已有负向串（可选）
  instruction: "加一点夜晚室内光和汗",       // 白话指令
  mode: "add",                             // add | edit | prune | weights
  options: {},                             // 覆盖 maxNewTags / temperature / maxTokens / timeoutMs / keepOrder
})
```

返回 `{ ok, positive, negative, tags, delta: { added, removed, weighted }, ops, notes, ms, model, purgeLevel, warnings }`。

四种 `mode` 的语义：

- `add`：补齐缺失标签，不动已有标签与权重；新增上限 `config.refine.maxNewTags`。模型在 `add` 条目里写了显式权重（`"(smile:1.2)"` 或 `{ tag, weight }`）时保留它，没写才用标签库的权重。
- `edit`：按指令改画面 —— 删冲突、加新词。
- `prune`：只删冗余/冲突，不新增。
- `weights`：只调权重，标签集合不变。

硬约束（调用方可以依赖）：

1. **不重跑整串**：模型只输出差分 JSON，输出预算与小标签集无关。
2. **新增必须过标签库**：`tags.canonicalizeMany` 命中不了的丢弃并写进 `warnings`。
3. `keepOrder: true`（默认）时已有顺序不变，新增追加尾部；`false` 才允许重排。
4. 失败不抛：`{ ok: false, error, warnings }`，HTTP 对应 502。模型流被中断时 `error` 是 `aborted`（超时是 `timeout`、接口报错是 `llm-error`），不再统一折成 `llm-error`。
5. **带权重写法能对上原串**：`remove` / `weights` / `order` 里回传 `"(smile:1.2)"`、`"smile::1.3"`、`"{{smile}}"` 都按 `smile` 匹配；同一个词既在 `remove` 又在 `weights` 里时以删除为准，不会出现在 `delta.weighted`。
6. `beforeRefine` 钩子改 `negative` 会同时影响提示词与返回的 `negative`（以前只改了入参、结果里还是原值）。

## 6. 锻造契约（`lib/forge.js`）

```js
export function createForge({ config, llm, tags, logger, spi }) -> {
  generate({ text, options, signal }) -> Promise<ForgeResult>
  models(provider), systemPrompt({ preview }), agentDirective(),
  purgeState(), history(), refreshPurge()
}
```

`ForgeResult`（成功失败都返回对象，不抛）：

```js
{
  ok, error?, message?,
  positive, negative,                  // 已按 weightSyntax 格式化；positive 以质量词开头，可直接进 CLIPTextEncode
  tags: [{ tag, weight, kind?, cn? }],
  negativeTags: [...],                  // 顺序 = 调用方 opts.negative 的顺序，不再倒序
  standards: ["wd","camie"],
  pipeline: { repairs: [{from,to,how}], poseHints: [{tag,weight,hit}], changes: [{kind,tag,reason?}] },
  raw, repaired, model, provider, ms, usage?, notes?, warnings: []
}
```

`pipeline` 是「三道本地处理改了什么」的痕迹，面板直接渲染；`warnings` 里的「xxx 不在库里」表示该词没通过词库校验。

调模型：`llm.stream({ provider, model, messages, ... })` 产出 `{type:"text-delta",text}` /
`{type:"reasoning-delta"}` / `{type:"finish",kind:"stop"|"error"|"aborted",failure?}`；
必须带 `AbortController` 与 `config.llm.timeoutMs`；llm 缺席返回 `{ ok:false, error:"no-llm" }`。

## 7. 标签索引契约（`lib/tags.js`）

```js
export function createTagIndex({ dir, logger, dataDirs }) -> index
index.stats() -> { loaded, general, character, copyright, artist, sourceFiles, builtAt, ready }
index.search(query, { limit, kinds }) -> [{ tag, kind, cn, postCount, aliases, standards }]
index.canonicalize(raw, { standards, syntax }) -> { tag, weight, matched, kind, cn, note }
index.canonicalizeMany(list, { syntax }) -> [{ raw, tag, weight, matched, kind, cn }]
index.parseTagString(s) -> [{ tag, weight }]
index.formatTagString(list, { syntax }) -> string
index.toStandard(tag, "wd" | "camie") -> string
index.suggestTags(raw, limit) -> [{ tag, cn, score }]
index.ready() -> Promise<void>
index.reload() / index.ensureFresh() -> Promise<boolean>   // overlay 改动热重载
```

`lib/tags.js` 是转发层，实现在 `lib/tags/loader.js`（读 jsonl、overlay 签名、建 Map 索引、单例缓存）与
`lib/tags/matcher.js`（归一、检索、格式化）。**别直接 import 子模块**，一律从 `lib/tags.js` 走，这样将来换实现不动调用方。

数据源（按顺序探测）：`DSH_DANBOORU_DIR` → `~/.dsh-comfyui-workbench/data/danbooru/*.jsonl` → **仓库的 `data/danbooru/*.jsonl`** → `<dataDir>/tags/*.jsonl` → `data/tags/*.jsonl`（包内 overlay）
→ 内置 `lib/seed-tags.js` 兜底。

仓库里那份 `data/danbooru/` 在私有仓是完整快照（99447 条），在公开仓是 `scripts/tags/filter-dict.mjs` 过滤出的 SFW 快照（四份、约 97497 条、`manifest.sfw === true`）；加载器不区分两者，只按 jsonl 读。

## 8. SPI 契约（`lib/spi.js`）

```js
import { createRegistry, SPI_VERSION, SLOTS, HOOKS } from "./lib/spi.js"
const spi = createRegistry({ logger, config })
```

### 槽位（SLOTS）

| 槽位 | 实现形状 |
| --- | --- |
| `tagProviders` | `{ id, label, search(term, limit) -> [{ tag, cn }] }` |
| `postProcessors` | `{ id, apply(result, ctx) -> result }`，按注册顺序串行，返回值替换上一步结果 |
| `workflowBackends` | `{ id, label, ping(), listWorkflows(), submit(payload), status(id) }` |
| `panels` | `{ id, label, mount(el, api) }`（web 版用） |

```js
const dispose = spi.register("tagProviders", "my-dict", {
  label: "我的词表",
  search(term, limit) { return [{ tag: "my_tag", cn: "我的词" }] },
})
```

同名 `id` 重复注册会先 dispose 旧的再替换；返回的 `dispose()` 幂等。

### 钩子（HOOKS）

`beforeForge` / `afterForge` / `beforeRefine` / `afterRefine` / `beforeSubmit` / `afterSubmit`

```js
const off = spi.on("afterForge", async (payload, ctx) => {
  payload.result.notes = (payload.result.notes ?? "") + " [已过我的规则]"
}, { id: "my-rule" })
```

钩子收到 payload 可**就地改写**；单个钩子抛错只记日志，后续钩子照跑，主流程绝不中断。

### 注册表 API

```
version, register(slot, id, impl, meta) -> dispose, has(slot,id), get(slot,id),
entries(slot), values(slot), on(hook, fn, meta) -> off, emit(hook, payload, ctx),
applyPostProcessors(result, ctx), searchProviders(term, limit), describe()
```

`describe()` 的形状（`GET /tagger/api/spi` 原样返回）：`{ version, slots: {每个槽位: [{id,label}]}, hooks: {每个钩子: [id]}, backends: [{id,label}] }`。

## 9. 独立服务的最小 ctx

`server/shims.mjs` 做的就是「自己造一个最小 ctx」：`get(service)` 认 `llm` / `webServer` / `tools`，
`effect(fn)` 返回 dispose，`inject(deps, fn)` 给可选服务。独立服务里只有 `llm` 是可选注入：给了就用
`stream({provider, model, messages})` 产出 `{type:"text-delta",text}` / `{type:"finish",kind}`，不给就按 `config.llm`
直连 OpenAI 兼容接口；`webServer` 由 shims 自己实现（`register({ kind: "prefix", path, handler }) -> dispose`），
整套 `/tagger/api` 就活了。

## 10. 门禁（改完必须过）

```bash
npm run check:tags     # 词表结构自检（data/tags/*.jsonl 每行合法 + 同文件 tag 不重复）
npm run check:overlay  # overlay 体检：tag 是否在词库、中文是否缺、跨文件重复、别名与权威写法冲突、POSE_HINTS 是否在库
npm run check:layout   # 目录体检：根目录白名单、必需目录、docs 索引、script 目标存在、data/tags 行数 == tag 数
npm run typecheck      # tsc --noEmit -p tsconfig.json（不进构建，只查）
npm test               # 全量测试，串行（scripts/dev/run-tests.mjs）
npm run check          # 上面五道连跑 —— 改完这一条必须绿
npm run bench          # 本地计算层基准，超预算 exit 1（见 docs/PERF.md）
```

`npm test` 走 `scripts/dev/run-tests.mjs`，不是裸的 `node --test`：Node 20.11 之前没有
`--test-concurrency`，写死在 package.json 里会让老版本直接报参数错；脚本按版本决定加不加。
`package.json` 的 `engines.node` 是 `>=18.18.0`，CI 用 Node 20。

前五道就是 `npm run check` 串起来的那一串。`.github/workflows/ci.yml` 是 windows-latest，与开发机一致；
CI 步骤依次是 `npm install` → `npm run check:tags` → `npm run typecheck` → `npm test`
（`check:overlay` / `check:layout` 是纯静态体检，本地跑，CI 不跑）。

**本机没有 `node` 命令时**（只有 DeepSeek Harness 自带的 Electron）：用
`ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/dev/run-tests.mjs`，
同理 `... scripts/tags/check-tags.mjs` / `... scripts/tags/check-overlay-tags.mjs` / `... scripts/dev/check-layout.mjs` /
`... /tmp/tsdk/package/lib/tsc.js -p tsconfig.json`。

**测试必须串行跑**（`--test-concurrency=1`）：deliverable 里有几个套件会读同一份默认词表目录，进程并行时可能撞上另一个进程正在重写 overlay，表现为偶发 1 条失败（单跑必绿）。这不是业务 bug，但不许在门禁里并行。

`tsconfig.json` 是 `allowJs` + `checkJs` + `noEmit`：改的是 JS，检查的是错误用法（拼错的字段、传错参数）。

## 11. 兼容与版本

- `SPI_VERSION = 1`：槽位/钩子名变了才跳版本，新增槽位算兼容。
- HTTP 前缀 `/tagger/api`；旧前缀 `/prompt-forge/api` 同时注册（`LEGACY_PREFIX`）。
- MCP：`SERVER_INFO.name = "dsh-tagger"`，工具集在 `lib/mcp.js`，参数见 `docs/API.md`。
- 配置键与路由只增不改名；要弃用就先留一版双读。
