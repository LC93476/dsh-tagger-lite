/**
 * lib/workflow-import.js — 把用户手里的 ComfyUI 工作流 JSON 变成工作台模板。
 *
 * 面板的「导入自定义工作流」走这里：收一段 API 格式 JSON（+ 可选 schema），
 * 校验 → 取 id → 补一份最小 schema（没给的话从节点输入反推变量表）→ 原子写进模板目录。
 *
 * 三条硬约束：
 *   1. 只收 API 格式（{ "3": { class_type, inputs } }）。UI 格式（nodes/links）直接拒 ——
 *      它需要前端图数据，硬转会在节点 0 之前就丢连线语义。
 *   2. id 必须能当文件名：白名单 [a-z0-9_-]，其余一律折叠成 '-'，空就报 bad-name。
 *      id 不进 URL 也不拼用户输入，但它是 path.join 的一段，所以照样要挡穿越。
 *   3. 写盘先写 .tmp 再 rename —— 半截 JSON 出现在模板目录里会让整份列表读失败。
 */
import fs from 'node:fs'
import path from 'node:path'

import { isRecord } from './backend-common.js'
import { isUiFormat, nodeIds, resolveTextMapping, varsFromSchema } from './comfy-workflow.js'

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_WORKFLOW_BYTES = 4 * 1024 * 1024
const NUMERIC_VARS = new Set(['seed', 'noise_seed', 'steps', 'cfg', 'width', 'height', 'denoise', 'guidance', 'batch_size', 'cn_strength', 'strength', 'start_percent', 'end_percent'])
const DROP_VARS = new Set(['text', 'filename_prefix'])

/** 名字 → 合法 id：小写、非白名单折叠成 '-'、去掉首尾 '-'、最多 64 段。 */
export function slugify(name) {
  const raw = String(name ?? '').trim().toLowerCase()
  const folded = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '')
  return folded.slice(0, 64)
}

/** 收 string / object，返回工作流对象或 { error, message }。 */
export function parseWorkflow(raw) {
  let value = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return { error: 'empty-file', message: '工作流是空的，先把 JSON 贴进来或选文件' }
    if (text.length > MAX_WORKFLOW_BYTES) return { error: 'too-large', message: '工作流 JSON 超过 4MB，不像普通模板' }
    try {
      value = JSON.parse(text)
    } catch (error) {
      return { error: 'bad-json', message: '这不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  if (isRecord(value) === false) return { error: 'bad-workflow', message: '工作流得是一个 JSON 对象' }
  if (isUiFormat(value)) {
    return {
      error: 'ui-format',
      message: '这是 UI 格式（带 nodes/links）。在 ComfyUI 里用「工作流 → 导出（API）/ Save (API Format)」重新导出，那份才是 { 节点id: { class_type, inputs } } 的形状。',
    }
  }
  const ids = nodeIds(value)
  if (ids.length === 0) return { error: 'bad-workflow', message: '这份 JSON 里没有带 class_type 的节点，不像 API 格式的工作流' }
  return { workflow: value, nodes: ids.length }
}

/** 收 schema（string/object，可空），返回对象或 { error, message }。 */
export function parseSchema(raw) {
  if (raw === undefined || raw === null || raw === '') return { schema: null }
  let value = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return { schema: null }
    try {
      value = JSON.parse(text)
    } catch (error) {
      return { error: 'bad-json', message: 'schema 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  if (isRecord(value) === false) return { error: 'bad-schema', message: 'schema 得是一个 JSON 对象' }
  if (Array.isArray(value.vars) === false && value.vars !== undefined) {
    return { error: 'bad-schema', message: 'schema.vars 得是数组（每个变量一条 { name, label, ... }）' }
  }
  return { schema: value }
}

/**
 * 没给 schema 时造一份最小可用的：prompt / negative_prompt 绑到识别出的文本节点，
 * 其余从节点输入反推（seed / steps / cfg / width / height …），并补上模板当前值当默认。
 */
export function inferSchema(workflow, { title = '', description = '', config = null } = {}) {
  const mapping = resolveTextMapping(workflow, null, config ?? {}, [])
  const vars = []
  if (mapping.positiveNode !== '') {
    vars.push({ name: 'prompt', label: '正向提示词', group: 'basic', type: 'string', node: mapping.positiveNode, hint: '只写画面 tag；质量词与造型词由工作流自带的节点补' })
  }
  if (mapping.negativeNode !== '' && mapping.negativeNode !== mapping.positiveNode) {
    vars.push({ name: 'negative_prompt', label: '负向提示词', group: 'basic', type: 'string', node: mapping.negativeNode })
  }
  const inferred = varsFromSchema(null, workflow, mapping)
  for (const variable of inferred) {
    if (DROP_VARS.has(variable.name) || variable.name === 'prompt' || variable.name === 'negative_prompt') continue
    vars.push({
      ...variable,
      group: NUMERIC_VARS.has(variable.name) ? 'advanced' : 'basic',
      type: typeof variable.default === 'number' ? 'number' : 'string',
    })
  }
  return {
    title,
    description,
    internalInputs: ['filename_prefix'],
    vars,
    imported: { at: new Date().toISOString(), nodes: nodeIds(workflow).length, mapping: { positiveNode: mapping.positiveNode, negativeNode: mapping.negativeNode } },
  }
}

/** schema 里没写 default 的变量补模板当前值，免得面板输入框空着。 */
export function fillDefaults(schema, workflow) {
  const mapping = resolveTextMapping(workflow, schema, {}, [])
  const vars = varsFromSchema(schema, workflow, mapping)
  const byName = new Map(vars.map(variable => [variable.name, variable]))
  schema.vars = (Array.isArray(schema.vars) ? schema.vars : []).map(variable => {
    if (isRecord(variable) === false) return variable
    if (variable.default !== undefined) return variable
    const filled = byName.get(String(variable.name ?? ''))
    return filled !== undefined && filled.default !== undefined ? { ...variable, default: filled.default } : variable
  })
  return schema
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清不掉也没关系，下次覆盖 */ }
    throw error
  }
}

/**
 * 导入一份工作流。
 *
 * @param {{ dir: string, name?: string, workflow?: unknown, schema?: unknown, overwrite?: boolean, config?: any }} input
 * @returns {{ ok: true, id: string, title: string, dir: string, workflowPath: string, schemaPath: string, nodes: number, created: boolean }
 *   | { ok: false, error: string, message: string }}
 */
export function importWorkflow(input) {
  const dir = String(input?.dir ?? '').trim()
  if (dir === '') return { ok: false, error: 'no-workflow-dir', message: '没配工作流模板目录（comfy.workflowDir）' }
  const parsed = parseWorkflow(input?.workflow)
  if (parsed.error !== undefined) return { ok: false, error: parsed.error, message: parsed.message }
  const workflow = parsed.workflow
  const schemaRead = parseSchema(input?.schema)
  if (schemaRead.error !== undefined) return { ok: false, error: schemaRead.error, message: schemaRead.message }

  const wanted = slugify(input?.name)
  if (wanted === '' || ID_RE.test(wanted) === false) {
    return { ok: false, error: 'bad-name', message: 'id 只能用小写字母、数字、连字符(-) 和下划线(_)，并且要以字母或数字开头（比如 my-sdxl-t2i）' }
  }
  const id = wanted
  const workflowPath = path.join(dir, id + '.json')
  const schemaPath = path.join(dir, id + '.schema.json')
  const exists = fs.existsSync(workflowPath)
  if (exists && input?.overwrite !== true) {
    return { ok: false, error: 'exists', message: '已经有同名模板 ' + id + '，换个 id，或勾上「覆盖同名模板」' }
  }

  let schema = schemaRead.schema
  const title = (isRecord(schema) && typeof schema.title === 'string' && schema.title.trim() !== '' ? schema.title : '') || id
  if (isRecord(schema)) {
    schema = { ...schema, title }
    fillDefaults(schema, workflow)
  } else {
    schema = inferSchema(workflow, { title, description: '', config: input?.config ?? null })
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    writeAtomic(workflowPath, JSON.stringify(workflow, null, 2))
    writeAtomic(schemaPath, JSON.stringify(schema, null, 2))
  } catch (error) {
    return { ok: false, error: 'write-failed', message: '写模板目录失败：' + (error instanceof Error ? error.message : String(error)) }
  }
  return { ok: true, id, title, dir, workflowPath, schemaPath, nodes: parsed.nodes, created: exists === false }
}
