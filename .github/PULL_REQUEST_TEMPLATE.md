## 这个 PR 做了什么

<!-- 一句话 + 要点。关联 issue 写 Closes #123 -->

## 为什么

<!-- 解决什么问题 / 满足什么需求。行为变化要贴前后对比。 -->

## 自查清单

- [ ] `npm run check` 全绿（check:tags / check:overlay / check:layout / typecheck / test），并已把最后几行输出贴到下面
- [ ] 没有给运行时（`index.js` / `lib/` / `server/` / `bin/`）引入第三方依赖
- [ ] 没有改名外部契约（HTTP 路由 / MCP 工具名与参数 / config DEFAULTS 键 / 面板 `ptf-*` testid）；如有意改动，已先改 `docs/CONTRACT.md` 并说明兼容方案
- [ ] 行为变化带了测试；修 bug 的 PR 里有能复现的上游用例
- [ ] 文档已同步（改了目录结构动 `docs/LAYOUT.md`，改了接口动 `docs/API.md`，改了安装方式动 `README.md` / `INSTALL.md`）
- [ ] 没有提交生成物（`dist/`、`tmp/`、`D:/DSh tagger-lite-lite`、zip）

## 门禁输出

```
# npm run check 的最后 10~20 行
```

## 截图 / 复现步骤（可选）
