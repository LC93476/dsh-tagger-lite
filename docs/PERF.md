# 性能与健壮性（实测数字，不是估算）

锻造一次的真实耗时 90% 以上花在模型上（本机 deepseek-v4.1-flash 一条 40 tag 约 5–18s），
所以这里关心的不是「怎么更快出图」，而是「本地这层别成为瓶颈，也别在慢的时候把整个服务拖死」。

## 预算表

| 环节 | 预算 | 实测（本机 RTX 4060 Ti / i7，99470 条索引） | 超预算意味着 |
| --- | --- | --- | --- |
| 标签索引构建（进程内一次） | < 3000ms | **451ms**（data/tags overlay 4 文件 + danbooru 99372 行流式读） | 有人把整份 jsonl 读进了内存或做了 N² 匹配 |
| 单次检索（`tags.search`，limit 8） | < 50ms | **15.8ms** 冷查询（峰值 29.5ms） | 模糊评分退化成全文正则扫描 |
| 单次归一 20 条（`canonicalizeMany`） | < 30ms | **0.04ms** | 归一里加了 IO 或每次都重建 Map |
| 三道后处理（repair → poseHints → postprocess） | < 20ms | 修复 1.89ms + 姿势意图 0.22ms + 去重合序 0.10ms | 分桶表被改成每行都重算 |
| 一次 `/forge` 本地部分 | < 300ms | ~180ms（8 个候选查询 + 上述全部） | 候选注入的查询数失控 |

跑一遍自己看（有 `--json` 给 CI 或对比用，超标退出码 1）：

```bash
node scripts/dev/bench.mjs
node scripts/dev/bench.mjs --json --rounds 50
```

## 已经做掉的健壮性

| 场景 | 做法 | 位置 |
| --- | --- | --- |
| 模型不吐字 / 吐一半 | 流式收齐再看 `finish.kind`；被截断（`max-tokens`）自动把上限翻倍重试一次，上限 16000 | `lib/forge/index.js` |
| 请求卡住 | 共用 `lib/backend-common.js` 的带超时 request：LLM 用 `llm.timeoutMs`，ComfyUI 单次提交用 `comfy.submitTimeoutMs`（默认 120000），整张图用 `comfy.timeoutMs`（默认 900000） | `lib/backend-common.js` |
| 索引被并发重建 | 进程内单例 + 单飞（`loadPromise` 只允许一个在飞），`ensureFresh` 靠 overlay 签名（文件名+size+mtime）判断要不要重载，最多留 4 份 | `lib/tags/index.js` |
| 词表写坏一行 | 加载器按行 try/catch，坏行跳过并计数；CI 里 `scripts/tags/check-tags.mjs` 提前拦下 | `lib/tags/loader.js` |
| 模型回的不是 JSON | 抽围栏 → 取首个 `{` → 补齐括号 → 重试解析，全失败给 `bad-json` 而不是崩 | `lib/refine/diff.js` |
| 面板与服务端版本不一致 | 老页面缺字段一律有兜底（`pipeline` / `purge` / `spi` 都是可选读），不因为多一个字段就白屏 | `server/public/` |
| 进程退出 | SIGINT/SIGTERM 反序 dispose，keep-alive 连接 destroy，4s 兜底强退 | `server/standalone.mjs` |
| 静态资源被穿越 | `/public` 三重防护：拒 `..`/空段/NUL → resolve 后必须仍在目录内 → 必须 isFile | `server/standalone.mjs` |
| 宿主路由把 `..` 折叠掉 | `rawPathOf()` 只切 `?`/`#`，不用 `new URL().pathname`（URL 规范会把 `/public/../index.js` 规范化成 `/index.js` 直击面板） | `lib/cordis/host.js`（原 `server/shims.mjs`） |

## 没做（有意识的不做）

- **不缓存 `/forge` 结果**：同样一句白话两次结果本就该不同（模型有随机性），缓存会让人以为服务坏了。
- **不给 `tags.search` 加 LRU**：冷查询 16ms 已经在预算内，加缓存只会引入「词表热重载后拿到旧结果」的坑。
- **不把词表预编译成二进制**：451ms 的构建成本换来了「改 jsonl 立刻生效」这个日常最重要的体验。
