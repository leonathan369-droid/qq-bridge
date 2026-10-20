/**
 * qq-bridge-panel —— host 半（Cordis 插件）
 * ============================================================================
 * 只做四件事：把 `/qq-bridge-panel/{status,start,stop,open}` 注册到 DSH 的
 * 同源 webServer 上，交给 `lib/panel-core.js` 执行；client 半（client.js）是
 * 设置页「QQ 桥接」，它只 `fetch` 这几个相对路径。
 *
 * 为什么需要 host 半：DSH 桌面壳只对 `https:` 外链调 `shell.openExternal`，
 * 页面里 `<a href="http://127.0.0.1:3101/...">` 会被 deny；而「读 config.json /
 * 探端口 / spawn 桥接 / 调系统 open」都需要 Node 权限。两条壳（Web 与 Desktop）
 * 都通过 host 的 webServer 拿同一份能力（Desktop 的 `dsh-app://app/*` 会转发）。
 *
 * 信任边界：
 *   · 只接受回环来源；
 *   · 写操作必须是 `application/json`（跨站表单/文本请求会被挡在外面）；
 *   · 控制台 token 不进响应体，只在 host 拼 URL 时使用。
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceManager, resolveRepoDir, SERVICES } from './panel-core.js'

export const name = 'qq-bridge-panel'

/** webServer 提供路由载体，subprocess 负责按 PATH 解析 node。 */
export const inject = ['webServer', 'subprocess']

/** 路由前缀；client.js 用同一个常量拼请求。 */
export const PANEL_ROUTE = '/qq-bridge-panel'

const BODY_LIMIT = 8192

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return LOOPBACK.has(address)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        rejectBody(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

function sameOrigin(req) {
  const origin = String(req.headers.origin ?? '')
  if (!origin) return true // 同源 fetch 在部分壳里不带 Origin；回环 + JSON 已足够
  try {
    return new URL(origin).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

/** 由模块位置推导仓库根；找不到时退回插件包目录（status 会给出 configError）。 */
function detectRepoDir() {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const packageDir = dirname(moduleDir)
  const preferred = process.env.QQ_BRIDGE_DIR ? resolve(process.env.QQ_BRIDGE_DIR) : ''
  if (preferred && isAbsolute(preferred)) return resolveRepoDir(preferred)
  return resolveRepoDir(packageDir)
}

export function apply(ctx) {
  const repoDir = detectRepoDir()

  const manager = createServiceManager({
    repoDir,
    resolveNode: async () => {
      try {
        return await ctx.subprocess.resolveExecutable('node')
      } catch {
        return null
      }
    },
  })

  console.log(`[qq-bridge-panel] 仓库目录：${repoDir}`)

  /** 统一包一层：回环校验、方法校验、JSON 校验、异常兜底。 */
  const route = (method, suffix, handler) => {
    return ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: PANEL_ROUTE + suffix,
          handler: async (req, res) => {
            try {
              if (!isLoopback(req)) {
                sendJson(res, 403, { ok: false, message: '仅允许本机回环访问' })
                return
              }
              if (req.method !== method) {
                sendJson(res, 405, { ok: false, message: `只接受 ${method}` })
                return
              }
              if (method !== 'GET') {
                const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
                if (!contentType.includes('application/json')) {
                  sendJson(res, 415, { ok: false, message: '写操作必须是 application/json' })
                  return
                }
                if (!sameOrigin(req)) {
                  sendJson(res, 403, { ok: false, message: '跨站请求被拒绝' })
                  return
                }
              }
              const body = method === 'GET' ? {} : await readJsonBody(req)
              const result = await handler(body)
              sendJson(res, result?.ok === false && result?.code === 'external' ? 409 : 200, result)
            } catch (error) {
              sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
            }
          },
        }),
      `qq-bridge-panel: ${method} ${PANEL_ROUTE}${suffix}`,
    )
  }

  route('GET', '/status', () => manager.status())

  // client 半加载自检：页面脚本 apply() 时打一次，status 里的 client.seen 就是它。
  route('POST', '/ping', () => {
    manager.markClientPing()
    return { ok: true, message: 'client loaded' }
  })

  route('POST', '/start', (body) => {
    const service = String(body?.service ?? '')
    if (!SERVICES.includes(service)) return { ok: false, message: `service 必须是 ${SERVICES.join(' / ')}` }
    return manager.start(service)
  })

  route('POST', '/stop', (body) => {
    const service = String(body?.service ?? '')
    if (!SERVICES.includes(service)) return { ok: false, message: `service 必须是 ${SERVICES.join(' / ')}` }
    return manager.stop(service)
  })

  route('POST', '/open', (body) => {
    const target = String(body?.target ?? '')
    if (target !== 'console' && target !== 'llbot') return { ok: false, message: 'target 必须是 console / llbot' }
    return manager.open(target)
  })

  ctx.effect(() => () => manager.dispose(), 'qq-bridge-panel: 释放子进程')
}
