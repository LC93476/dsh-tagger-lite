// plan: 编排层——boot 拉一次 /state，锻造 / 精修 / 出图三个动作，末尾把所有事件绑上
/**
 * server/public/app.js — 锻造台的「编排层」。
 *
 * 依赖顺序（panel.html 里按这个顺序加载）：
 *   api.js（BASE / api / poseThumbUrl）
 *   → i18n.js（T / 语言选择 / 静态文案回填）
 *   → state.js（state / 表单读写 / 配置默认值）
 *   → render.js（状态灯 / 结果卡 / 错误码表）
 *   → settings.js（设置表单 / 工作流下拉 / ComfyUI 探活与启动）
 *   → history.js（出图轮询与预览 / 参考图 / 姿势弹窗 / 参数记忆）
 *   → app.js（本文件：只做编排与事件绑定，不自己写 DOM 细节）。
 *
 * 各层都是普通 script 共享全局函数，跨文件调用只在「运行时」发生，所以加载顺序只要满足
 * 「定义在调用之前」即可；这里不做模块打包，改完刷新浏览器就生效。
 * 界面文案一律 T('ui.…')，本文件不写死中文；换语言就重跑 boot，动态部分跟着重渲染。
 */
async function boot() {
  try {
    // 语言先就位：后面每一步都在往 DOM 里写文案，字典没到就只能写内置 zh。
    if (typeof i18nStart === "function") await i18nStart();
    await bootInner();
  } catch (err) {
    // 任何一步炸了都要把状态灯点亮成红色，不能一屏「读取中」骗人。
    var why = err && err.message ? err.message : String(err);
    setPill("llm-pill", "err", T("ui.boot.llmFailed", { why: why }));
    setPill("comfy-pill", "err", T("ui.boot.comfyFailed"));
    $("lamp-text").textContent = T("ui.boot.lampFailed");
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.boot.failed", { why: why });
  }
}
/** 冷启动只打一个状态接口：/state 一次给全 config / purge / comfy / workflows / history。 */
async function bootInner() {
  var st = await api("/state");
  var s = st.data || {};
  setLamp(s.purge);
  var comfy = s.comfy || {};
  if (comfy.ok === true) setPill("comfy-pill", "ok", T("ui.comfy.pillOk", { version: comfy.version || T("ui.common.online") }));
  else setPill("comfy-pill", "err", T("ui.comfy.pillDown"));
  fillWorkflows(s.workflows, s.config && s.config.comfy ? s.config.comfy.defaultWorkflowId : "");
  await loadPoses();
  applyForgeToggles(s.config);
  if (Array.isArray(s.history) && s.history.length > 0) {
    var last = s.history[0];
    $("gen-status").textContent = T("ui.history.last", { seed: last.seed || "?", workflow: last.workflowId || "" });
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
  if (text === "") { $("forge-status").className = "hint err"; $("forge-status").textContent = T("ui.forge.emptyText"); return }
  var btn = $("forge");
  btn.disabled = true;
  $("forge-status").className = "hint";
  $("forge-status").textContent = T("ui.forge.running");
  var started = Date.now();
  var options = {};
  var maxTags = readMaxTags();
  if (maxTags !== null) options.maxTags = maxTags;
  var res = await api("/forge", { method: "POST", body: JSON.stringify({ text: text, options: options }) });
  btn.disabled = false;
  var d = res.data || {};
  if (d.ok !== true) {
    $("forge-status").className = "hint err";
    $("forge-status").textContent = T("ui.forge.failed", { text: errText(d, res.status) });
    return;
  }
  state.result = d;
  renderResult();
  $("refine-delta").textContent = "";
  $("forge-status").className = "hint";
  $("forge-status").textContent = T("ui.common.doneSecs", { s: ((Date.now() - started) / 1000).toFixed(1) });
}
async function doRefine() {
  if (!state.result) return;
  var instruction = $("refine-text").value.trim();
  if (instruction === "") { $("refine-status").className = "hint err"; $("refine-status").textContent = T("ui.refine.emptyInstruction"); return }
  var btn = $("refine");
  btn.disabled = true;
  $("refine-status").className = "hint";
  $("refine-status").textContent = T("ui.refine.running");
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
    $("refine-status").textContent = T("ui.refine.failedPrefix", { text: errText(d, res.status) });
    return;
  }
  state.result = Object.assign({}, state.result, { tags: d.tags, positive: d.positive, negative: d.negative });
  renderResult();
  $("refine-status").className = "hint";
  $("refine-status").textContent = T("ui.common.doneMs", { ms: d.ms || 0 }) + (d.notes ? " · " + d.notes : "");
  var delta = d.delta || {};
  var lines = [];
  if ((delta.added || []).length) lines.push("+ " + delta.added.join(", "));
  if ((delta.removed || []).length) lines.push("- " + delta.removed.join(", "));
  (delta.weighted || []).forEach(function (w) { lines.push("~ " + w.tag + " " + w.from + " → " + w.to) });
  (d.warnings || []).forEach(function (w) { lines.push("! " + w) });
  $("refine-delta").textContent = lines.length ? lines.join("\n") : T("ui.refine.noChange");
}
async function doRun() {
  var workflowId = $("workflow").value;
  if (!workflowId) { $("gen-status").className = "hint err"; $("gen-status").textContent = T("ui.run.noWorkflow"); return }
  if (!state.result) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.run.noPositive");
    return;
  }
  var btn = $("run");
  btn.disabled = true;
  $("gen-status").className = "hint";
  $("gen-status").textContent = T("ui.run.submitting");
  var res = await api("/run", {
    method: "POST",
    body: JSON.stringify({ workflowId: workflowId, positive: positiveText(), negative: "", vars: readVars() })
  });
  btn.disabled = false;
  var d = res.data || {};
  if (d.ok !== true) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.run.submitFailed", { text: errText(d, res.status) });
    return;
  }
  $("gen-status").className = "hint";
  $("gen-status").textContent = T("ui.run.submitted", { id: d.promptId });
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
    $("ref-status").textContent = T("ui.ref.uploadFailed", { text: (err && err.message ? err.message : err) });
  });
});
bind("llm-save", saveLlm);
bind("llm-test", testLlm);
bind("comfy-save", saveComfy);
bind("comfy-ping", pingComfy);
bind("comfy-launch", launchComfy);
bind("wf-import", doWorkflowImport);
$("wf-file").addEventListener("change", pickWorkflowFiles);
// 复制成功提示：1 秒后把按钮文案复原（文案来自字典，切语言后下一次重渲染自然跟上）
var COPY_TOAST_MS = 1000;
$("copy-pair").addEventListener("click", function () { navigator.clipboard.writeText($("pairs").value); $("copy-pair").textContent = T("ui.common.copied"); setTimeout(function () { $("copy-pair").textContent = T("ui.common.copy") }, COPY_TOAST_MS) });
$("copy-pos").addEventListener("click", function () { navigator.clipboard.writeText($("positive").value); $("copy-pos").textContent = T("ui.common.copied"); setTimeout(function () { $("copy-pos").textContent = T("ui.common.copy") }, COPY_TOAST_MS) });
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
// 换语言：记住选择 + 换字典 + 重写静态文案，再重跑 boot 把动态部分（状态灯、结果、提示）重渲染一遍。
if ($("lang")) {
  $("lang").addEventListener("change", async function (e) {
    await i18nSetLang(e.target.value);
    boot();
  });
}
boot();
