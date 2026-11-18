// plan: 宿主入口：装配运行时（createRuntime）+ 挂载 HTTP / 工具 / 提示词（apply），细节都在 lib/cordis/

/**
 * dsh-tagger 宿主入口（从 dsh-prompt-forge 派生，桌面端优先）。
 *
 * index.js 只做编排，实现按职责分在 lib/cordis/ 下：
 *   - config.js    配置投影（configView / persistPatch；apiKey 只给尾号）
 *   - commands.js  模型工具注册 + 智能体系统提示词注入
 *   - handlers.js  面板的全部 HTTP 接口（health / state / forge / refine / mcp …）
 *   - adapter.js   logger / 连接配置 / 最小 ctx 的适配层（standalone 也用这一份）
 *
 * 一条 entry 做四件事：
 *   1. 把 HTTP 前缀 /tagger/api 挂到宿主 webServer 上（面板的全部接口）；
 *   2. 建共享运行时：标签索引 / 锻造器（宿主 llm 服务）/ ComfyUI 客户端 / MCP 处理器；
 *   3. 注册三个模型工具（prompt_forge、prompt_forge_run、prompt_forge_status）；
 *   4. 需要时把「标签写法」注入智能体系统提示词（默认关）。
 *
 * 面板本身在 client.js；宿主只负责数据与投递，两边的操作逻辑共用同一批方法。
 */
import { dataDir, resolveConfig } from './lib/config.js'
import { createTagIndex } from './lib/tags.js'
import { createForge } from './lib/forge.js'
import { createComfyClient } from './lib/comfy.js'
import { createPoseCatalog } from './lib/poses.js'
import { createMcpHandler } from './lib/mcp.js'
import { launchComfy } from './lib/launch.js'
import { createRefiner } from './lib/refine.js'
import { createRegistry } from './lib/spi.js'
import { createDispatch, LEGACY_PREFIX, PREFIX } from './lib/routes.js'
import { createLogger } from './lib/cordis/adapter.js'
import { PLUGIN } from './lib/cordis/config.js'
import { registerSystemPromptSection, registerTools } from './lib/cordis/commands.js'
import { createHandlers } from './lib/cordis/handlers.js'

/** 路由表本体在 lib/cordis/handlers.js，这里按名字转出（外部与测试都这么 import）。 */
export { createHandlers }

export const name = PLUGIN

/** webServer 必须注入：前缀注册要它。llm / tools 走可选读取，缺席时面板仍可用（模板拼接模式）。 */
export const inject = ['webServer']

/** 组装运行时；导出是为了测试能不起宿主直接验接口。 */
export function createRuntime(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = createLogger()
  const dir = dataDir()
  const tags = createTagIndex({ dir, logger: log })
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  const forge = createForge({ config, llm, tags, logger: log })
  const comfy = createComfyClient({ config, logger: log })
  const poses = createPoseCatalog({ config, logger: log })
  // SPI：以后接别的插件 / web 版都从这里插，核心不直接 import 外部实现。
  const spi = createRegistry({ logger: log, config })
  const refine = createRefiner({ config, llm, tags, logger: log, spi })
  const mcp = createMcpHandler({ forge, comfy, tags, config, logger: log, refine })
  return {
    ctx,
    config,
    log,
    dir,
    tags,
    llm,
    forge,
    refine,
    spi,
    comfy,
    poses,
    mcp,
    launch: () => launchComfy({ config, logger: log }),
  }
}

export function apply(ctx, rawConfig) {
  const rt = createRuntime(ctx, rawConfig)
  const server = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  if (server === undefined || typeof server.register !== 'function') {
    rt.log.warn('拿不到 webServer 服务，HTTP 接口未注册。')
  } else {
    try {
      const routes = createHandlers(rt)
      // 新前缀 + 旧前缀（兼容 dsh-prompt-forge 时期的客户端与脚本）
      const dispose = server.register({ kind: 'prefix', path: PREFIX, handler: createDispatch(routes, rt.log, PREFIX) })
      if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'prompt-forge: http prefix')
      }
      rt.log.info('接口就绪：' + PREFIX)
      // 旧前缀兼容：同一个 dispatch 换切片长度。失败不影响新前缀。
      try {
        const disposeLegacy = server.register({
          kind: 'prefix',
          path: LEGACY_PREFIX,
          handler: createDispatch(routes, rt.log, LEGACY_PREFIX),
        })
        if (typeof disposeLegacy === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => () => disposeLegacy(), 'tagger: legacy http prefix')
        }
      } catch (error) {
        rt.log.info('旧前缀 ' + LEGACY_PREFIX + ' 未注册（不影响使用）：' + (error instanceof Error ? error.message : String(error)))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('duplicate prefix route')) rt.log.info('HTTP 前缀已存在（热重载），沿用现有实例。')
      else throw error
    }
  }

  registerTools(ctx, rt)
  registerSystemPromptSection(ctx, rt)

  return rt
}
