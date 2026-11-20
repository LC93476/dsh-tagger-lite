# 交给 agent 执行的注入指令（可直接粘贴）

> 用法：把下面「提示词正文」整段复制给任意能执行命令的 agent（Claude Code / Codex CLI / DSH / 本地脚本代理），
> 只改第一行的 `TARGET`（公开版仓库的绝对路径）。其余别动。

## 提示词正文

````text
你负责把「私有版提示词」注入到公开版仓库，并验证结果。严格按顺序执行，每步先看退出码再往下走。

目标目录：TARGET = D:/DSh tagger-lite-lite        # ← 改成实际路径；含空格必须加引号
私货来源：优先用注入包（本机若有 dist/dsh-tagger-inject-*.zip 或已解压的 inject-private.mjs）；
         否则用私有仓库 D:/DSh tagger-lite 里的 tools/inject-private.mjs

硬约束（违反算失败）：
1. 只允许改 TARGET 下的这六份文件：lib/purge.js、lib/postprocess/rules.js、lib/zh-intent.js、
   data/tags/general-nsfw.jsonl、data/tags/pose-view.jsonl、data/tags/seed/seed-08-adult.jsonl。
   其它文件一律不动。
2. 不许对 TARGET 执行任何 git 写操作（add/commit/push/tag/stash/checkout）。只读的 git status/diff/log 可以。
3. 不许手抄、改写、裁剪这六份文件的内容；只许用下面的脚本写入。
4. 任何一步的退出码不符合预期，就停下并按「失败处置」报告，不要自己发明补救办法。

### 步骤 0：定位脚本（只读）
在 TARGET 的同级或上级找注入包；找不到就用私有仓库：
```bash
ls -d "D:/DSh tagger-lite/dist"/dsh-tagger-inject-*.zip 2>/dev/null
ls -d "D:/DSh tagger-lite-lite/../dsh-tagger-inject"* 2>/dev/null
test -f "D:/DSh tagger-lite/tools/inject-private.mjs" && echo PRIVATE_REPO_OK
```
把找到的注入脚本绝对路径记为 INJECT（解压出来的 inject-private.mjs 或 tools/inject-private.mjs）。
两个都没有 → 停止，报告「找不到注入脚本」。

### 步骤 1：确认 TARGET 是公开版仓库（只读）
```bash
test -f "TARGET/index.js" && test -d "TARGET/lib" && test -d "TARGET/data/tags" && echo TARGET_OK
git -C "TARGET" status --porcelain        # 有未提交改动就记下来，继续，不要清理
wc -c < "TARGET/lib/purge.js"            # 公开版被削过一般 ≈21085 B，注入后 ≈21638 B；只是参考，判据看 --check
```
`TARGET_OK` 没打印 → 停止（路径不对，或不是公开版仓库）。

> 不要靠 grep 某些标识符判断「是不是公开版」：make-public 会整段改写这些文件，标识符在公开版里可能根本不存在。
> 唯一权威判据是第 2/4 步的 `--dry` / `--check` 状态。

### 步骤 2：干跑，先看清差在哪（不写盘）
```bash
node "INJECT" --dst "TARGET" --dry
```
期望：列出 6 行，状态是「覆盖」或「新增」。若出现「缺源文件」或 6 行里有任何一行缺失 → 停止。
若全部显示「已最新」→ 说明已经注入过，跳到步骤 5 只做验证，并在报告里写明「本来就已注入」。

### 步骤 3：注入 + 顺手自检
```bash
node "INJECT" --dst "TARGET" --verify
```
期望输出：
- `✓ 注入完成：N 份文件（原文件已备份到 <备份目录>）`
- 若 TARGET 有 scripts/check-tags.mjs：`词表结构自检通过`，且 `合计 ≥ 198 行`
退出码必须是 0。非 0 → 停止，报告完整输出（此时备份已生成，改动可能已部分写入，不要自己 retry）。
把 `<备份目录>` 原样记下来写进报告。

### 步骤 4：验证（必须两条都满足）
```bash
node "INJECT" --dst "TARGET" --check ; echo "CHECK_EXIT=$?"
```
- `CHECK_EXIT=0` 且输出 `✓ 公开版已是私货全量版（无需注入）`
- 再跑一次 `node "INJECT" --dst "TARGET" --check`，结果必须一致（幂等；第二次不许再生成新备份）

可选（TARGET 里有测试就直接跑，30 秒内没结束就跳过并注明）：
```bash
cd "TARGET" && node --test --test-concurrency=1 tests/*.test.mjs
```

### 步骤 5：报告（只输出这一段，不要再做别的）
```
注入结果：成功 / 失败
目标目录：<TARGET 绝对路径>
注入脚本：<INJECT 绝对路径>（来源：注入包 / 私有仓库）
写入文件：N 份（逐行列出 rel + 字节数变化，如 lib/purge.js 21085 → 21638）
备份目录：<备份目录绝对路径>
验证：--check 退出码 0；词表自检 合计 X 行 / Y 个文件
回滚命令：node "<INJECT>" --dst "<TARGET>" --restore
提醒：目标目录现在是私货全量版，不要 git push 到公开仓。
```

### 失败处置
| 现象 | 处理 |
| --- | --- |
| 找不到注入脚本 | 停止，报告找过的路径，不要自己写脚本 |
| TARGET_OK 没打印 | 停止，报告实际路径与 `ls` 结果 |
| `--dry` 出现「缺源文件」 | 停止，报告缺哪份（注入包可能被删了 payload） |
| 注入退出码非 0 | 停止，贴完整输出；回滚用 `--restore` |
| `--check` 退出码 1 | 停止，贴 `--dry` 输出说明还差哪几份 |
| 目标仓 `git status` 本来就不干净 | 继续，但在报告里列出来，不要 commit/清理 |
| 命令不存在（node / git） | Windows 试 `ELECTRON_RUN_AS_NODE=1 "C:/Users/<你>/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" "INJECT" ...`；仍不行就停止报告 |
````

## 配套：打包注入包（源侧，一次就够）

```bash
cd "D:/DSh tagger-lite"
node scripts/pack-inject.mjs                  # → dist/dsh-tagger-inject-<版本>/ 与同名 zip（约 98 KB）
node scripts/pack-inject.mjs --no-zip --quiet  # 只出目录
```

包内自带 `inject.cmd` / `inject.sh` / `README.txt` / `MANIFEST.txt`，把 zip 拷到目标机器解压即可；
agent 用包时把上面的 `node "INJECT"` 换成 `inject.cmd "TARGET"`（Windows）或 `./inject.sh "TARGET"`（Unix）也可以，
参数与退出码语义完全一致。

## 脚本的退出码语义（agent 靠它判断，别改）

| 退出码 | 含义 |
| --- | --- |
| 0 | 注入成功 / 已是最新 / `--restore` 成功 |
| 1 | `--check` 发现还有差异；或注入后 `--verify` 自检失败 |
| 2 | 目标目录不存在、没有备份可回滚、备份缺 manifest |

| 文件状态 | 含义 |
| --- | --- |
| `已最新`（same） | 目标与私货逐字节一致，不会写盘 |
| `新增`（new） | 目标里没有这份文件（`general-nsfw.jsonl` 正常情况就是这个） |
| `覆盖`（update） | 存在但内容被削过，会被覆盖 |
| `缺源文件`（missing-source） | 源侧少了这份，属于打包/仓库损坏，必须先修 |

## 安全线

- 注入后的 TARGET 是**私货全量版**：不要 `git push` 到公开仓，也不要打包上传。
- 想回干净公开版：`--restore`（用最近一次备份，能删掉注入前不存在的文件），或重跑私有仓的 `node tools/make-public.mjs`。
- 备份默认落在脚本所在仓库的 `.inject-backups/<时间戳>/`；用注入包时落在**包目录**下，不污染 TARGET。
- 注入包里的 `payload/` 是明文私货，别放进公开仓库或公开分享链接。
