/**
 * lib/comfy/index.js —— ComfyUI 客户端：ping / 列工作流 / 投递 / 查状态 / 等出图 / 取图 / 传参考图。
 * 铁律：submit 只「读」工作流文件，改的是内存深拷贝 —— 模板是复现凭据，被投递改过就永久失真。
 *
 * 目录分工（Phase 6.2 目录化，外部 import 一行不用改）：
 *   ./index.js    编排 + HTTP：ping / listWorkflows / submit / status / waitFor / image
 *   ./workflow.js 纯函数：格式判定、正负向节点映射、vars 注入、schema 变量面、history 摘要
 *   ./upload.js   本地文件：参考图落进 ComfyUI 的 input 目录
 * HTTP 脚手架（超时/重试/错误归一/JSON 容错）仍在 ../backend-common.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bodyPreview, clampInt, httpJson, isRecord, msgOf, parseJson, pollUntil, readJsonFile, request } from '../backend-common.js'
import {
  DONE_STATES, WORKBENCH_DIR, applyVars, failureMessageOf, imagesOf, isUiFormat, mappingOf, nodeIds,
  readSchema, resolveTextMapping, resolveWorkflowDir, summarizeHistory, varsFromSchema,
} from './workflow.js'
import { createUploader } from './upload.js'

export { WORKBENCH_DIR, applyVars, isUiFormat, resolveTextMapping, resolveWorkflowDir }

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'

function nowBaseUrl(config) {
  const raw = typeof config?.comfy?.baseUrl === 'string' ? config.comfy.baseUrl.trim() : ''
  return (raw === '' ? DEFAULT_BASE_URL : raw).replace(/\/+$/, '')
}

function readIds(dir) {
  return fs.readdirSync(dir)
    .filter(name => /\.json$/i.test(name) && /\.schema\.json$/i.test(name) === false)
    .map(name => name.slice(0, -5))
    .sort((a, b) => a.localeCompare(b))
}

function safeIds(dir) {
  try {
    return readIds(dir)
  } catch {
    return null
  }
}

/** @param {{ config?: object, logger?: { info?: Function, warn?: Function, error?: Function } }} deps */

export function createComfyClient({ config, logger } = {}) {
  const log = logger ?? {}
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {}
  const comfyCfg = () => (isRecord(config?.comfy) ? config.comfy : {})
  // 上传只碰本地文件系统，拆在 ./upload.js；这里只负责把它接进同一个客户端对象
  const uploaded = createUploader({ config, logger })

  /** ComfyUI 活着吗？顺带把版本号带走 —— 面板用它显示服务状态。 */
  async function ping() {
    const baseUrl = nowBaseUrl(config)
    try {
      const res = await request(baseUrl + '/system_stats', { timeoutMs: 8000 })
      if (res.status !== 200) return { ok: false, reachable: false, baseUrl, message: 'GET /system_stats 返回 HTTP ' + res.status + '：' + bodyPreview(res.buffer) }
      const data = parseJson(res.buffer)
      if (data === null) return { ok: false, reachable: false, baseUrl, message: '/system_stats 不是合法 JSON（地址指向了别的东西？）' }
      const devices = Array.isArray(data?.devices) ? data.devices : []
      return {
        ok: true, reachable: true, version: String(data?.system?.comfyui_version ?? data?.system?.version ?? ''), baseUrl,
        system: {
          os: data?.system?.os ?? '',
          python: data?.system?.python_version ? String(data.system.python_version).split(' ')[0] : '',
          ramTotal: data?.system?.ram_total ?? null,
        },
        devices: devices.map(device => ({ name: device?.name ?? '', vramTotal: device?.vram_total ?? null, vramFree: device?.vram_free ?? null })),
      }
    } catch (error) {
      return { ok: false, reachable: false, baseUrl, message: '连不上 ComfyUI（' + baseUrl + '）：' + msgOf(error) + '。检查服务是否在跑，或面板设置里的地址。' }
    }
  }

  /** 扫工作流目录：<id>.json 是 API 格式模板，<id>.schema.json 是它的输入面。 */
  async function listWorkflows() {
    const dir = resolveWorkflowDir(config)
    if (fs.existsSync(dir) === false) {
      return { ok: false, dir, workflows: [], message: '工作流目录不存在：' + dir + '（在面板设置里改 comfy.workflowDir，或把 API 格式 JSON 放进去）' }
    }
    let ids
    try {
      ids = readIds(dir)
    } catch (error) {
      return { ok: false, dir, workflows: [], message: '读不了工作流目录：' + msgOf(error) }
    }
    const workflows = []
    const problems = []
    for (const id of ids) {
      const workflowPath = path.join(dir, id + '.json')
      const schemaPath = path.join(dir, id + '.schema.json')
      const read = readJsonFile(workflowPath)
      const workflow = read.ok === true ? read.value : null
      const schema = readSchema(schemaPath)
      const uiFormat = isUiFormat(workflow)
      const usable = workflow !== null && uiFormat === false
      const mapping = usable ? resolveTextMapping(workflow, schema, config, []) : { positiveNode: '', negativeNode: '' }
      const entry = {
        id,
        title: typeof schema?.title === 'string' && schema.title.trim() !== '' ? schema.title : id,
        description: typeof schema?.description === 'string' ? schema.description : '',
        vars: usable ? varsFromSchema(schema, workflow, mapping) : [],
        path: workflowPath,
        schemaPath: fs.existsSync(schemaPath) ? schemaPath : '',
        format: uiFormat ? 'ui' : 'api',
        nodes: usable ? nodeIds(workflow).length : 0,
        mapping: mappingOf(mapping),
        hasSchema: schema !== null,
      }
      if (read.ok === false) {
        entry.error = read.error
        problems.push(id + '：' + read.error)
      } else if (uiFormat) {
        entry.message = '这是 UI 格式（含 nodes/links），请在 ComfyUI 里 Export (API) 重新导出后再放进来'
        problems.push(id + '：UI 格式')
      }
      workflows.push(entry)
    }
    return {
      ok: true, dir, workflows,
      ...(problems.length > 0 ? { warnings: problems } : {}),
      ...(workflows.length === 0 ? { message: '目录里还没有 API 格式的工作流 JSON：' + dir } : {}),
    }
  }

  /** 读一份工作流（深拷贝，绝不回写）。id 空则取目录里第一个。 */
  function loadWorkflow(workflowId) {
    const dir = resolveWorkflowDir(config)
    const requested = String(workflowId ?? '').trim()
    const configured = typeof comfyCfg().defaultWorkflowId === 'string' ? comfyCfg().defaultWorkflowId.trim() : ''
    let id = requested !== '' ? requested : configured
    const available = safeIds(dir) ?? []
    if (id === '') {
      if (available.length === 0) return { ok: false, error: 'no-workflow', dir, message: '没有可用工作流：' + dir + ' 里没有 <id>.json' }
      id = available[0]
    }
    // 大小写不一致时按忽略大小写再找一次，省得手抄错一个字母就卡住
    if (available.includes(id) === false) {
      const loose = available.find(name => name.toLowerCase() === id.toLowerCase())
      if (loose !== undefined) id = loose
    }
    if (available.includes(id) === false) {
      return {
        ok: false, error: 'workflow-not-found', dir,
        message: '工作流 ' + id + ' 不存在。目录里可用：' + (available.length === 0 ? '（空）' : available.join(' / ')),
      }
    }
    const workflowPath = path.join(dir, id + '.json')
    const read = readJsonFile(workflowPath)
    if (read.ok === false) return { ok: false, error: 'bad-workflow', dir, id, message: read.kind === 'json' ? read.error : '工作流 JSON 读不了：' + read.error }
    if (isUiFormat(read.value)) {
      return {
        ok: false, error: 'ui-format', dir, id,
        message: '工作流 ' + id + ' 是 UI 格式（含 nodes/links），ComfyUI 的 /prompt 只吃 API 格式：请在界面里 Export (API) 后重新放进来',
      }
    }
    if (nodeIds(read.value).length === 0) return { ok: false, error: 'bad-workflow', dir, id, message: '工作流 ' + id + ' 里没有 class_type 节点，不像 API 格式' }
    const schemaPath = path.join(dir, id + '.schema.json')
    return { ok: true, id, dir, path: workflowPath, schemaPath, schema: readSchema(schemaPath), workflow: JSON.parse(JSON.stringify(read.value)) }
  }

  /** 投递：读模板 → 内存深拷贝 → 写正向/负向 + vars → POST /prompt。 */
  async function submit({ workflowId = '', positive = '', negative = '', vars = {} } = {}) {
    const loaded = loadWorkflow(workflowId)
    if (loaded.ok === false) return { ok: false, workflowId: String(workflowId ?? ''), error: loaded.error, dir: loaded.dir, message: loaded.message }
    const { workflow, schema, id } = loaded
    const warnings = []
    const mapping = resolveTextMapping(workflow, schema, config, warnings)
    const map = mappingOf(mapping)
    const positiveText = typeof positive === 'string' ? positive.trim() : ''
    const negativeText = typeof negative === 'string' ? negative.trim() : ''
    if (positiveText !== '' || negativeText !== '') {
      if (mapping.positiveNode === '') {
        return {
          ok: false, workflowId: id, error: 'no-prompt-node', mapping: { positiveNode: '', negativeNode: mapping.negativeNode }, warnings,
          message: '工作流 ' + id + ' 里找不到可以写提示词的 CLIPTextEncode 节点（用 comfy.positiveNode 指定节点 id）',
        }
      }
      if (positiveText !== '') workflow[mapping.positiveNode].inputs.text = positiveText
      if (negativeText !== '') {
        if (mapping.negativeNode === '') warnings.push('工作流里没有单独的负向节点，负向提示词没写进去')
        else workflow[mapping.negativeNode].inputs.text = negativeText
      }
    }
    const applied = applyVars(workflow, schema, vars, mapping, warnings)
    const clientId = crypto.randomUUID()
    const baseUrl = nowBaseUrl(config)
    let res
    try {
      res = await httpJson(baseUrl + '/prompt', {
        method: 'POST', body: { prompt: workflow, client_id: clientId },
        timeoutMs: clampInt(comfyCfg().submitTimeoutMs, 5000, 600000, 120000),
      })
    } catch (error) {
      return { ok: false, workflowId: id, error: 'unreachable', mapping: map, warnings, message: '投递失败，连不上 ComfyUI（' + baseUrl + '）：' + msgOf(error) }
    }
    const data = res.data
    const nodeErrors = isRecord(data?.node_errors) ? data.node_errors : {}
    const nodeErrorIds = Object.keys(nodeErrors)
    const topError = data?.error
    if (res.status !== 200 || topError !== undefined || nodeErrorIds.length > 0) {
      const details = []
      if (topError !== undefined) details.push(typeof topError === 'string' ? topError : (topError.message ?? topError.type ?? JSON.stringify(topError)))
      for (const nodeId of nodeErrorIds) {
        const errors = nodeErrors[nodeId]?.errors
        const first = Array.isArray(errors) && errors.length > 0 ? errors[0] : null
        details.push('节点 ' + nodeId + (first?.message ? '：' + first.message : '') + (first?.details ? '（' + first.details + '）' : ''))
      }
      if (details.length === 0) details.push('HTTP ' + res.status + ' ' + bodyPreview(res.buffer))
      return {
        ok: false, workflowId: id, error: 'rejected', status: res.status, mapping: map, nodeErrors, applied: applied.applied, warnings,
        message: 'ComfyUI 拒收这次任务：' + details.join('；'),
      }
    }
    const promptId = typeof data?.prompt_id === 'string' ? data.prompt_id : ''
    if (promptId === '') return { ok: false, workflowId: id, error: 'no-prompt-id', mapping: map, warnings, message: 'ComfyUI 没回 prompt_id：' + bodyPreview(res.buffer) }
    info('已投递 ' + id + ' → ' + promptId + '（正向节点 ' + mapping.positiveNode + '，负向节点 ' + (mapping.negativeNode || '无') + '）')
    return {
      ok: true, promptId, workflowId: id, mapping: map, applied: applied.applied, skipped: applied.skipped, warnings,
      queueNumber: typeof data?.number === 'number' ? data.number : null, clientId,
    }
  }

  /** 一次状态查询：历史是终态、队列是过程，所以先看历史再问队列。 */
  async function status(promptId) {
    const id = String(promptId ?? '').trim()
    const baseUrl = nowBaseUrl(config)
    if (id === '') return { ok: false, promptId: '', state: 'unknown', images: [], message: '缺 promptId' }
    let queueRes
    let historyRes
    try {
      ;[queueRes, historyRes] = await Promise.all([
        httpJson(baseUrl + '/queue', { timeoutMs: 8000 }),
        httpJson(baseUrl + '/history/' + encodeURIComponent(id), { timeoutMs: 8000 }),
      ])
    } catch (error) {
      return { ok: false, promptId: id, state: 'unknown', images: [], message: '查状态的请求失败（' + baseUrl + '）：' + msgOf(error) }
    }
    // 非 2xx 不能当"没查到"糊过去：/queue 或 /history 炸了是服务端在出事，得如实回失败
    const codeOf = res => (Number.isFinite(res?.status) ? res.status : 0)
    if (codeOf(queueRes) !== 200) {
      return {
        ok: false, promptId: id, state: 'unknown', images: [], status: codeOf(queueRes),
        message: '查队列失败：GET /queue 返回 HTTP ' + codeOf(queueRes) + '：' + bodyPreview(queueRes?.buffer),
      }
    }
    if (codeOf(historyRes) !== 200) {
      return {
        ok: false, promptId: id, state: 'unknown', images: [], status: codeOf(historyRes),
        message: '查历史失败：GET /history/' + id + ' 返回 HTTP ' + codeOf(historyRes) + '：' + bodyPreview(historyRes?.buffer),
      }
    }
    const queue = isRecord(queueRes.data) ? queueRes.data : {}
    const history = isRecord(historyRes.data) ? historyRes.data : {}
    const historyEntry = history[id]
    if (isRecord(historyEntry)) {
      const images = imagesOf(historyEntry, baseUrl)
      const statusStr = historyEntry?.status?.status_str
      // status_str 有时滞后：messages 里出现过 execution_error / execution_interrupted 就是失败
      const messages = Array.isArray(historyEntry?.status?.messages) ? historyEntry.status.messages : []
      const brokeDown = messages.some(item => Array.isArray(item) && (item[0] === 'execution_error' || item[0] === 'execution_interrupted'))
      if (statusStr === 'error' || brokeDown) return { ok: true, promptId: id, state: 'failed', images, message: failureMessageOf(historyEntry), history: summarizeHistory(historyEntry) }
      if (statusStr === 'success' || historyEntry?.status?.completed === true || images.length > 0) {
        return {
          ok: true, promptId: id, state: 'done', images, progress: 1,
          message: images.length === 0 ? '任务完成，但工作流里没有保存节点（加 SaveImage 才能取图）' : undefined,
          history: summarizeHistory(historyEntry),
        }
      }
    }
    const running = Array.isArray(queue.queue_running) ? queue.queue_running : []
    const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : []
    const isMine = entry => (Array.isArray(entry) ? entry[1] === id : entry?.prompt_id === id)
    if (running.some(isMine)) return { ok: true, promptId: id, state: 'running', images: [], queuePosition: 0 }
    const pendingIndex = pending.findIndex(isMine)
    if (pendingIndex >= 0) return { ok: true, promptId: id, state: 'queued', images: [], queuePosition: pendingIndex + 1 }
    return { ok: true, promptId: id, state: 'unknown', images: [], message: '队列和历史里都没有这个 promptId：可能刚提交还没入队（等一秒再查），或历史已被清空' }
  }

  /**
   * 轮询到终态；超时返回最后一次状态 + timedOut，交给面板决定继续等还是放弃。
   * @param {string} promptId
   * @param {{ timeoutMs?: number, pollIntervalMs?: number }} [options]
   */
  async function waitFor(promptId, { timeoutMs, pollIntervalMs } = {}) {
    const limit = clampInt(timeoutMs ?? comfyCfg().timeoutMs, 1000, 3600000, 900000)
    const interval = clampInt(pollIntervalMs ?? comfyCfg().pollIntervalMs, 50, 30000, 1000)
    const run = await pollUntil({ fn: () => status(promptId), timeoutMs: limit, intervalMs: interval, shouldStop: last => DONE_STATES.has(last.state) })
    const last = run.last
    if (run.ok === true) {
      // 到终态不等于成功：failed 也要 ok:false，否则上层（面板 / MCP）会把失败任务当出图了
      return { ...last, ok: last?.state !== 'failed', waitedMs: run.waitedMs, timedOut: false }
    }
    return {
      ...last, ok: false, waitedMs: run.waitedMs, timedOut: true,
      message: last?.message ?? ('等出图超时（' + limit + 'ms），任务可能还在排队；用 comfy_status 继续查'),
    }
  }

  /** 取图：/view 回二进制，这里原样转交 Buffer + content-type。 */
  async function image({ filename = '', subfolder = '', type = 'output' } = {}) {
    const baseUrl = nowBaseUrl(config)
    const name = String(filename ?? '').trim()
    if (name === '') return { ok: false, message: '缺 filename' }
    const query = new URLSearchParams({
      filename: name,
      subfolder: typeof subfolder === 'string' ? subfolder : '',
      type: typeof type === 'string' && type !== '' ? type : 'output',
    })
    try {
      const res = await request(baseUrl + '/view?' + query.toString(), { timeoutMs: 30000 })
      if (res.status !== 200) {
        return { ok: false, status: res.status, message: 'ComfyUI 取图失败（HTTP ' + res.status + '）：' + name + '。文件可能被清理了，或 type/subfolder 不对' }
      }
      return {
        ok: true, buffer: res.buffer, contentType: String(res.headers['content-type'] ?? 'image/png').split(';')[0],
        bytes: res.buffer.length, url: res.url,
      }
    } catch (error) {
      return { ok: false, message: '取图请求失败（' + baseUrl + '）：' + msgOf(error) }
    }
  }

  return {
    ping, listWorkflows, submit, status, waitFor, image, upload: uploaded.upload,
    // 面板调试用（不在契约里，但只读、无副作用）
    workflowDir: () => resolveWorkflowDir(config),
    baseUrl: () => nowBaseUrl(config),
  }
}
