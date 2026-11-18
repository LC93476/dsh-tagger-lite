// plan: 面板到 /tagger/api 的唯一通道——BASE 常量 + fetch 封装，只发请求不碰 DOM
/**
 * server/public/api.js — 面板的 HTTP 层。
 *
 * 一个 BASE、一个 api()，坏响应统一折成 { ok:false, message }，让上层永远拿到结构化的东西。
 * 以普通 script 加载（不是 module），后面的 state.js / app.js 直接用这里的全局函数。
 */
var BASE = "/tagger/api";
async function api(path, init) {
  var options = Object.assign({ headers: { "content-type": "application/json" } }, init || {});
  var res = await fetch(BASE + path, options);
  var data = {};
  try { data = await res.json() } catch (e) { data = { ok: false, message: "响应不是 JSON（HTTP " + res.status + "）" } }
  return { status: res.status, data: data };
}
/** 姿势缩略图走接口代理（浏览器直接读不了 ComfyUI 的目录）。 */
function poseThumbUrl(id) { return BASE + "/pose-thumb?id=" + encodeURIComponent(id) }
