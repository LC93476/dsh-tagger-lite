// 设置区保存 + ComfyUI 探活/拉起：副作用在这里，panel.js 只留状态编排与骨架。
import { normalizePurge } from './state.js'
import { requestJson } from './api.js'

export function createSettingsOps(ctx) {
  const {
    api,
    t,
    settings,
    setSettings,
    setSettingsStatus,
    setSettingsError,
    setComfyStatus,
    setPurgeInfo,
    applyLevel,
    applyComfy,
  } = ctx

  const saveSettings = async () => {
    setSettingsStatus('saving')
    setSettingsError('')
    const res = await requestJson(api + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patch: {
          llm: { provider: settings.provider, model: settings.model },
          purge: { level: settings.level },
          forge: {
            repair: settings.forgeRepair,
            postprocess: settings.forgePostprocess,
            poseHints: settings.forgePoseHints,
            candidates: settings.forgeCandidates,
          },
          comfy: {
            baseUrl: settings.baseUrl,
            workflowDir: settings.workflowDir,
            launchDir: settings.launchDir,
            pythonPath: settings.pythonPath,
          },
        },
      }),
    })
    if (!res.ok || res.payload?.ok === false) {
      setSettingsStatus('error')
      setSettingsError(res.payload?.message ?? res.message ?? t('settings.failed'))
      return
    }
    setSettingsStatus('saved')
    applyLevel(settings.level)
    const fresh = await requestJson(api + '/state')
    if (fresh.ok) {
      const purge = fresh.payload?.purge
      if (purge !== null && purge !== undefined && typeof purge === 'object') setPurgeInfo(normalizePurge(purge))
    }
  }

  const patchSettings = patch => setSettings(previous => ({ ...previous, ...patch }))

  const checkComfy = async () => {
    setComfyStatus(previous => ({ ...previous, busy: 'check' }))
    applyComfy(await requestJson(api + '/comfy'))
  }

  const startComfy = async () => {
    setComfyStatus(previous => ({ ...previous, busy: 'launch' }))
    const res = await requestJson(api + '/comfy/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitMs: 60000 }),
    })
    const payload = res.payload !== null && typeof res.payload === 'object' ? res.payload : {}
    if (!res.ok || payload.ok === false) {
      setComfyStatus(previous => ({
        ...previous,
        state: 'offline',
        busy: '',
        message: String(payload.message ?? res.message ?? t('comfy.launchFailed')),
        launchDir: String(payload.dir ?? previous.launchDir),
      }))
      return
    }
    setComfyStatus(previous => ({
      ...previous,
      state: payload.state === 'online' ? 'online' : 'starting',
      version: String(payload.status?.version ?? previous.version),
      message: String(payload.message ?? ''),
      launchDir: String(payload.dir ?? previous.launchDir),
      command: String(payload.command ?? previous.command),
      busy: '',
    }))
  }

  return { saveSettings, patchSettings, checkComfy, startComfy }
}
