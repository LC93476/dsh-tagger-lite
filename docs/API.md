# DSh Tagger HTTP / MCP 接口

前缀：`/tagger/api`（旧前缀 `/prompt-forge/api` 同时可用，行为完全一致）。
所有响应 `Content-Type: application/json`，除非标注 `binary`。

## 路由表

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ plugin: 'dsh-tagger', version, dataDir }` |
| GET | `/state` | 面板启动一次性要的全部状态：`{ config, purge, comfy, workflows, workflowsError?, history }`（**没有 `ok` 字段**，出错看 `workflowsError` 与 `comfy.ok`） |
| GET/POST | `/config` | GET 读配置视图（同样是裸对象，不含 `ok`）；POST `{ patch }` 写持久化覆盖并热应用 → `{ ok: true, config }` |
| GET/POST | `/purge` | GET 读破甲档位与系统提示词预览；POST `{ purge: { enabled, level, extraDirectives } }` |
| GET | `/models?provider=` | 该 provider 可用模型列表 |
| POST | `/probe` | LLM 连通性探针，返回逐 chunk 摘要（`{ ok, args, chunks }`） |
| GET | `/spi` | SPI 注册表快照 `{ ok, spi: { version, slots: { 槽位: [{ id, label }] }, hooks: { 钩子: [id] }, backends } }` —— `slots` / `hooks` 是**对象**（按槽位名分组），不是数组 |
| GET | `/locale?lang=zh` | 语言包：`{ ok: true, locale, langs: ['zh','en'], dict }`；`?lang=en` 取英文，非法值退回 `zh`；读不到包回 500 + `{ ok: false, error: 'no-locale', message }` |
| POST | `/forge` | 白话 → 标签：body `{ text, options }` |
| POST | `/refine` | 二次精修：body `{ positive, negative, instruction, mode, options }` |
| GET | `/workflows` | 模板列表 `{ workflows, dir }` |
| POST | `/workflows/import` | 导入自定义工作流：body `{ name, workflow, schema?, overwrite? }`（`workflow` 可以是对象或 JSON 字符串，`schema` 可省；也可以用 `{ path }` 直接给磁盘上的 json 文件）→ `{ ok, id, title, dir, workflowPath, schemaPath, nodes, created, workflows }`；只收 API 格式，UI 格式回 400 `ui-format`，同名回 409 `exists` |
| POST | `/run` | 投递出图：body `{ workflowId, positive, negative, vars }` |
| POST | `/upload` | 参考图落进 ComfyUI 的 `input/`：body `{ filename, data }`（`data` 可带 `data:image/png;base64,` 前缀）→ `{ ok, name, bytes, dir }` |
| GET | `/poses` | 姿势目录（读 ai-pose-gallery-zh 的 catalog.csv）：`?set=sexy&q=侧坐&limit=40` |
| GET | `/pose-thumb` | 姿势缩略图：`?id=full_sexy_P016_diag`，优先 `img/thumbs/<id>.jpg`（220px），没有就退回原图 `img/<id>.png`；id 只收 `[A-Za-z0-9_-]`，不合法或没这张直接 404 |
| GET | `/job?id=` | 查询 `promptId` 状态与产物图 |
| GET | `/image?filename=&subfolder=&type=` | **binary** 代理 ComfyUI 的 `/view` |
| GET | `/tags?q=&limit=` | 标签检索 `{ rows, stats }` |
| POST | `/tags/canonicalize` | body `{ tags: string[] }` → 归一结果（含权重与中文） |
| GET | `/comfy` | ComfyUI 探活 + 启动参数 + 模板摘要 |
| POST | `/comfy/launch` | 拉起 ComfyUI（已在跑则直接认账），body `{ waitMs }` |
| POST/GET | `/mcp` | MCP JSON-RPC 端点（GET 用于 SSE/探测） |

**静态资源（不属于 `/tagger/api`，只有独立服务 `server/standalone.mjs` 提供）**：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/HEAD | `/`、`/panel`、`/panel.html` | 面板 HTML（骨架，引用下面的 CSS/JS） |
| GET/HEAD | `/public/panel.css`、`/public/api.js`、`/public/state.js`、`/public/app.js`（Phase 7 后还有 `render.js` `settings.js` `history.js`） | 面板静态资源，`Cache-Control: no-cache` + 强 ETag，可 304 |
| GET/HEAD | `/about` | 信息页（健康状态 / 数据目录 / 接口清单），`no-store` |

`/public/*` 的缓存策略：**`no-cache` + 强 ETag**（`"<size 十六进制>-<mtimeMs 十六进制>"`）。
浏览器可以留副本，但每次刷新都带 `If-None-Match` 复验：没改 → `304` 空 body；改了（size 或 mtime 变）→
ETag 失效，拿到新内容。既不会每次重下 100KB，也不会被缓存骗着看到旧面板。
HTML 页面与接口 JSON 仍是 `no-store`。

`/public` 只收白名单扩展名（`.css .js .json .svg .png .jpg .jpeg .webp`），带 `..` 或解析后跑到
`server/public/` 之外的路径一律 `400 {"ok":false,"error":"bad-path"}`（挡路径穿越）。

## `/state` 里 `purge` 的子形状

`purgeState()` 的返回被面板用来画破甲灯，四个字段都保证存在：

```js
{ enabled: true,        // level 为 off，或 config.purge.enabled 显式为 false 时是 false
  level: "max",         // off | light | standard | full | max
  modules: ["direct-output", "adult-allowed", "no-refusal"],  // 当前档位生效的模块名
  chars: 6400 }         // 拼进系统提示词的破甲层总字数
```

面板拿到不认识的 `level` 一律退回 `full`。

## `POST /forge`

```bash
curl -s http://127.0.0.1:PORT/tagger/api/forge \
  -H 'content-type: application/json' \
  -d '{"text":"室内夜晚，裸体少女躺在床边回头看镜头，紫瞳黑长发","options":{"maxTags":40}}'
```

```js
{
  ok: true,
  positive: 'masterpiece, best_quality, highres, 1girl, solo, long_hair, black_hair, purple_eyes, ...',
  negative: '',                       // 负向交给 ComfyUI 工作流内置；串首质量词由本地按 tags.qualityTags 补
  tags: [{ tag: '1girl', weight: 1, cn: '一个女孩' }],
  notes: '补了构图与光线',
  ms: 14200, model: 'deepseek-v4.1-flash', purgeLevel: 'full',
  warnings: [],
  // 三道本地后处理留下的痕迹，面板照这个显示（老页面没有这一项也能用）
  pipeline: {
    repairs: [{ from: 'top_down_bottom_up', to: 'top-down-bottom-up', how: 'hyphen' }],
    poseHints: [{ tag: 'all_fours', weight: 1.1, hit: '跪趴' }],
    changes: [{ kind: 'dedupe', tag: 'profile', reason: 'synonym' }]
  }
}
```

### 模型接口与 ComfyUI 连接（`config.llm` / `config.comfy`）

独立服务没有宿主 llm 服务，接口地址与 key 存在 settings.json 里：

| 键 | 说明 |
| --- | --- |
| `llm.baseUrl` | OpenAI 兼容地址，可带 `/v1`（拼 `/chat/completions` 与 `/models`） |
| `llm.apiKey` | 密钥；**`GET /config` 永不回明文**，只回 `apiKeySet` 与 `apiKeyHint`（尾 4 位） |
| `llm.model` / `llm.provider` | 模型名与 provider 名 |
| `comfy.baseUrl` / `comfy.launchDir` / `comfy.pythonPath` / `comfy.workflowDir` / `comfy.defaultWorkflowId` | ComfyUI 连接、启动与模板目录 |

保存后**下一次请求立刻用新值**（standalone 的 llm shim 每次调用现读配置），不用重启；
CLI `--base-url` / `--api-key` 或环境变量优先于 settings.json。

### POST /llm/probe：验证接口连通

```json
// 请求：字段留空就用已保存的配置
{ "baseUrl": "https://api.example.com/v1", "apiKey": "sk-..." }
// 200：连上了
{ "ok": true, "endpoint": "https://api.example.com/v1/models", "ms": 210, "count": 41, "models": ["..."], "message": "连上了，可见 41 个模型" }
// 400 no-base-url / no-api-key；502 unreachable 或 http-<status>（带 message）
```

### 本地后处理开关（`config.forge`）

四道处理都能单独关，写进 settings.json 立刻生效，不用重启：

| 键 | 默认 | 关掉会怎样 |
| --- | --- | --- |
| `repair` | true | 库里查不到的多词不再自动改成连字符/撇号写法，直接进 warnings |
| `postprocess` | true | 不去重、不降权上位词、不按 14 段排序 |
| `quality` | true | 串首不再自动补 `masterpiece, best_quality, highres`，评分词一条都不留（交给工作流内置） |
| `poseHints` | true | 白话里点到的姿势/视角不再从本地词库补进来 |
| `candidates` | true | 锻造前不从词库捞候选词喂模型（模型更容易自己猜错拼写） |

```bash
curl -s -X POST http://127.0.0.1:PORT/tagger/api/config \
  -H 'content-type: application/json' \
  -d '{"patch":{"forge":{"poseHints":false}}}'
```

## `POST /refine`

```bash
curl -s http://127.0.0.1:PORT/tagger/api/refine \
  -H 'content-type: application/json' \
  -d '{"positive":"1girl, on_bed","instruction":"加夜晚室内光和汗","mode":"add"}'
```

返回形状见 `docs/CONTRACT.md` 第 5 节。失败时 HTTP 502 + `{ ok:false, error }`。

## `POST /run`

```bash
curl -s http://127.0.0.1:PORT/tagger/api/run \
  -H 'content-type: application/json' \
  -d '{"workflowId":"feiyue-sam3-posetags","positive":"1girl, solo","vars":{"width":1200,"height":1800,"seed":20261108}}'
```

```js
{ ok: true, promptId: 'xxxx', workflowId: 'feiyue-sam3-posetags', applied: [ { name:'prompt', node:'11', input:'text' }, { name:'width', node:'13', input:'width' } ], skipped: [], warnings: [] }
```

> **提示词走 `positive`，不是 `vars.prompt`。** schema 里虽然声明了 `prompt` 变量，但它和 `positive` 是同一个落点（节点 11 的 `text`）：`applyVars` 会跳过 `prompt` 键，只认 `positive`。把串塞进 `vars.prompt` 会被忽略 —— 正向提示词空着进模型，出来就是一张只有姿势没有内容的空壳图（我第一次就这么踩的：图里光秃秃一个灰模身体）。看 `applied` 里有没有 `prompt` 一项就能确认写没写进去。
### 姿势类模板的两个专属变量

`feiyue-sam3-pose` / `feiyue-sam3-posetags` 的 schema 里有两个变量，用 `vars` 传：

| 变量 | 落到 | 说明 |
| --- | --- | --- |
| `pose` | 节点 60 `image_id` | 白模姿势 id，如 `full_sexy_P016_diag`。姿势标签节点 204 是从 60 连过来的，换 id 时标签会自动跟着变 |
| `cnStrength` | 节点 62 `strength` | 只 `feiyue-sam3-pose` 有。`0` = 不锁姿势（纯提示词），0.3–0.45 松档，0.6 以上明显僵硬 |

```bash
curl -s http://127.0.0.1:PORT/tagger/api/run \
  -H 'content-type: application/json' \
  -d '{"workflowId":"feiyue-sam3-pose","positive":"1girl, solo, sitting","vars":{"pose":"full_sexy_P016_diag","cnStrength":0.38}}'
```

### 导入自定义工作流（`POST /workflows/import`）

面板设置区「导入自定义工作流」走这条：选一份 ComfyUI 里用 **工作流 → 导出（API）/ Save (API Format)** 存出来的 JSON，
可选再顺带选一份 `<id>.schema.json`。服务端校验形状 → 取 id → 补 schema（没给就按节点输入反推变量表）→ 原子写进 `comfy.workflowDir`。

```bash
# 直接贴 JSON（schema 省略时自动反推变量）
curl -s -X POST http://127.0.0.1:7789/tagger/api/workflows/import \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sdxl-t2i","workflow":{"3":{"class_type":"KSampler","inputs":{"seed":1}}}'}

# 独立服务在本机时也可以直接指磁盘文件（省掉浏览器读文件那一步）
curl -s -X POST http://127.0.0.1:7789/tagger/api/workflows/import \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sdxl-t2i","path":"D:/Somewhere/workflow_api.json","overwrite":true}'
```

返回 `{ ok: true, id, title, dir, workflowPath, schemaPath, nodes, created, workflows }` —— 末尾 `workflows` 是导入后的完整列表，
面板直接拿它刷新下拉，不必再打一次 `/workflows`。

拒绝口径（都 4xx，且一个字节都不落盘）：

| 情况 | 状态码 | `error` |
| --- | --- | --- |
| 不是合法 JSON | 400 | `bad-json` |
| UI 格式（带 `nodes`/`links`） | 400 | `ui-format` |
| 没有带 `class_type` 的节点 | 400 | `bad-workflow` |
| id 折叠后为空（比如纯中文名） | 400 | `bad-name` |
| `schema.vars` 不是数组 | 400 | `bad-schema` |
| 同名模板已存在且没给 `overwrite` | 409 | `exists` |
| 模板目录读不了 / 写不了 | 400 | `no-workflow-dir` / `write-failed` |
### 参考图类模板：`feiyue-sam3-ref`

> Web 面板里，「出图」区与「参考图」行是常显的；工作流下拉中带 `〔参考图〕` 徽标的模板才吃 `vars.image`，选到别的模板时该行置灰并提示切换。

不用姿势库那种白模，直接把**你自己的一张图**喂进去锁体态：节点 400 `LoadImage` 读 `<ComfyUI>/input/` 里的文件，节点 401 `DepthAnythingV2Preprocessor` 提深度图，节点 62 `ControlNetApplyAdvanced` 用这张深度图约束骨架。所以只有两步 —— 先把图传上去，再把返回的 `name` 填进 `vars.image`。

```bash
# 1) 传图（含空格的文件名会被规整成 tagger_ref_<8位>_xxx.png）
curl -s http://127.0.0.1:PORT/tagger/api/upload \
  -H 'content-type: application/json' \
  -d "{\"filename\":\"my pose.png\",\"data\":\"$(base64 -w0 'my pose.png')\"}"
# → { ok: true, name: 'tagger_ref_1a2b3c4d_my_pose.png', bytes: 741354, dir: '...\\ComfyUI\\input' }

# 2) 带着这个名字出图
curl -s http://127.0.0.1:PORT/tagger/api/run \
  -H 'content-type: application/json' \
  -d '{"workflowId":"feiyue-sam3-ref","positive":"1girl, solo, long_hair, nude, on_side","vars":{"image":"tagger_ref_1a2b3c4d_my_pose.png","cnStrength":0.45}}'
```

| 变量 | 落到 | 说明 |
| --- | --- | --- |
| `image` | 节点 400 `image` | `/upload` 回的文件名，只认 `<ComfyUI>/input/` 下已有的文件 |
| `cnStrength` | 节点 62 `strength` | 默认 0.45；越要像参考图就调高（0.5–0.7），只想借个姿态就压到 0.3 |

`/upload` 的拒绝口径：扩展名只认 `.png/.jpg/.jpeg/.webp`（`error: bad-type`）、空内容 `empty-file`、超 24MB `too-large`、没配 `comfy.launchDir` 是 `no-launch-dir`（这项不知道 ComfyUI 装哪就没法写）。

拍照/网图都可以用 —— 深度提取只关心身体轮廓，穿不穿衣服、画风如何都不影响骨架；但背影、躺平这类糊成一团的构图，深度图分不出四肢，锁姿势效果会比站坐姿差。
### `GET /poses`

读 `<launchDir>/custom_nodes/ai-pose-gallery-zh/skills/pose-reference-*/references/catalog.csv`，按文件 mtime 缓存，姿势库换文件不用重启。

```bash
curl -s 'http://127.0.0.1:PORT/tagger/api/poses?set=sexy&q=侧坐&limit=5'
```

```js
{ ok: true, total: 1439, sets: ['couple','sexy','standard','upper'],
  poses: [ { id:'full_sexy_P016_diag', set:'sexy', category:'坐姿', code:'P016', name:'侧坐・单手支撑・身体柔弯', angle:'斜侧' } ],
  launchDir: 'D:/QUARK/ComfyUI-aki-v3.2/ComfyUI' }
```

## MCP

端点：`POST /tagger/api/mcp`，JSON-RPC 2.0，`SERVER_INFO = { name: 'dsh-tagger', version: '0.2.0' }`。

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `forge_tags` | `text`（必需）、`negative`、`maxTags` | 白话 → WD/Camie 标签串 |
| `refine_tags` | `positive`（必需）、`instruction`（必需）、`negative`、`mode` | 对已有标签串做增量精修 |
| `comfy_workflows` | 无 | 列出可用模板 |
| `comfy_run` | `workflowId`、`positive`、`negative`、`vars` | 投递出图 |
| `comfy_status` | `promptId` | 查询出图进度与产物 |
| `tag_search` | `query`、`limit` | 标签检索（含中文） |

标准 MCP 握手：

```bash
curl -s http://127.0.0.1:PORT/tagger/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
curl -s http://127.0.0.1:PORT/tagger/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools\/list"}'
curl -s http://127.0.0.1:PORT/tagger/api/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools\/call","params":{"name":"forge_tags","arguments":{"text":"银发少女跪在床边回头"}}}'
```

> JSON 里的 `\/` 是 `/` 的合法转义（等价于 MCP 的 tools list 方法），原样复制即可。

## 独立运行（web 版入口）

```bash
DSH_TAGGER_API_KEY=sk-xxx DSH_TAGGER_MODEL=deepseek-v4.1-flash \
  node bin/tagger.mjs --port 7789 --base-url https://api.example.com
# 或
npm start -- --port 7789
```

`GET /` 返回**锻造台面板**（`server/panel.html`，原生 JS，无需构建；改文件后刷新浏览器即生效）；`GET /about` 是原来的 HTML 壳（健康状态 + 接口清单）。`/tagger/api/*` 的行为与接口手册一致。

不想敲命令就直接双击仓库根目录的 `start.cmd`：首次进向导，之后起服务并开浏览器，端口默认 7789（`start.cmd 8090` 换端口）。无窗口启动用根目录 `start-tagger-hidden.vbs`（它只是无窗口跑 `start.cmd`），停服务用 `stop-tagger.cmd [端口]`。
