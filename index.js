// plan: 独立服务的装配入口：createRuntime 装运行时，createHandlers 出路由表，细节都在 lib/cordis/

/**
 * dsh-tagger 装配入口（从 dsh-prompt-forge 派生，现在只服务独立 web 服务）。
 *
 * index.js 只做编排，实现按职责分在 lib/cordis/ 下：
 *   - config.js    配置投影（configView / persistPatch；apiKey 只给尾号）
 *   - handlers.js  web 面板的全部 HTTP 接口（health / state / forge / refine / mcp …）
 *   - adapter.js   logger / 连接配置 / 最小 ctx 的适配层（standalone 也用这一份）
 *
 * 起服务的两条出路都从这里进：server/standalone.mjs 自己起 http 服务并把 createHandlers
 * 的路由表挂到 /tagger/api；bin/tagger.mjs 同进程转调 standalone。
 *
 * 面板是 server/public/ 下的静态资源，服务只负责数据与投递。
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
import { createLogger } from './lib/cordis/adapter.js'
import { createHandlers } from './lib/cordis/handlers.js'

/** 路由表本体在 lib/cordis/handlers.js，这里按名字转出（standalone 与测试都这么 import）。 */
export { createHandlers }

/**
 * 组装运行时。ctx 是可选的 llm 注入点：独立模式传 llm 替身；没有就退化成模板拼接。
 * 导出是为了测试能不起服务直接验接口。
 */
export function createRuntime(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = createLogger()
  const dir = dataDir()
  const tags = createTagIndex({ dir, logger: log })
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  const forge = createForge({ config, llm, tags, logger: log })
  const comfy = createComfyClient({ config, logger: log })
  const poses = createPoseCatalog({ config, logger: log })
  // SPI：接别的实现都从这里插，核心不直接 import 外部实现。
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
