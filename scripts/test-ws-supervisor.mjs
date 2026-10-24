// WS 连接看门狗回归测试（纯逻辑，不连真实 QQ/LLBot）。
//
// 钉住的事故（2026-10-24 实测）：先启桥接、LLBot 还在等扫码（OneBot WS 端口未监听）时，
// Node 22 内置 WebSocket 连不上**只发 error、不发 close**，readyState 永远停在 0。
// @snowluma/sdk 的 connect() 只在 close 里清 connectPromise，于是：
//   ① 那个 promise 永不 settle；② 之后每次 connect() 都返回同一个 pending promise；
//   ③ 没有 close → SDK 不排重连 → 永久放弃。用户侧表现＝面板全绿但收发全废。
// 这里先用 FakeClient 复现 ①②③，再断言看门狗能把连接救回来。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createWsSupervisor, describeError } = await import(pathToFileURL(path.join(ROOT, 'src/ws-supervisor.js')).href)

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failed += 1
}

const CONNECTING = 0
const OPEN = 1

/**
 * 复刻 @snowluma/sdk SnowLumaWebSocketClient 的关键语义（只保留本测试关心的部分）：
 *   · socket 卡在 CONNECTING、connectPromise 永不 settle（连不上的真实形态）；
 *   · close() 才清 socket/connectPromise；
 *   · connect() 已存在 connectPromise 时直接返回它（关键：这就是死锁来源）。
 * `openOnAttempt` 用来模拟「第 N 次尝试时 LLBot 端口终于起来了」。
 */
class FakeClient {
  constructor({ openOnAttempt = Number.POSITIVE_INFINITY } = {}) {
    this.openOnAttempt = openOnAttempt
    this.attempts = 0
    this.socket = null
    this.connectPromise = null
    this.closes = []
    this.errors = []
  }

  get isConnected() {
    return this.socket?.readyState === OPEN
  }

  connect() {
    if (this.isConnected) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    this.attempts += 1
    const socket = { attempt: this.attempts, readyState: CONNECTING }
    this.socket = socket
    if (this.attempts >= this.openOnAttempt) {
      socket.readyState = OPEN
      this.connectPromise = Promise.resolve()
      return this.connectPromise
    }
    // 真实行为：只 emit('error')，永不 emit('close')，readyState 停在 0
    const error = new Error('Received network error or non-101 status code.')
    this.errors.push({ attempt: this.attempts, error })
    this.connectPromise = new Promise(() => {})   // 永不 settle
    return this.connectPromise
  }

  close(code, reason) {
    this.closes.push({ code, reason })
    this.socket = null
    this.connectPromise = null
  }
}

// ── ① 先复现：没有看门狗时，SDK 自己永远回不来 ────────────────────────────────
{
  const client = new FakeClient()
  const first = client.connect()
  const second = client.connect()
  check('前提①：连不上时 socket 停在 CONNECTING', client.socket?.readyState === CONNECTING)
  check('前提②：再次 connect() 拿到的是同一个 pending promise（死锁）', first === second)
  check('前提③：不会发起第二次尝试（SDK 无从重连）', client.attempts === 1, `attempts=${client.attempts}`)
  check('前提④：error 已经发过，但没有 close', client.errors.length === 1 && client.closes.length === 0)
}

// ── ② 看门狗在 stallMs 之后强制重建，并把连接救回来 ───────────────────────────
{
  const clock = { t: 1_000_000 }
  const client = new FakeClient({ openOnAttempt: 2 })   // 第 2 次尝试时"LLBot 起来了"
  const logs = []
  const forced = []
  const supervisor = createWsSupervisor({
    client,
    stallMs: 8_000,
    log: (msg) => logs.push(String(msg)),
    onForced: (info) => forced.push(info),
    now: () => clock.t,
  })
  client.connect()

  check('首次 tick：识别到新 socket 并开始计时', supervisor.tick().action === 'watch')
  clock.t += 3_000
  check('未到 stallMs：只等待，不动连接', supervisor.tick().action === 'wait' && client.closes.length === 0)

  clock.t += 5_000   // 累计 8s
  const forcedTick = supervisor.tick()
  check('到 stallMs：判定卡死并强制重建', forcedTick.action === 'forced', JSON.stringify(forcedTick))
  check('强制关闭用的是看门狗专用码 4002', client.closes[0]?.code === 4002)
  check('重建会真的发起下一次 connect（attempts 增加）', client.attempts === 2, `attempts=${client.attempts}`)
  check('onForced 回调给出第几次', forced.length === 1 && forced[0].attempt === 1)
  check('日志说清了"卡在连接中"与次数', logs.some((l) => l.includes('卡在连接中') && l.includes('第 1 次')), logs.join(' | '))

  check('第 2 次尝试成功：连接已建立', client.isConnected)
  check('连上之后 tick 不再动手', supervisor.tick().action === 'none' && client.closes.length === 1)
  check('连上后 forcedCount 归零', supervisor.stats().forcedCount === 0)
}

// ── ③ 连续卡死会不断重试（不能只救一次），且关闭后仍是新 socket ────────────────
{
  const clock = { t: 0 }
  const client = new FakeClient({ openOnAttempt: 4 })
  const supervisor = createWsSupervisor({ client, stallMs: 8_000, log: () => {}, now: () => clock.t })
  client.connect()
  supervisor.tick()                       // watch

  const sockets = new Set([client.socket])
  for (let i = 0; i < 3; i += 1) {
    clock.t += 8_000
    const result = supervisor.tick()
    check(`第 ${i + 1} 轮强制重建生效`, result.action === 'forced', JSON.stringify(result))
    if (client.socket) sockets.add(client.socket)
    if (i < 2) supervisor.tick()           // 新一轮 watch
  }
  check('前三次都失败、第四次成功（attempts=4）', client.attempts === 4, `attempts=${client.attempts}`)
  check('每次重建都是全新的 socket（不是复用卡死的那个）', sockets.size === 4, `distinct=${sockets.size}`)
  check('三次强制关闭、最终连上', client.closes.length === 3 && client.isConnected)
}

// ── ④ 正常路径不打扰：一次就连上时永远不动手 ─────────────────────────────────
{
  const clock = { t: 0 }
  const client = new FakeClient({ openOnAttempt: 1 })
  const supervisor = createWsSupervisor({ client, stallMs: 8_000, log: () => {}, now: () => clock.t })
  client.connect()
  let actions = []
  for (let i = 0; i < 20; i += 1) {
    clock.t += 2_000
    actions.push(supervisor.tick().action)
  }
  check('健康连接下不产生任何强制关闭', client.closes.length === 0 && client.attempts === 1)
  check('健康连接下 tick 一律为 none', actions.every((a) => a === 'none'), actions.join(','))
}

// ── ⑤ SDK 自己在退避重连（socket 为 null）时绝不插手，避免双连接 ──────────────
{
  const clock = { t: 0 }
  const client = new FakeClient()
  const supervisor = createWsSupervisor({ client, stallMs: 8_000, log: () => {}, now: () => clock.t })
  check('socket 为 null 时交给 SDK', supervisor.tick().action === 'delegate')
  clock.t += 60_000
  check('长时间空窗也不强制连接', supervisor.tick().action === 'delegate' && client.attempts === 0 && client.closes.length === 0)
}

// ── ⑥ 定时器接线（start/stop 幂等，且用注入的 interval） ─────────────────────
{
  const client = new FakeClient()
  let intervalFn = null
  let cleared = 0
  let period = 0
  const supervisor = createWsSupervisor({
    client,
    stallMs: 8_000,
    log: () => {},
    now: () => 0,
    setIntervalImpl: (fn, ms) => {
      intervalFn = fn
      period = ms
      return 'timer-1'
    },
    clearIntervalImpl: () => { cleared += 1 },
  })
  const stop = supervisor.start()
  check('start() 按 tickMs 排了定时器', typeof intervalFn === 'function' && period === 2_000, `period=${period}`)
  supervisor.start()
  check('重复 start() 不会排第二个定时器', typeof intervalFn === 'function' && cleared === 0)
  stop()
  check('stop() 清掉定时器', cleared === 1)
}

// ── ⑦ 错误文本：`{}` 事故现场不能再出现 ─────────────────────────────────────
{
  check('Error 取出 message', describeError(new Error('Received network error or non-101 status code.')) === 'Received network error or non-101 status code.')
  check('带 code 的错误两个都要', describeError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })).includes('code=ECONNREFUSED'))
  check('字符串原样返回', describeError('fetch failed') === 'fetch failed')
  check('空对象也给出非空文本（绝不打出空串）', describeError({}).length > 0, `得到 ${describeError({})}`)
  check('null/undefined 不会崩', describeError(null) === 'null' && describeError(undefined) === 'undefined')
}

// ── ⑧ 真实运行环境的前提校验（只确认"不会自己好起来"这个前提仍成立） ─────────
{
  const behavior = await new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:1/')
    const events = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    socket.addEventListener('open', () => { events.push('open'); finish({ events, readyState: socket.readyState }) })
    socket.addEventListener('error', () => { events.push('error') })
    socket.addEventListener('close', () => { events.push('close'); finish({ events, readyState: socket.readyState }) })
    setTimeout(() => finish({ events, readyState: socket.readyState }), 1500)
  })
  const opened = behavior.events.includes('open')
  check('本机 WebSocket 在端口不可用时不返回 open', !opened, JSON.stringify(behavior))
  console.log(`ℹ️ 本机 Node ${process.version} 行为：事件 ${JSON.stringify(behavior.events)}，1.5s 后 readyState=${behavior.readyState}`
    + (behavior.events.includes('close') ? '（会发 close —— 看门狗同样安全）' : '（不发 close —— 正是本次事故形态，必须有看门狗）'))
}

console.log(failed === 0 ? '\n✅ WS 看门狗回归测试通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
