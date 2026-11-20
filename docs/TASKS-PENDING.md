# 补词表（overlay / seed）扩充：完成记录与剩余可选工作

> 2026-11-20 收尾。四个 teammate（repair-engine / forge-llm / tag-index / post-pipeline）按 task-30～33 分四批扩容，
> Lead 统一跑门禁。这份文件留着当**词表口径的说明书**，也记着还剩什么。

## 一句话结果

一个词表行从 198 涨到 **1247**（overlay 四文件 511 + seed 十三份 736），跨文件重复清零，三道门禁全绿：

```bash
EXE="C:/Users/<你的用户名>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe"
cd "/d/DSh tagger-lite"
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/tags/check-tags.mjs           # 511 行 / 4 文件，结构自检通过
ELECTRON_RUN_AS_NODE=1 "$EXE" scripts/check-overlay-tags.mjs   # 1247 行 / 1247 tag，✓ 体检通过
ELECTRON_RUN_AS_NODE=1 "$EXE" --test --test-concurrency=1 tests/*.test.mjs   # 265 tests / 264 pass / 1 skipped
```

## 扩容前后（逐文件）

| 文件 | 前 | 后 | 内容 |
| --- | --- | --- | --- |
| `data/tags/general-nsfw.jsonl` | 46 | 154 | 体液 / 性行为 / 身体细节 / 裸露程度（成人向主文件） |
| `data/tags/pose-view.jsonl` | 136 | 274 | 静态姿势 / 手与支撑 / 腿脚 / 身体弧线 / 视线 / 视角 / 景别 |
| `data/tags/quality-common.jsonl` | 7 | 30 | 评分词（cn 注明「评分词，管线会丢」）+ 质感 |
| `data/tags/scene-common.jsonl` | 9 | 53 | 光照 16 + 室内家具与位置 |
| `seed/seed-01-base` | 9 | 10 | 基础人数 / 性质 |
| `seed/seed-02-hair` | 42 | 93 | 发色 24 / 长度 6 / 发型 40+ / 刘海 7 / 发饰 13 |
| `seed/seed-03-face` | 48 | 85 | 表情 48 / 瞳色 11 / 异色瞳与兽耳角尾翼 13 / 帽饰 10 |
| `seed/seed-04-composition` | 23 | 62 | 漫画骨架 8 / 构图 14 / 背景族 40 |
| `seed/seed-05-scene` | 37 | 90 | 自然天气 27 / 地点 38 / 建筑设施 25 |
| `seed/seed-06-quality` | 21 | 42 | 画风 / 媒介 |
| `seed/seed-07-negative` | 27 | 27 | 负向词，每行补齐 3 条中文口语别名 |
| `seed/seed-08-adult` | 38 | 80 | 粗粒度成人词（无大词库时的兜底） |
| `seed/seed-09-pose` | 19 | 8 | 只留 pose-view 没有的手势 |
| `seed/seed-10-outfit` | 30 | 78 | 服装与配饰 |
| `seed/seed-11-character` | 36 | 60 | 角色（全部改成库内真名 tag） |
| `seed/seed-12-copyright` | 38 | 55 | 作品 |
| `seed/seed-13-artist` | 19 | 46 | 画师 |

`lib/zh-intent.js` 的 `POSE_HINTS` 同时从 470 行扩到 1108 行（+126 条姿势/视角短语，每条 3–4 个中文口语变体，权重只用 1.1 / 1.12 / 1.05 / 1.05）。

## 合并语义（决定「重复该删哪一份」，改词表前先看这段）

`lib/tags/loader.js:211` 的 `addRecord()`：

```js
if (postCount > entry.postCount) entry.postCount = postCount                    // 取最大
if (cnValue !== "" && (entry.cn === undefined || entry.cn === "")) entry.cn = cnValue   // 先到的非空中文赢
for (const name of names) if (!entry.names.includes(name)) entry.names.push(name)      // 别名取并集
```

加载顺序（`lib/tags/index.js:81` → `lib/tags/loader.js:258`）：主词表 → overlay（`data/tags/*.jsonl` 只读顶层，字典序 general-nsfw → pose-view → quality-common → scene-common）→ seed（`data/tags/seed/*.jsonl`，`if (!entries.has(key))` **只补空位、永不覆盖**）。

- 同一条词在多个文件出现时：**字典序靠前的那份赢 cn / note / kind**，靠后那份只贡献更大的 postCount 与额外 aliases。
- 因此去重一律删「靠后那份」的行，删之前把它独有的 aliases 并进保留行 —— 并集不会自动继承，删了就丢。
- 所有权：四个主文件拥有词条；`seed-*` 只留主文件没有的词。seed 与主词表重复是纯噪音（不会覆盖中文），但也别留。

## 两个已知取舍（不是 bug，别当 bug 修）

2. **`lib/postprocess/rules.js` 的表里一个幽灵词都不许留**：`silver_hair` / `bangs` / `room` / `rim_light` / `cinematic_lighting` / `soft_lighting` / `dramatic_lighting` / `volumetric_lighting` 都已删掉，换成库内真词（`grey_hair` / `blunt_bangs` / `sidelighting` / `underlighting` / `dim_lighting` / `light_particles` / `ring_light` / `spotlight` / `candlelight`）。`tests/postprocess.test.mjs` 的「幽灵词」断言就是防这个 —— 加键前先 `canonicalize` 一下。

## 剩余可选工作（想做再做）

- `scripts/check-overlay-tags.mjs` 的「不在库」是拿**含 overlay 的索引**比对，所以 overlay 自创词条永远算「在库」。要更严可以再加一个 `--strict-dict`：只对主词表快照（`discoverDataDir()`）比对，把靠 overlay 自引用存活的词条列成警告。
- 词表行数还可以继续加（主词表快照 99447 条里，overlay 只覆盖了很小一部分）。取材用 `scripts/suggest-overlay.mjs --group <Posture|Image composition|Attire|Face tags|Hair styles|…> --min-count N`。
- `docs/PERF.md` 的基准还没跑在「词表 1247 行」上：`scripts/dev/bench.mjs` 可以重跑一次看检索是否变慢（索引 99447 条，预计与之前同量级）。