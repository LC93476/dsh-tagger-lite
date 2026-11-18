// plan: 面板的渲染与事件——所有 DOM 更新、请求编排、点击绑定都在这里收口
/**
 * server/public/app.js — 铸炉台的「控制层」。
 *
 * 依赖顺序（panel.html 里按这个顺序加载）：api.js（BASE / api）→ state.js（state / 表单读写）→ app.js。
 * 这里只管渲染和事件：不直接拼 URL（走 api()），不缓存表单值（走 readVars / llmPatch）。
 */
function setPill(id, kind, text) {
  var pill = $(id);
  if (!pill) return;
  pill.dataset.state = kind;
  // id 是 "llm-pill" 而文案节点叫 "llm-text"，两种写法都容错，别让一个 null 把 boot 打死。
  var label = $(id + "-text") || $(id.replace(/-pill$/, "") + "-text");
  if (label) label.textContent = text;
}
function setLamp(purge) {
  var lamp = $("lamp");
  var level = purge && typeof purge.level === "string" ? purge.level : "full";
  lamp.dataset.level = level;
  lamp.dataset.enabled = purge && purge.enabled === false ? "off" : "on";
  var modules = purge && Array.isArray(purge.modules) ? purge.modules.length : 0;
  $("lamp-text").textContent = level + (modules ? " · " + modules + " 模块" : "");
  if ($("level").value !== level) $("level").value = level;
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
async function loadPoses() {
  var sel = $("pose");
  var res = await api("/poses");
  var d = res.data || {};
  var poses = d.poses || [];
  state.poses = poses;
  state.poseIndex = {};
  poses.forEach(function (p) { state.poseIndex[p.id] = p });
  renderPoseSets();
  if (!poses.length) {
    sel.innerHTML = "<option value=\"\">（没读到姿势库，检查 ComfyUI 目录下的 ai-pose-gallery-zh）</option>";
    return;
  }
  sel.innerHTML = "";
  var groups = {};
  poses.forEach(function (p) {
    var key = p.set || "pose";
    if (!groups[key]) {
      var og = document.createElement("optgroup");
      og.label = key;
      groups[key] = og;
      sel.appendChild(og);
    }
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = (p.name || p.id) + " · " + (p.angle || "") + "（" + p.id + "）";
    groups[key].appendChild(o);
  });
  var want = "full_sexy_P016_diag";
  var exists = poses.some(function (p) { return p.id === want });
  sel.value = exists ? want : poses[0].id;
  syncPoseBtn();
  renderPoseGrid();
}
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
async function bootInner() {
  var health = await api("/health");
  var h = health.data || {};
  if (h.llmReady === true) setPill("llm-pill", "ok", "llm " + ((h.llm && h.llm.model) || "就绪"));
  else setPill("llm-pill", "warn", "llm 未配置（锻造会回 no-llm）");
  var st = await api("/state");
  var s = st.data || {};
  setLamp(s.purge);
  var comfy = s.comfy || {};
  if (comfy.ok === true) setPill("comfy-pill", "ok", "ComfyUI " + (comfy.version || "在线"));
  else setPill("comfy-pill", "err", "ComfyUI 没连上");
  fillWorkflows(s.workflows, s.config && s.config.comfy ? s.config.comfy.defaultWorkflowId : "");
  await loadPoses();
  var forgeCfg = (s.config && s.config.forge) || {};
  $("fg-repair").checked = forgeCfg.repair !== false;
  $("fg-postprocess").checked = forgeCfg.postprocess !== false;
  $("fg-posehints").checked = forgeCfg.poseHints !== false;
  $("fg-candidates").checked = forgeCfg.candidates !== false;
  if (Array.isArray(s.history) && s.history.length > 0) {
    var last = s.history[0];
    $("gen-status").textContent = "历史里最近一条：seed " + (last.seed || "?") + " · " + (last.workflowId || "");
  }
  fillSettings(s.config);
  syncRefRow();
  loadUi();
}
function syncRefRow() {
  var wid = $("workflow").value || "";
  var isRef = wid.indexOf("ref") >= 0;
  // 这一栏常显：选到不用参考图的模板时置灰并写一句话，省得用户以为没做出来
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
  // 参考图要从真图提深度、细节比白模少，默认给高一点；换回姿势库时再降回来
  var cn = $("cnstrength");
  if (cn && state.lastWid !== wid) {
    if (isRef && cn.value === "0.38") cn.value = "0.45";
    if (!isRef && cn.value === "0.45") cn.value = "0.38";
  }
  state.lastWid = wid;
}
function fmtSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
async function pickRef(file) {
  if (!file) return;
  var status = $("ref-status");
  status.className = "hint";
  status.textContent = "上传中…（" + fmtSize(file.size) + "）";
  var dataUrl = await new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || "")) };
    reader.onerror = function () { reject(new Error("读不出这个文件")) };
    reader.readAsDataURL(file);
  });
  var res = await api("/upload", { method: "POST", body: JSON.stringify({ filename: file.name, data: dataUrl }) });
  var d = res.data || {};
  if (d.ok !== true) {
    state.refName = "";
    status.className = "hint err";
    status.textContent = "上传失败：" + errText(d, res.status);
    return;
  }
  state.refName = d.name;
  var preview = $("ref-preview");
  preview.src = dataUrl;
  preview.style.display = "";
  status.className = "hint";
  status.textContent = "已上传 · " + d.name + " · " + fmtSize(d.bytes || 0) + "（出图时自动带上）";
  $("gen-status").className = "hint";
  $("gen-status").textContent = "参考图就位，点「出图」";
}
function currentPose() { return state.poseIndex[$("pose").value] || null }
function syncPoseBtn() {
  var p = currentPose();
  var img = $("pose-thumb");
  if (!p) {
    img.hidden = true;
    $("pose-name").textContent = "还没有选姿势";
    $("pose-meta").textContent = "点这里按缩略图挑";
    return;
  }
  img.hidden = false;
  img.src = poseThumbUrl(p.id);
  $("pose-name").textContent = (p.name || p.id) + (p.angle ? " · " + p.angle : "");
  $("pose-meta").textContent = p.id + (p.category ? " · " + p.category : "") + " · 点这里换一张";
}
function renderPoseSets() {
  var box = $("pose-sets");
  box.innerHTML = "";
  var counts = {};
  state.poses.forEach(function (p) { var k = p.set || "pose"; counts[k] = (counts[k] || 0) + 1 });
  var items = [{ key: "", label: "全部", n: state.poses.length }];
  Object.keys(counts).sort().forEach(function (k) { items.push({ key: k, label: k, n: counts[k] }) });
  items.forEach(function (s) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = s.label + " " + s.n;
    if ((state.poseSet || "") === s.key) b.className = "on";
    b.addEventListener("click", function () {
      state.poseSet = s.key;
      renderPoseSets();
      renderPoseGrid();
    });
    box.appendChild(b);
  });
}
function filterPoses() {
  var q = (state.poseQuery || "").toLowerCase();
  return state.poses.filter(function (p) {
    if (state.poseSet && p.set !== state.poseSet) return false;
    if (q === "") return true;
    return String(p.name || "").toLowerCase().indexOf(q) >= 0
      || String(p.id || "").toLowerCase().indexOf(q) >= 0
      || String(p.category || "").toLowerCase().indexOf(q) >= 0
      || String(p.code || "").toLowerCase().indexOf(q) >= 0;
  });
}
function renderPoseGrid() {
  var grid = $("pose-grid");
  if (!grid) return;
  var list = filterPoses();
  var shown = list.slice(0, 240);
  var cur = $("pose").value;
  grid.innerHTML = "";
  shown.forEach(function (p) {
    var fig = document.createElement("figure");
    if (p.id === cur) fig.className = "on";
    var img = document.createElement("img");
    img.loading = "lazy";
    img.src = poseThumbUrl(p.id);
    img.alt = p.name || p.id;
    var cap = document.createElement("figcaption");
    cap.textContent = p.name || p.id;
    var em = document.createElement("em");
    em.textContent = [p.code, p.angle, p.id].filter(function (x) { return x }).join(" · ");
    cap.appendChild(em);
    fig.appendChild(img);
    fig.appendChild(cap);
    fig.addEventListener("click", function () { selectPose(p.id) });
    grid.appendChild(fig);
  });
  var tail = list.length > shown.length ? "，先显示前 " + shown.length + " 条 —— 缩小搜索或换体系" : "";
  $("pose-count").textContent = "匹配 " + list.length + " 条" + tail;
}
function selectPose(id) {
  $("pose").value = id;
  syncPoseBtn();
  $("pose-modal").hidden = true;
}
function openPoseModal() {
  var wid = $("workflow").value || "";
  if (wid.indexOf("pose") < 0) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "当前工作流不吃姿势变量：选 feiyue-sam3-pose 那类模板才有用。";
    return;
  }
  if (!state.poses.length) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "姿势库还没读到（检查 ComfyUI 目录下的 ai-pose-gallery-zh）。";
    return;
  }
  $("pose-modal").hidden = false;
  renderPoseGrid();
  setTimeout(function () { $("pose-q").focus() }, 30);
}

async function doForge() {
  var text = $("text").value.trim();
  if (text === "") { $("forge-status").className = "hint err"; $("forge-status").textContent = "先写几句白话"; return }
  var btn = $("forge");
  btn.disabled = true;
  $("forge-status").className = "hint";
  $("forge-status").textContent = "锻造中…（十几秒）";
  var started = Date.now();
  var res = await api("/forge", { method: "POST", body: JSON.stringify({ text: text, options: { maxTags: Number($("maxTags").value) || 40 } }) });
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
async function pollJob(promptId) {
  if (state.timer) clearTimeout(state.timer);
  var res = await api("/job?id=" + encodeURIComponent(promptId));
  var d = res.data || {};
  if (d.state === "done" || d.state === "success" || (d.images || []).length > 0) {
    $("gen-status").textContent = "出图完成 · " + (d.images || []).length + " 张";
    var box = $("images");
    box.innerHTML = "";
    (d.images || []).forEach(function (img) {
      var fig = document.createElement("figure");
      var el = document.createElement("img");
      el.loading = "lazy";
      el.src = BASE + "/image?filename=" + encodeURIComponent(img.filename) + "&subfolder=" + encodeURIComponent(img.subfolder || "") + "&type=" + encodeURIComponent(img.type || "output");
      var cap = document.createElement("figcaption");
      cap.textContent = img.filename;
      fig.appendChild(el);
      fig.appendChild(cap);
      box.appendChild(fig);
    });
    return;
  }
  if (d.state === "failed" || d.state === "error") {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = "失败：" + (errText(d, res.status) + " · " + (d.state || "")).replace(/ · $/, "");
    return;
  }
  $("gen-status").textContent = "排队中 / 采样中…（" + (d.state || "?") + (d.queuePosition ? " · 队列第 " + d.queuePosition : "") + "）";
  state.timer = setTimeout(function () { pollJob(promptId) }, 3000);
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
async function saveForgeToggle() {
  var res = await api("/config", { method: "POST", body: JSON.stringify({ patch: { forge: forgeToggleCfg() } }) });
  var ok = res.data && res.data.ok !== false;
  $("forge-status").className = ok ? "hint" : "hint err";
  $("forge-status").textContent = ok ? "本地处理开关已保存（立刻生效）" : "开关没保存成功";
}
function refreshLlmPill(ready, model) {
  if (ready === true) setPill("llm-pill", "ok", "llm " + (model || "就绪"));
  else setPill("llm-pill", "warn", "llm 未配置（锻造会回 no-llm）");
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
// 桌面版是全屏工具，关掉浏览器再回来还要接着用：把出图参数和工作流记在 localStorage（无痕模式会抛，忽略即可）
var LS_KEY = "dsh-tagger:panel.v1";
var UI_FIELDS = ["width", "height", "seed", "steps", "cfg", "maxTags", "cnstrength", "refine-mode"];
function saveUi() {
  try {
    var box = { workflow: $("workflow").value || "" };
    UI_FIELDS.forEach(function (id) { if ($(id)) box[id] = $(id).value });
    localStorage.setItem(LS_KEY, JSON.stringify(box));
  } catch (e) { /* 无痕/禁用存储：不影响功能 */ }
}
function loadUi() {
  var raw = null;
  try { raw = localStorage.getItem(LS_KEY) } catch (e) { return }
  if (!raw) return;
  var box = null;
  try { box = JSON.parse(raw) } catch (e) { return }
  if (!box || typeof box !== "object") return;
  UI_FIELDS.forEach(function (id) {
    if ($(id) && typeof box[id] === "string" && box[id] !== "") $(id).value = box[id];
  });
  var wid = typeof box.workflow === "string" ? box.workflow : "";
  var known = state.workflows.some(function (w) { return w.id === wid });
  if (wid !== "" && known) $("workflow").value = wid;
  syncRefRow();
}function bind(id, fn) { $(id).addEventListener("click", fn) }
["fg-repair", "fg-postprocess", "fg-posehints", "fg-candidates"].forEach(function (id) {
  $(id).addEventListener("change", saveForgeToggle);
});
$("forge").addEventListener("click", doForge);
$("refine").addEventListener("click", doRefine);
$("run").addEventListener("click", doRun);
$("workflow").addEventListener("change", syncRefRow);
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
$("copy-pair").addEventListener("click", function () { navigator.clipboard.writeText($("pairs").value); $("copy-pair").textContent = "已复制"; setTimeout(function () { $("copy-pair").textContent = "复制" }, 1200) });
$("copy-pos").addEventListener("click", function () { navigator.clipboard.writeText($("positive").value); $("copy-pos").textContent = "已复制"; setTimeout(function () { $("copy-pos").textContent = "复制" }, 1200) });
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
