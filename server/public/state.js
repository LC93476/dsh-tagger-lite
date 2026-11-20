// plan: 面板的客户端状态与表单读写——state 只在这里改，读写 DOM 表单也集中在这里
/**
 * server/public/state.js — 状态与表单。
 *
 * 约定：state 里只放「跨渲染要用」的东西；表单值永远现读（readVars / llmPatch），
 * 免得用户在输入框里改完、内存里还是旧值。
 *
 * 表单的「默认值」只有一个来源：panel.html 上各 input 自带的 value / data-* 属性。
 * 这里一律读 defaultValue（用户清空输入框时也回落到它），绝不在 JS 里再抄一份 1200/1800/30，
 * 否则两边迟早对不上。真正需要跟服务端配置对齐的字段（最多标签数、精修模式）由 applyUiDefaults
 * 从 /state 的 config 回填。
 *
 * 界面文案一律走 i18n.js 的 T('ui.…')，这里不写死中文。
 */
/**
 * 出图变量的兜底值 —— 全前端唯一一张常量表（别的文件不许再抄一份 1200/1800/30）。
 * 取用顺序永远是：输入框的 value → 输入框的 defaultValue（HTML 上写的）→ 这张表。
 *
 * DEFAULTS-SOURCE: lib/config.js DEFAULTS —— 那里已有的键（tags.maxTags / refine.mode /
 * purge.level / comfy.baseUrl / forge.*）不许在这里另立一份，一律由 /state 的 config 回填；
 * 这张表只放 configView 里没有、又必须有兜底的出图变量。
 */
var DEFAULT_VARS = { width: 1200, height: 1800, seed: 20261108, steps: 30, cfg: 5.03 };
var state = {
  result: null, workflows: [], timer: null, refName: "",
  poses: [], poseIndex: {}, poseSet: "", poseQuery: "", lastWid: "",
  // 出图轮询令牌：每次新任务/新一次轮询递增，回来的旧响应靠它丢弃。
  pollSeq: 0, pollFails: 0,
  // 顶栏两盏灯最近一次的状态，切语言时据此重画（不去重新探测服务）。
  llmPill: { ready: false, model: "" }, comfyPill: { ok: false, version: "" }
};
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
/** 读一个表单字段的字符串值：空输入回落到 HTML 里写的 defaultValue。 */
function fieldValue(id) {
  var el = $(id);
  if (!el) return "";
  var raw = typeof el.value === "string" ? el.value : "";
  if (raw.trim() === "") {
    var def = el.defaultValue;
    raw = typeof def === "string" ? def : "";
  }
  if (raw.trim() === "" && Object.prototype.hasOwnProperty.call(DEFAULT_VARS, id)) {
    raw = String(DEFAULT_VARS[id]);
  }
  return raw.trim();
}
/** 同 fieldValue，转成数字；转不出来给 null（调用方据此决定「不塞这个变量」）。 */
function fieldNum(id) {
  var raw = fieldValue(id);
  if (raw === "") return null;
  var n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function readVars() {
  var vars = {};
  ["width", "height", "seed", "steps", "cfg"].forEach(function (id) {
    var n = fieldNum(id);
    if (n !== null) vars[id] = n;
  });
  // 模板声明了哪些变量才塞哪些：塞了模板没有的会被服务端丢掉并留 warning。
  var caps = workflowCaps($("workflow").value || "");
  if (caps.pose) {
    var pose = $("pose").value;
    if (pose) vars.pose = pose;
  }
  // 参考图模板：image 写进 LoadImage
  if (caps.image && state.refName) vars.image = state.refName;
  // cnStrength 决定「多听参考图的 / 多听骨架的」
  if (caps.cnStrength) {
    var strength = fieldNum("cnstrength");
    if (strength !== null) vars.cnStrength = strength;
  }
  return vars;
}
/** 投给 ComfyUI 的正向串：优先用户手改过的 #positive，空则回退标签拼出来的那份。 */
function effectivePositive() {
  var el = $("positive");
  var manual = el && typeof el.value === "string" ? el.value.trim() : "";
  return manual !== "" ? manual : positiveText();
}
/** 模板能力：优先看模板自己声明的 vars，没声明才回退到 id 子串（老模板 / 列表还没到时）。 */
function workflowCaps(wid) {
  var id = String(wid || "");
  var wf = null;
  (state.workflows || []).forEach(function (w) { if (w && w.id === id) wf = w });
  var vars = wf && Array.isArray(wf.vars) ? wf.vars : [];
  if (vars.length) {
    function has(name) { return vars.some(function (v) { return v && v.name === name }) }
    return { image: has("image"), pose: has("pose"), cnStrength: has("cnStrength"), declared: true };
  }
  var isRef = id.indexOf("ref") >= 0;
  var isPose = id.indexOf("pose") >= 0;
  return { image: isRef, pose: isPose, cnStrength: isRef || (isPose && id.indexOf("posetags") < 0), declared: false };
}
/** 锻造要的「最多标签数」：没填就交给服务端默认（tags.maxTags）。 */
function readMaxTags() {
  var n = fieldNum("maxTags");
  if (n === null) return null;
  return Math.round(n);
}
/**
 * CN 强度的两档：base 永远取面板 HTML 上写的 defaultValue（不是用户当前值），
 * boost 取 data-boost。这样参考图模板切回普通模板时能回到骨架默认强度。
 */
function cnStrengthPair() {
  var el = $("cnstrength");
  var rawBase = el && typeof el.defaultValue === "string" ? el.defaultValue.trim() : "";
  var base = rawBase === "" ? 0 : Number(rawBase);
  if (!Number.isFinite(base)) base = 0;
  var raw = el && el.dataset ? el.dataset.boost : "";
  var boost = raw === "" || raw === undefined ? base : Number(raw);
  if (!Number.isFinite(boost)) boost = base;
  return { base: base, boost: boost };
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
/** 配置里有、但 HTML 里也有默认值的字段：以配置为准回填（不塞进 JS 常量）。 */
function applyUiDefaults(config) {
  if (!config) return;
  var tags = config.tags || {};
  if (typeof tags.maxTags === "number" && Number.isFinite(tags.maxTags) && $("maxTags")) {
    $("maxTags").value = String(tags.maxTags);
  }
  var refine = config.refine || {};
  var mode = typeof refine.mode === "string" ? refine.mode : "";
  var sel = $("refine-mode");
  if (mode !== "" && sel) {
    var known = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === mode) known = true;
    if (known) sel.value = mode;
  }
}
/** 把 /config 归一化后的视图写回表单（key 永远不回显，只回显「已配置 + 尾号」）。 */
function fillSettings(config) {
  var llm = (config && config.llm) || {};
  var comfy = (config && config.comfy) || {};
  $("llm-baseurl").value = llm.baseUrl || "";
  $("llm-model").value = llm.model || "";
  $("llm-provider").value = llm.provider || "";
  $("llm-key").value = "";
  $("llm-key").placeholder = llm.apiKeySet
    ? T("ui.llm.keySetPlaceholder", { hint: llm.apiKeyHint || "••••" })
    : T("ui.llm.keyEmptyPlaceholder");
  setStatus("llm-status", llm.apiKeySet
    ? (llm.baseUrl ? T("ui.llm.statusReady", { baseUrl: llm.baseUrl }) : T("ui.llm.statusReadyNoUrl"))
    : T("ui.llm.statusMissing"), false);
  $("comfy-baseurl").value = comfy.baseUrl || "";
  $("comfy-dir").value = comfy.launchDir || "";
  $("comfy-python").value = comfy.pythonPath || "";
  $("comfy-workflows").value = comfy.workflowDir || "";
  $("comfy-default").value = comfy.defaultWorkflowId || "";
  setStatus("comfy-status", T("ui.comfy.statusLine", { url: comfy.baseUrl || T("ui.comfy.defaultBase") }), false);
  applyUiDefaults(config);
}
