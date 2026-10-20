/**
 * qq-bridge-panel —— host 半（Cordis 插件）
 * ============================================================================
 * 把 `/qq-bridge-panel/*` 注册到 DSH 的同源 webServer 上，交给 `lib/panel-core.js`
 * 执行；client 半（client.js）是设置页「QQ 桥接」，它只 `fetch` 这些相对路径。
 *
 * 为什么需要 host 半：DSH 桌面壳只对 `https:` 外链调 `shell.openExternal`，
 * 页面里 `<a href="http://127.0.0.1:3101/...">` 会被 deny；而「读 config.json /
 * 探端口 / spawn 桥接 / 调系统 open」都需要 Node 权限。两条壳（Web 与 Desktop）
 * 都通过 host 的 webServer 拿同一份能力（Desktop 的 `dsh-app://app/*` 会转发）。
 *
 * 模型作用域（本轮重点）：
 *   `POST /model/apply` 是给**桥接进程**调用的会话局部模型应用接口。它用 DSH 自己的
 *   `sessionController.agents.selectForNextRequest()`，等价于官方 `session/selectModel`
 *   去掉最后那句 `agentDefaultModel.saveSelection()` —— 因此只改 QQ 会话，**不写
 *   DSH 全局默认模型**。目录校验用 `sessionController.modelCatalog()`，档位校验用
 *   `llm.resolveCallConfig()`，与官方链路一致。
 *
 * 信任边界：
 *   · 只接受回环来源；
 *   · 写操作必须是 `application/json`（跨站表单/文本请求会被挡在外面）+ Origin 校验；
 *   · consoleToken 不进任何响应体（status 只给掩码）；打开浏览器走一次性票据；
 *   · 会话模型应用只接受「已在 DSH 会话列表里的 sessionId」，且必须通过目录校验。
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServiceManager, PANEL_VERSION, resolveRepoDir, SERVICES } from './panel-core.js'

export const name = 'qq-bridge-panel'

/** webServer 提供路由载体，subprocess 负责按 PATH 解析 node。 */
export const inject = ['webServer', 'subprocess']

/** 路由前缀；client.js 用同一个常量拼请求。 */
export const PANEL_ROUTE = '/qq-bridge-panel'

const BODY_LIMIT = 64 * 1024

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
  if (!origin) return true // 同源 fetch / 本机进程调用不带 Origin；回环 + JSON 已足够
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

/**
 * 从宿主 ctx 取一个可选服务。**不用硬 inject**：这些服务在别的壳/精简 profile 里可能
 * 不存在，硬 inject 会让整个面板（包括启停服务）一起不加载。取不到时对应功能降级，
 * status 里如实标记不可用。
 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** 读 DSH 的模型目录（与官方选择器同一个 RPC 的实现）。 */
function makeCatalogProvider(ctx) {
  return async () => {
    const controller = optionalService(ctx, 'sessionController')
    if (!controller || typeof controller.modelCatalog !== 'function') {
      throw new Error('宿主没有 sessionController.modelCatalog（DSH 版本过旧？）')
    }
    // buildModelCatalog 是 async（要逐个 provider 列模型 + resolveModelInfo），必须 await。
    const catalog = await controller.modelCatalog()
    if (!catalog || !Array.isArray(catalog.groups)) throw new Error('模型目录返回结构异常')
    return catalog
  }
}

/** 读/写 `qq-mode` settings 命名空间（桥接不可用时的模式回退路径）。 */
function makeSettingsBridge(ctx) {
  const read = async () => {
    const settings = optionalService(ctx, 'settings')
    if (!settings || typeof settings.describe !== 'function') return null
    const forms = await settings.describe()
    const form = (forms ?? []).find((row) => row?.ns === 'qq-mode')
    return form?.value ?? null
  }
  const write = async (mode) => {
    const settings = optionalService(ctx, 'settings')
    if (!settings || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
      return { ok: false, message: '宿主没有 settings 服务，无法写 qq-mode 命名空间' }
    }
    try {
      const forms = await settings.describe()
      const form = (forms ?? []).find((row) => row?.ns === 'qq-mode')
      if (!form) {
        return {
          ok: false,
          message: 'DSH 里没有 qq-mode 这个命名空间：请确认 qq-mode-console bundle 已注册并重启 DSH',
        }
      }
      await settings.update('qq-mode', { mode }, form.revision)
      return { ok: true, revision: form.revision }
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) }
    }
  }
  return { readSettingsMode: read, writeSettingsMode: write }
}

/**
 * 会话局部应用模型 —— 等价官方 `session/selectModel` 去掉 `agentDefaultModel.saveSelection()`。
 *
 * 官方链路（dsh-api-session-controller）：resolveAgent → requireModel → llm.resolveCallConfig
 *   → agents.selectForNextRequest（append 会话内 `model/selection` 事件）
 *   → **agentDefaultModel.saveSelection（写 DSH 全局默认）**。
 * 最后一句是「只想改 QQ 助手却改了 GUI 新会话默认」的根因，RPC 层没有开关；
 * 这里直接走它前面那几步，不动最后一句。
 */
function makeSessionModelApplier(ctx, log) {
  return async ({ sessionId, provider, model, reasoningEffort }) => {
    const controller = optionalService(ctx, 'sessionController')
    if (!controller) return { ok: false, message: '宿主没有 sessionController，无法应用会话模型' }
    const agents = controller.agents
    if (!agents) return { ok: false, message: '宿主 sessionController 缺少 agents 实例（DSH 版本不兼容）' }
    if (typeof agents.selectForNextRequest !== 'function') {
      return { ok: false, message: 'sessionController.agents.selectForNextRequest 不存在（DSH 版本不兼容）' }
    }
    // 1) 模型必须在目录里（= 可用）。目录不可读时不做这个判断，交给 resolveCallConfig。
    try {
      const catalog = typeof controller.modelCatalog === 'function' ? await controller.modelCatalog() : null
      if (catalog?.groups) {
        const group = catalog.groups.find((g) => g?.id === provider)
        const entry = group?.models?.find((m) => m?.id === model)
        if (!entry) {
          return { ok: false, message: `模型 ${provider}/${model} 不在 DSH 当前可路由的模型目录里` }
        }
        const efforts = Array.isArray(entry.reasoning?.efforts) ? entry.reasoning.efforts.map((e) => String(e?.id ?? '')) : []
        if (reasoningEffort && efforts.length && !efforts.includes(reasoningEffort)) {
          return { ok: false, message: `模型 ${provider}/${model} 不支持思考强度「${reasoningEffort}」（支持：${efforts.join(' / ')}）` }
        }
        if (reasoningEffort && efforts.length === 0) {
          return { ok: false, message: `模型 ${provider}/${model} 不支持可配置的思考强度，不能提交「${reasoningEffort}」` }
        }
      }
    } catch (error) {
      log(`目录校验失败（继续走 resolveCallConfig）：${error?.message ?? error}`)
    }
    // 2) 解析/物化到 provider 真实接受的 provider/model/effort（与官方 selectModel 一致）。
    const llm = optionalService(ctx, 'llm')
    if (!llm || typeof llm.resolveCallConfig !== 'function') {
      return { ok: false, message: '宿主没有 llm.resolveCallConfig，无法校验模型' }
    }
    let resolved
    try {
      resolved = await llm.resolveCallConfig({
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      })
    } catch (error) {
      return { ok: false, message: `模型不可用：${error?.message ?? error}` }
    }
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    // 3) 找到（或恢复）会话；找不到时如实报 session/not-found，让桥接退役并重建。
    let found
    try {
      found = await controller.resolveAgent(sessionId)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/not.?found|不存在/i.test(message)) return { ok: false, code: 'session/not-found', message }
      return { ok: false, message: `无法定位会话：${message}` }
    }
    if (!found) return { ok: false, code: 'session/not-found', message: `session/not-found: ${sessionId}` }
    if (found.error) {
      const message = String(found.error.message ?? found.error)
      return { ok: false, code: /not.?found/i.test(message) ? 'session/not-found' : '', message }
    }
    const agent = found.agent
    if (!agent) return { ok: false, code: 'session/not-found', message: `session/not-found: ${sessionId}` }
    // 4) 与官方一致：走图片准入串行链，避免和图片/表情处理交错；只应用到「下一次请求」，
    //    正在执行的回合不会被中断（模型选择在 prompt 组装时 snapshot）。
    try {
      const apply = () => agents.selectForNextRequest(agent, selected)
      if (typeof agents.serializeImageAdmission === 'function') {
        await agents.serializeImageAdmission(agent, async () => apply())
      } else {
        apply()
      }
    } catch (error) {
      return { ok: false, message: `应用会话模型失败：${error?.message ?? error}` }
    }
    log(`会话 ${sessionId} 模型 -> ${selected.provider}/${selected.model}${
      selected.reasoningEffort ? ` (${selected.reasoningEffort})` : ''
    } [会话局部，未写全局默认]`)
    return { ok: true, selected, scope: 'session', globalDefaultUntouched: true }
  }
}

export function apply(ctx) {
  const repoDir = detectRepoDir()
  const log = (message) => console.log(`[qq-bridge-panel] ${message}`)

  const manager = createServiceManager({
    repoDir,
    resolveNode: async () => {
      try {
        return await ctx.subprocess.resolveExecutable('node')
      } catch {
        return null
      }
    },
    catalogProvider: makeCatalogProvider(ctx),
    ...makeSettingsBridge(ctx),
    applySessionModel: makeSessionModelApplier(ctx, log),
    log,
  })

  log(`仓库目录：${repoDir}（面板 v${PANEL_VERSION}）`)

  /** 统一包一层：回环校验、方法校验、JSON 校验、Origin 校验、异常兜底。 */
  const route = (method, suffix, handler) => {
    return ctx.effect(
      () => ctx.webServer.register({
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
            const status = result?.code === 'external' ? 409 : 200
            sendJson(res, status, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
          }
        },
      }),
      `qq-bridge-panel: ${method} ${PANEL_ROUTE}${suffix}`,
    )
  }

  route('GET', '/status', () => manager.status())
  route('POST', '/ping', () => {
    manager.markClientPing()
    return { ok: true, message: 'client loaded', version: PANEL_VERSION }
  })
  route('POST', '/start', async (body) => {
    const service = String(body?.service ?? '')
    if (!SERVICES.includes(service)) return { ok: false, message: `service 必须是 ${SERVICES.join(' / ')}` }
    return manager.start(service)
  })
  route('POST', '/stop', async (body) => {
    const service = String(body?.service ?? '')
    if (!SERVICES.includes(service)) return { ok: false, message: `service 必须是 ${SERVICES.join(' / ')}` }
    return manager.stop(service)
  })
  route('POST', '/restart', async (body) => {
    const service = String(body?.service ?? '')
    if (!SERVICES.includes(service)) return { ok: false, message: `service 必须是 ${SERVICES.join(' / ')}` }
    return manager.restart(service)
  })
  route('POST', '/start-all', () => manager.startAll())
  route('POST', '/open', async (body) => {
    const target = String(body?.target ?? '')
    if (target !== 'console' && target !== 'llbot') return { ok: false, message: 'target 必须是 console / llbot' }
    return manager.open(target)
  })
  route('POST', '/mode', async (body) => manager.setMode(body?.mode))
  route('POST', '/model', async (body) => manager.setModel(body ?? {}))
  // 桥接进程调用：只做会话局部应用（不写全局默认模型）。
  route('POST', '/model/apply', async (body) => manager.applyModelToSession(body ?? {}))

  ctx.effect(() => () => manager.dispose(), 'qq-bridge-panel: 释放')
}
