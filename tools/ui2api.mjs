/**
 * ui2api.mjs —— 把 ComfyUI 网页导出的 UI 工作流（nodes/links）转成 /prompt 能吃的 API 格式。
 *
 * 为什么需要：网页里保存的 .json 是 UI 图（含坐标、widgets_values 数组），
 * /prompt 只认 { "节点id": { class_type, inputs } }。转换的关键是拿 /object_info
 * 把 widgets_values 的位置对回输入名，并把 mode=4（bypass）的节点当直通处理。
 */
import fs from 'node:fs'

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

function inputSpecs(objectInfo, classType) {
  const def = objectInfo[classType]
  if (def === undefined) return undefined
  const out = []
  for (const group of ['required', 'optional']) {
    const bucket = def.input?.[group]
    if (bucket === null || typeof bucket !== 'object') continue
    for (const [name, spec] of Object.entries(bucket)) {
      const type = Array.isArray(spec) ? spec[0] : undefined
      const opts = (Array.isArray(spec) ? spec[1] : undefined) ?? {}
      const isCombo = Array.isArray(type)
      const isWidget = isCombo || (typeof type === 'string' && WIDGET_TYPES.has(type))
      out.push({
        name,
        type: isCombo ? 'COMBO' : type,
        linkOnly: opts.forceInput === true || isWidget === false,
        widget: isWidget && opts.forceInput !== true,
        slot: isWidget !== true,
        default: Object.prototype.hasOwnProperty.call(opts, 'default') ? opts.default : undefined,
        controlAfterGenerate: opts.control_after_generate === true,
      })
    }
  }
  return out
}

function indexLinks(links) {
  const map = new Map()
  for (const row of links) {
    if (!Array.isArray(row) || row.length < 6) continue
    map.set(row[0], { id: row[0], origin: row[1], originSlot: row[2], target: row[3], targetSlot: row[4], type: row[5] })
  }
  return map
}

export function convert(ui, objectInfo, options = {}) {
  const nodes = new Map(ui.nodes.map(n => [n.id, n]))
  const links = indexLinks(ui.links ?? [])
  const warnings = []

  const isMuted = id => nodes.get(id)?.mode === 2
  const isBypassed = id => nodes.get(id)?.mode === 4

  function resolve(linkId, depth = 0) {
    if (depth > 24) throw new Error('bypass 链路过深（可能成环）：' + linkId)
    const link = links.get(linkId)
    if (link === undefined) throw new Error('link 不存在：' + linkId)
    if (isMuted(link.origin)) throw new Error('上游节点 #' + link.origin + ' 被静音（mode=2），输出拿不到')
    if (isBypassed(link.origin)) {
      const origin = nodes.get(link.origin)
      const slots = origin.inputs ?? []
      // ComfyUI 的 bypass 是「第 i 个输出接回第 i 个输入」（类型要一致），不是「随便找一个同类型的输入」。
      // 否则 ControlNetApplyAdvanced 这种双 CONDITIONING 输出的节点，negative 会被错接成 positive。
      const sameSlot = slots[link.originSlot]
      const usable = slot => slot !== undefined && slot.type === link.type && slot.link !== undefined && slot.link !== null
      const passthrough = usable(sameSlot) ? sameSlot : slots.find(usable)
      if (passthrough === undefined) throw new Error('bypass 节点 #' + link.origin + ' 找不到同类型直通输入（' + link.type + '）')
      return resolve(passthrough.link, depth + 1)
    }
    return [String(link.origin), link.originSlot]
  }

  function buildNode(node) {
    const specs = inputSpecs(objectInfo, node.type)
    if (specs === undefined) throw new Error('ComfyUI 里没有这个节点类：' + node.type + '（#' + node.id + '）')
    const inputs = {}
    const widgets = specs.filter(spec => spec.widget)
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
    let cursor = 0
    for (const spec of widgets) {
      if (cursor >= values.length) break
      inputs[spec.name] = values[cursor]
      cursor += 1
      // control_after_generate 只在网页里存在（object_info 不一定标），但它会占一个 widget 位：seed 后面那个 "fixed"/"randomize" 必须跳过。
      const nextValue = values[cursor]
      const looksLikeControl = typeof nextValue === 'string' && (nextValue === 'fixed' || nextValue === 'randomize' || nextValue === 'increment' || nextValue === 'decrement')
      if ((spec.controlAfterGenerate || spec.type === 'INT') && looksLikeControl) cursor += 1
    }
    if (cursor < values.length) warnings.push('#' + node.id + ' ' + node.type + ' 有 ' + (values.length - cursor) + ' 个 widget 值没对上输入名')
    // 节点后来加了新输入（老工作流里没有那个 widget 值）时，/prompt 会报 required_input_missing。
    // 缺的标量输入按 object_info 的 default 补上，别让它带着「缺参数」发出去。
    for (const spec of specs) {
      if (spec.slot === true || inputs[spec.name] !== undefined) continue
      if (spec.default !== undefined) {
        inputs[spec.name] = spec.default
        warnings.push('#' + node.id + ' ' + node.type + ' 缺 ' + spec.name + '，已按默认值 ' + JSON.stringify(spec.default) + ' 补上')
      }
    }
    for (const slot of node.inputs ?? []) {
      if (slot.link === undefined || slot.link === null) continue
      const [originId, originSlot] = resolve(slot.link)
      inputs[slot.name] = [originId, originSlot]
    }
    return { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } }
  }

  function collect(terminalIds) {
    const api = {}
    const seen = new Set()
    const queue = [...terminalIds]
    while (queue.length > 0) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      const node = nodes.get(id)
      if (node === undefined) continue
      if (node.mode === 2) continue
      if (node.mode === 4) {
        for (const slot of node.inputs ?? []) if (slot.link !== undefined && slot.link !== null) queue.push(links.get(slot.link)?.origin)
        continue
      }
      const built = buildNode(node)
      api[String(id)] = built
      for (const value of Object.values(built.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') queue.push(Number(value[0]))
      }
    }
    return api
  }

  const outputs = options.outputs ?? ui.nodes.filter(n => /^(SaveImage|PreviewImage)$/.test(n.type) && n.mode === 0).map(n => n.id)
  const api = collect(outputs.map(Number))
  return { api, warnings, outputs }
}

if (process.argv[1]?.endsWith('ui2api.mjs')) {
  const [uiPath, outPath, outputsArg] = process.argv.slice(2)
  const base = process.env.COMFY_URL ?? 'http://127.0.0.1:8188'
  const ui = JSON.parse(fs.readFileSync(uiPath, 'utf8'))
  const objectInfo = await (await fetch(base + '/object_info')).json()
  const outputs = outputsArg === undefined || outputsArg === '' ? undefined : outputsArg.split(',').map(Number)
  const { api, warnings, outputs: used } = convert(ui, objectInfo, { outputs })
  fs.writeFileSync(outPath, JSON.stringify(api, null, 2), 'utf8')
  console.log('节点数', Object.keys(api).length, '输出', used.join(','))
  for (const id of Object.keys(api)) console.log(' ', id, api[id].class_type, '|', JSON.stringify(api[id].inputs).slice(0, 140))
  for (const w of warnings) console.log('WARN', w)
}
