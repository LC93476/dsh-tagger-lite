// plan: 接口设置表单 + 工作流下拉 + ComfyUI 探活/启动——只碰 settings-card 与 workflow 选择
/**
 * server/public/settings.js — 设置与工作流。
 *
 * 表单值的读取归 state.js（llmPatch / readVars），这里只负责「把服务端配置写回表单」
 * 与「把表单内容存回服务端」，外加工作流下拉与 ComfyUI 三件事（探活 / 保存 / 启动）。
 * 界面文案一律 T('ui.…')，本文件不写死中文。
 */
function refreshLlmPill(ready, model) {
  if (ready === true) setPill("llm-pill", "ok", T("ui.llm.pillOk", { model: model || T("ui.common.ready") }));
  else setPill("llm-pill", "warn", T("ui.llm.pillMissing"));
}
function fillWorkflows(list, def) {
  state.workflows = list || [];
  var sel = $("workflow");
  sel.innerHTML = "";
  state.workflows.forEach(function (w) {
    var o = document.createElement("option");
    o.value = w.id;
    var needsImage = String(w.id).indexOf("ref") >= 0 || (Array.isArray(w.vars) && w.vars.some(function (v) { return v && v.name === "image" }));
    o.textContent = (w.title ? w.id + " · " + w.title : w.id) + (needsImage ? T("ui.ref.badge") : "");
    sel.appendChild(o);
  });
  if (def) sel.value = def;
  if (!state.workflows.length) {
    var none = document.createElement("option");
    none.value = "";
    none.textContent = T("ui.workflow.none");
    sel.appendChild(none);
  }
  syncRefRow();
}
/** 参考图行随模板变：不用参考图的模板置灰并说明，姿势行只在姿势模板里露出来。 */
function syncRefRow() {
  var wid = $("workflow").value || "";
  var isRef = wid.indexOf("ref") >= 0;
  $("ref-row").style.display = "";
  $("ref-row").style.opacity = isRef ? "" : "0.5";
  $("ref-file").disabled = !isRef;
  $("ref-status").style.display = "";
  if (isRef) {
    if (!state.refName) {
      $("ref-status").className = "hint";
      $("ref-status").textContent = T("ui.ref.hintPick");
    }
  } else {
    $("ref-status").className = "hint";
    $("ref-status").textContent = T("ui.ref.hintDisabled");
    $("ref-preview").style.display = "none";
  }
  $("pose").parentNode.style.display = (wid.indexOf("pose") >= 0 && wid.indexOf("ref") < 0) ? "" : "none";
  applyCnStrength(isRef, state.lastWid !== wid);
  state.lastWid = wid;
}
/** 换模板时给 CN 强度换一档：姿势模板取骨架默认值，参考图模板取骨架写的 data-boost。 */
function applyCnStrength(isRef, changed) {
  var cn = $("cnstrength");
  if (!cn || !changed) return;
  var pair = cnStrengthPair();
  if (isRef && cn.value === String(pair.base)) cn.value = String(pair.boost);
  if (!isRef && cn.value === String(pair.boost)) cn.value = String(pair.base);
}
async function reloadState() {
  var st = await api("/state");
  var s = st.data || {};
  var comfy = s.comfy || {};
  if (comfy.ok === true) setPill("comfy-pill", "ok", T("ui.comfy.pillOk", { version: comfy.version || T("ui.common.online") }));
  else setPill("comfy-pill", "err", T("ui.comfy.pillDown"));
  var def = s.config && s.config.comfy ? s.config.comfy.defaultWorkflowId : "";
  fillWorkflows(s.workflows || [], def);
  loadUi();
  return s;
}
async function saveForgeToggle() {
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { forge: forgeToggleCfg() } }) });
  var ok = res.data && res.data.ok !== false;
  $("forge-status").className = ok ? "hint" : "hint err";
  $("forge-status").textContent = ok ? T("ui.forge.toggleSaved") : T("ui.forge.toggleFailed");
}
async function saveLlm() {
  setStatus("llm-status", T("ui.common.saving"), false);
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { llm: llmPatch() } }) });
  var d = res.data || {};
  if (!d.config) { setStatus("llm-status", T("ui.common.saveFailed", { text: errText(d, res.status) }), true); return }
  fillSettings(d.config);
  var health = await api("/health");
  var h = health.data || {};
  refreshLlmPill(h.llmReady === true, h.llm && h.llm.model);
  if (h.llmReady === true) setStatus("llm-status", T("ui.llm.savedReady"), false);
  else setStatus("llm-status", T("ui.llm.savedMissing"), true);
}
async function testLlm() {
  setStatus("llm-status", T("ui.llm.testing"), false);
  var res = await api("/llm/probe", { method: "POST", body: JSON.stringify({ baseUrl: $("llm-baseurl").value.trim(), apiKey: $("llm-key").value.trim() }) });
  var d = res.data || {};
  if (d.ok === true) {
    var extra = (d.models && d.models.length) ? "\n" + d.models.slice(0, 8).join(T("ui.common.listSep")) : "";
    setStatus("llm-status", "✓ " + (d.message || T("ui.llm.probeOk")) + " · " + (d.ms || 0) + " ms" + extra, false);
  } else {
    setStatus("llm-status", "✗ " + errText(d, res.status) + (d.endpoint ? "\n" + d.endpoint : ""), true);
  }
}
async function saveComfy() {
  setStatus("comfy-status", T("ui.common.saving"), false);
  var patch = {
    baseUrl: $("comfy-baseurl").value.trim(),
    launchDir: $("comfy-dir").value.trim(),
    pythonPath: $("comfy-python").value.trim(),
    workflowDir: $("comfy-workflows").value.trim(),
    defaultWorkflowId: $("comfy-default").value.trim()
  };
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { comfy: patch } }) });
  var d = res.data || {};
  if (!d.config) { setStatus("comfy-status", T("ui.common.saveFailed", { text: errText(d, res.status) }), true); return }
  fillSettings(d.config);
  var s = await reloadState();
  var comfy = s.comfy || {};
  if (comfy.ok === true) setStatus("comfy-status", T("ui.comfy.saved", { version: comfy.version || T("ui.common.online"), n: state.workflows.length }), false);
  else setStatus("comfy-status", T("ui.comfy.savedDown", { text: comfy.message || T("ui.comfy.badAddress") }), true);
}
async function pingComfy() {
  setStatus("comfy-status", T("ui.comfy.checking"), false);
  var res = await api("/comfy");
  var d = res.data || {};
  var status = d.status || {};
  if (status.ok === true) {
    setPill("comfy-pill", "ok", T("ui.comfy.pillOk", { version: status.version || T("ui.common.online") }));
    setStatus("comfy-status", T("ui.comfy.onlineLine", { version: status.version || "", n: (d.workflows || []).length }), false);
  } else {
    setPill("comfy-pill", "err", T("ui.comfy.pillDown"));
    setStatus("comfy-status", T("ui.comfy.downLine", { text: status.message || T("ui.comfy.launchHint") }), true);
  }
}
async function launchComfy() {
  setStatus("comfy-status", T("ui.comfy.launching"), false);
  var res = await api("/comfy/launch", { method: "POST", body: JSON.stringify({ waitMs: 60000 }) });
  var d = res.data || {};
  if (d.ok === true) {
    setPill("comfy-pill", "ok", T("ui.comfy.pillOk", { version: (d.status && d.status.version) || T("ui.common.online") }));
    setStatus("comfy-status", T("ui.comfy.launched", { pid: d.pid || "?" }) + (d.alreadyRunning ? T("ui.comfy.alreadyRunning") : ""), false);
    await reloadState();
  } else {
    setStatus("comfy-status", T("ui.comfy.launchFailed", { text: errText(d, res.status) }), true);
  }
}
