// plan: 历史与预览交互：出图轮询与图片预览、参考图上传、姿势缩略图挑图、参数记忆
/**
 * server/public/history.js — 历史与预览。
 *
 * 三件事：① 出图轮询与结果图片；② 参考图上传与预览；③ 姿势缩略图弹窗；
 * 外加「关掉浏览器再回来还在」的参数记忆（localStorage）。
 * 界面文案一律 T('ui.…')，本文件不写死中文。
 */
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
  status.textContent = T("ui.ref.uploading", { size: fmtSize(file.size) });
  var dataUrl = await new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || "")) };
    reader.onerror = function () { reject(new Error(T("ui.ref.readFailed"))) };
    reader.readAsDataURL(file);
  });
  var res = await api("/upload", { method: "POST", body: JSON.stringify({ filename: file.name, data: dataUrl }) });
  var d = res.data || {};
  if (d.ok !== true) {
    state.refName = "";
    status.className = "hint err";
    status.textContent = T("ui.ref.uploadFailed", { text: errText(d, res.status) });
    return;
  }
  state.refName = d.name;
  var preview = $("ref-preview");
  preview.src = dataUrl;
  preview.style.display = "";
  status.className = "hint";
  status.textContent = T("ui.ref.uploaded", { name: d.name, size: fmtSize(d.bytes || 0) });
  $("gen-status").className = "hint";
  $("gen-status").textContent = T("ui.ref.ready");
}
/* ── 姿势库：下拉（隐藏）+ 缩略图卡片 + 弹窗 ─────────────────────────── */
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
    sel.innerHTML = "";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = T("ui.pose.noneOption");
    sel.appendChild(none);
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
function currentPose() { return state.poseIndex[$("pose").value] || null }
function syncPoseBtn() {
  var p = currentPose();
  var img = $("pose-thumb");
  if (!p) {
    img.hidden = true;
    $("pose-name").textContent = T("ui.pose.none");
    $("pose-meta").textContent = T("ui.pose.pickHint");
    return;
  }
  img.hidden = false;
  img.src = poseThumbUrl(p.id);
  $("pose-name").textContent = (p.name || p.id) + (p.angle ? " · " + p.angle : "");
  $("pose-meta").textContent = p.id + (p.category ? " · " + p.category : "") + T("ui.pose.changeHint");
}
function renderPoseSets() {
  var box = $("pose-sets");
  box.innerHTML = "";
  var counts = {};
  state.poses.forEach(function (p) { var k = p.set || "pose"; counts[k] = (counts[k] || 0) + 1 });
  var items = [{ key: "", label: T("ui.pose.all"), n: state.poses.length }];
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
  var tail = list.length > shown.length ? T("ui.pose.truncated", { n: shown.length }) : "";
  $("pose-count").textContent = T("ui.pose.count", { n: list.length }) + tail;
}
function selectPose(id) {
  $("pose").value = id;
  syncPoseBtn();
  $("pose-modal").hidden = true;
  saveUi();
}
function openPoseModal() {
  if (!workflowCaps($("workflow").value || "").pose) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.pose.notPoseWorkflow");
    return;
  }
  if (!state.poses.length) {
    $("gen-status").className = "hint err";
    $("gen-status").textContent = T("ui.pose.notLoaded");
    return;
  }
  $("pose-modal").hidden = false;
  renderPoseGrid();
  setTimeout(function () { $("pose-q").focus() }, 30);
}
/* ── 出图轮询与图片 ─────────────────────────────────────────────────── */
function renderImages(images) {
  var box = $("images");
  box.innerHTML = "";
  (images || []).forEach(function (img) {
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
}
async function pollJob(promptId) {
  if (state.timer) clearTimeout(state.timer);
  // 每次轮询领一个令牌：新任务会把 state.pollSeq 顶掉，回来的旧响应据此丢弃。
  var seq = ++state.pollSeq;
  var res = await api("/job?id=" + encodeURIComponent(promptId));
  if (seq !== state.pollSeq) return;
  var d = res.data || {};
  var status = $("gen-status");
  // 连续 3 次「HTTP 错误 / 接口说 ok:false」就停，别拿同一个坏请求一直打。
  if (res.status >= 400 || d.ok === false) {
    state.pollFails += 1;
    if (state.pollFails >= 3) {
      status.className = "hint err";
      status.textContent = errText(d, res.status);
      return;
    }
  } else {
    state.pollFails = 0;
  }
  if (d.state === "done" || d.state === "success" || (d.images || []).length > 0) {
    state.pollFails = 0;
    status.textContent = T("ui.run.done", { n: (d.images || []).length });
    renderImages(d.images);
    return;
  }
  if (d.state === "failed" || d.state === "error") {
    state.pollFails = 0;
    status.className = "hint err";
    status.textContent = T("ui.run.failed", { text: (errText(d, res.status) + " · " + (d.state || "")).replace(/ · $/, "") });
    return;
  }
  var queue = d.queuePosition ? T("ui.run.queuePosition", { n: d.queuePosition }) : "";
  status.textContent = T("ui.run.polling", { state: (d.state || "?") + queue });
  state.timer = setTimeout(function () { pollJob(promptId) }, 3000);
}
/* ── 参数记忆：桌面版是全屏工具，关掉浏览器再回来还要接着用 ──────────── */
var LS_KEY = "dsh-tagger:panel.v1";
var UI_FIELDS = ["width", "height", "seed", "steps", "cfg", "maxTags", "cnstrength", "refine-mode"];
function saveUi() {
  try {
    var box = { workflow: $("workflow").value || "" };
    UI_FIELDS.forEach(function (id) { if ($(id)) box[id] = $(id).value });
    // 姿势不在 UI_FIELDS 里（它是下拉 + 弹窗），单独记一份 id。
    if ($("pose")) box.pose = $("pose").value || "";
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
  // 姿势列表可能还没加载 / 换了词库：只有这个 id 现在确实存在才恢复。
  var pose = typeof box.pose === "string" ? box.pose : "";
  if (pose !== "" && state.poseIndex[pose] && $("pose")) {
    $("pose").value = pose;
    syncPoseBtn();
  }
  syncRefRow();
}
