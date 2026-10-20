/**
 * qq-bridge-panel —— host 侧核心逻辑
 * ============================================================================
 * 这一层**不 import 任何 DSH / Cordis 包**，只依赖 Node 内置模块，因此可以
 * 用普通 `node` 直接跑离线回归（`scripts/test-panel-host.mjs`），不必启动 DSH。
 *
 * 职责：
 *   · 读桥接仓库的 `config.json`（consolePort / consoleToken / snowluma.webuiUrl）；
 *   · 探测控制台端口与 LLBot WebUI 端口是否在监听（status 的"灯"）；
 *   · 启动 / 停止桥接进程（LLBot 是第三方程序，只有显式配置 `panel.llbotCommand`
 *     才允许面板启动它）；
 *   · 用系统默认浏览器打开控制台（带 `?token=`）或 LLBot WebUI。
 *
 * 安全边界（与桥接控制台一致）：
 *   · 只做 127.0.0.1 回环探测与打开，不对外网暴露任何东西；
 *   · 控制台 token 只出现在 host 进程拼出的 URL 里，不返回给浏览器页面；
 *   · POST 走 application/json（浏览器跨站请求会先撞 CORS 预检，等于 CSRF 防护）；
 *   · 面板只停止**自己 spawn 的**进程；外部启动的实例（终端 / 启动台）绝不 kill。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'

/** 桥接 README 里的默认控制台端口（本机可能被 config.json 改成 3101）。 */
export const DEFAULT_CONSOLE_PORT = 3100

/** 允许面板托管启动的服务名。 */
export const SERVICES = ['bridge', 'llbot']

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * 从插件包目录向上找桥接仓库根（同时存在 config.json 与 src/bridge.js）。
 * `QQ_BRIDGE_DIR` 显式指定时优先，便于 npm 安装 / 多副本场景。
 */
export function resolveRepoDir(startDir, env = process.env) {
  const fromEnv = String(env.QQ_BRIDGE_DIR ?? '').trim()
  if (fromEnv) {
    const dir = resolve(fromEnv)
    if (existsSync(join(dir, 'config.json'))) return dir
    return dir
  }
  let dir = resolve(startDir)
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, 'config.json')) && existsSync(join(dir, 'src', 'bridge.js'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return resolve(startDir)
}

/** 读 config.json；解析失败不抛，交给调用方决定怎么提示。 */
export function loadBridgeConfig(repoDir) {
  const file = join(repoDir, 'config.json')
  if (!existsSync(file)) {
    return { file, exists: false, config: null, error: '未找到 config.json（先复制 config.example.json）' }
  }
  try {
    return { file, exists: true, config: JSON.parse(readFileSync(file, 'utf8')), error: '' }
  } catch (error) {
    return { file, exists: true, config: null, error: `config.json 解析失败：${error?.message ?? error}` }
  }
}

export function consolePortOf(config) {
  const port = Number(config?.consolePort)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONSOLE_PORT
}

/** consoleToken 优先 config.json；没配时桥接会写到 state/console-token。 */
export function consoleTokenOf(config, repoDir) {
  const configured = String(config?.consoleToken ?? '').trim()
  if (configured) return configured
  try {
    return readFileSync(join(repoDir, 'state', 'console-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function llbotWebuiUrlOf(config) {
  return String(config?.snowluma?.webuiUrl ?? '').trim()
}

export function portOfUrl(url) {
  const text = String(url ?? '').trim()
  if (!text) return 0
  try {
    const parsed = new URL(text)
    if (parsed.port) return Number(parsed.port)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return 0
  }
}

/** LLBot 启动命令：只认数组，避免把字符串当 shell 执行（注入面）。 */
export function llbotCommandOf(config) {
  const raw = config?.panel?.llbotCommand
  return Array.isArray(raw) ? raw.map((part) => String(part)).filter(Boolean) : []
}

export function llbotCwdOf(config, repoDir) {
  const configured = String(config?.panel?.llbotCwd ?? '').trim()
  if (configured) return configured
  const launcher = String(config?.snowluma?.launcherPath ?? '').trim()
  return launcher ? dirname(launcher) : repoDir
}

/** TCP 探测 127.0.0.1:port 是否有人监听（500ms 超时，探不到就是关闭）。 */
export function probePort(port, { timeoutMs = 500, host = '127.0.0.1' } = {}) {
  return new Promise((resolveProbe) => {
    if (!port) {
      resolveProbe(false)
      return
    }
    const socket = connect({ port, host })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 轮询等待端口达到期望状态；返回最终是否达到。 */
export async function waitPort(port, want, timeoutMs, probe = probePort, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last = await probe(port)
  while (last !== want && Date.now() < deadline) {
    await sleep(intervalMs)
    last = await probe(port)
  }
  return last === want
}

/** 读一个 JSON GET；失败返 null（状态探测是 best-effort，不该把面板打挂）。 */
export async function httpJson(url, { headers = {}, timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * 用系统默认浏览器打开一个 URL。
 * 之所以不用 `shell.openExternal`：那是 Electron 壳内部 API，插件拿不到；
 * 而桌面壳对 `http://` 外链直接 deny，所以必须由 host 进程调平台命令。
 */
export function openUrlNative(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = String(url ?? '')
  if (!target) return Promise.reject(new Error('空 URL'))
  let command
  let args
  if (platform === 'darwin') {
    command = 'open'
    args = [target]
  } else if (platform === 'win32') {
    // start 的第一个引号参数是窗口标题（必须给空标题，否则 URL 会被当成标题）
    command = process.env.ComSpec || 'cmd.exe'
    args = ['/d', '/s', '/c', `start "" "${target.replace(/"/g, '')}"`]
  } else {
    command = 'xdg-open'
    args = [target]
  }
  return new Promise((resolveOpen, rejectOpen) => {
    let child
    try {
      child = spawnImpl(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    } catch (error) {
      rejectOpen(error)
      return
    }
    child.once('error', rejectOpen)
    child.once('spawn', () => {
      try {
        child.unref()
      } catch {}
      resolveOpen()
    })
  })
}

/**
 * 服务管理器：状态 / 启动 / 停止 / 打开。
 *
 * 所有外部副作用（spawn、probe、open、node 解析）都可注入，测试脚本用真实
 * 临时进程验证 start/stop，用记录函数验证 open，不碰真实桥接与浏览器。
 */
export function createServiceManager({
  repoDir,
  resolveNode = async () => null,
  spawnImpl = spawn,
  probe = probePort,
  openImpl = openUrlNative,
  platform = process.platform,
  env = process.env,
  startTimeoutMs = 15000,
  stopTimeoutMs = 6000,
} = {}) {
  const children = new Map()
  const logs = new Map()
  let nodePromise = null
  // 诊断用：client 半每次 apply() 会 ping 一次，用来确认"设置页那半边真的被加载了"。
  // 它不是功能路径，只是让离线排查（以及本项目的验收）不必去翻渲染进程控制台。
  let lastClientPing = 0

  const pushLog = (service, chunk) => {
    const lines = String(chunk ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(0, 300))
    if (lines.length === 0) return
    const list = logs.get(service) ?? []
    list.push(...lines)
    logs.set(service, list.slice(-30))
  }

  const tailLog = (service, count = 6) => (logs.get(service) ?? []).slice(-count).join('\n')

  const resolveNodeOnce = () => {
    if (nodePromise === null) {
      nodePromise = (async () => {
        const fromEnv = String(env.QQ_BRIDGE_NODE ?? '').trim()
        if (fromEnv && existsSync(fromEnv)) return fromEnv
        try {
          return await resolveNode()
        } catch {
          return null
        }
      })()
    }
    return nodePromise
  }

  const readState = () => {
    const loaded = loadBridgeConfig(repoDir)
    const config = loaded.config ?? {}
    return {
      loaded,
      config,
      bridgePort: consolePortOf(config),
      bridgeToken: consoleTokenOf(config, repoDir),
      llbotUrl: llbotWebuiUrlOf(config),
      llbotPort: portOfUrl(llbotWebuiUrlOf(config)),
      llbotCommand: llbotCommandOf(config),
      llbotCwd: llbotCwdOf(config, repoDir),
    }
  }

  const spawnChild = (service, command, args, options) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.set(service, child)
    child.stdout?.on('data', (chunk) => pushLog(service, chunk))
    child.stderr?.on('data', (chunk) => pushLog(service, chunk))
    child.once('exit', (code, signal) => {
      if (children.get(service) === child) children.delete(service)
      pushLog(service, `[exit] code=${code ?? ''} signal=${signal ?? ''}`)
    })
    child.once('error', (error) => {
      if (children.get(service) === child) children.delete(service)
      pushLog(service, `[error] ${error?.message ?? error}`)
    })
    return child
  }

  const waitStarted = async (service, child, port) => {
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      if (await probe(port)) {
        return { ok: true, started: true, service, message: `已启动（端口 ${port}）` }
      }
      if (child.exitCode !== null && child.exitCode !== undefined) {
        return {
          ok: false,
          service,
          message: `进程启动后立即退出（code=${child.exitCode}）${tailLog(service) ? `\n${tailLog(service)}` : ''}`,
        }
      }
      await sleep(250)
    }
    return { ok: false, service, message: `等待端口 ${port} 超时${tailLog(service) ? `\n${tailLog(service)}` : ''}` }
  }

  async function status() {
    const state = readState()
    const [bridgeOpen, llbotOpen, nodePath] = await Promise.all([
      probe(state.bridgePort),
      state.llbotPort ? probe(state.llbotPort) : Promise.resolve(false),
      resolveNodeOnce(),
    ])
    const live = bridgeOpen && state.bridgeToken
      ? await httpJson(`http://127.0.0.1:${state.bridgePort}/api/status`, {
          headers: { 'x-console-token': state.bridgeToken },
        })
      : null
    return {
      ok: true,
      repoDir,
      configFile: state.loaded.file,
      configFound: state.loaded.exists,
      configError: state.loaded.error,
      nodePath: nodePath ?? '',
      bridge: {
        port: state.bridgePort,
        open: bridgeOpen,
        owned: children.has('bridge'),
        tokenConfigured: Boolean(state.bridgeToken),
        mode: typeof live?.mode === 'string' ? live.mode : '',
        dshReady: live?.dshReady === true,
        lastLog: tailLog('bridge', 4),
      },
      llbot: {
        url: state.llbotUrl,
        port: state.llbotPort,
        open: llbotOpen,
        owned: children.has('llbot'),
        startable: state.llbotCommand.length > 0,
      },
      client: {
        seen: lastClientPing > 0,
        at: lastClientPing > 0 ? new Date(lastClientPing).toISOString() : '',
      },
    }
  }

  /** client 半加载标记（见 client.js 的 apply）。 */
  function markClientPing() {
    lastClientPing = Date.now()
  }

  async function start(service) {
    if (!SERVICES.includes(service)) return { ok: false, message: `未知服务：${service}` }
    const state = readState()
    if (service === 'bridge') {
      if (await probe(state.bridgePort)) return { ok: true, already: true, message: '桥接已在运行（无需重复启动）' }
      const nodePath = await resolveNodeOnce()
      if (!nodePath) {
        return { ok: false, message: '找不到 Node（可设置环境变量 QQ_BRIDGE_NODE 指向 Node ≥ 22.13）' }
      }
      const child = spawnChild('bridge', nodePath, ['src/bridge.js'], { cwd: repoDir })
      return waitStarted('bridge', child, state.bridgePort)
    }
    if (!state.llbotPort) return { ok: false, message: '未配置 snowluma.webuiUrl，无法确定 LLBot 端口' }
    if (await probe(state.llbotPort)) return { ok: true, already: true, message: 'LLBot 已在运行（无需重复启动）' }
    if (state.llbotCommand.length === 0) {
      return {
        ok: false,
        message: '未配置 panel.llbotCommand：LLBot 是第三方程序，默认由你自己启动；需要面板代管时在 config.json 填启动命令数组',
      }
    }
    const [command, ...args] = state.llbotCommand
    const child = spawnChild('llbot', command, args, { cwd: state.llbotCwd })
    return waitStarted('llbot', child, state.llbotPort)
  }

  async function stop(service) {
    if (!SERVICES.includes(service)) return { ok: false, message: `未知服务：${service}` }
    const state = readState()
    const port = service === 'bridge' ? state.bridgePort : state.llbotPort
    const child = children.get(service)
    if (!child) {
      const open = port ? await probe(port) : false
      return open
        ? { ok: false, code: 'external', message: '这个实例不是面板启动的，请到你启动它的终端/启动台里停止' }
        : { ok: true, already: true, message: '当前未在运行' }
    }
    try {
      child.kill('SIGTERM')
    } catch {}
    let closed = port ? await waitPort(port, false, stopTimeoutMs, probe) : true
    if (!closed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {}
      closed = port ? await waitPort(port, false, 3000, probe) : true
    }
    children.delete(service)
    return closed
      ? { ok: true, stopped: true, message: '已停止' }
      : { ok: false, message: `已发送结束信号，但端口 ${port} 仍在监听` }
  }

  async function open(target) {
    const state = readState()
    if (target === 'console') {
      const query = state.bridgeToken ? `?token=${encodeURIComponent(state.bridgeToken)}` : ''
      await openImpl(`http://127.0.0.1:${state.bridgePort}/${query}`, { platform })
      return { ok: true, opened: true, target, message: '已在系统浏览器打开桥接控制台' }
    }
    if (target === 'llbot') {
      if (!state.llbotUrl) return { ok: false, message: '未配置 snowluma.webuiUrl' }
      await openImpl(state.llbotUrl, { platform })
      return { ok: true, opened: true, target, message: '已在系统浏览器打开 LLBot WebUI' }
    }
    return { ok: false, message: `未知目标：${target}` }
  }

  function dispose() {
    for (const [, child] of children) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    children.clear()
  }

  return { status, start, stop, open, dispose, markClientPing }
}
