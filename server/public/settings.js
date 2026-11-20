// plan: 接口设置表单 + 工作流下拉 + ComfyUI 探活/启动——只碰 settings-card 与 workflow 选择
/**
 * server/public/settings.js — 设置与工作流。
 *
 * 表单值的读取归 state.js（llmPatch / readVars），这里只负责「把服务端配置写回表单」
 * 与「把表单内容存回服务端」，外加工作流下拉与 ComfyUI 三件事（探活 / 保存 / 启动）。
 * 界面文案一律 T('ui.…')，本文件不写死中文。
 */
/** 顶栏两盏灯的唯二写入口：顺手记下状态，切语言时据此重画（不必重新探测服务）。 */
function refreshLlmPill(ready, model) {
  state.llmPill = { ready: ready === true, model: model || "" };
  if (ready === true) setPill("llm-pill", "ok", T("ui.llm.pillOk", { model: state.llmPill.model || T("ui.common.ready") }));
  else setPill("llm-pill", "warn", T("ui.llm.pillMissing"));
}
function setComfyPill(ok, version) {
  state.comfyPill = { ok: ok === true, version: version || "" };
  if (state.comfyPill.ok) setPill("comfy-pill", "ok", T("ui.comfy.pillOk", { version: state.comfyPill.version || T("ui.common.online") }));
  else setPill("comfy-pill", "err", T("ui.comfy.pillDown"));
}
function fillWorkflows(list, def) {
  state.workflows = list || [];
  var sel = $("workflow");
  sel.innerHTML = "";
  state.workflows.forEach(function (w) {
    var o = document.createElement("option");
    o.value = w.id;
    var needsImage = workflowCaps(w.id).image;
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
  var caps = workflowCaps(wid);
  var isRef = caps.image;
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
  $("pose").parentNode.style.display = (caps.pose && !caps.image) ? "" : "none";
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
  setComfyPill(comfy.ok, comfy.version);
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
    setComfyPill(true, status.version);
    setStatus("comfy-status", T("ui.comfy.onlineLine", { version: status.version || "", n: (d.workflows || []).length }), false);
  } else {
    setComfyPill(false, "");
    setStatus("comfy-status", T("ui.comfy.downLine", { text: status.message || T("ui.comfy.launchHint") }), true);
  }
}
async function launchComfy() {
  setStatus("comfy-status", T("ui.comfy.launching"), false);
  var res = await api("/comfy/launch", { method: "POST", body: JSON.stringify({ waitMs: 60000 }) });
  var d = res.data || {};
  if (d.ok === true) {
    setComfyPill(true, d.status && d.status.version);
    setStatus("comfy-status", T("ui.comfy.launched", { pid: d.pid || "?" }) + (d.alreadyRunning ? T("ui.comfy.alreadyRunning") : ""), false);
    await reloadState();
  } else {
    setStatus("comfy-status", T("ui.comfy.launchFailed", { text: errText(d, res.status) }), true);
  }
}
// ── 导入自定义工作流 ────────────────────────────────────────────────────────
// 收 1 份工作流 JSON（必须 API 格式）+ 可选 1 份 schema；服务端落到 comfy.workflowDir。
// 判断「这份文件是工作流还是 schema」只看形状：有 class_type 节点的是工作流，带 vars 的是 schema。
var wfImport = { workflow: null, schema: null };

/** 文件名 → 合法模板 id（与 lib/workflow-import.js 的 slugify 同一套规则）。 */
function slugName(raw) {
  return String(raw || "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

/** 形状判定：workflow（API 格式）/ schema / ui（界面格式，拒）/ bad。 */
function classifyWfFile(text) {
  var v;
  try { v = JSON.parse(text) } catch (e) { return "bad" }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "bad";
  if (Array.isArray(v.nodes)) return "ui";
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) {
    var node = v[keys[i]];
    if (node && typeof node === "object" && typeof node.class_type === "string") return "workflow";
  }
  return "schema";
}

function readFileText(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || "")) };
    reader.onerror = function () { reject(new Error("read-failed")) };
    reader.readAsText(file);
  });
}

function wfSetStatus(text, bad) { setStatus("wf-status", text, bad); }

/** 选文件：工作流进 wfImport.workflow，schema 进 wfImport.schema；id 没填就从文件名推。 */
async function pickWorkflowFiles(event) {
  var files = Array.prototype.slice.call(event.target.files || []);
  if (!files.length) return;
  wfImport.workflow = null;
  wfImport.schema = null;
  var schemaName = "";
  wfSetStatus(T("ui.wfImport.reading"), false);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var text = "";
    try { text = await readFileText(file) } catch (e) {
      wfSetStatus(T("ui.wfImport.failed", { text: errText({ error: "no-file" }, 0) }), true);
      return;
    }
    var kind = classifyWfFile(text);
    if (kind === "workflow") {
      wfImport.workflow = text;
      if (!$("wf-name").value.trim()) $("wf-name").value = slugName(file.name.replace(/\.json$/i, ""));
    } else if (kind === "schema") {
      wfImport.schema = text;
      schemaName = file.name;
    } else if (kind === "ui") {
      wfSetStatus(T("ui.wfImport.failed", { text: T("err.ui-format") }), true);
      return;
    } else {
      wfSetStatus(T("ui.wfImport.failed", { text: T("err.bad-json") }), true);
      return;
    }
  }
  if (!wfImport.workflow) { wfSetStatus(T("ui.wfImport.noFile"), true); return; }
  var parts = [];
  parts.push($("wf-name").value.trim() || "workflow");
  if (schemaName) parts.push(T("ui.wfImport.schemaPicked", { name: schemaName }));
  wfSetStatus(parts.filter(Boolean).join(" · "), false);
}

/** 提交导入 → 成功就刷新下拉并选中新模板。 */
async function doWorkflowImport() {
  if (!wfImport.workflow) { wfSetStatus(T("ui.wfImport.noFile"), true); return; }
  var name = slugName($("wf-name").value);
  if (!name) { wfSetStatus(T("ui.wfImport.needName"), true); return; }
  wfSetStatus(T("ui.wfImport.importing"), false);
  var body = { name: name, workflow: wfImport.workflow, overwrite: $("wf-overwrite").checked === true };
  if (wfImport.schema) body.schema = wfImport.schema;
  var res = await api("/workflows/import", { method: "POST", body: JSON.stringify(body) });
  var d = res.data || {};
  if (d.ok !== true) { wfSetStatus(T("ui.wfImport.failed", { text: errText(d, res.status) }), true); return; }
  // 导入接口已经把刷新后的列表一起回了，不用再单独打一次 /workflows
  var payload = Array.isArray(d.workflows) ? { workflows: d.workflows } : {};
  if (!Array.isArray(payload.workflows)) {
    wfSetStatus(T("ui.wfImport.reloadFailed", { text: errText(d, res.status) }), true);
    return;
  }
  fillWorkflows(payload.workflows, d.id);
  var n = 0;
  payload.workflows.forEach(function (w) { if (w.id === d.id && Array.isArray(w.vars)) n = w.vars.length });
  wfSetStatus(n > 0 ? T("ui.wfImport.ok", { id: d.id, title: d.title, n: n }) : T("ui.wfImport.okNoVars", { id: d.id, title: d.title }), false);
  saveUi();
}

// ── 模型档案（tag / pony / natural / custom）──────────────────────────────────
// 档案决定「要不要补质量词、词序按不按 14 段重排」，落盘键是 config.forge.profile；
// 规则本身在 lib/model-profiles.js，面板只管选档与说明生效值。
var PROFILE_LIST = [];

/** 档案下拉：照服务端给的顺序建 option 并选中当前档；标题取服务端 title，缺了退回 id。 */
function fillProfiles(list, current) {
  PROFILE_LIST = Array.isArray(list)
    ? list.filter(function (p) { return p && typeof p.id === "string" && p.id !== "" })
    : [];
  var sel = $("model-profile");
  if (!sel) return;
  sel.innerHTML = "";
  PROFILE_LIST.forEach(function (p) {
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = typeof p.title === "string" && p.title !== "" ? p.title : p.id;
    sel.appendChild(o);
  });
  var want = current && typeof current.id === "string" ? current.id : "";
  if (want !== "" && PROFILE_LIST.some(function (p) { return p.id === want; })) sel.value = want;
}

/** 服务端可能只回 id：用清单里同一档补齐质量词与词序，说明行才不会空着。 */
function mergeProfileState(st) {
  var raw = st && typeof st === "object" ? st : {};
  var id = typeof raw.id === "string" && raw.id !== "" ? raw.id : "tag";
  var hit = null;
  PROFILE_LIST.forEach(function (p) { if (p.id === id) hit = p; });
  var tags = Array.isArray(raw.qualityTags) ? raw.qualityTags : [];
  if (tags.length === 0 && hit && Array.isArray(hit.qualityTags)) tags = hit.qualityTags;
  var quality = typeof raw.quality === "boolean" ? raw.quality : Boolean(hit && hit.quality === true);
  var order = typeof raw.order === "boolean" ? raw.order : Boolean(hit === null || hit.order !== false);
  return { id: id, quality: quality, qualityTags: tags, order: order };
}

/** 说明行正文：补哪些质量词 + 词序怎么走；自定义档再点一句「读配置」。 */
function profileStatusText(st) {
  var p = mergeProfileState(st);
  var parts = [];
  parts.push(p.quality && p.qualityTags.length > 0 ? T("ui.profile.quality") + p.qualityTags.join(", ") : T("ui.profile.none"));
  parts.push(p.order ? T("ui.profile.orderOn") : T("ui.profile.orderOff"));
  if (p.id === "custom") parts.push(T("ui.profile.custom"));
  return parts.join(T("ui.common.listSep"));
}

/** 写说明行（顺手记下生效值，换语言重渲染时要用）；extra 用来在前面挂「已保存 / 正在保存」。 */
function renderProfileStatus(st, extra) {
  state.profile = st && typeof st === "object" ? st : null;
  var text = profileStatusText(state.profile);
  var el = $("profile-status");
  if (!el) return text;
  el.className = "hint";
  el.textContent = extra ? extra + T("ui.common.listSep") + text : text;
  return text;
}

/** GET /profiles：清单与当前生效值一起拿；接口没有或形状奇怪都不致命，面板别处照常用。 */
async function loadProfiles() {
  var res = await api("/profiles");
  var d = res.data || {};
  if (d.ok === false) return;
  var list = Array.isArray(d.profiles) ? d.profiles : [];
  if (list.length === 0 && Array.isArray(d.list)) list = d.list;
  var current = null;
  if (d.current && typeof d.current === "object") current = d.current;
  if (current === null && d.state && typeof d.state === "object") current = d.state;
  if (current === null && typeof d.profile === "string" && d.profile !== "") current = { id: d.profile };
  if (list.length === 0) {
    // 没有清单时至少把当前档显示出来，别留一个空白下拉
    if (current === null) return;
    fillProfiles([current], current);
    renderProfileStatus(current, "");
    return;
  }
  fillProfiles(list, current);
  renderProfileStatus(current, "");
}

/** 切档：落 config（forge.profile），成功后按服务端回的生效值刷新说明行；失败红字提示。 */
async function changeProfile() {
  var sel = $("model-profile");
  if (!sel) return;
  if (sel.disabled) return;
  var id = String(sel.value || "").trim();
  if (id === "") return;
  sel.disabled = true;
  try {
    renderProfileStatus(state.profile, T("ui.common.saving"));
    var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { forge: { profile: id } } }) });
    var d = res.data || {};
    if (d.ok === false) {
      setStatus("profile-status", T("ui.profile.failed", { text: errText(d, res.status) }), true);
      return;
    }
    if (d.config) fillSettings(d.config);
    var cur = null;
    if (d.profile && typeof d.profile === "object") cur = d.profile;
    if (cur === null && d.current && typeof d.current === "object") cur = d.current;
    if (cur === null && d.state && typeof d.state === "object") cur = d.state;
    if (cur === null) cur = { id: id };
    renderProfileStatus(cur, T("ui.profile.saved"));
  } finally {
    sel.disabled = false;
  }
}

