// plan: 编排层——boot 拉一次 /state，锻造 / 精修 / 出图三个动作，末尾把所有事件绑上
/**
 * server/public/app.js — 铸炉台的「编排层」。
 *
 * 依赖顺序（panel.html 里按这个顺序加载）：
 *   api.js（BASE / api / poseThumbUrl）
 *   → state.js（state / 表单读写 / 配置默认值）
 *   → render.js（状态灯 / 结果卡 / 错误码中文表）
 *   → settings.js（设置表单 / 工作流下拉 / ComfyUI 探活与启动）
 *   → history.js（出图轮询与预览 / 参考图 / 姿势弹窗 / 参数记忆）
 *   → app.js（本文件：只做编排与事件绑定，不自己写 DOM 细节）。
 *
 * 各层都是普通 script 共享全局函数，跨文件调用只在「运行时」发生，所以加载顺序只要满足
 * 「定义在调用之前」即可；这里不做模块打包，改完刷新浏览器就生效。
 */
async function boot() {
  try {
    await bootInner();
  } catch (err) {
    // 任何一步炸了都要把状态灯点亮成红色，不能一屏「读取中」骗人。
    var why = err && err.message ? err.message : String(err);
    setPill("llm-pill", "err", "读取状态失败：" + why);
    setPill("comfy-pill", "err", "读取状态失败");
    $("lamp-text").textContent = "读取失败";
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "前端读取状态出错：" + why + "（F5 看控制台）";
  }
}
/** 冷启动只打一个状态接口：/state 一次给全 config / purge / comfy / workflows / history。 */
async function bootInner() {
  var st = await api("/state");
  var s = st.data || {};
  setLamp(s.purge);
  var comfy = s.comfy || {};
  if (comfy.ok === true) setPill("comfy-pill", "ok", "ComfyUI " + (comfy.version || "在线"));
  else setPill("comfy-pill", "err", "ComfyUI 没连上");
  fillWorkflows(s.workflows, s.config && s.config.comfy ? s.config.comfy.defaultWorkflowId : "");
  await loadPoses();
  applyForgeToggles(s.config);
  if (Array.isArray(s.history) && s.history.length > 0) {
    var last = s.history[0];
    $("gen-status").textContent = "历史里最近一条：seed " + (last.seed || "?") + " · " + (last.workflowId || "");
  }
  fillSettings(s.config);
  syncRefRow();
  loadUi();
  await refreshLlmPillFromHealth();
}
/** 本地三道处理的开关：只有服务端明确关了才不打勾，缺字段按开。 */
function applyForgeToggles(config) {
  var forge = (config && config.forge) || {};
  $("fg-repair").checked = forge.repair !== false;
  $("fg-postprocess").checked = forge.postprocess !== false;
  $("fg-posehints").checked = forge.poseHints !== false;
  $("fg-candidates").checked = forge.candidates !== false;
}
/** /state 里没有 llmReady（DSh 插件版才有），独立服务靠 /health 补一次。 */
async function refreshLlmPillFromHealth() {
  if (typeof api !== "function") return;
  var health = await api("/health");
  var h = health.data || {};
  if (typeof h.llmReady !== "boolean") return;
  refreshLlmPill(h.llmReady === true, h.llm && h.llm.model);
}
async function doForge() {
  var text = $("text").value.trim();
  if (text === "") { $("forge-status").className = "hint err"; $("forge-status").textContent = "先写几句白话"; return }
  var btn = $("forge");
  btn.disabled = true;
  $("forge-status").className = "hint";
  $("forge-status").textContent = "锻造中…（十几秒）";
  var started = Date.now();
  var options = {};
  var maxTags = readMaxTags();
  if (maxTags !== null) options.maxTags = maxTags;
  var res = await api("/forge", { method: "POST", body: JSON.stringify({ text: text, options: options }) });
  btn.disabled = false;
  var d = res.data || {};
  if (d.ok !== true) {
    $("forge-status").className = "hint err";
    $("forge-status").textContent = "锻造失败：" + errText(d, res.status);
    return;
  }
  state.result = d;
  renderResult();
  $("refine-delta").textContent = "";
  $("forge-status").className = "hint";
  $("forge-status").textContent = "完成 · " + ((Date.now() - started) / 1000).toFixed(1) + " s";
}
async function doRefine() {
  if (!state.result) return;
  var instruction = $("refine-text").value.trim();
  if (instruction === "") { $("refine-status").className = "hint err"; $("refine-status").textContent = "说一句要改什么"; return }
  var btn = $("refine");
  btn.disabled = true;
  $("refine-status").className = "hint";
  $("refine-status").textContent = "精修中…";
  var res = await api("/refine", {
    method: "POST",
    body: JSON.stringify({
      positive: positiveText(),
      negative: "",
      instruction: instruction,
      mode: $("refine-mode").value
    })
  });
  btn.disabled = false;
  var d = res.data || {};
  if (d.ok !== true) {
    $("refine-status").className = "hint err";
    $("refine-status").textContent = "精修失败：" + errText(d, res.status);
    return;
  }
  state.result = Object.assign({}, state.result, { tags: d.tags, positive: d.positive, negative: d.negative });
  renderResult();
  $("refine-status").className = "hint";
  $("refine-status").textContent = "完成 · " + (d.ms || 0) + " ms" + (d.notes ? " · " + d.notes : "");
  var delta = d.delta || {};
  var lines = [];
  if ((delta.added || []).length) lines.push("+ " + delta.added.join(", "));
  if ((delta.removed || []).length) lines.push("- " + delta.removed.join(", "));
  (delta.weighted || []).forEach(function (w) { lines.push("~ " + w.tag + " " + w.from + " → " + w.to) });
  (d.warnings || []).forEach(function (w) { lines.push("! " + w) });
  $("refine-delta").textContent = lines.length ? lines.join("\n") : "没有改动";
}
async function doRun() {
  var workflowId = $("workflow").value;
  if (!workflowId) { $("gen-status").className = "hint err"; $("gen-status").textContent = "先选一个工作流模板"; return }
  if (!state.result) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "还没有正向串：先在上面写几句白话点「锻造」，出图用的是锻造结果。";
    return;
  }
  var btn = $("run");
  btn.disabled = true;
  $("gen-status").className = "hint";
  $("gen-status").textContent = "提交中…";
  var res = await api("/run", {
    method: "POST",
    body: JSON.stringify({ workflowId: workflowId, positive: positiveText(), negative: "", vars: readVars() })
  });
  btn.disabled = false;
  var d = res.data || {};
  if (d.ok !== true) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "提交失败：" + errText(d, res.status);
    return;
  }
  $("gen-status").className = "hint";
  $("gen-status").textContent = "已提交 " + d.promptId + " · 开始轮询";
  pollJob(d.promptId);
}
/* ── 事件绑定 ───────────────────────────────────────────────────────── */
function bind(id, fn) { $(id).addEventListener("click", fn) }
["fg-repair", "fg-postprocess", "fg-posehints", "fg-candidates"].forEach(function (id) {
  $(id).addEventListener("change", saveForgeToggle);
});
$("forge").addEventListener("click", doForge);
$("refine").addEventListener("click", doRefine);
$("run").addEventListener("click", doRun);
$("workflow").addEventListener("change", function () { syncRefRow(); saveUi() });
$("pose-btn").addEventListener("click", openPoseModal);
$("pose-close").addEventListener("click", function () { $("pose-modal").hidden = true });
$("pose-modal").addEventListener("click", function (e) { if (e.target === $("pose-modal")) $("pose-modal").hidden = true });
$("pose-q").addEventListener("input", function (e) { state.poseQuery = String(e.target.value || "").trim(); renderPoseGrid() });
document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("pose-modal").hidden = true });
$("ref-file").addEventListener("change", function (e) {
  var file = e.target.files && e.target.files[0];
  if (file) pickRef(file).catch(function (err) {
    $("ref-status").className = "hint err";
    $("ref-status").textContent = "上传失败：" + (err && err.message ? err.message : err);
  });
});
bind("llm-save", saveLlm);
bind("llm-test", testLlm);
bind("comfy-save", saveComfy);
bind("comfy-ping", pingComfy);
bind("comfy-launch", launchComfy);
// 复制成功提示：1 秒后把按钮文案复原（也只是个 toast，别跟出图变量混为一谈）
var COPY_TOAST_MS = 1000;
$("copy-pair").addEventListener("click", function () { navigator.clipboard.writeText($("pairs").value); $("copy-pair").textContent = "已复制"; setTimeout(function () { $("copy-pair").textContent = "复制" }, COPY_TOAST_MS) });
$("copy-pos").addEventListener("click", function () { navigator.clipboard.writeText($("positive").value); $("copy-pos").textContent = "已复制"; setTimeout(function () { $("copy-pos").textContent = "复制" }, COPY_TOAST_MS) });
$("save-level").addEventListener("click", async function () {
  var res = await api("/purge", { method: "POST", body: JSON.stringify({ purge: { enabled: $("level").value !== "off", level: $("level").value } }) });
  if (res.data && res.data.purge) setLamp(res.data.purge);
});
$("text").addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doForge() });
// 参数改了就记住：下次开面板还在原样（工作流本身由 fillWorkflows 自己 syncRefRow）
UI_FIELDS.concat(["workflow"]).forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener("change", saveUi);
});
$("refine-text").addEventListener("keydown", function (e) { if (e.key === "Enter") doRefine() });
boot();
