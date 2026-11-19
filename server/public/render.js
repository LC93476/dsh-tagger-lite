// plan: 顶栏状态灯 / 结果卡 / 错误码表——只渲染，不发请求，文案全走 T()
/**
 * server/public/render.js — 渲染层（纯 DOM 写入，不自己发请求）。
 *
 * 依赖顺序（panel.html 里）：api.js → i18n.js → state.js → render.js → settings.js → history.js → app.js。
 * 这里能被 app.js / settings.js / history.js 调用，反过来不成立：谁要数据谁传进来。
 * 界面文案一律 T('ui.…') / T('err.…')，本文件不写死中文。
 */
function setPill(id, kind, text) {
  var pill = $(id);
  if (!pill) return;
  pill.dataset.state = kind;
  // id 是 "llm-pill" 而文案节点叫 "llm-text"，两种写法都容错，别让一个 null 把 boot 打死。
  var label = $(id + "-text") || $(id.replace(/-pill$/, "") + "-text");
  if (label) label.textContent = text;
}
/** 破甲灯：档位与开关都只认服务端给的 purge 状态，缺字段就不动 DOM（不猜默认档）。 */
function setLamp(purge) {
  var lamp = $("lamp");
  if (!lamp) return;
  var level = purge && typeof purge.level === "string" ? purge.level : "";
  if (level !== "") {
    lamp.dataset.level = level;
    if ($("level") && $("level").value !== level) $("level").value = level;
  }
  lamp.dataset.enabled = purge && purge.enabled === false ? "off" : "on";
  var modules = purge && Array.isArray(purge.modules) ? purge.modules.length : 0;
  var shown = level !== "" ? level : (lamp.dataset.level || "");
  if ($("lamp-text")) {
    $("lamp-text").textContent = modules ? T("ui.lamp.modules", { level: shown, n: modules }) : shown;
  }
}
function renderResult() {
  var r = state.result;
  $("result-card").hidden = !r;
  $("refine-card").hidden = !r;
  $("gen-card").hidden = false;   // 出图区常显：参考图、姿势库、工作流不依赖是否锻造过
  if (!r) return;
  var tags = r.tags || [];
  var sep = T("ui.common.listSep");
  $("pairs").value = tags.map(pairOf).join("\n");
  $("positive").value = positiveText();
  var chips = $("chips");
  chips.innerHTML = "";
  tags.forEach(function (t, i) {
    var el = document.createElement("span");
    el.className = "chip";
    var b = document.createElement("b"); b.textContent = t.tag;
    el.appendChild(b);
    if (t.cn) { var em = document.createElement("em"); em.textContent = t.cn; el.appendChild(em) }
    var x = document.createElement("span"); x.textContent = "×"; x.title = T("ui.chip.remove");
    x.onclick = function () { tags.splice(i, 1); renderResult() };
    el.appendChild(x);
    chips.appendChild(el);
  });
  var pipe = r.pipeline || {};
  var parts = [];
  if ((pipe.repairs || []).length) parts.push(T("ui.pipeline.repairs", { items: pipe.repairs.map(function (x) { return x.from + "→" + x.to }).join(sep) }));
  if ((pipe.poseHints || []).length) parts.push(T("ui.pipeline.poseHints", { items: pipe.poseHints.map(function (x) { return x.tag }).join(sep) }));
  if ((pipe.changes || []).length) parts.push(T("ui.pipeline.changes", { items: pipe.changes.map(function (x) { return x.tag }).join(sep) }));
  $("pipeline").textContent = parts.length ? T("ui.pipeline.prefix", { parts: parts.join(" · ") }) : "";
  var notes = [];
  if (r.notes) notes.push(r.notes);
  (r.warnings || []).forEach(function (w) { notes.push(T("ui.notes.warning", { text: w })) });
  notes.push(T("ui.notes.summary", {
    n: tags.length,
    ms: r.ms || 0,
    model: r.model || "",
    level: r.purgeLevel || "?"
  }));
  $("notes").className = "hint";
  $("notes").textContent = notes.join("\n");
}
function setStatus(id, text, bad) {
  var el = $(id);
  if (!el) return;
  el.className = bad ? "hint err" : "hint";
  el.textContent = text || "";
}
// 服务端错误码 → 字典键。码表里没有就退回服务端 message，再没有就显示码本身。
var ERR_TEXT = {
  "no-llm": "err.no-llm",
  "no-api-key": "err.no-api-key",
  "no-base-url": "err.no-base-url",
  "llm-error": "err.llm-error",
  "bad-llm": "err.bad-llm",
  "http-400": "err.http-400",
  "timeout": "err.timeout",
  "bad-json": "err.bad-json",
  "empty-text": "err.empty-text",
  "empty-prompt": "err.empty-prompt",
  "empty-instruction": "err.empty-instruction",
  "empty-positive": "err.empty-positive",
  "empty-output": "err.empty-output",
  "bad-type": "err.bad-type",
  "empty-file": "err.empty-file",
  "too-large": "err.too-large",
  "no-launch-dir": "err.no-launch-dir",
  "bad-workflow": "err.bad-workflow",
  "bad-schema": "err.bad-schema",
  "no-file": "err.no-file",
  "no-workflow-dir": "err.no-workflow-dir",
  "bad-name": "err.bad-name",
  "exists": "err.exists",
  "write-failed": "err.write-failed",
  "workflow-not-found": "err.workflow-not-found",
  "no-workflow": "err.no-workflow",
  "no-prompt-node": "err.no-prompt-node",
  "no-prompt-id": "err.no-prompt-id",
  "unreachable": "err.unreachable",
  "launch-failed": "err.launch-failed",
  "ui-format": "err.ui-format",
  "pose-image": "err.pose-image",
  "max-tokens": "err.max-tokens",
  "method-not-allowed": "err.method-not-allowed",
  "internal": "err.internal"
};
/** 把 {error, message} 折成一句人话：认得的码查字典，后面再接上服务端原文。 */
function errText(data, status) {
  var d = data || {};
  var code = String(d.error || "");
  var key = ERR_TEXT[code] || "";
  var human = key ? T(key) : "";
  var detail = String(d.message || "").trim();
  var parts = [];
  if (human) parts.push(human);
  else if (detail) parts.push(detail);
  else if (code) parts.push(T("ui.error.code", { code: code }));
  if (human && detail && detail !== human) parts.push(detail);
  var text = parts.join(" · ") || T("ui.error.generic");
  if (status && status >= 400 && text.indexOf("HTTP") < 0) text += T("ui.error.http", { status: status });
  return text;
}
