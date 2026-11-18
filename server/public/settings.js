// plan: 接口设置表单 + 工作流下拉 + ComfyUI 探活/启动——只碰 settings-card 与 workflow 选择
/**
 * server/public/settings.js — 设置与工作流。
 *
 * 表单值的读取归 state.js（llmPatch / readVars），这里只负责「把服务端配置写回表单」
 * 与「把表单内容存回服务端」，外加工作流下拉与 ComfyUI 三件事（探活 / 保存 / 启动）。
 */
function refreshLlmPill(ready, model) {
  if (ready === true) setPill("llm-pill", "ok", "llm " + (model || "就绪"));
  else setPill("llm-pill", "warn", "llm 未配置（锻造会回 no-llm）");
}
function fillWorkflows(list, def) {
  state.workflows = list || [];
  var sel = $("workflow");
  sel.innerHTML = "";
  state.workflows.forEach(function (w) {
    var o = document.createElement("option");
    o.value = w.id;
    var needsImage = String(w.id).indexOf("ref") >= 0 || (Array.isArray(w.vars) && w.vars.some(function (v) { return v && v.name === "image" }));
    o.textContent = (w.title ? w.id + " · " + w.title : w.id) + (needsImage ? "　〔参考图〕" : "");
    sel.appendChild(o);
  });
  if (def) sel.value = def;
  if (!state.workflows.length) sel.innerHTML = "<option value=\"\">（没读到工作流模板）</option>";
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
      $("ref-status").textContent = "选一张图（png/jpg/webp，≤24MB）：DepthAnythingV2 提深度后由 ControlNet 锁住体态，提示词只负责内容与画风。";
    }
  } else {
    $("ref-status").className = "hint";
    $("ref-status").textContent = "当前模板不用参考图。要用自己的图锁体态：工作流选下拉里带〔参考图〕的那条（feiyue-sam3-ref）。";
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
  if (comfy.ok === true) setPill("comfy-pill", "ok", "ComfyUI " + (comfy.version || "在线"));
  else setPill("comfy-pill", "err", "ComfyUI 没连上");
  var def = s.config && s.config.comfy ? s.config.comfy.defaultWorkflowId : "";
  fillWorkflows(s.workflows || [], def);
  loadUi();
  return s;
}
async function saveForgeToggle() {
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { forge: forgeToggleCfg() } }) });
  var ok = res.data && res.data.ok !== false;
  $("forge-status").className = ok ? "hint" : "hint err";
  $("forge-status").textContent = ok ? "本地处理开关已保存（立刻生效）" : "开关没保存成功";
}
async function saveLlm() {
  setStatus("llm-status", "保存中…", false);
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { llm: llmPatch() } }) });
  var d = res.data || {};
  if (!d.config) { setStatus("llm-status", "保存失败：" + errText(d, res.status), true); return }
  fillSettings(d.config);
  var health = await api("/health");
  var h = health.data || {};
  refreshLlmPill(h.llmReady === true, h.llm && h.llm.model);
  if (h.llmReady === true) setStatus("llm-status", "已保存，模型接口就绪（立刻生效）", false);
  else setStatus("llm-status", "已保存，但接口地址或 key 还缺，锻造仍会回 no-llm", true);
}
async function testLlm() {
  setStatus("llm-status", "测试中…", false);
  var res = await api("/llm/probe", { method: "POST", body: JSON.stringify({ baseUrl: $("llm-baseurl").value.trim(), apiKey: $("llm-key").value.trim() }) });
  var d = res.data || {};
  if (d.ok === true) {
    var extra = (d.models && d.models.length) ? "\n" + d.models.slice(0, 8).join("、") : "";
    setStatus("llm-status", "✓ " + (d.message || "连上了") + " · " + (d.ms || 0) + " ms" + extra, false);
  } else {
    setStatus("llm-status", "✗ " + errText(d, res.status) + (d.endpoint ? "\n" + d.endpoint : ""), true);
  }
}
async function saveComfy() {
  setStatus("comfy-status", "保存中…", false);
  var patch = {
    baseUrl: $("comfy-baseurl").value.trim(),
    launchDir: $("comfy-dir").value.trim(),
    pythonPath: $("comfy-python").value.trim(),
    workflowDir: $("comfy-workflows").value.trim(),
    defaultWorkflowId: $("comfy-default").value.trim()
  };
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { comfy: patch } }) });
  var d = res.data || {};
  if (!d.config) { setStatus("comfy-status", "保存失败：" + errText(d, res.status), true); return }
  fillSettings(d.config);
  var s = await reloadState();
  var comfy = s.comfy || {};
  if (comfy.ok === true) setStatus("comfy-status", "已保存 · ComfyUI " + (comfy.version || "在线") + " · 模板 " + state.workflows.length + " 套", false);
  else setStatus("comfy-status", "已保存，但没连上：" + (comfy.message || "地址或端口不对？"), true);
}
async function pingComfy() {
  setStatus("comfy-status", "检测中…", false);
  var res = await api("/comfy");
  var d = res.data || {};
  var status = d.status || {};
  if (status.ok === true) {
    setPill("comfy-pill", "ok", "ComfyUI " + (status.version || "在线"));
    setStatus("comfy-status", "在线 · " + (status.version || "") + " · 模板 " + ((d.workflows || []).length) + " 套", false);
  } else {
    setPill("comfy-pill", "err", "ComfyUI 没连上");
    setStatus("comfy-status", "连不上：" + (status.message || "先确认 ComfyUI 已启动，或点「启动 ComfyUI」"), true);
  }
}
async function launchComfy() {
  setStatus("comfy-status", "拉起中…（最多等 60 秒）", false);
  var res = await api("/comfy/launch", { method: "POST", body: JSON.stringify({ waitMs: 60000 }) });
  var d = res.data || {};
  if (d.ok === true) {
    setPill("comfy-pill", "ok", "ComfyUI " + ((d.status && d.status.version) || "在线"));
    setStatus("comfy-status", "已启动 · pid " + (d.pid || "?") + (d.alreadyRunning ? "（本来就在跑）" : ""), false);
    await reloadState();
  } else {
    setStatus("comfy-status", "启动失败：" + errText(d, res.status), true);
  }
}
