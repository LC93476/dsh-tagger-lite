# DSh Tagger · 契约

这份文档是**唯一权威的核心契约**：模块边界、运行时对象、配置键、路由返回形状、SPI、客户端门面。
HTTP/MCP 的逐条参数与示例不在这里，看 [`API.md`](./API.md)。

据此写扩展的人只需要记住一句：核心代码（`lib/tags.js` / `lib/forge.js` / `lib/refine.js` / `lib/comfy.js`）
**不 import 任何外部东西**，扩展只能从 SPI 注册表插进来 —— 卸载时整批 dispose，不会留尾巴。

历史沿革：曾被拆成 `CONTRACT.md`（并行开发分工）+ `CONTRACTS.md`（扩展契约）两份，现已合并为本文件，
`CONTRACTS.md` 已删除，内容全部在本文件第 5～10 节。

## 1. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `index.js` | 宿主入口：`name` / `inject` / `apply(ctx, config)`；装配 runtime、注册 HTTP 前缀（新 `/tagger/api` + 旧 `/prompt-forge/api`）、注册 MCP 工具 |
| `client.js` | 浏览器端面板门面（`window.__ModuleLoader__.load` 工厂），侧边栏图标 + better-sidebar 页签；实现拆在 `client/` 下 |
| `lib/tags.js` | 标签索引**统一入口**（转发层）；实现拆在 `lib/tags/`：`text.js` 纯归一、`loader.js` 读盘/overlay/建索引、`matcher.js` 检索与 canonicalize、`index.js` 懒加载与单例 |
| `lib/forge.js` | 锻造器：白话 → 调 LLM → 解析 JSON → 词形修复 → 姿势补词 → 去重合序 → 标签串 |
| `lib/repair.js` | 词形修复：库里不存在的写法按 hyphen / apostrophe / spacing / plural / swap / suggest 阶梯纠回 |
| `lib/postprocess.js` | 后处理门面；实现拆在 `lib/postprocess/`：`rules.js` 纯数据（13 段桶表 / 上位词对 / 同义组），`index.js` 六步流程 |
| `lib/zh-intent.js` | 中文姿势/视角意图表（`POSE_HINTS`）与候选注入（`selectCandidates`） |
| `lib/refine.js` | 二次精修门面：在已有标签串上做增量增删/调权，**不重跑整串**；实现拆在 `lib/refine/`（`consts` / `diff` / `prompt` / `apply` / `index`） |
| `lib/purge.js` | 破甲系统提示词（档位 `off` / `light` / `standard` / `full` / `max`） |
| `lib/comfy.js` | ComfyUI 客户端：模板 → 变量注入 → `POST /prompt` → 轮询 `/history` → 取图/上传参考图 |
| `lib/backend-common.js` | 后端公共层：HTTP 封装、超时、错误码归一、轮询等待（comfy / forge 共用） |
| `lib/comfy-workflow.js` | 工作流模板解析、变量映射、历史摘要（纯函数，无 IO，comfy.js 调用它） |
| `lib/mcp.js` | MCP 服务端（JSON-RPC over HTTP），供外部 MCP 客户端调用 |
| `lib/spi.js` | 扩展注册表（槽位 + 钩子） |
| `lib/routes.js` | 路由表与 dispatch（前缀可换，支持旧前缀共存） |
| `lib/config.js` | 默认配置与归一化（`DEFAULTS` + `normalize`） |
| `lib/poses.js` | 姿势目录与缩略图查找（`createPoseCatalog` / `poseImage`） |
| `server/standalone.mjs` | 脱离 DSH 的独立 HTTP 服务（web 版入口） |
| `server/shims.mjs` | 独立模式的最小 ctx（llm / webServer / tools 三个 shim） |
| `server/public/` | Web 面板静态资源（`panel.css` / `api.js` / `state.js` / `app.js`），由独立服务的 `/public` 前缀提供，白名单扩展名 + 防穿越 |
| `scripts/win/` | Windows 启停脚本（根目录的 `.cmd` / `.vbs` 只是转发入口） |
| `data/tags/*.jsonl` | 随包词表补丁（overlay）；用户词表在 `<dataDir>/tags/`，改了热重载 |
| `docs/CONTRACT.md` | **本文件**：唯一权威核心契约（目录 / 配置 / 路由 / refine / forge / tags / SPI / 客户端 / 门禁） |
| `docs/API.md` | 接口手册（HTTP 路由表 + MCP 工具 + 示例） |
| `docs/PERF.md` | 实测性能数字、预算表、健壮性清单（`scripts/bench.mjs`） |

## 2. 运行时对象

`createRuntime(ctx, rawConfig)` 产出（`index.js` 内的装配顺序即依赖顺序）：

```js
{
  ctx,        // 宿主上下文；独立服务下是 server/shims.mjs 造的最小对象
  config,     // 归一化后的配置，键见第 3 节
  log,        // { info, warn, error }
  dir,        // 数据目录，默认 ~/.dsh-tagger
  tags,       // createTagIndex(...) 的索引对象
  llm,        // 宿主 llm 服务（ctx.get("llm")），独立服务下是注入的 shim，可能 undefined
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

**键只能新增，不许改名** —— 面板回填、`cordis.patch.yml`、用户已有 `settings.json` 都按这些名字读。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `llm.provider` / `llm.model` | `opencode-go` / `deepseek-v4.1-flash` | 宿主 llm 服务的 provider 与模型 id |
| `llm.reasoningEffort` | `""` | 留空表示用宿主默认 |
| `llm.maxTokens` / `llm.timeoutMs` | `4000` / `120000` | 截断会自动翻倍重试，天花板 16000 |
| `llm.baseUrl` / `llm.apiKey` | `""` | **只在没有宿主 llm 时用**（独立服务 / web 版） |
| `purge.enabled` / `purge.level` | `true` / `full` | 破甲开关与档位（`off`/`light`/`standard`/`full`/`max`） |
| `purge.extraDirectives` | `[]` | 追加到破甲层的自定义指令 |
| `purge.injectIntoAgentPrompt` | `false` | 是否顺带覆写宿主的智能体提示词 |
| `tags.standards` | `["wd","camie"]` | 标签标准 |
| `tags.maxTags` | `40` | 正向条数上限 |
| `tags.weightSyntax` | `comfy` | `comfy`(`(tag:1.2)`) / `a1111` / `plain` |
| `tags.chineseAlias` | `true` | 中文别名参与匹配 |
| `forge.repair` / `forge.postprocess` / `forge.poseHints` / `forge.candidates` | 全 `true` | 三道本地处理与候选注入的开关 |
| `forge.candidateLimit` | `18` | 注入给模型的词库候选条数 |
| `refine.mode` | `add` | `add` / `edit` / `prune` / `weights` |
| `refine.maxNewTags` / `refine.temperature` / `refine.maxTokens` / `refine.timeoutMs` / `refine.keepOrder` | `12` / `0.4` / `3000` / `120000` / `true` | 精修预算与顺序策略 |
| `comfy.baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `comfy.launchDir` / `comfy.pythonPath` / `comfy.launchArgs` | `""` | 面板「启动 ComfyUI」用 |
| `comfy.workflowDir` / `comfy.defaultWorkflowId` | `""` | 模板目录与默认模板 |
| `comfy.positiveNode` / `comfy.negativeNode` | `""` | 无 schema 时手工指定正/负向节点 id |
| `comfy.pollIntervalMs` / `comfy.timeoutMs` | `1000` / `900000` | 轮询间隔与出图超时（整张图的总预算） |
| `comfy.submitTimeoutMs` | `120000` | **单次** HTTP（提交 / 上传 / 探活）的等待上限，夹在 5000–600000；别拿它跟 `timeoutMs` 混用 |
| `ui.sidebarTab` / `ui.keepHistory` | `true` / `20` | 侧栏页签开关与历史保留条数 |

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

- `add`：补齐缺失标签，不动已有标签与权重；新增上限 `config.refine.maxNewTags`。
- `edit`：按指令改画面 —— 删冲突、加新词。
- `prune`：只删冗余/冲突，不新增。
- `weights`：只调权重，标签集合不变。

硬约束（调用方可以依赖）：

1. **不重跑整串**：模型只输出差分 JSON，输出预算与小标签集无关。
2. **新增必须过标签库**：`tags.canonicalizeMany` 命中不了的丢弃并写进 `warnings`。
3. `keepOrder: true`（默认）时已有顺序不变，新增追加尾部；`false` 才允许重排。
4. 失败不抛：`{ ok: false, error, warnings }`，HTTP 对应 502。

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
  positive, negative,                  // 已按 weightSyntax 格式化，可直接进 CLIPTextEncode
  tags: [{ tag, weight, kind?, cn? }],
  negativeTags: [...],
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

数据源（按顺序探测）：`<workbench>/data/danbooru/*.jsonl` → `<dataDir>/tags/*.jsonl` → `data/tags/*.jsonl`（包内 overlay）
→ 内置 `lib/seed-tags.js` 兜底。

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

## 9. 客户端契约（`client.js`）

```js
window.__ModuleLoader__.load({
  id: "dsh-tagger",
  factory(require) {
    const React = require("react")
    return { inject: ["slots"], apply(ctx) { /* 注册面板 */ } }
  },
})
```

两个入口：

- 侧边栏图标：`slots.inject("sidebar.panellist", () => slots.register({ name: "sidebar.panellist", id, order, label }, Icon))`
- 主面板：`slots.inject("main", () => slots.register({ name: "main", key: id }, Panel))`
- better-sidebar 页签（可选服务）：`ctx.inject(["betterSidebar"], scope => scope.effect(() => { const d = scope.betterSidebar.registerTab({ id, title, description, icon, order, single: true, component }); return () => d() }, "tagger: tab"))`

**坑**：`locale` / `betterSidebar` 只能通过 `ctx.inject([...], fn)` 取，直接 `ctx.get(...)` 拿到 undefined 且插件会被标 failed。

文案：`client/locale.js` 的内嵌 `dict` 与 `locale/zh.json`、`locale/en.json` 是**三份副本**，加键必须三处同改
（`tests/render.test.mjs` 会检查裸键）。样式只用宿主 token（`--dsw-alias-*` / `--dsw-radius-*`），类名前缀 `.ptf-`。

### 子模块怎么加载（重要，别自己发明）

宿主只把**包根**的 `client.js` 当 classic script 执行（`__ModuleLoader__.load({ id, factory })` 的工厂里不能有
顶层 `import` / `export`）；`client/` 子目录浏览器拿不到，宿主的 `/plugins/<id>/client.<name>.js` 只认包根且要 `?rev=`。
所以子模块走插件自己的路由：

- 路由：`GET /tagger/api/_mod/client/<name>.js`（旧前缀同样可用）→ `text/javascript; charset=utf-8` + `no-store`；
  名字白名单 `/^client\/[a-z0-9][a-z0-9-]*\.js$/`（只一层，不许子目录/大写/反斜杠），其余 `400 bad-module`，缺文件 `404 no-module`。
- `client.js` 门面：`factory` 里 `const mod = await import(base + "client/panel.js")`，**React 显式传进去**：
  `mod.create({ React, ctx, apiPrefix, locale })`。子模块是纯 ESM，禁止裸 import（拿不到 React）、禁止顶层 await。
- 基址顺序：`globalThis.__DSH_TAGGER_MODBASE__`（测试用 `file://.../client/`）→ `/tagger/api/_mod/client/` → 失败再试 `/prompt-forge/api/_mod/client/`。
  **注意末尾的 `client/` 段不能省**：路由白名单要求路径是 `client/<名字>.js`，写成 `/_mod/panel.js` 会被宿主判 `400 bad-module`。
- **加载失败不许把插件弄成 failed**：整块 try/catch，失败只注册一张极简错误卡（错误 message + 「重启宿主」提示），
  `apply` 照常返回。宿主判 failed 会导致整个面板入口消失，比没有子模块糟糕得多。
- `slots.inject/register` 是同步注册语义：先 `await` 到组件，再在 `apply` 里同步注册，不要把注册写在 await 之后。

## 10. web 版 / 别的宿主怎么接

`server/shims.mjs` 做的就是「自己造一个最小 ctx」：`get(service)` 认 `llm` / `webServer` / `tools`，
`effect(fn)` 返回 dispose，`inject(deps, fn)` 给可选服务。只要宿主能提供
`llm`（`stream({provider, model, messages})` 产出 `{type:"text-delta",text}` / `{type:"finish",kind}`）与
`webServer`（`register({ kind: "prefix", path, handler }) -> dispose`），整套 `/tagger/api` 就活了。

## 11. 门禁（改完必须过）

```bash
# 词表结构自检（data/tags/*.jsonl 每行合法 + 同文件 tag 不重复）
node scripts/check-tags.mjs

# 全量测试（本机没有 node 时用 Electron 当 node）
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" --test --test-concurrency=1 tests/*.test.mjs

# 静态类型检查（不进构建，只查）
npx tsc --noEmit -p tsconfig.json
```

三道门禁与 `.github/workflows/ci.yml` 一一对应（CI 是 windows-latest，与开发机一致）。

该 workflow 文件目前因 token 缺 `workflow` scope 没有随仓提交（见 `.gitignore` 里的说明）；补上 scope 后删掉那两行再提交即可，门禁命令本身不用改。

**测试必须串行跑**（`--test-concurrency=1`）：deliverable 里有几个套件会读同一份默认词表目录，进程并行时可能撞上另一个进程正在重写 overlay，表现为偶发 1 条失败（单跑必绿）。这不是业务 bug，但不许在门禁里并行。

`tsconfig.json` 是 `allowJs` + `checkJs` + `noEmit`：改的是 JS，检查的是错误用法（拼错的字段、传错参数）。

## 12. 兼容与版本

- `SPI_VERSION = 1`：槽位/钩子名变了才跳版本，新增槽位算兼容。
- HTTP 前缀 `/tagger/api`；旧前缀 `/prompt-forge/api` 同时注册（`LEGACY_PREFIX`）。
- MCP：`SERVER_INFO.name = "dsh-tagger"`，工具集在 `lib/mcp.js`，参数见 `docs/API.md`。
- 配置键与路由只增不改名；要弃用就先留一版双读。
