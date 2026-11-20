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
 * 界面文案一律 T('ui.…')，本文件不写死中文；换语言走 relocalize() 就地重画，不重跑 boot。
 */
async function boot() {
  try {
    // 语言先就位：后面每一步都在往 DOM 里写文案，字典没到就只能写内置 zh。
    if (typeof i18nStart === "function") await i18nStart();
    await bootInner();
  } catch (err) {
    // 任何一步炸了都要把状态灯点亮成红色，不能一屏「读取中」骗人。
    var why = err && err.message ? err.message : String(err);
    refreshLlmPill(false, "");
    setComfyPill(false, "");
    $("lamp-text").textContent = T("ui.boot.lampFailed");
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.boot.failed", { why: why });
  }
}
/** 冷启动只打一个状态接口：/state 一次给全 config / purge / comfy / workflows / history。 */
async function bootInner() {
  document.documentElement.lang = typeof i18nLang === "function" ? i18nLang() : "zh";
  document.title = T("ui.head.title");
  var st = await api("/state");
  var s = st.data || {};
  setLamp(s.purge);
  var comfy = s.comfy || {};
  setComfyPill(comfy.ok, comfy.version);
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
  var btn = $("forge");
  if (btn.disabled) return;
  var text = $("text").value.trim();
  if (text === "") { $("forge-status").className = "hint err"; $("forge-status").textContent = T("ui.forge.emptyText"); return }
  btn.disabled = true;
  $("forge-status").className = "hint";
  $("forge-status").textContent = T("ui.forge.running");
  var started = Date.now();
  try {
    var options = {};
    var maxTags = readMaxTags();
    if (maxTags !== null) options.maxTags = maxTags;
    var res = await api("/forge", { method: "POST", body: JSON.stringify({ text: text, options: options }) });
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
  } finally {
    // 成功、失败、异常、断网都要把按钮放回去，否则一次网络抖动就把面板锁死。
    btn.disabled = false;
  }
}
async function doRefine() {
  var btn = $("refine");
  if (btn.disabled) return;
  var positive = effectivePositive();
  if (positive === "") { $("refine-status").className = "hint err"; $("refine-status").textContent = T("ui.run.noPositive"); return }
  var instruction = $("refine-text").value.trim();
  if (instruction === "") { $("refine-status").className = "hint err"; $("refine-status").textContent = T("ui.refine.emptyInstruction"); return }
  btn.disabled = true;
  $("refine-status").className = "hint";
  $("refine-status").textContent = T("ui.refine.running");
  try {
    var res = await api("/refine", {
      method: "POST",
      body: JSON.stringify({
        positive: positive,
        negative: "",
        instruction: instruction,
        mode: $("refine-mode").value
      })
    });
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
  } finally {
    btn.disabled = false;
  }
}
async function doRun() {
  var btn = $("run");
  if (btn.disabled) return;
  var workflowId = $("workflow").value;
  if (!workflowId) { $("gen-status").className = "hint err"; $("gen-status").textContent = T("ui.run.noWorkflow"); return }
  // 正向串可以是手改的 #positive，不再要求先锻造过（有标签只是默认值）。
  var positive = effectivePositive();
  if (positive === "") {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.run.noPositive");
    return;
  }
  btn.disabled = true;
  $("gen-status").className = "hint";
  $("gen-status").textContent = T("ui.run.submitting");
  var promptId = "";
  try {
    var res = await api("/run", {
      method: "POST",
      body: JSON.stringify({ workflowId: workflowId, positive: positive, negative: "", vars: readVars() })
    });
    var d = res.data || {};
    if (d.ok !== true) {
      $("gen-status").className = "hint err";
      $("gen-status").textContent = T("ui.run.submitFailed", { text: errText(d, res.status) });
      return;
    }
    promptId = d.promptId;
    $("gen-status").className = "hint";
    $("gen-status").textContent = T("ui.run.submitted", { id: promptId });
  } finally {
    btn.disabled = false;
  }
  pollJob(promptId);
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
// 复制：优先 Clipboard API；拿不到或被拒时退回隐藏 textarea + execCommand（http 来源 / 无权限时常见）。
function copyText(text) {
  var payload = String(text == null ? "" : text);
  var attempt = null;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") attempt = navigator.clipboard.writeText(payload);
  } catch (e) { attempt = null }
  if (!attempt || typeof attempt.then !== "function") return Promise.resolve(legacyCopy(payload));
  return Promise.resolve(attempt).then(function () { return true }, function () { return legacyCopy(payload) });
}
function legacyCopy(payload) {
  var ta = document.createElement("textarea");
  ta.value = payload;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  var ok = false;
  try { ta.select(); ok = document.execCommand("copy") !== false } catch (e) { ok = false }
  document.body.removeChild(ta);
  return ok;
}
// 每个按钮一个 toast timer：连点两次时先清掉上一次的复原，免得把新文案提前抹掉。
var COPY_TOAST_MS = 1000;
var copyTimers = {};
function copyToast(id, ok) {
  var btn = $(id);
  if (!btn) return;
  if (copyTimers[id]) clearTimeout(copyTimers[id]);
  btn.textContent = ok === false ? T("action.copyFailed") : T("ui.common.copied");
  copyTimers[id] = setTimeout(function () {
    delete copyTimers[id];
    btn.textContent = T("ui.common.copy");
  }, COPY_TOAST_MS);
}
$("copy-pair").addEventListener("click", function () { copyText($("pairs").value).then(function (ok) { copyToast("copy-pair", ok) }) });
$("copy-pos").addEventListener("click", function () { copyText($("positive").value).then(function (ok) { copyToast("copy-pos", ok) }) });
/** 破甲档位旁的状态位：HTML 里没写就在按钮后面补一个（只补一次）。 */
function levelStatusEl() {
  var el = $("level-status");
  if (el) return el;
  var btn = $("save-level");
  if (!btn || !btn.parentNode) return null;
  el = document.createElement("span");
  el.id = "level-status";
  el.className = "hint";
  el.style.margin = "0";
  btn.parentNode.insertBefore(el, btn.nextSibling);
  return el;
}
$("save-level").addEventListener("click", async function () {
  var btn = $("save-level");
  if (btn.disabled) return;
  var statusEl = levelStatusEl();
  btn.disabled = true;
  try {
    var res = await api("/purge", { method: "POST", body: JSON.stringify({ purge: { enabled: $("level").value !== "off", level: $("level").value } }) });
    var d = res.data || {};
    if (d.purge) {
      setLamp(d.purge);
      if (statusEl) setStatus("level-status", T("ui.forge.applyLevel"), false);
    } else if (statusEl) {
      // 档位没生效必须说出来，不能点了像没反应。
      setStatus("level-status", errText(d, res.status), true);
    }
  } finally {
    btn.disabled = false;
  }
});
$("text").addEventListener("keydown", function (e) {
  // 输入法组字中的 Enter 是「选词」，不是提交。
  if (e.isComposing || e.keyCode === 229) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doForge();
});
// 参数改了就记住：下次开面板还在原样（工作流由上面那条 change 统一做 syncRefRow + saveUi，这里不重复绑）
UI_FIELDS.forEach(function (id) {
  var el = $(id);
  if (!el) return;
  el.addEventListener("change", saveUi);
});
$("refine-text").addEventListener("keydown", function (e) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") doRefine();
});
/** 换语言：只换字典与看得见的文案，服务状态沿用最近一次探测的结果（不重跑 boot、不丢表单）。 */
function relocalize() {
  document.documentElement.lang = typeof i18nLang === "function" ? i18nLang() : "zh";
  document.title = T("ui.head.title");
  if (typeof i18nApplyStatic === "function") i18nApplyStatic();
  refreshLlmPill(state.llmPill.ready, state.llmPill.model);
  setComfyPill(state.comfyPill.ok, state.comfyPill.version);
  fillWorkflows(state.workflows, $("workflow").value || "");
  renderPoseSets();
  syncPoseBtn();
  if (state.result) renderResult();
}
if ($("lang")) {
  $("lang").addEventListener("change", async function (e) {
    await i18nSetLang(e.target.value);
    relocalize();
  });
}
boot();
