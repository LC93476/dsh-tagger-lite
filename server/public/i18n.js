// server/public/i18n.js — 桌面端界面文案。
//
// 三个约定：
// 1) 所有界面文案都从字典出（T('ui.…') / T('err.…')），JS 里不再写死中文，换语言就是换字典；
// 2) 字典以 GET /locale?lang=zh|en 为准，拿不到就用本文件内置的 zh —— 任何情况下都不许白屏；
// 3) 用户选的语言记住在 localStorage（I18N_KEY），下次打开还是那个语言。
//
// 依赖：api.js 的 api()（panel.html 里 i18n.js 紧跟在 api.js 之后加载）。
var I18N_KEY = "dsh-tagger:locale.v1";
var I18N_LANGS = ["zh", "en"];
var I18N_BUILTIN_ZH = {
  "ui.head.title": "DSh Tagger · 锻造台",
  "ui.head.sub": "白话 → WD + Camie 标签 → 二次精修 → 直接出图。负向与画质词由 ComfyUI 工作流内置。",
  "ui.head.lamp": "破甲",
  "ui.head.level": "破甲档",
  "ui.lang.label": "语言",
  "ui.common.copy": "复制",
  "ui.common.copied": "已复制",
  "ui.common.close": "关闭",
  "ui.common.online": "在线",
  "ui.common.ready": "就绪",
  "ui.common.saving": "保存中…",
  "ui.common.saveFailed": "保存失败：{text}",
  "ui.common.listSep": "、",
  "ui.common.doneSecs": "完成 · {s} s",
  "ui.common.doneMs": "完成 · {ms} ms",
  "ui.settings.summary": "接口设置（模型 API 与 ComfyUI 连接）",
  "ui.settings.hint": "填完点保存写进 settings.json，立刻生效，不用重启。DSH 面板里不用填这些 —— 那边走宿主的模型服务。",
  "ui.settings.baseUrl": "接口地址（OpenAI 兼容，可带 /v1）",
  "ui.settings.baseUrlPlaceholder": "https://api.openai.com/v1",
  "ui.settings.apiKey": "API Key",
  "ui.settings.apiKeyPlaceholder": "没配过就粘进来；已经配过留空表示不改",
  "ui.settings.model": "模型名",
  "ui.settings.provider": "provider 名",
  "ui.settings.saveLlm": "保存接口",
  "ui.settings.testLlm": "测试连接",
  "ui.settings.comfyBaseUrl": "ComfyUI 地址",
  "ui.settings.launchDir": "安装目录（点「启动 ComfyUI」用的工作目录）",
  "ui.settings.launchDirPlaceholder": "D:\\QUARK\\ComfyUI-aki-v3.2\\ComfyUI",
  "ui.settings.pythonPath": "python 路径",
  "ui.settings.pythonPlaceholder": "D:\\QUARK\\ComfyUI-aki-v3.2\\python\\python.exe",
  "ui.settings.workflowDir": "工作流模板目录",
  "ui.settings.workflowDirPlaceholder": "C:\\Users\\你\\.dsh-comfyui-workbench\\workflows",
  "ui.settings.defaultWorkflow": "默认工作流 id",
  "ui.settings.saveComfy": "保存 ComfyUI",
  "ui.settings.pingComfy": "检测连通",
  "ui.settings.launchComfy": "启动 ComfyUI",
  "ui.forge.title": "白话描述",
  "ui.forge.placeholder": "例：室内夜晚，裸体少女躺在床边回头看镜头，紫瞳黑长发，油亮皮肤，柔和暖光",
  "ui.forge.maxTags": "最多标签",
  "ui.forge.applyLevel": "应用档位",
  "ui.forge.repair": "词形修复",
  "ui.forge.repairTitle": "库里查不到的多词会被改成连字符/撇号写法",
  "ui.forge.postprocess": "去重合序",
  "ui.forge.postprocessTitle": "去重、上位词降权、按 13 段稳定排序",
  "ui.forge.poseHints": "姿势补全",
  "ui.forge.poseHintsTitle": "白话里点到的姿势/视角，直接从本地词库补进来",
  "ui.forge.candidates": "候选注入",
  "ui.forge.candidatesTitle": "锻造前先从词库捞一批真词喂给模型",
  "ui.forge.run": "锻造",
  "ui.forge.emptyText": "先写几句白话",
  "ui.forge.running": "锻造中…（十几秒）",
  "ui.forge.failed": "锻造失败：{text}",
  "ui.forge.toggleSaved": "本地处理开关已保存（立刻生效）",
  "ui.forge.toggleFailed": "开关没保存成功",
  "ui.result.pairs": "中英对照 · 带权重",
  "ui.result.positive": "正向串（投给 ComfyUI 的就是这份）",
  "ui.chip.remove": "删掉这条",
  "ui.pipeline.prefix": "本地处理 · {parts}",
  "ui.pipeline.repairs": "修正 {items}",
  "ui.pipeline.poseHints": "补词 {items}",
  "ui.pipeline.changes": "整理 {items}",
  "ui.notes.warning": "· {text}",
  "ui.notes.summary": "标签 {n} 条 · {ms} ms · {model} · 破甲 {level}",
  "ui.lamp.modules": "{level} · {n} 模块",
  "ui.lamp.loading": "读取中",
  "ui.refine.title": "二次精修（不需要重打白话）",
  "ui.refine.modeAdd": "add · 只加",
  "ui.refine.modeEdit": "edit · 加与删",
  "ui.refine.modePrune": "prune · 只删",
  "ui.refine.modeWeights": "weights · 只调权重",
  "ui.refine.placeholder": "例：加夜景与逆光，胸口再露一点 / 去掉多余的手 / 主体权重提到 1.2",
  "ui.refine.run": "精修",
  "ui.refine.emptyInstruction": "说一句要改什么",
  "ui.refine.running": "精修中…",
  "ui.refine.failedPrefix": "精修失败：{text}",
  "ui.refine.noChange": "没有改动",
  "ui.run.title": "出图",
  "ui.run.refLabel": "参考图（任意照片/线稿，走 DepthAnythingV2 → ControlNet）",
  "ui.run.cnStrength": "CN 强度",
  "ui.run.width": "宽",
  "ui.run.height": "高",
  "ui.run.steps": "步数",
  "ui.run.run": "出图",
  "ui.run.noWorkflow": "先选一个工作流模板",
  "ui.run.noPositive": "还没有正向串：先在上面写几句白话点「锻造」，出图用的是锻造结果。",
  "ui.run.submitting": "提交中…",
  "ui.run.submitFailed": "提交失败：{text}",
  "ui.run.submitted": "已提交 {id} · 开始轮询",
  "ui.run.done": "出图完成 · {n} 张",
  "ui.run.failed": "失败：{text}",
  "ui.run.polling": "排队中 / 采样中…（{state}）",
  "ui.run.queuePosition": " · 队列第 {n}",
  "ui.history.last": "历史里最近一条：seed {seed} · {workflow}",
  "ui.ref.uploading": "上传中…（{size}）",
  "ui.ref.readFailed": "读不出这个文件",
  "ui.ref.uploadFailed": "上传失败：{text}",
  "ui.ref.uploaded": "已上传 · {name} · {size}（出图时自动带上）",
  "ui.ref.ready": "参考图就位，点「出图」",
  "ui.ref.hintPick": "选一张图（png/jpg/webp，≤24MB）：DepthAnythingV2 提深度后由 ControlNet 锁住体态，提示词只负责内容与画风。",
  "ui.ref.hintDisabled": "当前模板不用参考图。要用自己的图锁体态：工作流选下拉里带〔参考图〕的那条（feiyue-sam3-ref）。",
  "ui.ref.badge": "　〔参考图〕",
  "ui.workflow.none": "（没读到工作流模板）",
  "ui.pose.none": "还没有选姿势",
  "ui.pose.pickHint": "点这里按缩略图挑",
  "ui.pose.changeHint": " · 点这里换一张",
  "ui.pose.all": "全部",
  "ui.pose.count": "匹配 {n} 条",
  "ui.pose.truncated": "，先显示前 {n} 条 —— 缩小搜索或换体系",
  "ui.pose.noneOption": "（没读到姿势库，检查 ComfyUI 目录下的 ai-pose-gallery-zh）",
  "ui.pose.notPoseWorkflow": "当前工作流不吃姿势变量：选 feiyue-sam3-pose 那类模板才有用。",
  "ui.pose.notLoaded": "姿势库还没读到（检查 ComfyUI 目录下的 ai-pose-gallery-zh）。",
  "ui.pose.modalTitle": "选姿势 · 缩略图对照",
  "ui.pose.searchPlaceholder": "搜中文名 / 编号 P016 / 分类（坐姿、趴卧、跪立…）",
  "ui.llm.pillLoading": "llm 读取中",
  "ui.comfy.pillLoading": "ComfyUI 读取中",
  "ui.llm.pillOk": "llm {model}",
  "ui.llm.pillMissing": "llm 未配置（锻造会回 no-llm）",
  "ui.llm.keySetPlaceholder": "已配置 {hint}（留空表示不改）",
  "ui.llm.keyEmptyPlaceholder": "没配过就粘进来",
  "ui.llm.statusReady": "当前接口已配置 · {baseUrl}",
  "ui.llm.statusReadyNoUrl": "当前接口已配置",
  "ui.llm.statusMissing": "还没配接口 —— 锻造会回 no-llm",
  "ui.llm.savedReady": "已保存，模型接口就绪（立刻生效）",
  "ui.llm.savedMissing": "已保存，但接口地址或 key 还缺，锻造仍会回 no-llm",
  "ui.llm.testing": "测试中…",
  "ui.llm.probeOk": "连上了",
  "ui.comfy.statusLine": "ComfyUI {url}",
  "ui.comfy.defaultBase": "（默认 127.0.0.1:8188）",
  "ui.comfy.pillOk": "ComfyUI {version}",
  "ui.comfy.pillDown": "ComfyUI 没连上",
  "ui.comfy.saved": "已保存 · ComfyUI {version} · 模板 {n} 套",
  "ui.comfy.savedDown": "已保存，但没连上：{text}",
  "ui.comfy.badAddress": "地址或端口不对？",
  "ui.comfy.checking": "检测中…",
  "ui.comfy.onlineLine": "在线 · {version} · 模板 {n} 套",
  "ui.comfy.downLine": "连不上：{text}",
  "ui.comfy.launchHint": "先确认 ComfyUI 已启动，或点「启动 ComfyUI」",
  "ui.comfy.launching": "拉起中…（最多等 60 秒）",
  "ui.comfy.launched": "已启动 · pid {pid}",
  "ui.comfy.alreadyRunning": "（本来就在跑）",
  "ui.comfy.launchFailed": "启动失败：{text}",
  "ui.wfImport.noFile": "先选一份工作流 JSON（ComfyUI 里「导出（API 格式）」那份）",
  "ui.wfImport.reading": "读取文件…",
  "ui.wfImport.needName": "填一个模板 id（小写字母/数字/连字符，比如 my-sdxl-t2i）",
  "ui.wfImport.importing": "导入中…",
  "ui.wfImport.ok": "已导入 {id} · {title} · {n} 个变量",
  "ui.wfImport.okNoVars": "已导入 {id} · {title}",
  "ui.wfImport.schemaPicked": "附带 schema：{name}",
  "ui.wfImport.failed": "导入失败：{text}",
  "ui.wfImport.reloadFailed": "导入成功，但列表没刷新：{text}（F5 一下）",
  "ui.boot.llmFailed": "读取状态失败：{why}",
  "ui.boot.comfyFailed": "读取状态失败",
  "ui.boot.lampFailed": "读取失败",
  "ui.boot.failed": "前端读取状态出错：{why}（F5 看控制台）",
  "ui.error.code": "出错（{code}）",
  "ui.error.generic": "出错",
  "ui.error.http": "（HTTP {status}）",
  "err.no-llm": "没配置模型接口：设置里填 Base URL + API Key（独立服务也可以用 DSH_TAGGER_* 环境变量）",
  "err.no-api-key": "缺 API Key：设置 → 接口密钥",
  "err.no-base-url": "缺接口地址：设置 → Base URL（比如 https://api.deepseek.com）",
  "err.llm-error": "模型接口报错",
  "err.bad-llm": "模型接口返回的形状不对",
  "err.http-400": "模型接口返回 400：多半是模型名或参数不对",
  "err.timeout": "等超时了：接口太慢或网络断了，可以调大超时再试",
  "err.bad-json": "模型回的不是合法 JSON（偶发，重试一次通常就好）",
  "err.empty-text": "还没写白话",
  "err.empty-prompt": "正向串是空的：先锻造，或手动写几条 tag",
  "err.empty-instruction": "还没说要改什么",
  "err.empty-positive": "没有可改的正向串：先锻造",
  "err.empty-output": "模型这次什么都没给，重试一次",
  "err.bad-type": "只收 png / jpg / webp 图片",
  "err.empty-file": "这个文件是空的（0 字节）",
  "err.too-large": "图片超过 24MB，压一下再传",
  "err.no-launch-dir": "先在设置里填 ComfyUI 的安装目录（launchDir），否则服务端不知道往哪写图",
  "err.bad-workflow": "工作流模板格式不对（UI 格式要先过 scripts/release/ui2api.mjs 转成 API 格式）",
  "err.workflow-not-found": "没有这个工作流模板，检查模板目录",
  "err.no-workflow": "模板目录里没有可用工作流",
  "err.no-prompt-node": "没找到能写提示词的节点：模板里的 CLIPTextEncode 认不出来",
  "err.no-prompt-id": "ComfyUI 没返回 promptId（提交被拒，看 ComfyUI 控制台）",
  "err.unreachable": "连不上 ComfyUI：先点「启动 ComfyUI」，或确认 8188 端口",
  "err.launch-failed": "拉起 ComfyUI 失败，看服务端日志里的命令与报错",
  "err.ui-format": "这个模板是 UI 格式，得先转成 API 格式",
  "err.bad-schema": "schema 格式不对：vars 得是数组",
  "err.no-file": "读不了那个路径的文件",
  "err.no-workflow-dir": "先在设置里填工作流模板目录（comfy.workflowDir），导入才有地方落",
  "err.bad-name": "模板 id 只能用小写字母、数字、连字符和下划线，且以字母或数字开头",
  "err.exists": "已经有同名模板，换个 id 或勾上「覆盖同名」",
  "err.write-failed": "写模板目录失败，看服务端日志（目录权限？）",
  "err.pose-image": "没有这张姿势图",
  "err.max-tokens": "模型输出被截断了（服务端已自动翻倍重试，还不行就把上限调高）",
  "err.method-not-allowed": "这个接口不接受这种请求方法",
  "err.internal": "服务端内部错误，看服务端控制台",
  "ui.error.response": "响应不是 JSON（HTTP {status}）"
};
// 静态骨架（panel.html 里写死的那批）在运行时要跟着语言走：选择器 → 字典键 → 写到哪个位置。
// prop: text（textContent）/ placeholder / title / label（input 外面那层 label 的第一个文本节点）。
var I18N_STATIC = [
  {
    "sel": "#app-title",
    "key": "ui.head.title",
    "prop": "text"
  },
  {
    "sel": "#app-sub",
    "key": "ui.head.sub",
    "prop": "text"
  },
  {
    "sel": "#lamp b",
    "key": "ui.head.lamp",
    "prop": "text"
  },
  {
    "sel": "#llm-text",
    "key": "ui.llm.pillLoading",
    "prop": "text"
  },
  {
    "sel": "#comfy-text",
    "key": "ui.comfy.pillLoading",
    "prop": "text"
  },
  {
    "sel": "#lang",
    "key": "ui.lang.label",
    "prop": "title"
  },
  {
    "sel": "#settings-card > summary",
    "key": "ui.settings.summary",
    "prop": "text"
  },
  {
    "sel": "#settings-card > .hint",
    "key": "ui.settings.hint",
    "prop": "text"
  },
  {
    "sel": "#llm-baseurl",
    "key": "ui.settings.baseUrl",
    "prop": "label"
  },
  {
    "sel": "#llm-baseurl",
    "key": "ui.settings.baseUrlPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#llm-key",
    "key": "ui.settings.apiKey",
    "prop": "label"
  },
  {
    "sel": "#llm-key",
    "key": "ui.settings.apiKeyPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#llm-model",
    "key": "ui.settings.model",
    "prop": "label"
  },
  {
    "sel": "#llm-provider",
    "key": "ui.settings.provider",
    "prop": "label"
  },
  {
    "sel": "#llm-save",
    "key": "ui.settings.saveLlm",
    "prop": "text"
  },
  {
    "sel": "#llm-test",
    "key": "ui.settings.testLlm",
    "prop": "text"
  },
  {
    "sel": "#comfy-baseurl",
    "key": "ui.settings.comfyBaseUrl",
    "prop": "label"
  },
  {
    "sel": "#comfy-dir",
    "key": "ui.settings.launchDir",
    "prop": "label"
  },
  {
    "sel": "#comfy-dir",
    "key": "ui.settings.launchDirPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#comfy-python",
    "key": "ui.settings.pythonPath",
    "prop": "label"
  },
  {
    "sel": "#comfy-python",
    "key": "ui.settings.pythonPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#comfy-workflows",
    "key": "ui.settings.workflowDir",
    "prop": "label"
  },
  {
    "sel": "#comfy-workflows",
    "key": "ui.settings.workflowDirPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#comfy-default",
    "key": "ui.settings.defaultWorkflow",
    "prop": "label"
  },
  {
    "sel": "#comfy-save",
    "key": "ui.settings.saveComfy",
    "prop": "text"
  },
  {
    "sel": "#comfy-ping",
    "key": "ui.settings.pingComfy",
    "prop": "text"
  },
  {
    "sel": "#comfy-launch",
    "key": "ui.settings.launchComfy",
    "prop": "text"
  },
  {
    "sel": "#forge-title",
    "key": "ui.forge.title",
    "prop": "text"
  },
  {
    "sel": "#text",
    "key": "ui.forge.placeholder",
    "prop": "placeholder"
  },
  {
    "sel": "#maxTags",
    "key": "ui.forge.maxTags",
    "prop": "label"
  },
  {
    "sel": "#level",
    "key": "ui.head.level",
    "prop": "label"
  },
  {
    "sel": "#save-level",
    "key": "ui.forge.applyLevel",
    "prop": "text"
  },
  {
    "sel": "#fg-repair",
    "key": "ui.forge.repair",
    "prop": "label"
  },
  {
    "sel": "#fg-repair",
    "key": "ui.forge.repairTitle",
    "prop": "title"
  },
  {
    "sel": "#fg-postprocess",
    "key": "ui.forge.postprocess",
    "prop": "label"
  },
  {
    "sel": "#fg-postprocess",
    "key": "ui.forge.postprocessTitle",
    "prop": "title"
  },
  {
    "sel": "#fg-posehints",
    "key": "ui.forge.poseHints",
    "prop": "label"
  },
  {
    "sel": "#fg-posehints",
    "key": "ui.forge.poseHintsTitle",
    "prop": "title"
  },
  {
    "sel": "#fg-candidates",
    "key": "ui.forge.candidates",
    "prop": "label"
  },
  {
    "sel": "#fg-candidates",
    "key": "ui.forge.candidatesTitle",
    "prop": "title"
  },
  {
    "sel": "#forge",
    "key": "ui.forge.run",
    "prop": "text"
  },
  {
    "sel": "#result-card h2",
    "key": "ui.result.pairs",
    "prop": "text"
  },
  {
    "sel": "#copy-pair",
    "key": "ui.common.copy",
    "prop": "text"
  },
  {
    "sel": "#copy-pos",
    "key": "ui.common.copy",
    "prop": "text"
  },
  {
    "sel": "#refine-card > h2",
    "key": "ui.refine.title",
    "prop": "text"
  },
  {
    "sel": "#refine-mode option[value=\"add\"]",
    "key": "ui.refine.modeAdd",
    "prop": "text"
  },
  {
    "sel": "#refine-mode option[value=\"edit\"]",
    "key": "ui.refine.modeEdit",
    "prop": "text"
  },
  {
    "sel": "#refine-mode option[value=\"prune\"]",
    "key": "ui.refine.modePrune",
    "prop": "text"
  },
  {
    "sel": "#refine-mode option[value=\"weights\"]",
    "key": "ui.refine.modeWeights",
    "prop": "text"
  },
  {
    "sel": "#refine-text",
    "key": "ui.refine.placeholder",
    "prop": "placeholder"
  },
  {
    "sel": "#refine",
    "key": "ui.refine.run",
    "prop": "text"
  },
  {
    "sel": "#gen-card > h2",
    "key": "ui.run.title",
    "prop": "text"
  },
  {
    "sel": "#ref-file",
    "key": "ui.run.refLabel",
    "prop": "label"
  },
  {
    "sel": "#pose-name",
    "key": "ui.pose.none",
    "prop": "text"
  },
  {
    "sel": "#pose-meta",
    "key": "ui.pose.pickHint",
    "prop": "text"
  },
  {
    "sel": "#cnstrength",
    "key": "ui.run.cnStrength",
    "prop": "label"
  },
  {
    "sel": "#width",
    "key": "ui.run.width",
    "prop": "label"
  },
  {
    "sel": "#height",
    "key": "ui.run.height",
    "prop": "label"
  },
  {
    "sel": "#steps",
    "key": "ui.run.steps",
    "prop": "label"
  },
  {
    "sel": "#run",
    "key": "ui.run.run",
    "prop": "text"
  },
  {
    "sel": ".modal-head b",
    "key": "ui.pose.modalTitle",
    "prop": "text"
  },
  {
    "sel": "#pose-q",
    "key": "ui.pose.searchPlaceholder",
    "prop": "placeholder"
  },
  {
    "sel": "#pose-close",
    "key": "ui.common.close",
    "prop": "text"
  },
  {
    "sel": "#lamp-text",
    "key": "ui.lamp.loading",
    "prop": "text"
  }
];
var i18n = { lang: "zh", dict: {}, langs: I18N_LANGS.slice(), listeners: [] };
/** 字典查词：当前语言 → 内置 zh → 原样返回键名（看得见就是没翻，不是白屏）。 */
function T(key, vars) {
  var raw = Object.prototype.hasOwnProperty.call(i18n.dict, key) ? i18n.dict[key] : I18N_BUILTIN_ZH[key];
  if (typeof raw !== "string") return String(key);
  if (!vars) return raw;
  return raw.replace(/\{([a-zA-Z0-9_]+)\}/g, function (m, name) {
    return Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m;
  });
}
/** 改 label 里的说明文字：<label>文字<input></label>，只换第一个文本节点，别把 input 删了。 */
function i18nSetLabel(el, text) {
  var label = el && el.parentElement && el.parentElement.tagName === "LABEL" ? el.parentElement : null;
  if (!label) return;
  if (label.firstChild && label.firstChild.nodeType === 3) label.firstChild.nodeValue = text;
  else label.insertBefore(document.createTextNode(text), label.firstChild);
}
/** 把静态骨架文案按当前字典写一遍；选择器找不到就跳过（HTML 少一个节点也不该炸）。 */
function i18nApplyStatic() {
  I18N_STATIC.forEach(function (item) {
    var el = document.querySelector(item.sel);
    if (!el) return;
    var text = T(item.key);
    if (item.prop === "placeholder") { if ("placeholder" in el) el.placeholder = text; return }
    if (item.prop === "title") { el.title = text; return }
    if (item.prop === "label") { i18nSetLabel(el, text); return }
    el.textContent = text;
  });
}
function i18nLang() { return i18n.lang }
function i18nOnChange(fn) { if (typeof fn === "function") i18n.listeners.push(fn) }
function i18nReadLang() {
  var saved = "";
  try { saved = localStorage.getItem(I18N_KEY) || "" } catch (e) { saved = "" }
  return I18N_LANGS.indexOf(saved) >= 0 ? saved : "zh";
}
function i18nWriteLang(lang) {
  try { localStorage.setItem(I18N_KEY, lang) } catch (e) { /* 无痕模式：记不住也不影响本次 */ }
}
/** 拉一份字典：成功且形状对就换掉；失败保持现状（内置 zh 兜底），绝不把面板搞白。 */
async function i18nLoad(lang) {
  var want = I18N_LANGS.indexOf(lang) >= 0 ? lang : "zh";
  i18n.lang = want;
  i18n.dict = {};
  try {
    var res = await api("/locale?lang=" + encodeURIComponent(want));
    var d = (res && res.data) || {};
    if (d.ok === true && d.dict && typeof d.dict === "object" && !Array.isArray(d.dict)) {
      i18n.dict = d.dict;
      if (Array.isArray(d.langs) && d.langs.length) i18n.langs = d.langs.slice();
      if (typeof d.locale === "string" && I18N_LANGS.indexOf(d.locale) >= 0) i18n.lang = d.locale;
    }
  } catch (e) { /* 服务端没这个路由就继续用内置 zh */ }
  return i18n.lang;
}
/** 切语言：记住 → 换字典 → 重写静态文案 → 通知（app.js 借它重跑 boot 重渲染动态部分）。 */
async function i18nSetLang(lang) {
  i18nWriteLang(I18N_LANGS.indexOf(lang) >= 0 ? lang : "zh");
  await i18nLoad(lang);
  i18nApplyStatic();
  var sel = $("lang");
  if (sel && sel.value !== i18n.lang) sel.value = i18n.lang;
  i18n.listeners.forEach(function (fn) { try { fn(i18n.lang) } catch (e) { /* 监听器自己炸不该拖垮切换 */ } });
  return i18n.lang;
}
/** 启动用：读记住的语言 → 拉字典 → 写静态文案。整个过程不抛（服务端挂了也要能开面板）。 */
async function i18nStart() {
  var lang = i18nReadLang();
  try { await i18nLoad(lang) } catch (e) { i18n.dict = {} }
  i18nApplyStatic();
  var sel = $("lang");
  if (sel) sel.value = i18n.lang;
  return i18n.lang;
}
