// plan: 顶栏状态灯 / 结果卡 / 错误码中文表——只渲染，不发请求
/**
 * server/public/render.js — 渲染层（纯 DOM 写入，不自己发请求）。
 *
 * 依赖顺序（panel.html 里）：api.js → state.js → render.js → settings.js → history.js → app.js。
 * 这里能被 app.js / settings.js / history.js 调用，反过来不成立：谁要数据谁传进来。
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
  if ($("lamp-text")) $("lamp-text").textContent = shown + (modules ? " · " + modules + " 模块" : "");
}
function renderResult() {
  var r = state.result;
  $("result-card").hidden = !r;
  $("refine-card").hidden = !r;
  $("gen-card").hidden = false;   // 出图区常显：参考图、姿势库、工作流不依赖是否锻造过
  if (!r) return;
  var tags = r.tags || [];
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
    var x = document.createElement("span"); x.textContent = "×"; x.title = "删掉这条";
    x.onclick = function () { tags.splice(i, 1); renderResult() };
    el.appendChild(x);
    chips.appendChild(el);
  });
  var pipe = r.pipeline || {};
  var parts = [];
  if ((pipe.repairs || []).length) parts.push("修正 " + pipe.repairs.map(function (x) { return x.from + "→" + x.to }).join("、"));
  if ((pipe.poseHints || []).length) parts.push("补词 " + pipe.poseHints.map(function (x) { return x.tag }).join("、"));
  if ((pipe.changes || []).length) parts.push("整理 " + pipe.changes.map(function (x) { return x.tag }).join("、"));
  $("pipeline").textContent = parts.length ? "本地处理 · " + parts.join(" · ") : "";
  var notes = [];
  if (r.notes) notes.push(r.notes);
  (r.warnings || []).forEach(function (w) { notes.push("· " + w) });
  notes.push("标签 " + tags.length + " 条 · " + (r.ms || 0) + " ms · " + (r.model || "") + " · 破甲 " + (r.purgeLevel || "?"));
  $("notes").className = "hint";
  $("notes").textContent = notes.join("\n");
}
function setStatus(id, text, bad) {
  var el = $(id);
  if (!el) return;
  el.className = bad ? "hint err" : "hint";
  el.textContent = text || "";
}
// 服务端错误码 → 人话。码表里没有就退回服务端 message，再没有就显示码本身。
var ERR_TEXT = {
  "no-llm": "没配置模型接口：设置里填 Base URL + API Key（独立服务也可以用 DSH_TAGGER_* 环境变量）",
  "no-api-key": "缺 API Key：设置 → 接口密钥",
  "no-base-url": "缺接口地址：设置 → Base URL（比如 https://api.deepseek.com）",
  "llm-error": "模型接口报错",
  "bad-llm": "模型接口返回的形状不对",
  "http-400": "模型接口返回 400：多半是模型名或参数不对",
  "timeout": "等超时了：接口太慢或网络断了，可以调大超时再试",
  "bad-json": "模型回的不是合法 JSON（偶发，重试一次通常就好）",
  "empty-text": "还没写白话",
  "empty-prompt": "正向串是空的：先锻造，或手动写几条 tag",
  "empty-instruction": "还没说要改什么",
  "empty-positive": "没有可改的正向串：先锻造",
  "empty-output": "模型这次什么都没给，重试一次",
  "bad-type": "只收 png / jpg / webp 图片",
  "empty-file": "这个文件是空的（0 字节）",
  "too-large": "图片超过 24MB，压一下再传",
  "no-launch-dir": "先在设置里填 ComfyUI 的安装目录（launchDir），否则服务端不知道往哪写图",
  "bad-workflow": "工作流模板格式不对（UI 格式要先过 tools/ui2api.mjs 转成 API 格式）",
  "workflow-not-found": "没有这个工作流模板，检查模板目录",
  "no-workflow": "模板目录里没有可用工作流",
  "no-prompt-node": "没找到能写提示词的节点：模板里的 CLIPTextEncode 认不出来",
  "no-prompt-id": "ComfyUI 没返回 promptId（提交被拒，看 ComfyUI 控制台）",
  "unreachable": "连不上 ComfyUI：先点「启动 ComfyUI」，或确认 8188 端口",
  "launch-failed": "拉起 ComfyUI 失败，看服务端日志里的命令与报错",
  "ui-format": "这个模板是 UI 格式，得先转成 API 格式",
  "pose-image": "没有这张姿势图",
  "max-tokens": "模型输出被截断了（服务端已自动翻倍重试，还不行就把上限调高）",
  "method-not-allowed": "这个接口不接受这种请求方法",
  "internal": "服务端内部错误，看服务端控制台"
};
/** 把 {error, message} 折成一句中文：认得的码给人话，后面再接上服务端原文。 */
function errText(data, status) {
  var d = data || {};
  var code = String(d.error || "");
  var human = ERR_TEXT[code] || "";
  var detail = String(d.message || "").trim();
  var parts = [];
  if (human) parts.push(human);
  else if (detail) parts.push(detail);
  else if (code) parts.push("出错（" + code + "）");
  if (human && detail && detail !== human) parts.push(detail);
  var text = parts.join(" · ") || "出错";
  if (status && status >= 400 && text.indexOf("HTTP") < 0) text += "（HTTP " + status + "）";
  return text;
}
