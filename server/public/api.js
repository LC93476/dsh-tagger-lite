// plan: 面板到 /tagger/api 的唯一通道——BASE 常量 + fetch 封装，只发请求不碰 DOM
/**
 * server/public/api.js — 面板的 HTTP 层。
 *
 * 一个 BASE、一个 api()。请求永远不外抛：断网 / 超时 / DNS 失败都折成
 * { status: 0, data: { ok:false, error:"network", message } }，上层只管看 status 与 data。
 * 头是合并而不是覆盖：默认只在有 body 的方法上带 content-type，GET / HEAD 不带。
 * 以普通 script 加载（不是 module），后面的 i18n.js / state.js / app.js 直接用这里的全局。
 * 坏响应的文案走 T('ui.error.response')（i18n.js 在本文件之后加载，调用发生在运行时，所以拿得到）。
 */
var BASE = "/tagger/api";
/** 头名大小写不敏感：调用方写了 Content-Type 也算「已指定」。 */
function hasHeader(headers, name) {
  var want = String(name).toLowerCase();
  return Object.keys(headers || {}).some(function (k) { return String(k).toLowerCase() === want });
}
async function api(path, init) {
  var options = init || {};
  var method = String(options.method || "GET").toUpperCase();
  var headers = Object.assign({}, options.headers || {});
  if (method !== "GET" && method !== "HEAD" && !hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
  var res;
  try {
    res = await fetch(BASE + path, Object.assign({}, options, { method: method, headers: headers }));
  } catch (err) {
    var message = err && err.message ? String(err.message) : String(err);
    return { status: 0, data: { ok: false, error: "network", message: message } };
  }
  var data = {};
  try { data = await res.json() } catch (e) { data = { ok: false, message: typeof T === "function" ? T("ui.error.response", { status: res.status }) : String(res.status) } }
  return { status: res.status, data: data };
}
/** 姿势缩略图走接口代理（浏览器直接读不了 ComfyUI 的目录）。 */
function poseThumbUrl(id) { return BASE + "/pose-thumb?id=" + encodeURIComponent(id) }
