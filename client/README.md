# client/ · 面板子模块

`client.js` 只是门面（classic script，无构建）；面板实现全在这里，纯 ESM、无顶层 await、不裸 import React。

## 宿主要求
子模块由宿主按 `GET {PREFIX}/_mod/client/<name>.js` 提供（PREFIX = `/tagger/api`，旧前缀 `/prompt-forge/api` 也挂一份），
`content-type: text/javascript; charset=utf-8`、`Cache-Control: no-store`。**路径里的 `client/` 段不能省**：
宿主白名单是 `/^client\/[a-z0-9][a-z0-9-]*\.js$/`，漏了就 400 `bad-module`（只认本目录根下这一层，没带子目录）。
测试用 `globalThis.__DSH_TAGGER_MODBASE__` 喂 `file://` 基址绕过 HTTP。

## 模块契约
| 文件 | 导出 |
| --- | --- |
| `constants.js` | `NS API PANEL_ID TAB_ID LEVELS REFINE_MODES JOB_KEY DEFAULT_POLL_MS` |
| `locale.js` | `dict`（zh/en 内嵌字典）、`lookup`、`withFallback`、`createT` |
| `css.js` | `CSS`（字符串数组，只用 --dsw-alias-* / --dsw-radius-* token） |
| `state.js` | `describe clampInt formatTag formatTagLine normalizeTags normalizePipeline normalizePurge normalizeDelta chosenStandards` |
| `api.js` | `apiUrl imageSrc requestJson readAsDataUrl` |
| `icon.js` | `createIcon({ React })` → 侧边栏图标组件 |
| `panel.js` | `createPanel({ React })` → `{ Panel }`；并 re-export 上面全部纯函数 |
| `view-head.js` | `headViews(p)` → `{ lampNode spiNode comfyNode workflowOptions levelSelect }` |
| `view-result.js` | `resultViews(p)` → `{ deltaNode refineNode chipNodes warningNodes pipelineNode imageNodes resultNode }` |
| `view-settings.js` | `settingsViews(p)` → `{ settingsNode }` |
| `view-shell.js` | `shell(p)` → 面板根元素（`data-testid="ptf-panel"`） |

所有 `*Views(p)` / `shell(p)` 都吃同一个 bag `p`：`{ h, t, api, ...state, ...actions }`，
函数第一行按需解构，DOM 结构与 testid 与拆分前逐字一致。

## 门面装载顺序
1. `globalThis.__DSH_TAGGER_MODBASE__`（测试注入）→ 2. `/tagger/api/_mod/client/` → 3. `/prompt-forge/api/_mod/client/`。
成功即把模块对象缓存进 `globalThis.__DSH_TAGGER_MODS__`，下次 apply 同步注册（宿主 HMR / 二次挂载不会重复 await）。
三个基址全失败时降级渲染 `data-testid="ptf-load-error"` 错误卡，插件不标 failed。

## 体积护栏
门面 < 12KB、每个子模块 < 30KB（`tests/render.test.mjs` 有护栏测试，改大之前先拆）。
