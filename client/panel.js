// 面板主组件：状态、副作用、动作。视图由 view-*.js 负责，这里只做组装。
import { API, DEFAULT_POLL_MS, JOB_KEY, NS, PANEL_ID, REFINE_MODES, TAB_ID } from './constants.js'
import { createT, dict, withFallback } from './locale.js'
import { clampInt, formatTag, formatTagLine, normalizeDelta, normalizePurge } from './state.js'
import { apiUrl, imageSrc, requestJson } from './api.js'
import { createIcon } from './icon.js'
import { createActions } from './panel-actions.js'
import { createRunOps } from './panel-runs.js'
import { createSettingsOps } from './panel-settings.js'
import { shell } from './view-shell.js'

/**
 * SPI 计数：describe() 的 slots / hooks 是**对象**（{ 槽位: [{id,label}] } / { 钩子: [id] }），
 * 老服务端或测试夹具可能直接给数字。三种形状都要数对，别把对象 Number() 成 NaN。
 */
function countEntries(value) {
  if (Array.isArray(value)) return value.length
  if (value !== null && typeof value === 'object') return Object.keys(value).length
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

// 面板组件：只放状态、钩子与动作；渲染全在 client/view-*.js 里，靠一个 bag 传进去。
export function createPanel({ React }) {
  const h = React.createElement
function Panel(props) {
  const t = typeof props?.t === 'function' ? props.t : createT('zh')
  const api = typeof props?.api === 'string' && props.api !== '' ? props.api : API
  const pollMs = Number.isFinite(props?.pollIntervalMs) && props.pollIntervalMs > 0 ? props.pollIntervalMs : DEFAULT_POLL_MS

  const [text, setText] = React.useState('')
  const [standards, setStandards] = React.useState({ wd: true, camie: true })
  const [maxTags, setMaxTags] = React.useState(40)
  const [level, setLevel] = React.useState('full')
  const [workflows, setWorkflows] = React.useState([])
  const [workflowState, setWorkflowState] = React.useState('loading')
  const [workflowError, setWorkflowError] = React.useState('')
  const [workflowId, setWorkflowId] = React.useState('')
  const [forge, setForge] = React.useState({ status: 'idle', error: '' })
  const [result, setResult] = React.useState(null)
  const [run, setRun] = React.useState({ status: 'idle', promptId: '', images: [], error: '' })
  // 参考图：只有 feiyue-sam3-ref 这类模板用得上（深度图锁体态），选完立刻传到 ComfyUI 的 input/
  const [refName, setRefName] = React.useState('')
  const [refBusy, setRefBusy] = React.useState(false)
  const [refError, setRefError] = React.useState('')
  const [settings, setSettings] = React.useState({
    provider: '',
    model: '',
    level: 'full',
    baseUrl: '',
    workflowDir: '',
    launchDir: '',
    pythonPath: '',
    // 本地三道后处理的开关（存 settings.json，改完点保存立刻生效，不用重启）
    forgeRepair: true,
    forgePostprocess: true,
    forgePoseHints: true,
    forgeCandidates: true,
  })
  const [comfyStatus, setComfyStatus] = React.useState({ state: 'checking', version: '', message: '', busy: '', launchDir: '', command: '' })
  const [settingsStatus, setSettingsStatus] = React.useState('idle')
  const [settingsError, setSettingsError] = React.useState('')
  const [copyStatus, setCopyStatus] = React.useState('idle')
  const [copyPair, setCopyPair] = React.useState('idle')
  const [purgeInfo, setPurgeInfo] = React.useState({ enabled: true, level: 'full', modules: [], chars: 0 })
  // 二次精修：指令、模式、请求状态、上一次的 delta（全空时给「没有改动」）。
  const [refine, setRefine] = React.useState({ instruction: '', mode: 'add', status: 'idle', error: '', delta: null })
  // SPI 自述：拿不到（旧服务端没有 /spi）就不显示徽标，不打扰用户。
  const [spi, setSpi] = React.useState({ ok: false, version: 0, slots: 0, hooks: 0 })

  React.useEffect(() => {
    let alive = true
    const boot = async () => {
      /* /state 是唯一入口：config / purge / comfy / workflows 都在里面，
         冷启动只打一次 HTTP（/state 内部才会去 ping ComfyUI）。
         老服务端缺段、或 /state 整个挂掉时，才回退 /config、/workflows、/comfy 三条老路由。 */
      const applyConfigPayload = c => {
        setSettings({
          provider: String(c.llm?.provider ?? ''),
          model: String(c.llm?.model ?? ''),
          level: String(c.purge?.level ?? 'full'),
          baseUrl: String(c.comfy?.baseUrl ?? ''),
          workflowDir: String(c.comfy?.workflowDir ?? ''),
          launchDir: String(c.comfy?.launchDir ?? ''),
          pythonPath: String(c.comfy?.pythonPath ?? ''),
          forgeRepair: c.forge?.repair !== false,
          forgePostprocess: c.forge?.postprocess !== false,
          forgePoseHints: c.forge?.poseHints !== false,
          forgeCandidates: c.forge?.candidates !== false,
        })
        if (Array.isArray(c.tags?.standards)) {
          setStandards({ wd: c.tags.standards.includes('wd'), camie: c.tags.standards.includes('camie') })
        }
        if (Number.isFinite(c.tags?.maxTags)) setMaxTags(c.tags.maxTags)
        if (typeof c.purge?.level === 'string') setLevel(c.purge.level)
        if (typeof c.comfy?.defaultWorkflowId === 'string' && c.comfy.defaultWorkflowId !== '') {
          setWorkflowId(c.comfy.defaultWorkflowId)
        }
      }
      // /state 的 workflows 是数组、失败原因单列在 workflowsError 里（列表可以是空数组）。
      const applyWorkflowsPayload = (list, error) => {
        setWorkflows(Array.isArray(list) ? list : [])
        if (typeof error === 'string' && error !== '') {
          setWorkflowState('error')
          setWorkflowError(error)
          return
        }
        setWorkflowState('ready')
        setWorkflowError('')
      }
      const loadConfig = async () => {
        const cfg = await requestJson(api + '/config')
        if (!alive) return null
        if (cfg.ok && cfg.payload?.config !== null && typeof cfg.payload?.config === 'object') {
          applyConfigPayload(cfg.payload.config)
          return cfg.payload.config
        }
        if (!cfg.ok) setSettingsError(cfg.message || t('error.config'))
        return null
      }
      const loadWorkflows = async () => {
        const wf = await requestJson(api + '/workflows')
        if (!alive) return
        if (wf.ok && Array.isArray(wf.payload?.workflows)) {
          applyWorkflowsPayload(wf.payload.workflows, '')
          return
        }
        setWorkflowState('error')
        setWorkflowError(wf.message || t('workflow.error'))
      }

      const st = await requestJson(api + '/state')
      if (!alive) return
      const state = st.ok && st.payload !== null && typeof st.payload === 'object' ? st.payload : null

      let config = state !== null && state.config !== null && typeof state.config === 'object' ? state.config : null
      if (config !== null) applyConfigPayload(config)
      else config = await loadConfig()
      if (!alive) return

      // 破甲灯要有服务端状态：/state 里的 purge 才是「当前生效」的那一份。
      const purge = state === null ? null : state.purge
      if (purge !== null && purge !== undefined && typeof purge === 'object') setPurgeInfo(normalizePurge(purge))

      // 工作流：/state 已经带了就说清了；连 workflows 段都没有才去问 /workflows。
      if (state !== null && Array.isArray(state.workflows)) {
        applyWorkflowsPayload(state.workflows, typeof state.workflowsError === 'string' ? state.workflowsError : '')
      } else {
        await loadWorkflows()
        if (!alive) return
      }

      // ComfyUI 连不上是常态（没开、在换模型），所以状态要能自证：/state 的 comfy 就是 ping 结果，
      // 启动目录跟 /comfy 的 launch.dir 同义，从刚回填的 config 补齐。
      if (state !== null && state.comfy !== null && typeof state.comfy === 'object') {
        applyComfy({
          ok: true,
          payload: { status: state.comfy, launch: { dir: String(config?.comfy?.launchDir ?? '') } },
          message: '',
        })
      } else {
        applyComfy(await requestJson(api + '/comfy'))
        if (!alive) return
      }

      // /spi 是自述接口：老版本没有这个路由，失败就当没有，不报错。
      const sp = await requestJson(api + '/spi')
      if (!alive) return
      const spiInfo = sp.ok ? sp.payload?.spi : null
      if (spiInfo !== null && spiInfo !== undefined && typeof spiInfo === 'object') {
        setSpi({
          ok: true,
          version: Number(spiInfo.version) || 0,
          slots: countEntries(spiInfo.slots),
          hooks: countEntries(spiInfo.hooks),
        })
      }
    }
    boot()
    return () => {
      alive = false
    }
  }, [])

  // 15 秒一次静默探活：用户自己去开 ComfyUI 时，灯不用他点也会亮。
  React.useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
      if (!alive) return
      setComfyStatus(current => {
        if (current.busy === '') requestJson(api + '/comfy').then(res => { if (alive) applyComfy(res) })
        return current
      })
    }, 15000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  React.useEffect(() => {
    const promptId = run.promptId
    if (promptId === '') return undefined
    if (run.status !== 'queued' && run.status !== 'running') return undefined
    let alive = true
    const tick = async () => {
      const res = await requestJson(apiUrl(api, '/job', { id: promptId }))
      if (!alive) return
      if (!res.ok) {
        setRun(prev => ({ ...prev, status: 'failed', error: res.message || t('error.job') }))
        return
      }
      const payload = res.payload ?? {}
      const state = typeof payload.state === 'string' ? payload.state : 'unknown'
      const images = Array.isArray(payload.images) ? payload.images : []
      setRun(prev => ({
        ...prev,
        status: JOB_KEY[state] ?? 'unknown',
        images: images.length > 0 ? images : prev.images,
        error: typeof payload.message === 'string' && state === 'failed' ? payload.message : '',
      }))
    }
    const timer = setInterval(tick, Math.max(1, pollMs))
    tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [run.promptId, run.status])



  const positiveText = result === null
    ? ''
    : result.chips.length > 0 ? formatTagLine(result.chips) : result.positive
  const negativeText = result === null
    ? ''
    : result.negativeChips.length > 0 ? formatTagLine(result.negativeChips) : result.negative

  // 中英对照：一行一条「(tag:权重) — 中文」。权重跟着正向串走（1 不带括号），
  // 库里没中文就只留带权重的 tag，不编中文、不留空破折号。
  const pairOf = chip => {
    const weighted = typeof chip.weight === 'number' && chip.weight !== 1
      ? '(' + chip.tag + ':' + chip.weight + ')'
      : chip.tag
    return chip.cn === '' || chip.cn === undefined ? weighted : weighted + ' — ' + chip.cn
  }
  const pairLines = (result?.chips ?? []).map(pairOf)
  const bilingualText = pairLines.join('\n')
  const negativePairText = (result?.negativeChips ?? []).map(pairOf).join('\n')

  /** 换破甲档：档位状态与灯一起走，别让两处各说各话。 */
  const applyLevel = next => {
    setLevel(next)
    setPurgeInfo(previous => normalizePurge({ ...previous, level: next }))
  }

  // 标签操作（chips / 复制 / 二次精修）在 client/panel-actions.js，这里只把这一轮的当前值传进去。
  const { removeChip, runRefine, copyPositive, copyBilingual } = createActions({
    api, t, result, setResult, refine, setRefine, positiveText, negativeText,
    bilingualText, applyLevel, setCopyStatus, setCopyPair,
  })

  // 三段副作用（锻造 / 参考图上传 / 投递出图）在 client/panel-runs.js；设置保存与 ComfyUI 探活/拉起在
  // client/panel-settings.js。这里只把这一轮的 state 与 setter 交出去，函数体是原样搬过去的。
  const { generate, pickRef, submitRun } = createRunOps({
    api, t, text, standards, maxTags, level, workflowId, refName, positiveText, negativeText,
    setForge, setCopyStatus, setRun, setRefine, setResult, setPurgeInfo,
    setRefName, setRefBusy, setRefError,
  })

  const isRefWorkflow = workflowId.indexOf('ref') >= 0

  /** 把 /comfy 的响应折成灯的状态；连不上也要给出「为什么」，别只留一个灰点。 */
  const applyComfy = (res) => {
    const payload = res && res.ok && res.payload !== null && typeof res.payload === 'object' ? res.payload : null
    if (payload === null) {
      setComfyStatus(previous => ({
        ...previous,
        state: 'offline',
        version: '',
        message: String(res?.message ?? t('comfy.offline')),
        busy: '',
      }))
      return
    }
    const status = payload.status !== null && typeof payload.status === 'object' ? payload.status : {}
    const launch = payload.launch !== null && typeof payload.launch === 'object' ? payload.launch : {}
    const online = status.ok === true
    setComfyStatus(previous => ({
      ...previous,
      state: online ? 'online' : 'offline',
      version: online ? String(status.version ?? '') : '',
      message: online ? '' : String(status.message ?? launch.message ?? t('comfy.offline')),
      launchDir: String(launch.dir ?? ''),
      command: String(launch.command ?? ''),
      busy: '',
    }))
  }

  const { saveSettings, patchSettings, checkComfy, startComfy } = createSettingsOps({
    api, t, settings, setSettings, setSettingsStatus, setSettingsError,
    setComfyStatus, setPurgeInfo, applyLevel, applyComfy,
  })
  const p = {
    h,
    t,
    api,
    text,
    setText,
    standards,
    setStandards,
    maxTags,
    setMaxTags,
    level,
    setLevel,
    workflows,
    workflowState,
    workflowError,
    workflowId,
    setWorkflowId,
    forge,
    result,
    run,
    refine,
    setRefine,
    runRefine,
    copyStatus,
    copyPair,
    refName,
    refBusy,
    refError,
    positiveText,
    negativeText,
    bilingualText,
    negativePairText,
    pairLines,
    settings,
    settingsStatus,
    settingsError,
    patchSettings,
    saveSettings,
    comfyStatus,
    checkComfy,
    startComfy,
    purgeInfo,
    spi,
    generate,
    submitRun,
    removeChip,
    copyPositive,
    copyBilingual,
    pickRef,
    isRefWorkflow,
  }
  return shell(p)
  }

  return { Panel }
}

export { NS, API, PANEL_ID, TAB_ID, LEVELS, REFINE_MODES, JOB_KEY, DEFAULT_POLL_MS } from './constants.js'
export { dict, createT, withFallback } from './locale.js'
export { describe, clampInt, formatTag, formatTagLine, normalizeTags, normalizePipeline, normalizePurge, normalizeDelta, chosenStandards } from './state.js'
export { apiUrl, imageSrc, requestJson, readAsDataUrl } from './api.js'
export { createIcon } from './icon.js'
export { shell } from './view-shell.js'
