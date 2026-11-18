/**
 * ComfyUI 工作流模板层（纯函数，不碰网络）：API/UI 格式判定、正负向节点映射、
 * vars → 节点输入、schema → 变量面、history → 状态摘要。
 * 单独成文件是因为这块要能被单测直接打桩；HTTP 与编排在 comfy.js。
 * 铁律：这里的函数只读传入对象，共享给 comfy.js 之前由它自己深拷贝模板 —— 模板文件绝不被改写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecord, readJsonFile } from './backend-common.js'

/** 工作台数据目录（工作流模板、uploads、cache 都在这下面）。 */
export const WORKBENCH_DIR = path.join(os.homedir(), '.dsh-comfyui-workbench')

const TEXT_CLASS = /textencode/i
const NEGATIVE_TITLE = /negative|neg_|负向|反向|负面|消极/i
const POSITIVE_TITLE = /positive|正向|正面|肯定/i
/** 终态：waitFor 靠它决定还等不等。 */
export const DONE_STATES = new Set(['done', 'failed'])
const hasOwn = (object, key) => Object.hasOwn(object, key)
const hasInputs = node => node !== undefined && node !== null && node.inputs !== null && typeof node?.inputs === 'object'

/** 只把映射的两端交给外面（candidates 是内部线索，别进 HTTP 响应）。 */
export const mappingOf = mapping => ({ positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode })

/** 工作流目录：配置优先，否则用工作台默认位置。每次现取，面板改完立刻生效。 */
export function resolveWorkflowDir(config) {
  const configured = typeof config?.comfy?.workflowDir === 'string' ? config.comfy.workflowDir.trim() : ''
  return configured === '' ? path.join(WORKBENCH_DIR, 'workflows') : path.resolve(configured)
}

/** UI 格式（界面工程文件带 nodes + links）不能直接投递，必须先 Export (API)。 */
export function isUiFormat(workflow) {
  return workflow !== null && typeof workflow === 'object' && Array.isArray(workflow.nodes)
    && (Array.isArray(workflow.links) || typeof workflow.last_node_id !== 'undefined')
}

export function nodeIds(workflow) {
  return Object.keys(workflow).filter(key => {
    const node = workflow[key]
    return node !== null && typeof node === 'object' && typeof node.class_type === 'string'
  })
}

/** 节点标题：_meta.title（API 导出保留）+ title/comment 兜底。 */
export function nodeTitle(node) {
  const meta = node?._meta ?? {}
  const title = meta.title ?? node?.title ?? meta.node_name ?? ''
  return typeof title === 'string' ? title : ''
}

export function textNodes(workflow) {
  return nodeIds(workflow)
    .filter(id => TEXT_CLASS.test(workflow[id].class_type) || typeof workflow[id]?.inputs?.text === 'string')
    .sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b)
    })
}

function bindingOf(variable) {
  for (const candidate of [variable?.node, variable?.nodeId, variable?.node_id, variable?.target, variable?.bind]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number') return String(candidate)
    if (candidate !== null && typeof candidate === 'object') {
      const inner = candidate.node ?? candidate.nodeId ?? candidate.id
      if (typeof inner === 'string' && inner.trim() !== '') return inner.trim()
      if (typeof inner === 'number') return String(inner)
    }
  }
  return ''
}

/**
 * 找正/负向节点：配置指定 > schema 变量绑定 > 标题语义 > 出现顺序。
 * 标题语义中文（正向/负向提示词）与英文（positive/negative）都认 —— 本机两套模板都有。
 */
export function resolveTextMapping(workflow, schema, config, warnings = []) {
  const nodes = textNodes(workflow)
  const has = id => id !== '' && workflow[id] !== undefined && typeof workflow[id]?.inputs?.text === 'string'
  const comfy = config?.comfy ?? {}
  let positiveNode = ''
  let negativeNode = ''
  /** @type {Array<[string, (value: string) => void]>} */
  const assigners = [['positiveNode', v => { positiveNode = v }], ['negativeNode', v => { negativeNode = v }]]
  for (const [field, assign] of assigners) {
    const wanted = typeof comfy[field] === 'string' ? comfy[field].trim() : ''
    if (wanted === '') continue
    if (has(wanted)) assign(wanted)
    else warnings.push('配置 comfy.' + field + '=' + wanted + ' 在工作流里不是 CLIPTextEncode 节点，已忽略')
  }
  for (const variable of Array.isArray(schema?.vars) ? schema.vars : []) {
    const name = String(variable?.name ?? '')
    const bound = bindingOf(variable)
    if (bound === '' || has(bound) === false) continue
    if (/^negative/i.test(name) || name === 'negative_prompt' || name === '负向提示词') {
      if (negativeNode === '') negativeNode = bound
    } else if (/^positive/i.test(name) || name === 'prompt' || name === '正向提示词') {
      if (positiveNode === '') positiveNode = bound
    }
  }
  for (const id of nodes) {
    const title = nodeTitle(workflow[id])
    if (title === '') continue
    if (negativeNode === '' && NEGATIVE_TITLE.test(title) && POSITIVE_TITLE.test(title) === false) negativeNode = id
    else if (positiveNode === '' && POSITIVE_TITLE.test(title) && NEGATIVE_TITLE.test(title) === false) positiveNode = id
  }
  // 什么线索都没有：按出现顺序取，且两个节点必须不同 —— 同一节点既正又负等于没写负向。
  const rest = nodes.filter(id => id !== positiveNode && id !== negativeNode)
  if (positiveNode === '' && rest.length > 0) positiveNode = rest.shift()
  if (negativeNode === '' && rest.length > 0) negativeNode = rest.shift()
  if (positiveNode === '') warnings.push('工作流里找不到 CLIPTextEncode 节点，正向提示词无处可写（用 comfy.positiveNode 指定节点 id）')
  return { positiveNode, negativeNode, candidates: nodes }
}

function coerceVar(value, current, variable) {
  const declared = typeof variable?.type === 'string' ? variable.type.toLowerCase() : ''
  if (declared === 'number' || typeof current === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    return Number.isFinite(n) ? n : value
  }
  if (declared === 'boolean' || typeof current === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    return value
  }
  if (declared === 'string' || typeof current === 'string') return typeof value === 'string' ? value : String(value)
  return value
}

/** 把 vars 写进节点输入：'seed'（schema 绑定/同名输入）、'7.seed'（精确打到节点 7）、'prompt' 由 submit 管。 */
export function applyVars(workflow, schema, vars, mapping, warnings = []) {
  const applied = []
  const skipped = []
  const internal = new Set((Array.isArray(schema?.internalInputs) ? schema.internalInputs : []).map(String))
  const declared = new Map()
  for (const variable of Array.isArray(schema?.vars) ? schema.vars : []) {
    if (typeof variable?.name === 'string') declared.set(variable.name, variable)
  }
  const promptNodeIds = new Set([mapping?.positiveNode, mapping?.negativeNode].filter(Boolean))
  for (const [key, raw] of Object.entries(vars ?? {})) {
    if (raw === undefined || raw === null) continue
    if (key === 'prompt' || key === 'negative_prompt' || key === 'positive' || key === 'negative') continue
    const dotted = /^([^.]+)\.([^.]+)$/.exec(key)
    if (dotted !== null) {
      const [, nodeId, input] = dotted
      const node = workflow[nodeId]
      if (hasInputs(node)) {
        node.inputs[input] = coerceVar(raw, node.inputs[input], declared.get(input))
        applied.push({ name: key, node: nodeId, input })
        continue
      }
      warnings.push('变量 ' + key + ' 没落到任何节点（工作流里没有节点 ' + nodeId + '）')
      skipped.push(key)
      continue
    }
    const variable = declared.get(key)
    // bindings：[{node,input}] —— 一个变量写进多个节点（姿势 id 要同时喂姿势图和姿势标签）。
    if (Array.isArray(variable?.bindings) && variable.bindings.length > 0) {
      let hit = 0
      for (const binding of variable.bindings) {
        const nodeId = String(binding?.node ?? '')
        const input = String(binding?.input ?? '')
        const node = workflow[nodeId]
        if (hasInputs(node) === false || input === '' || hasOwn(node.inputs, input) === false) continue
        node.inputs[input] = coerceVar(raw, node.inputs[input], variable)
        applied.push({ name: key, node: nodeId, input })
        hit += 1
      }
      if (hit > 0) continue
      warnings.push('变量 ' + key + ' 的 bindings 没落到任何节点，已丢弃')
      skipped.push(key)
      continue
    }
    const bound = bindingOf(variable)
    if (bound !== '' && hasInputs(workflow[bound]) && hasOwn(workflow[bound].inputs, key)) {
      workflow[bound].inputs[key] = coerceVar(raw, workflow[bound].inputs[key], variable)
      applied.push({ name: key, node: bound, input: key })
      continue
    }
    if (internal.has(key)) {
      warnings.push('变量 ' + key + ' 是内部参数（' + [...internal].join('/') + '），不按名字覆盖；要改请用 <节点id>.' + key)
      skipped.push(key)
      continue
    }
    let target = ''
    for (const id of nodeIds(workflow)) {
      if (promptNodeIds.has(id)) continue
      const inputs = workflow[id].inputs
      if (inputs === null || typeof inputs !== 'object' || hasOwn(inputs, key) === false) continue
      if (Array.isArray(inputs[key]) || key === 'text') continue
      target = id
      break
    }
    if (target === '') {
      warnings.push('变量 ' + key + ' 在工作流里没有同名输入，已丢弃（可用 <节点id>.' + key + ' 精确指定）')
      skipped.push(key)
      continue
    }
    workflow[target].inputs[key] = coerceVar(raw, workflow[target].inputs[key], variable)
    applied.push({ name: key, node: target, input: key })
  }
  return { applied, skipped }
}

/** 读 schema：坏了不算致命，只是少标题/缺默认值。 */
export function readSchema(schemaPath) {
  if (fs.existsSync(schemaPath) === false) return null
  const read = readJsonFile(schemaPath)
  return read.ok === true && isRecord(read.value) ? read.value : null
}

export function varsFromSchema(schema, workflow, mapping) {
  const declaredList = Array.isArray(schema?.vars) ? schema.vars : []
  const vars = []
  for (const v of declaredList) {
    if (isRecord(v) === false || typeof v.name !== 'string') continue
    vars.push({
      name: v.name, label: typeof v.label === 'string' ? v.label : v.name, group: typeof v.group === 'string' ? v.group : 'basic',
      type: typeof v.type === 'string' ? v.type : 'string', default: v.default,
      ...(Array.isArray(v.options) ? { options: v.options } : {}), ...(Number.isFinite(v.min) ? { min: v.min } : {}),
      ...(Number.isFinite(v.max) ? { max: v.max } : {}), ...(Number.isFinite(v.step) ? { step: v.step } : {}),
      ...(typeof v.hint === 'string' ? { hint: v.hint } : {}),
    })
  }
  if (vars.length === 0) {
    // 没有 schema：从节点输入反推一份可用变量表（至少让面板能改 seed/宽高）
    const seen = new Set()
    for (const id of nodeIds(workflow)) {
      const inputs = workflow[id].inputs
      if (inputs === null || typeof inputs !== 'object') continue
      for (const [name, value] of Object.entries(inputs)) {
        if (Array.isArray(value) || seen.has(name)) continue
        seen.add(name)
        vars.push({ name, label: name, group: 'advanced', type: typeof value === 'number' ? 'number' : 'string', default: value })
      }
    }
    return vars
  }
  // 没写 default 的补上模板当前值（面板输入框才有东西显示）。按全模板找同名输入，不只正负两个节点 ——
  // width/seed 挂在别的节点上；文本节点排前面，同名撞车时优先提示词节点。
  const textIds = [mapping?.positiveNode, mapping?.negativeNode].filter(id => id !== undefined && workflow[id] !== undefined)
  const allIds = [...new Set([...textIds, ...nodeIds(workflow)])]
  for (const variable of vars) {
    if (variable.default !== undefined) continue
    const declaredVar = declaredList.find(item => item?.name === variable.name)
    const bindings = Array.isArray(declaredVar?.bindings) ? declaredVar.bindings : []
    const boundFirst = bindings.find(binding => {
      const inputs = workflow[String(binding?.node ?? '')]?.inputs
      return inputs !== null && typeof inputs === 'object' && hasOwn(inputs, String(binding?.input ?? ''))
    })
    if (boundFirst !== undefined) {
      variable.default = workflow[String(boundFirst.node)].inputs[String(boundFirst.input)]
      continue
    }
    const id = allIds.find(nodeId => {
      const inputs = workflow[nodeId]?.inputs
      return inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) && hasOwn(inputs, variable.name)
    })
    if (id !== undefined) variable.default = workflow[id].inputs[variable.name]
  }
  return vars
}

/** history.outputs → 可下载的图列表（url 直接给面板 <img src>）。 */
export function imagesOf(historyEntry, baseUrl) {
  const images = []
  for (const nodeOutput of Object.values(historyEntry?.outputs ?? {})) {
    if (isRecord(nodeOutput) === false) continue
    for (const list of [nodeOutput.images, nodeOutput.gifs, nodeOutput.videos]) {
      if (Array.isArray(list) === false) continue
      for (const item of list) {
        if (isRecord(item) === false || typeof item.filename !== 'string') continue
        const subfolder = typeof item.subfolder === 'string' ? item.subfolder : ''
        const type = typeof item.type === 'string' ? item.type : 'output'
        const query = new URLSearchParams({ filename: item.filename, subfolder, type })
        images.push({
          filename: item.filename, subfolder, type,
          ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
          url: baseUrl + '/view?' + query.toString(),
        })
      }
    }
  }
  return images
}

/** 失败原因：status.messages 里那条 execution_error 的 exception_message 才是人话。 */
export function failureMessageOf(historyEntry) {
  const messages = Array.isArray(historyEntry?.status?.messages) ? historyEntry.status.messages : []
  for (const entry of messages) {
    if (Array.isArray(entry) === false) continue
    const [kind, payload] = entry
    if (kind !== 'execution_error' && kind !== 'execution_interrupted') continue
    const detail = payload?.exception_message ?? payload?.message ?? payload?.node_type
    return (kind === 'execution_interrupted' ? '执行被中断' : '执行失败') + (detail ? '：' + String(detail).split('\n')[0] : '')
  }
  return '执行失败（ComfyUI 没有给具体原因）'
}

export function summarizeHistory(entry) {
  const promptInfo = Array.isArray(entry?.prompt) ? entry.prompt : []
  const extra = isRecord(promptInfo[3]) ? promptInfo[3] : {}
  return {
    completed: entry?.status?.completed === true, status: entry?.status?.status_str ?? '',
    ...(typeof extra.create_time === 'number' ? { createTime: extra.create_time } : {}),
    ...(Array.isArray(promptInfo[4]) ? { outputNodes: promptInfo[4] } : {}),
  }
}
