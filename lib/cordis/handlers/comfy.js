// plan: 出图类接口 —— ComfyUI 状态与启动、工作流清单与导入、上传、提交、轮询、取图

/**
 * lib/cordis/handlers/comfy.js — /comfy /comfy/launch /workflows /workflows/import /upload /run /job /image。
 * 「启动 ComfyUI」的并发保护（launchingPromise）跟着这一段搬过来：它只服务于 /comfy/launch。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveLaunch } from '../../launch.js'
import { resolveWorkflowDir } from '../../comfy-workflow.js'
import { importWorkflow } from '../../workflow-import.js'
import { jsonFileInfo } from './shared.js'

/** 出图类路由。@param {any} rt @returns {import('./shared.js').Route[]} */
export function comfyRoutes(rt) {
  // 并发保护：两个请求同时点「启动 ComfyUI」时只 spawn 一次，第二个复用同一份结果
  let launchingPromise = null

  /** 真正去拉一次 ComfyUI 并等它开始监听；waitMs 按第一个发起请求的算。 */
  async function launchOnce(waitMs) {
    const launched = await rt.launch()
    if (!launched.ok) {
      return { status: 500, json: { ok: false, error: 'launch-failed', message: launched.message, launch: launched } }
    }
    const deadline = Date.now() + waitMs
    let status = await rt.comfy.ping()
    while (!status.ok && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      status = await rt.comfy.ping()
    }
    return {
      json: {
        ok: status.ok,
        state: status.ok ? 'online' : 'starting',
        pid: launched.pid,
        command: launched.command,
        dir: launched.dir,
        status,
        message: status.ok ? undefined : '进程已拉起（pid ' + launched.pid + '），' + Math.round(waitMs / 1000) + ' 秒内还没开始监听 —— 首次加载模型可能更久，等一会儿再点「检测」。',
      },
    }
  }

  return [
    {
      path: '/comfy',
      methods: ['GET'],
      handler: async () => {
        const [ping, workflows] = await Promise.all([rt.comfy.ping(), rt.comfy.listWorkflows()])
        return {
          json: {
            status: ping,
            launch: resolveLaunch(rt.config),
            workflows: workflows.ok ? workflows.workflows.map(item => ({ id: item.id, title: item.title })) : [],
          },
        }
      },
    },
    {
      path: '/comfy/launch',
      methods: ['POST'],
      handler: async ({ body }) => {
        // 已经在跑就直接认账 —— 别把用户的第二个 ComfyUI 实例也拉起来抢显存。
        const before = await rt.comfy.ping()
        if (before.ok) return { json: { ok: true, state: 'online', alreadyRunning: true, status: before } }
        const waitMs = Math.min(Math.max(Number(body?.waitMs ?? 45000) || 45000, 5000), 120000)
        // 并发点两次：第二个请求挂在同一个 Promise 上，rt.launch() 只跑一次
        if (launchingPromise === null) {
          launchingPromise = launchOnce(waitMs).finally(() => {
            launchingPromise = null
          })
        }
        return await launchingPromise
      },
    },
    {
      path: '/workflows',
      methods: ['GET'],
      handler: async () => {
        const result = await rt.comfy.listWorkflows()
        if (!result.ok) return { status: 502, json: { ok: false, error: 'workflows', message: result.message } }
        return { json: { workflows: result.workflows, dir: result.dir } }
      },
    },
    {
      // 导入自定义工作流：面板选文件 / 贴 JSON（可选一份 schema），落到 comfy.workflowDir。
      // body.path 是给本地独立服务用的：浏览器不方便选文件时可以直接给磁盘路径。
      path: '/workflows/import',
      methods: ['POST'],
      handler: async ({ body }) => {
        const configured = typeof rt.config?.comfy?.workflowDir === 'string' ? rt.config.comfy.workflowDir.trim() : ''
        const dir = configured !== '' ? configured : resolveWorkflowDir(rt.config)
        let workflow = body?.workflow
        const fromPath = typeof body?.path === 'string' ? body.path.trim() : ''
        if (workflow === undefined && fromPath !== '') {
          // body.path 是危险入参（任意磁盘路径）：读盘前先卡扩展名 / 普通文件 / 10MB 上限
          const info = await jsonFileInfo(fromPath)
          if (info.ok !== true) return { status: 400, json: info.json }
          try {
            workflow = await readFile(fromPath, 'utf8')
          } catch (error) {
            const why = error instanceof Error ? error.message : String(error)
            return { status: 400, json: { ok: false, error: 'no-file', message: '读不了这个文件：' + fromPath + '（' + why + '）' } }
          }
        }
        const result = importWorkflow({
          dir,
          name: body?.name,
          workflow,
          schema: body?.schema,
          overwrite: body?.overwrite === true,
          config: rt.config,
        })
        if (result.ok !== true) return { status: result.error === 'exists' ? 409 : 400, json: result }
        const list = await rt.comfy.listWorkflows()
        return {
          json: {
            ...result,
            workflows: list.ok ? list.workflows.map(item => ({ id: item.id, title: item.title, vars: item.vars })) : [],
          },
        }
      },
    },
    {
      path: '/upload',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.upload({
          filename: typeof body?.filename === 'string' ? body.filename : '',
          data: typeof body?.data === 'string' ? body.data : '',
          // subfolder 透传：不给就只能落 input 根，LoadImage 拿不到 refs/ 这类子目录前缀。
          subfolder: typeof body?.subfolder === 'string' ? body.subfolder : '',
        })
        return { status: result.ok ? 200 : 400, json: result }
      },
    },
    {
      path: '/run',
      methods: ['POST'],
      handler: async ({ body }) => {
        const result = await rt.comfy.submit({
          workflowId: typeof body?.workflowId === 'string' ? body.workflowId : '',
          positive: typeof body?.positive === 'string' ? body.positive : '',
          negative: typeof body?.negative === 'string' ? body.negative : '',
          vars: body?.vars !== null && typeof body?.vars === 'object' && Array.isArray(body.vars) === false ? body.vars : {},
        })
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/job',
      methods: ['GET'],
      handler: async ({ url }) => {
        const promptId = url.searchParams.get('id') ?? ''
        const result = await rt.comfy.status(promptId)
        return { status: result.ok ? 200 : 502, json: result }
      },
    },
    {
      path: '/image',
      methods: ['GET'],
      handler: async ({ url }) => {
        const filename = url.searchParams.get('filename') ?? ''
        const subfolder = url.searchParams.get('subfolder') ?? ''
        const type = url.searchParams.get('type') ?? 'output'
        const got = await rt.comfy.image({ filename, subfolder, type })
        if (!got.ok) return { status: 404, json: { ok: false, error: 'image', message: got.message } }
        return { binary: got.buffer, contentType: got.contentType }
      },
    },
  ]
}
