/**
 * 极小 HTTP 分派器：只做「解析 URL → 校验方法 → 读 body → 交给 handler → 回 JSON/二进制」。
 *
 * 为什么不复用宿主框架：这个插件只有十来个接口，用一张表写清楚更好查 ——
 * 每个接口的方法、入参、返回都在同一处，出问题时不用追三层。
 */

/** API 前缀。独立前缀，避免和 SPA fallback 抢路径。 */
export const PREFIX = '/tagger/api'

/** 旧前缀：dsh-prompt-forge 时期的 /prompt-forge/api，保留兼容（同一张路由表）。 */
export const LEGACY_PREFIX = '/prompt-forge/api'

const MAX_BODY = 8 * 1024 * 1024

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 8MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJson(buffer) {
  if (buffer.length === 0) return {}
  try {
    const value = JSON.parse(buffer.toString('utf8'))
    return value === null || typeof value !== 'object' ? {} : value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error('请求体不是合法 JSON：' + message)
  }
}

/**
 * @param routes - [{ path, methods, handler }]
 *   path 以 `/*` 结尾表示「前缀匹配」（如 `/_mod/*`），其余是精确匹配。
 *   前缀匹配时 handler 额外收到 `params.rest`（去掉前缀后剩下的部分，带前导斜杠的反面：不含前导 /）。
 *   handler({ url, method, body, req, params }) →
 *     { json, status? } | { binary, contentType } | { text, contentType? }
 */
export function createDispatch(routes, log, prefix = PREFIX) {
  const table = new Map(routes.map(route => [route.path, route]))
  const wildcards = routes.filter(route => route.path.endsWith('/*'))
  return async function dispatch(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.slice(prefix.length) || '/'
    let route = table.get(sub)
    let rest = ''
    if (route === undefined) {
      const hit = wildcards.find(item => sub.startsWith(item.path.slice(0, -1)))
      if (hit !== undefined) {
        route = hit
        rest = sub.slice(hit.path.length - 1).replace(/^\/+/, '')
      }
    }
    if (route === undefined) {
      sendJson(res, 404, { ok: false, error: 'unknown-route', message: '没有这个接口：' + sub })
      return
    }
    const method = req.method ?? 'GET'
    if (!route.methods.includes(method)) {
      sendJson(res, 405, {
        ok: false,
        error: 'method-not-allowed',
        message: '这个接口只接受 ' + route.methods.join(' / '),
      })
      return
    }
    try {
      const body = method === 'POST' || method === 'PUT' ? parseJson(await readBody(req)) : {}
      const result = (await route.handler({ url, method, body, req, params: { rest } })) ?? { json: { ok: true } }
      if (result.status === 204) {
        res.writeHead(204)
        res.end()
        return
      }
      if (result.raw !== undefined) {
        sendJson(res, result.status ?? 200, result.raw)
        return
      }
      if (result.binary !== undefined) {
        res.writeHead(result.status ?? 200, {
          'Content-Type': result.contentType ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        res.end(result.binary)
        return
      }
      if (result.text !== undefined) {
        res.writeHead(result.status ?? 200, {
          'Content-Type': result.contentType ?? 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(result.text)
        return
      }
      sendJson(res, result.status ?? 200, { ok: true, ...result.json })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log?.warn?.('[tagger] ' + sub + ' 失败：' + message)
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal', message })
      } else {
        res.destroy()
      }
    }
  }
}
