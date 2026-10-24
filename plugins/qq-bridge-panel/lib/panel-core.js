/**
 * qq-bridge-panel —— host 侧核心逻辑
 * ============================================================================
 * 这一层**不 import 任何 DSH / Cordis 包**，只依赖 Node 内置模块，因此可以用普通
 * `node` 直接跑离线回归（`scripts/test-panel-host.mjs`），不必启动 DSH。
 *
 * 职责：
 *   · 读桥接仓库的 config.json（consolePort / consoleToken / snowluma / panel.*）；
 *   · 真实健康检查：桥接控制台 /api/status、LLBot WebUI /api/login-info、OneBot get_status，
 *     **不把「端口在监听」当成「服务健康」**，也不把「WebUI 能开」当成「QQ 已登录」；
 *   · 一键启动：LLBot →（等待 OneBot/WebUI）→（等待扫码，不算失败）→ 桥接 → 健康校验；
 *   · 进程归属：面板启动的进程记到 `state/panel-services.json`，DSH 重启 / HMR / 页面
 *     刷新后仍能凭「记录 + pid 存活 + 命令行指纹 + 端口」确认归属；外部进程绝不 kill；
 *   · 打开控制台：优先向桥接申请**一次性票据**（60 秒），不再把长期 consoleToken
 *     放进浏览器地址栏；旧版桥接不支持时回退 ?token= 并明确提示；
 *   · 运行模式：优先写桥接 /api/mode（它负责写穿 DSH settings 的 qq-mode 命名空间），
 *     桥接不可用时退回 writeSettingsMode 注入实现，并**回读校验**真实生效值；
 *   · 模型：默认显示桥接 config.json.dsh 的真实值；改模型走桥接 POST /api/dsh/model
 *     （桥接自己落盘 + 递增代号让已有会话在下一条消息重应用），绝不在面板里假装成功。
 *
 * 安全边界：
 *   · 只探测/打开 127.0.0.1，不对外网暴露；
 *   · consoleToken 只出现在 host 进程；打开浏览器时换成一次性票据；
 *   · POST 侧由 index.js 统一做回环 + JSON + Origin 校验；
 *   · 只停止**自己启动并仍能验证归属**的进程；外部实例返回 code:'external'。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { connect } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

/** 桥接 README 里的默认控制台端口（本机可能被 config.json 改成 3101）。 */
export const DEFAULT_CONSOLE_PORT = 3100

/** 允许面板托管启动的服务名。 */
export const SERVICES = ['bridge', 'llbot']

/** 运行模式：界面上平铺的三档 + 一个必须提示权限风险的高级档。 */
export const MODES = ['chat', 'reserved', 'reserved2']
export const ADVANCED_MODES = ['closed-agent']
export const MODE_LABELS = {
  chat: 'chat · 纯聊天',
  reserved: 'reserved · 一代仿真',
  reserved2: 'reserved2 · 二代仿真（当前常用）',
  'closed-agent': 'closed-agent · 封闭 Agent（完整本地工具面，危险）',
}
export const MODE_RISK = {
  'closed-agent': '这个模式会挂载**完整本地工具面**（可执行命令、读写文件、派生 agent）。'
    + '只应在你完全信任的私聊（ownerQQ）里使用；群里任何人都不能进入这个模式。',
}
/** 面板版本（status 里透出，便于确认 DSH 加载的是哪一版 host 半）。 */
export const PANEL_VERSION = '0.3.2'

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** 服务状态常量，避免各处拼字符串。 */
export const STATE = {
  OK: 'ok',
  DEGRADED: 'degraded',
  DOWN: 'down',
  UNKNOWN: 'unknown',
  WAITING: 'waiting',
  EXTERNAL: 'external',
}

// ── 配置读取 ────────────────────────────────────────────────────────────────

/**
 * 从插件包目录向上找桥接仓库根（同时存在 config.json 与 src/bridge.js）。
 * `QQ_BRIDGE_DIR` 显式指定时优先，便于 npm 安装 / 多副本场景。
 */
export function resolveRepoDir(startDir, env = process.env) {
  const fromEnv = String(env.QQ_BRIDGE_DIR ?? '').trim()
  if (fromEnv) return resolve(fromEnv)
  let dir = resolve(startDir)
  for (let depth = 0; depth < 6; depth += 1) {
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

/**
 * 只允许回环 URL：面板打开/探测的目标必须由配置派生，且 host 必须是 127.0.0.1 / localhost / [::1]。
 * 这条检查同时挡住「配置被改成内网/外网地址」与「index.js 把任意 URL 传进来」两类问题。
 */
export function assertLoopbackUrl(url, { label = 'URL' } = {}) {
  let parsed
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    throw new Error(`${label} 不是合法 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} 只允许 http/https`)
  const host = parsed.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`${label} 只允许本机回环地址（实际 ${host}）`)
  }
  return parsed
}

/** LLBot WebUI 密码：直接配置优先，其次从文件读（LLBot 自己把密码写在那里）。 */
export function llbotWebuiPasswordOf(config) {
  const direct = String(config?.snowluma?.webuiPassword ?? '').trim()
  if (direct) return direct
  const file = String(config?.snowluma?.webuiPasswordFile ?? '').trim()
  if (!file) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/** LLBot WebUI 的鉴权头：X-Webui-Token = sha256(密码)。 */
export function llbotWebuiTokenOf(config) {
  const password = llbotWebuiPasswordOf(config)
  return password ? createHash('sha256').update(password).digest('hex') : ''
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

/**
 * LLBot 启动计划：只使用**明确配置的固定命令**或**从可信 launcherPath 派生**的命令。
 * 浏览器永远不能提交命令 —— index.js 只接受 service 名，不接受 command。
 *
 * 派生条件（缺一不可）：snowluma.launcherPath 指向一个存在的 .js 文件、panel.llbotQq 是数字。
 * 派生出来的是 `[node, <launcherPath>, '--qq', <qq>]`，与 README 里手工启动的方式一致。
 *
 * @returns {{available: boolean, command: string[], cwd: string, source: 'config'|'derived'|'', reason: string, display: string}}
 */
export function llbotLaunchPlanOf(config, { repoDir, nodePath } = {}) {
  const configured = llbotCommandOf(config)
  if (configured.length > 0) {
    return {
      available: true,
      command: configured,
      cwd: llbotCwdOf(config, repoDir),
      source: 'config',
      reason: '',
      display: configured.join(' '),
      qq: '',
      qqSource: 'panel.llbotCommand',
    }
  }
  const launcher = String(config?.snowluma?.launcherPath ?? '').trim()
  let qq = String(config?.panel?.llbotQq ?? '').trim()
  let qqSource = qq ? 'panel.llbotQq' : ''
  if (!launcher || !existsSync(launcher)) {
    return { available: false, command: [], cwd: '', source: '', reason: '未配置 panel.llbotCommand，且 snowluma.launcherPath 不存在', display: '', qq: '', qqSource: '' }
  }
  // 公开发布场景：用户不一定愿意手工填 QQ 号。LLBot 首次登录成功后会在自己的 data 目录
  // 写 `config_<QQ>.json`，所以只要那里**恰好只有一个**账号，就据此推导启动参数。
  // 多个账号时**不猜**（宁可让用户显式配置，也不要在错误账号上启动）。
  if (!qq) {
    const candidateDirs = []
    const homeDir = String(config?.snowluma?.homeDir ?? '').trim()
    if (homeDir) candidateDirs.push(homeDir)
    const sibling = join(dirname(launcher), 'data')
    if (!candidateDirs.includes(sibling)) candidateDirs.push(sibling)
    for (const dir of candidateDirs) {
      try {
        const qqs = [...new Set(readdirSync(dir)
          .map((name) => /^config_(\d{5,12})\.json$/.exec(name)?.[1])
          .filter(Boolean))]
        if (qqs.length === 1) {
          qq = qqs[0]
          qqSource = `LLBot 数据目录 ${dir} 的 config_${qq}.json`
          break
        }
        if (qqs.length > 1) {
          return {
            available: false,
            command: [],
            cwd: dirname(launcher),
            source: '',
            reason: `LLBot 数据目录 ${dir} 里有多个账号（${qqs.join(' / ')}），请显式设置 panel.llbotQq`,
            display: '',
            qq: '',
            qqSource: '',
          }
        }
      } catch {}
    }
  }
  if (!/^\d{5,12}$/.test(qq)) {
    return {
      available: false,
      command: [],
      cwd: dirname(launcher),
      source: '',
      reason: '未配置 panel.llbotCommand；要从 launcherPath 派生启动命令还需要 panel.llbotQq（QQ 号）',
      display: '',
    }
  }
  if (!nodePath) {
    return { available: false, command: [], cwd: dirname(launcher), source: '', reason: '找不到 node，无法派生 LLBot 启动命令', display: '', qq, qqSource }
  }
  const command = [nodePath, launcher, '--qq', qq]
  return { available: true, command, cwd: dirname(launcher), source: 'derived', reason: '', display: command.join(' '), qq, qqSource }
}

// ── 网络探测 ────────────────────────────────────────────────────────────────

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
export async function httpJson(url, { headers = {}, timeoutMs = 1500, method = 'GET', body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: res.ok, status: res.status, json, text }
  } catch (error) {
    return { ok: false, status: 0, json: null, text: '', error: String(error?.message ?? error) }
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

// ── 进程归属（磁盘登记 + 指纹校验）─────────────────────────────────────────
//
// 为什么不能只用内存里的 child 句柄：DSH 一重启 / HMR 一刷新 / 面板重建，内存就没了，
// 于是「面板启动的桥接」会被误判成外部实例，用户再也停不掉它（反向也危险：把外部进程
// 当成自己的 kill 掉）。所以启动成功后把 `{pid, command, cwd, startedAt, port}` 落到
// `state/panel-services.json`，之后每次判定归属都做三重校验：
//   ① pid 还活着（kill(pid,0)）；② 命令行仍包含我们当初启动的指纹；③ 端口仍在监听。
// 三条同时成立才允许 stop。

export function createOwnershipStore({ file, fs = { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync, renameSync, rmSync }, kill = process.kill, execFile = execFileSync, platform = process.platform } = {}) {
  const readAll = () => {
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeAll = (value) => {
    try {
      fs.mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
      fs.renameSync(temp, file)
    } catch {}
  }

  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  /** 取进程命令行：用于确认「这个 pid 还是当初那个程序」，防 pid 复用。 */
  const commandOf = (pid) => {
    try {
      if (platform === 'linux') {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
      }
      const out = String(execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) ?? '').trim()
      return out
    } catch {
      return ''
    }
  }

  const matches = (record) => {
    if (!record || !alive(record.pid)) return false
    const actual = commandOf(record.pid)
    if (!actual) return false
    for (const needle of record.fingerprint ?? []) {
      if (needle && !actual.includes(needle)) return false
    }
    return true
  }

  return {
    readAll,
    alive,
    commandOf,
    matches,
    /** 记录一个面板启动的服务。 */
    record(service, record) {
      const all = readAll()
      all[service] = {
        ...record,
        owner: 'qq-bridge-panel',
        host: hostname(),
        recordedAt: new Date().toISOString(),
      }
      writeAll(all)
      return all[service]
    },
    /** 取某个服务的登记；不满足三重校验时返回 null（并顺手清掉过期条目）。 */
    verify(service, record) {
      const all = readAll()
      const entry = record ?? all[service]
      if (!entry) return null
      if (!matches(entry)) {
        delete all[service]
        writeAll(all)
        return null
      }
      return entry
    },
    clear(service) {
      const all = readAll()
      if (!all[service]) return
      delete all[service]
      writeAll(all)
    },
  }
}

// ── 服务管理器 ──────────────────────────────────────────────────────────────

/**
 * 服务管理器：状态 / 一键启动 / 启停 / 重启 / 打开 / 模式 / 模型。
 *
 * 所有外部副作用（spawn、probe、open、node 解析、catalog、会话应用、settings 读写）
 * 都可注入 —— 离线测试用真实临时进程 + 假 HTTP 端验证行为，不碰真实桥接与浏览器。
 */
export function createServiceManager({
  repoDir,
  resolveNode = async () => null,
  spawnImpl = spawn,
  probe = probePort,
  openImpl = openUrlNative,
  platform = process.platform,
  env = process.env,
  startTimeoutMs = 20000,
  llbotStartTimeoutMs = 90000,
  stopTimeoutMs = 8000,
  // 以下由 index.js 注入（DSH host 能力），离线测试可给桩：
  catalogProvider = async () => null,
  readSettingsMode = async () => null,
  writeSettingsMode = async () => ({ ok: false, message: '当前宿主没有注入 settings 写入实现' }),
  applySessionModel = async () => ({ ok: false, message: '当前宿主没有注入会话模型应用实现' }),
  log = () => {},
} = {}) {
  const stateDir = join(repoDir, 'state')
  const logDir = join(stateDir, 'panel-logs')
  const ownershipFile = join(stateDir, 'panel-services.json')
  const ownership = createOwnershipStore({ file: ownershipFile, platform })
  const children = new Map()
  let nodePromise = null
  let lastClientPing = 0
  let lastError = ''
  let lastAction = null

  const setError = (message) => {
    lastError = String(message ?? '')
    if (lastError) log(`[panel] ${lastError}`)
  }

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

  const readConfig = () => {
    const loaded = loadBridgeConfig(repoDir)
    const config = loaded.config ?? {}
    return {
      loaded,
      config,
      bridgePort: consolePortOf(config),
      bridgeToken: consoleTokenOf(config, repoDir),
      bridgeBase: `http://127.0.0.1:${consolePortOf(config)}`,
      llbotUrl: llbotWebuiUrlOf(config),
      llbotPort: portOfUrl(llbotWebuiUrlOf(config)),
      llbotCommand: llbotCommandOf(config),
      llbotCwd: llbotCwdOf(config, repoDir),
      llbotWebuiToken: llbotWebuiTokenOf(config),
      dshBaseUrl: String(config?.dsh?.baseUrl ?? '').trim(),
      model: {
        provider: String(config?.dsh?.provider ?? ''),
        model: String(config?.dsh?.model ?? ''),
        reasoningEffort: String(config?.dsh?.reasoningEffort ?? ''),
      },
      modelScope: String(config?.dsh?.modelScope ?? 'session').trim().toLowerCase() === 'global' ? 'global' : 'session',
    }
  }

  /** 追加/读取服务日志文件（spawn 的 stdout/stderr 直接重定向到文件）。 */
  const logFileOf = (service) => join(logDir, `${service}.log`)
  const tailLog = (service, count = 8) => {
    try {
      const text = readFileSync(logFileOf(service), 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean)
      return lines.slice(-count).join('\n')
    } catch {
      return ''
    }
  }

  const spawnService = (service, command, args, { cwd, fingerprint }) => {
    mkdirSync(logDir, { recursive: true })
    const logFile = logFileOf(service)
    let fd = -1
    try {
      fd = openSync(logFile, 'a')
      // 每次启动写一行分隔，免得日志里分不清几次运行的输出。
      writeFileSync(logFile, `\n===== ${new Date().toISOString()} 启动 ${service}：${command} ${args.join(' ')} =====\n`, { flag: 'a' })
    } catch {
      fd = -1
    }
    let child
    try {
      // detached + unref：DSH 退出/刷新后服务继续跑，面板重启后靠登记信息重新接管。
      child = spawnImpl(command, args, {
        cwd,
        env: { ...env },
        detached: true,
        stdio: ['ignore', fd === -1 ? 'ignore' : fd, fd === -1 ? 'ignore' : fd],
        windowsHide: true,
      })
    } finally {
      if (fd !== -1) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
    try {
      child.unref()
    } catch {}
    children.set(service, child)
    const record = ownership.record(service, {
      pid: child.pid,
      command: [command, ...args],
      fingerprint,
      cwd,
      startedAt: new Date().toISOString(),
      port: 0,
    })
    child.once('exit', (code, signal) => {
      if (children.get(service) === child) children.delete(service)
      try {
        writeFileSync(logFile, `[exit] code=${code ?? ''} signal=${signal ?? ''}\n`, { flag: 'a' })
      } catch {}
    })
    child.once('error', (error) => {
      if (children.get(service) === child) children.delete(service)
      setError(`${service} 启动失败：${error?.message ?? error}`)
    })
    return { child, record }
  }

  /** 端口是否在监听（带超时）；返回是否达到期望。 */
  const waitForPort = (port, want, timeoutMs) => waitPort(port, want, timeoutMs, probe)

  /** 停止：只有「登记信息仍能验证归属」的进程才允许发信号。 */
  async function stopOwned(service) {
    const config = readConfig()
    const port = service === 'bridge' ? config.bridgePort : config.llbotPort
    const entry = ownership.verify(service)
    if (!entry) {
      const open = port ? await probe(port) : false
      if (open) {
        return {
          ok: false,
          code: 'external',
          message: '这个实例不是面板启动的（或面板已无法验证它的归属），请到你启动它的终端/启动台里停止',
        }
      }
      return { ok: true, already: true, message: '当前未在运行' }
    }
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(entry.pid, signal)
      } catch (error) {
        if (error?.code === 'ESRCH') break
      }
      const closed = port ? await waitForPort(port, false, stopTimeoutMs) : true
      if (closed) {
        ownership.clear(service)
        children.delete(service)
        return { ok: true, stopped: true, pid: entry.pid, message: signal === 'SIGTERM' ? '已停止' : '已强制停止（SIGKILL）' }
      }
    }
    return { ok: false, message: `已发送结束信号，但端口 ${port} 仍在监听；请稍后重试或手动检查` }
  }

  // ── 健康检查 ──────────────────────────────────────────────────────────────

  /** 桥接控制台健康：/api/status 必须返回 JSON，且报告 dshReady / mode。 */
  async function bridgeHealth(config) {
    if (!config.bridgeToken) {
      return { state: STATE.UNKNOWN, detail: '未配置控制台令牌，无法确认桥接身份（端口可能在监听，但不是我们认识的桥接）', live: null }
    }
    const res = await httpJson(`${config.bridgeBase}/api/status`, {
      headers: { 'x-console-token': config.bridgeToken },
      timeoutMs: 2500,
    })
    if (!res.ok || !res.json || typeof res.json !== 'object' || typeof res.json.mode !== 'string') {
      return {
        state: STATE.DEGRADED,
        detail: res.error ? `控制台无响应（${res.error}）` : `控制台返回异常（HTTP ${res.status}），端口上可能不是桥接`,
        live: null,
      }
    }
    const live = res.json
    const snow = live.snowluma && typeof live.snowluma === 'object' ? live.snowluma : null
    const upstreamDown = snow ? snow.good === false || snow.degraded === true || snow.silent === true : false
    return {
      state: upstreamDown ? STATE.DEGRADED : STATE.OK,
      detail: upstreamDown ? (snow?.hint || '桥接在运行，但与 QQ 上游（OneBot/LLBot）的连接不健康') : '控制台可访问',
      live,
    }
  }

  /** LLBot 健康 + QQ 登录态：以 WebUI /api/login-info 为准（不是「端口开着」）。 */
  async function llbotHealth(config) {
    if (!config.llbotPort) {
      return { state: STATE.UNKNOWN, detail: '未配置 snowluma.webuiUrl，无法确定 LLBot 端口', login: { state: STATE.UNKNOWN, uin: '', nick: '' }, endpointReachable: false }
    }
    const url = assertLoopbackSafe(config.llbotUrl)
    if (!url) return { state: STATE.UNKNOWN, detail: 'LLBot WebUI 地址不是回环地址，已忽略', login: { state: STATE.UNKNOWN, uin: '', nick: '' }, endpointReachable: false }
    if (!config.llbotWebuiToken) {
      return {
        state: STATE.UNKNOWN,
        detail: '已在端口监听，但没有 LLBot WebUI 密码（snowluma.webuiPassword / webuiPasswordFile），无法查询 QQ 登录状态',
        login: { state: STATE.UNKNOWN, uin: '', nick: '' },
        endpointReachable: true,
      }
    }
    const res = await httpJson(`${url}/api/login-info`, {
      headers: { 'x-webui-token': config.llbotWebuiToken },
      timeoutMs: 2500,
    })
    if (!res.ok || !res.json) {
      return {
        state: STATE.DEGRADED,
        detail: res.error ? `WebUI 无响应（${res.error}）` : `WebUI 返回异常（HTTP ${res.status}）`,
        login: { state: STATE.UNKNOWN, uin: '', nick: '' },
        endpointReachable: true,
      }
    }
    const data = res.json.data ?? {}
    const online = data.online === true && String(data.uin ?? '').trim() !== ''
    return {
      state: STATE.OK,
      detail: online ? 'LLBot 运行中，QQ 已登录' : 'LLBot 运行中，等待 QQ 扫码登录',
      login: {
        state: online ? 'online' : 'waiting',
        uin: String(data.uin ?? ''),
        nick: String(data.nick ?? ''),
        raw: { online: data.online === true, mode: String(data.mode ?? '') },
      },
      endpointReachable: true,
    }
  }

  /** OneBot HTTP 是否可用（旧 SnowLuma 有 /get_status；LLBot 未登录时通常不开这个端口）。 */
  async function onebotHealth(config) {
    const httpUrl = String(config?.config?.snowluma?.httpUrl ?? '').trim()
    if (!httpUrl) return { state: STATE.UNKNOWN, detail: '未配置 snowluma.httpUrl' }
    const safe = assertLoopbackSafe(httpUrl)
    if (!safe) return { state: STATE.UNKNOWN, detail: 'OneBot 地址不是回环地址，已忽略' }
    const token = String(config?.config?.snowluma?.accessToken ?? '').trim()
    const res = await httpJson(`${safe}/get_status`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: {},
      timeoutMs: 2500,
    })
    if (!res.ok || !res.json) return { state: STATE.DOWN, detail: res.error ? `OneBot 无响应（${res.error}）` : `OneBot 返回 HTTP ${res.status}` }
    const online = res.json.online === true || res.json.good === true
    return { state: online ? STATE.OK : STATE.DEGRADED, detail: online ? 'OneBot 在线' : 'OneBot 可达但自报离线', data: res.json }
  }

  /** DSH 连接：桥接的 dshReady（= 桥接到 DSH 的 RPC 通道可用）。 */
  async function dshHealth(config, bridgeLive) {
    if (!config.dshBaseUrl) return { state: STATE.UNKNOWN, detail: '桥接未配置 dsh.baseUrl' }
    const safe = assertLoopbackSafe(config.dshBaseUrl)
    if (!safe) return { state: STATE.UNKNOWN, detail: 'DSH 地址不是回环地址，已忽略' }
    if (bridgeLive) {
      return {
        state: bridgeLive.dshReady === true ? STATE.OK : STATE.DEGRADED,
        detail: bridgeLive.dshReady === true ? '桥接已连上 DSH' : '桥接在运行，但尚未连上 DSH',
      }
    }
    const res = await httpJson(`${safe}/`, { timeoutMs: 1200 })
    return {
      state: res.status > 0 ? STATE.UNKNOWN : STATE.DOWN,
      detail: res.status > 0 ? 'DSH 在监听，但桥接未运行，无法确认桥接连通' : 'DSH 不可达',
    }
  }

  function assertLoopbackSafe(url) {
    try {
      return assertLoopbackUrl(url).href.replace(/\/$/, '')
    } catch {
      return ''
    }
  }

  // 令牌掩码：**一个字符都不回显**，只给长度。前端只需要知道「配了没有」。
  const maskToken = (value) => (value ? `已配置（${String(value).length} 位，不在面板/接口里回显）` : '')

  /**
   * 消息链路：桥接到底有没有连上 LLBot 的 OneBot WebSocket。
   *
   * 为什么必须单独判（2026-10-24 真实事故）：「桥接控制台可达」≠「收得到 QQ 消息」。
   * 先启桥接、再扫码登录 LLBot 时，桥接的 WS 客户端首次连接就失败且**永不重连**，
   * 而 /api/status 依然健康（get_status 走 HTTP，是通的）→ 面板四项全绿「全部就绪」，
   * 用户却一条回复都收不到。只用端口/HTTP 推断永远发现不了这种状态，必须看
   * `snowluma.connected` 这个由真实 WS 连接状态写出的字段。
   */
  function messagePathOf(bridge) {
    if (!bridge?.live) {
      return { state: STATE.UNKNOWN, connected: null, detail: '桥接未运行或控制台不可达，无法确认消息链路', actionable: false }
    }
    const up = bridge.live.snowluma
    if (typeof up?.connected !== 'boolean') {
      // 老版本桥接不上报该字段：如实说"确认不了"，不要假报健康，也不要把用户吓去重启。
      return { state: STATE.UNKNOWN, connected: null, detail: '桥接未上报消息链路状态（版本较旧），无法确认能否收发', actionable: false }
    }
    if (up.connected === true) {
      const online = up.accountOnline === true ? '，账号在线' : up.accountOnline === false ? '，账号离线' : ''
      return { state: STATE.OK, connected: true, detail: `桥接已连上 LLBot OneBot${online}（消息可收发）`, actionable: false }
    }
    return {
      state: STATE.DEGRADED,
      connected: false,
      detail: '桥接在运行，但没连上 LLBot 的 OneBot WebSocket：QQ 消息收不到、回复也发不出',
      hint: '桥接启动时 LLBot 若还没就绪（例如还没扫码登录），修复版会自动重连；旧版需要重启桥接。',
      action: 'restart-bridge',
      actionable: true,
    }
  }

  // ── 状态汇总 ──────────────────────────────────────────────────────────────

  async function status() {
    const config = readConfig()
    const nodePath = await resolveNodeOnce()
    const [bridgePortOpen, llbotPortOpen, bridge, llbot] = await Promise.all([
      probe(config.bridgePort),
      config.llbotPort ? probe(config.llbotPort) : Promise.resolve(false),
      bridgeHealth(config),
      llbotHealth(config),
    ])
    const onebot = await onebotHealth(config)
    const dsh = await dshHealth(config, bridge.live)
    const bridgeEntry = ownership.verify('bridge')
    const llbotEntry = ownership.verify('llbot')

    const bridgeState = bridgePortOpen ? bridge.state : STATE.DOWN
    const bridgeOwned = Boolean(bridgeEntry && bridgePortOpen)
    const llbotOwned = Boolean(llbotEntry && llbotPortOpen)
    const llbotState = llbotPortOpen ? llbot.state : STATE.DOWN

    // QQ 登录态：优先 LLBot /api/login-info（真正的登录信息），其次桥接 /api/status 的
    // snowluma.accountOnline（它反映 QQ 账号是否在线），最后 OneBot 自报。**绝不**用端口推断。
    let qq = { state: STATE.UNKNOWN, detail: '无法确认（LLBot/桥接都没提供登录信息）', source: '' }
    if (llbot.login.state === 'online') {
      qq = { state: 'online', detail: `已登录${llbot.login.nick ? `（${llbot.login.nick}）` : ''}${llbot.login.uin ? ` · ${llbot.login.uin}` : ''}`, source: 'llbot /api/login-info' }
    } else if (llbot.login.state === 'waiting') {
      qq = { state: STATE.WAITING, detail: '等待扫码登录（打开 LLBot WebUI 扫码）', source: 'llbot /api/login-info' }
    } else if (bridge.live?.snowluma?.accountOnline === true) {
      qq = { state: 'online', detail: '桥接上报账号在线', source: 'bridge /api/status snowluma' }
    } else if (bridge.live?.snowluma?.accountOnline === false) {
      qq = { state: STATE.WAITING, detail: '桥接上报账号离线（等待扫码/登录）', source: 'bridge /api/status snowluma' }
    } else if (onebot.data && onebot.data.online === true) {
      qq = { state: 'online', detail: 'OneBot 自报在线', source: 'onebot /get_status' }
    }

    const messagePath = messagePathOf(bridge)

    // 综合状态：全部就绪 / 部分就绪 / 等待登录 / 收发链路中断 / 服务异常 / 全部停止
    let aggregate = 'stopped'
    let aggregateText = '全部停止'
    const running = (bridgeState === STATE.OK || bridgeState === STATE.DEGRADED) || (llbotState === STATE.OK || llbotState === STATE.DEGRADED)
    if (!running && !bridgePortOpen && !llbotPortOpen) {
      aggregate = 'stopped'
      aggregateText = '全部停止'
    } else if (bridgeState === STATE.DOWN && llbotState === STATE.DOWN) {
      aggregate = 'stopped'
      aggregateText = '全部停止'
    } else if (bridgeState === STATE.DEGRADED || bridgeState === STATE.UNKNOWN || llbotState === STATE.DEGRADED) {
      aggregate = 'error'
      aggregateText = '服务异常'
    } else if (qq.state !== 'online') {
      aggregate = 'waiting-login'
      aggregateText = qq.state === STATE.WAITING ? '等待 QQ 登录' : '等待 QQ 登录（状态未知）'
    } else if (messagePath.state === STATE.DEGRADED) {
      // 服务全在跑、QQ 也登录了，唯独桥接↔LLBot 的 WS 没连上：**这就是收发全废的状态**，
      // 绝不能判"全部就绪"（2026-10-24 事故原样：面板全绿、消息一条不进）。
      aggregate = 'upstream'
      aggregateText = '收发链路中断'
    } else if (bridgeState === STATE.OK && llbotState === STATE.OK && dsh.state === STATE.OK) {
      aggregate = 'ready'
      aggregateText = '全部就绪'
    } else {
      aggregate = 'partial'
      aggregateText = '部分就绪'
    }

    // 运行模式：桥接在线时以它为准（真实生效值），否则退回 DSH settings。
    let mode = { current: '', source: '', options: MODES, advanced: ADVANCED_MODES, labels: MODE_LABELS, risk: MODE_RISK, verified: false }
    if (bridge.live && typeof bridge.live.mode === 'string' && bridge.live.mode) {
      mode = { ...mode, current: bridge.live.mode, source: 'bridge /api/status', verified: true }
    } else {
      try {
        const settings = await readSettingsMode()
        if (settings && typeof settings.mode === 'string' && settings.mode) {
          mode = { ...mode, current: settings.mode, source: 'DSH settings qq-mode', verified: false, ownerQQ: settings.ownerQQ ?? '' }
        }
      } catch {}
    }
    if (!mode.current) {
      mode.current = ''
      mode.source = 'unknown'
    }

    // 模型：桥接在线时读它真实在用的；否则读 config.json（下次启动生效）。
    let model = {
      scope: config.modelScope,
      globalSideEffect: config.modelScope === 'global',
      current: { ...config.model, effortMode: config.model.reasoningEffort === 'auto' ? 'auto' : 'explicit' },
      source: 'config.json',
      catalog: null,
      catalogError: '',
      efforts: [],
      reasoningSupported: false,
      effortChecked: false,
    }
    if (bridge.live) {
      const res = await httpJson(`${config.bridgeBase}/api/dsh/model`, {
        headers: { 'x-console-token': config.bridgeToken },
        timeoutMs: 3000,
      })
      if (res.ok && res.json) {
        model = {
          ...model,
          current: {
            provider: String(res.json.provider ?? ''),
            model: String(res.json.model ?? ''),
            reasoningEffort: String(res.json.reasoningEffort ?? ''),
            effortMode: res.json.effortMode === 'auto' ? 'auto' : 'explicit',
          },
          efforts: Array.isArray(res.json.efforts) ? res.json.efforts : [],
          reasoningSupported: res.json.reasoningSupported === true,
          effortChecked: res.json.effortChecked === true,
          source: 'bridge /api/dsh/model',
          modelScope: res.json.modelScope ?? model.scope,
          globalSideEffect: res.json.globalSideEffect === true,
        }
      } else {
        model.catalogError = '桥接控制台没有响应 /api/dsh/model'
      }
    }
    // 模型目录：来自 DSH host（ctx.sessionController.modelCatalog()）。失败不致命。
    try {
      const catalog = await catalogProvider()
      if (catalog && Array.isArray(catalog.groups)) model.catalog = catalog
      else model.catalogError = model.catalogError || 'DSH 模型目录不可用'
    } catch (error) {
      model.catalogError = `读取 DSH 模型目录失败：${error?.message ?? error}`
    }

    return {
      ok: true,
      panel: {
        version: PANEL_VERSION,
        repoDir,
        configFile: config.loaded.file,
        configFound: config.loaded.exists,
        configError: config.loaded.error,
        nodePath: nodePath ?? '',
        platform,
        stateDir,
        logDir,
        lastError,
        lastAction,
        client: { seen: lastClientPing > 0, at: lastClientPing > 0 ? new Date(lastClientPing).toISOString() : '' },
        llbotLaunch: (() => {
          const plan = llbotLaunchPlanOf(config.config, { repoDir, nodePath })
          return { available: plan.available, source: plan.source, reason: plan.reason, display: plan.display, cwd: plan.cwd, qq: plan.qq ?? '', qqSource: plan.qqSource ?? '' }
        })(),
      },
      aggregate,
      aggregateText,
      // 消息链路（桥接 ↔ LLBot OneBot WS）：与端口/HTTP 健康分开报，
      // 否则「服务全在、面板全绿、消息一条不进」这种事故永远显示不出来。
      messagePath,
      services: {
        bridge: {
          label: 'QQ Bridge',
          running: bridgePortOpen,
          port: config.bridgePort,
          owned: bridgeOwned,
          ownership: bridgeOwned ? { pid: bridgeEntry.pid, startedAt: bridgeEntry.startedAt } : (bridgePortOpen ? { pid: null, startedAt: '' } : null),
          health: bridgeState,
          detail: bridge.detail,
          mode: bridge.live?.mode ?? '',
          dshReady: bridge.live?.dshReady === true,
          tokenConfigured: Boolean(config.bridgeToken),
          tokenMasked: maskToken(config.bridgeToken),
          lastLog: tailLog('bridge', 8),
          upstream: bridge.live?.snowluma ?? null,
          openUrl: config.bridgeBase,
        },
        llbot: {
          label: 'LLBot',
          running: llbotPortOpen,
          port: config.llbotPort,
          url: config.llbotUrl,
          owned: llbotOwned,
          ownership: llbotOwned ? { pid: llbotEntry.pid, startedAt: llbotEntry.startedAt } : (llbotPortOpen ? { pid: null, startedAt: '' } : null),
          health: llbotState,
          detail: llbot.detail,
          login: llbot.login,
          startable: llbotLaunchPlanOf(config.config, { repoDir, nodePath }).available,
          lastLog: tailLog('llbot', 8),
        },
        onebot,
        dsh: { ...dsh, baseUrl: config.dshBaseUrl },
        qq,
      },
      mode,
      model,
    }
  }

  // ── 启动 / 停止 / 重启 ────────────────────────────────────────────────────

  async function startBridge() {
    const config = readConfig()
    if (await probe(config.bridgePort)) {
      const health = await bridgeHealth(config)
      return { ok: true, already: true, service: 'bridge', message: `桥接已在运行（${health.detail}）`, health }
    }
    const nodePath = await resolveNodeOnce()
    if (!nodePath) return { ok: false, service: 'bridge', message: '找不到 Node（可设置环境变量 QQ_BRIDGE_NODE 指向 Node ≥ 22.13）' }
    // 用**绝对路径**启动：进程命令行里就带着仓库路径，归属校验（ps command 指纹）
    // 才能区分「我们启动的这份桥接」与别处同名的桥接；cwd 仍是仓库根，配置解析不变。
    const entryScript = join(repoDir, 'src', 'bridge.js')
    const { child } = spawnService('bridge', nodePath, [entryScript], {
      cwd: repoDir,
      fingerprint: ['src/bridge.js', repoDir],
    })
    const started = await waitForPort(config.bridgePort, true, startTimeoutMs)
    if (!started) {
      const exit = child.exitCode
      const tail = tailLog('bridge', 10)
      let message = `等待桥接端口 ${config.bridgePort} 超时（${Math.round(startTimeoutMs / 1000)} 秒）`
      if (exit !== null && exit !== undefined) message = `桥接启动后立即退出（code=${exit}）`
      if (tail) message += `\n${tail}`
      setError(message)
      return { ok: false, service: 'bridge', message }
    }
    const health = await bridgeHealth(config)
    ownership.record('bridge', {
      ...(ownership.verify('bridge') ?? {}),
      pid: child.pid,
      command: [nodePath, entryScript],
      fingerprint: ['src/bridge.js', repoDir],
      cwd: repoDir,
      startedAt: new Date().toISOString(),
      port: config.bridgePort,
    })
    return {
      ok: true,
      started: true,
      service: 'bridge',
      message: `桥接已启动（端口 ${config.bridgePort}；${health.detail}）`,
      health,
    }
  }

  async function startLlbot() {
    const config = readConfig()
    if (config.llbotPort && await probe(config.llbotPort)) {
      const health = await llbotHealth(config)
      return { ok: true, already: true, service: 'llbot', message: `LLBot 已在运行（${health.detail}）`, health }
    }
    if (!config.llbotPort) return { ok: false, service: 'llbot', message: '未配置 snowluma.webuiUrl，无法确定 LLBot 端口' }
    const nodePath = await resolveNodeOnce()
    const plan = llbotLaunchPlanOf(config.config, { repoDir, nodePath })
    if (!plan.available) {
      return {
        ok: false,
        service: 'llbot',
        code: 'not-configured',
        message: `LLBot 是第三方程序，需要显式配置才能由面板启动：${plan.reason}`,
      }
    }
    const [command, ...args] = plan.command
    const { child } = spawnService('llbot', command, args, {
      cwd: plan.cwd,
      fingerprint: [basename(plan.command[1] ?? command)],
    })
    const started = await waitForPort(config.llbotPort, true, llbotStartTimeoutMs)
    if (!started) {
      const exit = child.exitCode
      const tail = tailLog('llbot', 10)
      let message = `等待 LLBot WebUI 端口 ${config.llbotPort} 超时（${Math.round(llbotStartTimeoutMs / 1000)} 秒）`
      if (exit !== null && exit !== undefined) message = `LLBot 启动后立即退出（code=${exit}）`
      if (tail) message += `\n${tail}`
      setError(message)
      return { ok: false, service: 'llbot', message }
    }
    ownership.record('llbot', {
      ...(ownership.verify('llbot') ?? {}),
      pid: child.pid,
      command: plan.command,
      fingerprint: [basename(plan.command[1] ?? command)],
      cwd: plan.cwd,
      startedAt: new Date().toISOString(),
      port: config.llbotPort,
    })
    const health = await llbotHealth(config)
    // 起来了但没登录：**不是失败**，如实报「等待扫码」。
    const waiting = health.login.state !== 'online'
    return {
      ok: true,
      started: true,
      waitingLogin: waiting,
      service: 'llbot',
      message: waiting ? 'LLBot 已启动，等待 QQ 扫码登录（打开 LLBot WebUI 扫码）' : 'LLBot 已启动，QQ 已登录',
      health,
    }
  }

  async function start(service) {
    if (!SERVICES.includes(service)) return { ok: false, message: `未知服务：${service}` }
    const result = service === 'bridge' ? await startBridge() : await startLlbot()
    lastAction = { action: `start:${service}`, at: new Date().toISOString(), ok: result.ok === true, message: result.message }
    return result
  }

  async function stop(service) {
    if (!SERVICES.includes(service)) return { ok: false, message: `未知服务：${service}` }
    const result = await stopOwned(service)
    lastAction = { action: `stop:${service}`, at: new Date().toISOString(), ok: result.ok === true, message: result.message }
    return { ...result, service }
  }

  async function restart(service) {
    const stopped = await stopOwned(service)
    if (!stopped.ok && stopped.code !== 'external') return { ...stopped, service }
    if (stopped.code === 'external') return { ...stopped, service, message: '外部实例不能由面板重启，请先在你的终端里停止' }
    return start(service)
  }

  /**
   * 一键启动：LLBot → 等 WebUI/OneBot → 看 QQ 登录（等待扫码不算失败）→ 桥接 → 健康。
   * 幂等：每一步都先检查，已经在跑就记 already。部分成功如实展示。
   */
  async function startAll() {
    const steps = []
    const push = (step) => {
      steps.push({ ...step, at: new Date().toISOString() })
      log(`[panel] 一键启动：${step.id} → ${step.state}${step.message ? `（${step.message}）` : ''}`)
      return step
    }
    const started = Date.now()

    // 1) LLBot
    const llbotStep = await (async () => {
      const config = readConfig()
      if (config.llbotPort && await probe(config.llbotPort)) {
        const health = await llbotHealth(config)
        return push({ id: 'llbot', label: 'LLBot', state: 'already', message: health.detail })
      }
      const plan = llbotLaunchPlanOf(config.config, { repoDir, nodePath: await resolveNodeOnce() })
      if (!plan.available) {
        return push({ id: 'llbot', label: 'LLBot', state: 'skipped', message: `未配置代管启动（${plan.reason}）` })
      }
      const result = await startLlbot()
      return push({ id: 'llbot', label: 'LLBot', state: result.ok ? 'done' : 'failed', message: result.message })
    })()

    // 2) QQ 登录（等待扫码不算失败，但要让用户知道下一步该干什么）
    const qqStep = await (async () => {
      const config = readConfig()
      const health = await llbotHealth(config)
      if (health.login.state === 'online') return push({ id: 'qq', label: 'QQ 登录', state: 'done', message: health.detail })
      if (llbotStep.state === 'failed') return push({ id: 'qq', label: 'QQ 登录', state: 'skipped', message: 'LLBot 未就绪，无法检查登录状态' })
      return push({ id: 'qq', label: 'QQ 登录', state: 'waiting', message: '等待扫码：点「打开 LLBot WebUI」用手机 QQ 扫码' })
    })()

    // 3) OneBot 连接（LLBot 未登录时通常不开 3000/3001，属预期，不算失败）
    const onebotStep = await (async () => {
      const config = readConfig()
      const health = await onebotHealth(config)
      if (health.state === STATE.OK) return push({ id: 'onebot', label: 'OneBot', state: 'done', message: health.detail })
      if (health.state === STATE.UNKNOWN) return push({ id: 'onebot', label: 'OneBot', state: 'skipped', message: health.detail })
      return push({
        id: 'onebot',
        label: 'OneBot',
        state: qqStep.state === 'waiting' ? 'waiting' : 'failed',
        message: qqStep.state === 'waiting' ? 'QQ 尚未登录，OneBot 端口未开放（登录后自动就绪）' : health.detail,
      })
    })()

    // 4) 桥接
    const bridgeStep = await (async () => {
      const config = readConfig()
      if (await probe(config.bridgePort)) {
        const health = await bridgeHealth(config)
        return push({ id: 'bridge', label: 'QQ Bridge', state: health.state === STATE.OK ? 'already' : 'done', message: health.detail })
      }
      const result = await startBridge()
      return push({ id: 'bridge', label: 'QQ Bridge', state: result.ok ? 'done' : 'failed', message: result.message })
    })()

    // 5) DSH 连通
    const dshStep = await (async () => {
      const config = readConfig()
      const bridge = await bridgeHealth(config)
      const dsh = await dshHealth(config, bridge.live)
      if (dsh.state === STATE.OK) return push({ id: 'dsh', label: 'DSH 连接', state: 'done', message: dsh.detail })
      if (dsh.state === STATE.UNKNOWN) return push({ id: 'dsh', label: 'DSH 连接', state: 'skipped', message: dsh.detail })
      return push({ id: 'dsh', label: 'DSH 连接', state: 'failed', message: dsh.detail })
    })()

    const finalStatus = await status()
    lastAction = { action: 'start:all', at: new Date().toISOString(), ok: bridgeStep.state !== 'failed', message: finalStatus.aggregateText }
    return {
      ok: steps.every((s) => s.state !== 'failed'),
      partial: steps.some((s) => s.state === 'failed' || s.state === 'skipped' || s.state === 'waiting') && steps.some((s) => s.state === 'done' || s.state === 'already'),
      elapsedMs: Date.now() - started,
      steps,
      aggregate: finalStatus.aggregate,
      aggregateText: finalStatus.aggregateText,
      status: finalStatus,
    }
  }

  // ── 打开控制台 / WebUI ────────────────────────────────────────────────────

  async function open(target) {
    const config = readConfig()
    if (target === 'console') {
      if (!await probe(config.bridgePort)) {
        return { ok: false, target, message: '桥接未运行：先启动桥接，端口监听后才能打开控制台' }
      }
      const health = await bridgeHealth(config)
      if (!health.live) {
        return { ok: false, target, message: `无法确认端口 ${config.bridgePort} 上是桥接：${health.detail}` }
      }
      // 首选：一次性票据（长期 token 不进地址栏）。旧版桥接没有该接口时回退 ?token=。
      if (config.bridgeToken) {
        const res = await httpJson(`${config.bridgeBase}/api/console/ticket`, {
          method: 'POST',
          headers: { 'x-console-token': config.bridgeToken },
          body: {},
          timeoutMs: 3000,
        })
        if (res.ok && res.json?.ticket) {
          const url = `${config.bridgeBase}/auth/ticket?t=${encodeURIComponent(res.json.ticket)}`
          await openImpl(url, { platform })
          return {
            ok: true,
            opened: true,
            target,
            mode: 'ticket',
            message: '已在系统浏览器打开桥接控制台（一次性票据，60 秒内有效）',
          }
        }
      }
      const query = config.bridgeToken ? `?token=${encodeURIComponent(config.bridgeToken)}` : '/'
      await openImpl(`${config.bridgeBase}/${query}`, { platform })
      return {
        ok: true,
        opened: true,
        target,
        mode: 'token',
        warning: '当前桥接版本不支持一次性票据，已回退为令牌直连：令牌会出现在浏览器地址栏/历史里，建议升级桥接',
        message: '已在系统浏览器打开桥接控制台（回退：令牌直连）',
      }
    }
    if (target === 'llbot') {
      if (!config.llbotUrl) return { ok: false, target, message: '未配置 snowluma.webuiUrl' }
      const safe = assertLoopbackSafe(config.llbotUrl)
      if (!safe) return { ok: false, target, message: 'LLBot WebUI 地址不是本机回环地址，已拒绝打开' }
      if (!await probe(config.llbotPort)) return { ok: false, target, message: 'LLBot 未运行：先启动 LLBot，WebUI 端口监听后才能打开' }
      await openImpl(safe, { platform })
      return { ok: true, opened: true, target, message: '已在系统浏览器打开 LLBot WebUI' }
    }
    return { ok: false, message: `未知目标：${target}` }
  }

  // ── 运行模式 ──────────────────────────────────────────────────────────────

  async function setMode(requested) {
    const mode = String(requested ?? '').trim()
    if (![...MODES, ...ADVANCED_MODES].includes(mode)) {
      return { ok: false, message: `未知模式：${mode}（可选 ${[...MODES, ...ADVANCED_MODES].join(' / ')}）` }
    }
    const config = readConfig()
    const bridgeUp = await probe(config.bridgePort)
    let effective = ''
    let source = ''
    let dshSynced = null
    const warnings = []
    if (bridgeUp) {
      const res = await httpJson(`${config.bridgeBase}/api/mode`, {
        method: 'POST',
        headers: { 'x-console-token': config.bridgeToken },
        body: { mode },
        timeoutMs: 8000,
      })
      if (!res.ok || !res.json?.ok) {
        return { ok: false, message: `桥接拒绝切换模式：${res.json?.error ?? res.json?.message ?? res.error ?? `HTTP ${res.status}`}` }
      }
      effective = String(res.json.mode ?? mode)
      dshSynced = res.json.dshSynced === true
      source = 'bridge /api/mode'
      if (dshSynced) warnings.push('模式已写穿到 DSH settings（qq-mode 命名空间）')
      else warnings.push('模式只写到了桥接本地（state/mode.json）：DSH settings 同步失败，DSH 下一次轮询可能把它回滚，请检查 DSH 是否可达')
    } else {
      const written = await writeSettingsMode(mode)
      if (!written?.ok) return { ok: false, message: `桥接未运行，且写 DSH settings 失败：${written?.message ?? '未知原因'}` }
      effective = mode
      source = 'DSH settings qq-mode'
      warnings.push('桥接未运行：已写入 DSH settings，桥接启动后会以它为准')
    }
    // 回读校验：显示的是**真实生效值**，不是我们请求的值。
    const after = await status()
    const verified = after.mode.current === effective
    if (!verified) warnings.push(`回读校验未通过：当前生效模式是 ${after.mode.current || '未知'}`)
    lastAction = { action: `mode:${mode}`, at: new Date().toISOString(), ok: verified, message: warnings.join('；') }
    return {
      ok: verified,
      requested: mode,
      effective,
      current: after.mode.current,
      source,
      dshSynced,
      verified,
      warnings,
      message: verified ? `模式已切换为 ${effective}` : `模式切换未确认：请求 ${mode}，实际 ${after.mode.current || '未知'}`,
    }
  }

  async function refreshMode() {
    const after = await status()
    return { ok: true, mode: after.mode }
  }

  // ── 模型（QQ 专用）───────────────────────────────────────────────────────

  /** 在目录里找模型 + 推理能力；目录没有时返回 null。 */
  function findModel(catalog, provider, model) {
    if (!catalog) return null
    const group = (catalog.groups ?? []).find((g) => g?.id === provider)
    if (!group) return null
    const entry = (group.models ?? []).find((m) => m?.id === model)
    if (!entry) return null
    const efforts = Array.isArray(entry.reasoning?.efforts)
      ? entry.reasoning.efforts
        .map((e) => ({ id: String(e?.id ?? ''), name: String(e?.name ?? e?.id ?? ''), description: String(e?.description ?? '') }))
        .filter((e) => e.id)
      : []
    return {
      provider: group.id,
      providerName: String(group.name ?? group.id),
      model: entry.id,
      modelName: String(entry.name ?? entry.id),
      description: String(entry.description ?? ''),
      efforts,
      defaultEffort: entry.reasoning?.defaultEffort != null ? String(entry.reasoning.defaultEffort) : null,
    }
  }

  async function setModel(requested = {}) {
    const provider = String(requested.provider ?? '').trim()
    const model = String(requested.model ?? '').trim()
    if (!provider || !model) return { ok: false, message: 'provider 与 model 都不能为空' }
    let catalog = null
    let catalogError = ''
    try {
      catalog = await catalogProvider()
    } catch (error) {
      catalogError = String(error?.message ?? error)
    }
    const found = findModel(catalog, provider, model)
    if (catalog && !found) {
      return { ok: false, message: `模型 ${provider}/${model} 不在 DSH 当前可路由的模型目录里（可能是凭据缺失或 provider 未加载）` }
    }
    let effort = requested.reasoningEffort === undefined || requested.reasoningEffort === null ? '' : String(requested.reasoningEffort).trim()
    if (effort === 'auto') effort = ''
    if (effort && found) {
      if (!found.efforts.length) return { ok: false, message: `模型 ${provider}/${model} 不支持可配置的思考强度，不能提交「${effort}」` }
      if (!found.efforts.some((e) => e.id === effort)) {
        return { ok: false, message: `模型 ${provider}/${model} 不支持思考强度「${effort}」（支持：${found.efforts.map((e) => e.id).join(' / ')}）` }
      }
    } else if (effort && !found) {
      // 目录里没有这个模型：无法确认能力，按调用方要求保留请求值，但如实标记未确认。
    }
    if (!effort && found?.defaultEffort) effort = found.defaultEffort

    const config = readConfig()
    const bridgeUp = await probe(config.bridgePort)
    if (bridgeUp) {
      const res = await httpJson(`${config.bridgeBase}/api/dsh/model`, {
        method: 'POST',
        headers: { 'x-console-token': config.bridgeToken },
        body: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
        timeoutMs: 10000,
      })
      // 旧版桥接没有 POST /api/dsh/model（404/405）时，退化成「写 config.json + 提示重启桥接」：
      // 这样面板可以单独升级、不必和桥接同一时刻重启，但绝不假装已经对正在运行的桥接生效。
      const bridgeLacksEndpoint = res.status === 404 || res.status === 405
      if (bridgeLacksEndpoint) {
        return await writeConfigModel({ config, provider, model, effort, found, catalogError, reason: '旧版桥接没有 POST /api/dsh/model' })
      }
      if (!res.ok || !res.json?.ok) {
        return { ok: false, message: `桥接拒绝修改模型：${res.json?.error ?? res.json?.message ?? res.error ?? `HTTP ${res.status}`}` }
      }
      const selected = res.json.selected ?? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
      lastAction = { action: 'model', at: new Date().toISOString(), ok: true, message: `${provider}/${model}` }
      return {
        ok: true,
        source: 'bridge /api/dsh/model',
        selected,
        catalogChecked: Boolean(found),
        catalogError,
        modelScope: res.json.modelScope ?? config.modelScope,
        globalSideEffect: res.json.globalSideEffect === true,
        message: `QQ 模型已设为 ${selected.provider}/${selected.model}${selected.reasoningEffort ? `（思考强度 ${selected.reasoningEffort}）` : '（思考强度交给适配器默认）'}；新的 QQ 会话立即生效，已有会话在下一条消息生效`,
      }
    }
    // 桥接未运行：直接写 config.json（桥接下次启动生效）。保留 0600 权限与原子替换。
    return writeConfigModel({ config, provider, model, effort, found, catalogError, reason: '桥接未运行' })
  }

  /** 把模型写进桥接 config.json（原子替换 + 保留权限位）。 */
  async function writeConfigModel({ config, provider, model, effort, found, catalogError, reason }) {
    try {
      const file = config.loaded.config
      if (!file) return { ok: false, message: config.loaded.error || '读不到 config.json' }
      const next = {
        ...file,
        dsh: {
          ...(file.dsh ?? {}),
          provider,
          model,
          ...(effort ? { reasoningEffort: effort } : {}),
        },
      }
      const target = join(repoDir, 'config.json')
      const temp = `${target}.tmp-${process.pid}`
      writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
      try {
        const mode = statSync(target).mode & 0o777
        // 保留原文件的权限位（config.json 里有令牌，靠 0600 保护）。
        writeFileSync(temp, JSON.stringify(next, null, 2), { mode })
      } catch {}
      renameSync(temp, target)
      lastAction = { action: 'model', at: new Date().toISOString(), ok: true, message: `${provider}/${model}(file)` }
      return {
        ok: true,
        source: 'config.json',
        selected: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
        catalogChecked: Boolean(found),
        catalogError,
        modelScope: config.modelScope,
        globalSideEffect: config.modelScope === 'global',
        pendingRestart: true,
        message: `${reason}：已写入 config.json，桥接下次启动时生效（${provider}/${model}）`,
      }
    } catch (error) {
      return { ok: false, message: `写 config.json 失败：${error?.message ?? error}` }
    }
  }

  /** 会话局部应用（桥接进程会调这个；绝不写全局默认模型）。 */
  async function applyModelToSession(request) {
    const sessionId = String(request?.sessionId ?? '').trim()
    const provider = String(request?.provider ?? '').trim()
    const model = String(request?.model ?? '').trim()
    const reasoningEffort = request?.reasoningEffort === undefined || request?.reasoningEffort === null
      ? ''
      : String(request.reasoningEffort).trim()
    if (!sessionId) return { ok: false, message: 'sessionId 不能为空' }
    if (!provider || !model) return { ok: false, message: 'provider 与 model 都不能为空' }
    const result = await applySessionModel({ sessionId, provider, model, ...(reasoningEffort && reasoningEffort !== 'auto' ? { reasoningEffort } : {}) })
    return { ...result, sessionId }
  }

  function markClientPing() {
    lastClientPing = Date.now()
  }

  function dispose() {
    // 刻意**不杀**子进程：detached 启动的服务应当在 DSH 退出/刷新后继续运行，
    // 面板重启后靠 state/panel-services.json 重新接管（这是「归属不能只靠内存 PID」的落点）。
    // 需要停止请在面板里点停止，或到终端里停。
    log('[panel] dispose：保留已启动的服务进程（归属登记在 state/panel-services.json）')
  }

  return {
    status,
    start,
    stop,
    restart,
    startAll,
    open,
    setMode,
    refreshMode,
    setModel,
    applyModelToSession,
    markClientPing,
    dispose,
    // 供测试/诊断
    _internals: { readConfig, ownership, tailLog, findModel },
  }
}
