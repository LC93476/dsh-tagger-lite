// plan: 面板的客户端状态与表单读写——state 只在这里改，读写 DOM 表单也集中在这里
/**
 * server/public/state.js — 状态与表单。
 *
 * 约定：state 里只放「跨渲染要用」的东西；表单值永远现读（readVars / llmPatch），
 * 免得用户在输入框里改完、内存里还是旧值。
 */
var state = { result: null, workflows: [], timer: null, refName: "", poses: [], poseIndex: {}, poseSet: "", poseQuery: "" };
function $(id) { return document.getElementById(id) }
function trimNum(n) { return String(Math.round(n * 1000) / 1000) }
function pairOf(t) {
  var head = (typeof t.weight === "number" && Math.abs(t.weight - 1) >= 0.005) ? "(" + t.tag + ":" + trimNum(t.weight) + ")" : t.tag;
  return t.cn ? head + " — " + t.cn : head;
}
function positiveText() {
  var tags = (state.result && state.result.tags) || [];
  return tags.map(function (t) {
    return (typeof t.weight === "number" && Math.abs(t.weight - 1) >= 0.005) ? "(" + t.tag + ":" + trimNum(t.weight) + ")" : t.tag;
  }).join(", ");
}
function readVars() {
  var vars = {
    width: Number($("width").value) || 1200,
    height: Number($("height").value) || 1800,
    seed: Number($("seed").value) || 0,
    steps: Number($("steps").value) || 30,
    cfg: Number($("cfg").value) || 5
  };
  // 只有姿势类模板才有 pose / cnStrength 变量，别的模板塞进去会被丢掉并留 warning。
  var wid = $("workflow").value || "";
  if (wid.indexOf("pose") >= 0) {
    var pose = $("pose").value;
    if (pose) vars.pose = pose;
  }
  // 参考图模板：image 写进 LoadImage，cnStrength 决定「多听参考图的」
  if (wid.indexOf("ref") >= 0) {
    if (state.refName) vars.image = state.refName;
    var refStrength = Number($("cnstrength").value);
    if (Number.isFinite(refStrength)) vars.cnStrength = refStrength;
  } else if (wid.indexOf("pose") >= 0 && wid.indexOf("posetags") < 0) {
    var strength = Number($("cnstrength").value);
    if (Number.isFinite(strength)) vars.cnStrength = strength;
  }
  return vars;
}
function forgeToggleCfg() {
  return {
    repair: $("fg-repair").checked,
    postprocess: $("fg-postprocess").checked,
    poseHints: $("fg-posehints").checked,
    candidates: $("fg-candidates").checked
  };
}
function llmPatch() {
  var patch = {
    baseUrl: $("llm-baseurl").value.trim(),
    model: $("llm-model").value.trim(),
    provider: $("llm-provider").value.trim()
  };
  var key = $("llm-key").value.trim();
  if (key !== "") patch.apiKey = key;
  return patch;
}
/** 把 /config 归一化后的视图写回表单（key 永远不回显，只回显「已配置 + 尾号」）。 */
function fillSettings(config) {
  var llm = (config && config.llm) || {};
  var comfy = (config && config.comfy) || {};
  $("llm-baseurl").value = llm.baseUrl || "";
  $("llm-model").value = llm.model || "";
  $("llm-provider").value = llm.provider || "";
  $("llm-key").value = "";
  $("llm-key").placeholder = llm.apiKeySet ? "已配置 " + (llm.apiKeyHint || "••••") + "（留空表示不改）" : "没配过就粘进来";
  setStatus("llm-status", llm.apiKeySet ? "当前接口已配置" + (llm.baseUrl ? " · " + llm.baseUrl : "") : "还没配接口 —— 锻造会回 no-llm", false);
  $("comfy-baseurl").value = comfy.baseUrl || "";
  $("comfy-dir").value = comfy.launchDir || "";
  $("comfy-python").value = comfy.pythonPath || "";
  $("comfy-workflows").value = comfy.workflowDir || "";
  $("comfy-default").value = comfy.defaultWorkflowId || "";
  setStatus("comfy-status", "ComfyUI " + (comfy.baseUrl || "（默认 127.0.0.1:8188）"), false);
}
