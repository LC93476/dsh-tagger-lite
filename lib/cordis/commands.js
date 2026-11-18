// plan: 指令与工具注册：模型工具（prompt_forge 三兄弟）+ 可选的智能体系统提示词注入

/**
 * lib/cordis/commands.js — 「往宿主里投东西」的那一半：模型工具、系统提示词。
 *
 * 和 handlers.js（往外发 HTTP）分开，是因为它们的失败方式完全不同：
 * 这里全是「宿主没给这个服务」的软失败，只记日志、绝不影响面板；路由那边错了就是 500。
 */

/**
 * 注册三个模型工具。拿不到 tools 服务就只警告（面板照样能用）。
 * @param {any} ctx
 * @param {any} rt
 */
export function registerTools(ctx, rt) {
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    rt.log.warn('拿不到 tools 服务，模型工具未注册（面板不受影响）。')
    return
  }
  const jsonOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
  const specs = [
    {
      name: 'prompt_forge',
      description:
        '把白话描述锻造成 WD（Danbooru）+ Camie 标准的图像标签：正向 tag 串 + 负向 tag 串 + 逐条权重。'
        + '用户用口语描述画面时先调它，不要自己手写 tag —— 这一步就是"替代 LLM 转标签"的那一跳，'
        + '输出已经过本地标签库校对，可直接进 ComfyUI。'
        + '**给 text 就够**；需要换标准/上限时给 standards / maxTags。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '用户的白话描述（中文即可），越具体越好。' },
          standards: {
            type: 'array',
            items: { type: 'string', enum: ['wd', 'camie'] },
            description: '标签标准，默认按配置（wd + camie）。',
          },
          maxTags: { type: 'integer', description: '最多几个正向 tag，默认按配置（40）。' },
          negative: { type: 'string', description: '附加负向词（默认留空：负向由 ComfyUI 工作流内置）。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => rt.forge.generate({
        text: String(args.text ?? ''),
        options: {
          standards: Array.isArray(args.standards) ? args.standards : undefined,
          maxTags: typeof args.maxTags === 'number' ? args.maxTags : undefined,
          negative: typeof args.negative === 'string' ? args.negative : undefined,
        },
      }),
    },
    {
      name: 'prompt_forge_run',
      description:
        '锻造并直接投递 ComfyUI：给 text（白话）就走锻造，给 positive（现成 tag 串）就跳过锻造；'
        + '不给 workflowId 用配置里的默认工作流。返回 promptId，用 prompt_forge_status 续查。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '白话描述；给了就先用它锻造 tag。' },
          positive: { type: 'string', description: '现成正向 tag 串；给了就跳过锻造。' },
          negative: { type: 'string', description: '负向 tag 串；留空表示用工作流里内置的那一份。' },
          workflowId: { type: 'string', description: '工作流 id（见 /workflows 或面板列表）。' },
          vars: { type: 'object', additionalProperties: true, description: '其它工作流变量（宽高、seed、steps…）。' },
          wait: { type: 'boolean', description: 'true 表示同步等到出图再返回（上限按配置 timeoutMs）。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => {
        let positive = typeof args.positive === 'string' ? args.positive : ''
        let negative = typeof args.negative === 'string' ? args.negative : ''
        let forged = null
        if (positive.trim() === '' && typeof args.text === 'string' && args.text.trim() !== '') {
          forged = await rt.forge.generate({ text: args.text, options: {} })
          if (!forged.ok) return forged
          positive = forged.positive
          // 负向由 ComfyUI 工作流内置，不再沿用模型给的负向串
        }
        const submitted = await rt.comfy.submit({
          workflowId: typeof args.workflowId === 'string' ? args.workflowId : '',
          positive,
          negative,
          vars: args.vars !== null && typeof args.vars === 'object' ? args.vars : {},
        })
        if (!submitted.ok) return submitted
        if (args.wait === true) {
          const final = await rt.comfy.waitFor(submitted.promptId, {})
          return { ok: final.ok, forged, submitted, final }
        }
        return { ok: true, forged, submitted, next: '用 prompt_forge_status 传 promptId 续查' }
      },
    },
    {
      name: 'prompt_forge_status',
      description: '查一次 ComfyUI 任务：排队 / 运行 / 完成 / 失败，完成时带回图片地址。',
      parameters: {
        type: 'object',
        properties: { promptId: { type: 'string', description: 'prompt_forge_run 返回的 promptId。' } },
        required: ['promptId'],
        additionalProperties: false,
      },
      output: jsonOutput,
      execute: async args => rt.comfy.status(String(args.promptId ?? '')),
    },
  ]
  for (const spec of specs) {
    try {
      const dispose = tools.register(spec)
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'prompt-forge: tool ' + spec.name)
      }
    } catch (error) {
      rt.log.warn('工具 ' + spec.name + ' 未注册：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  rt.log.info('模型工具已注册：' + specs.map(s => s.name).join(' / '))
}

/**
 * 可选：把标签写法注入智能体系统提示词（默认关，开了之后对话里也能直接产出同款 tag）。
 * @param {any} ctx
 * @param {any} rt
 */
export function registerSystemPromptSection(ctx, rt) {
  if (!rt.config.purge.injectIntoAgentPrompt) return
  try {
    const section = ctx?.systemPrompt?.section
    if (typeof section === 'function') {
      const dispose = section({ id: 'prompt-forge:tag-rules', text: () => rt.forge.agentDirective() })
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'prompt-forge: system prompt section')
      }
    } else {
      rt.log.warn('systemPrompt 服务不可用，标签写法未注入。')
    }
  } catch (error) {
    rt.log.warn('注入系统提示词失败：' + (error instanceof Error ? error.message : String(error)))
  }
}
