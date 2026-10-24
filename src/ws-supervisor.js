// SnowLuma OneBot WebSocket 连接看门狗。
//
// 背景（真实事故，2026-10-24 实测）：先启桥接、LLBot 还在等扫码（OneBot WS 端口 3001
// 还没监听）时，Node 22 内置 WebSocket 连不上**只发 `error`、不发 `close`**，
// `readyState` 永远停在 0（CONNECTING）。而 @snowluma/sdk 的 `connect()` 只在
// `close` 回调里清 `connectPromise` 并把 rejected promise 交出去，于是：
//   · 那个 promise 永不 settle；
//   · 之后每次 `connect()` 都直接 `return this.connectPromise`（同一个 pending promise）；
//   · 没有 `close` → SDK 的 `scheduleReconnect()` 不会排期 → **永久放弃重连**；
//   · 没有 `close` → `healTokenIfStale()`（挂在 close 上的换账号自愈）也不会跑。
// 表现极其隐蔽：进程活着、控制台可达、DSH 就绪、LLBot 显示已登录、面板「全部就绪」，
// 但 QQ 消息一条都收不到、回复也发不出去。
//
// 本模块只做一件事：socket 一直卡在 CONNECTING 超过 `stallMs`，就强制
// `close()`（由它清掉 socket / connectPromise）再 `connect()`。
// 不接管 SDK 自己正常的退避重连（`socket === null` 时什么都不做），避免双连接。

/** 从任意值里抽出人类可读的错误文本（Error 的 message 是非枚举属性，JSON.stringify 会得到 `{}`）。 */
export function describeError(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const parts = []
  if (error.message) parts.push(String(error.message))
  if (error.code) parts.push(`code=${error.code}`)
  if (!parts.length) {
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') parts.push(json)
    } catch {}
  }
  if (!parts.length) parts.push(error?.constructor?.name ?? 'Error')
  return parts.join(' ')
}

const WATCHDOG_CLOSE_CODE = 4002

export function createWsSupervisor({
  client,
  stallMs = 8000,
  tickMs = 2000,
  log = () => {},
  onForced = null,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!client || typeof client.connect !== 'function') {
    throw new TypeError('createWsSupervisor 需要一个 WebSocket 客户端（含 connect/isConnected/socket）')
  }

  let watchedSocket = null
  let stuckSince = 0
  let forcedCount = 0
  let timer = null

  const resetWatch = () => {
    watchedSocket = null
    stuckSince = 0
  }

  /**
   * 推进一次检查。返回动作，便于测试与日志：
   *   none     已连接
   *   delegate socket 为空 —— SDK 自己在退避重连，不插手
   *   watch    新 socket，开始计时
   *   settled  socket 已有结果（open/closed），交给 SDK
   *   wait     还在 CONNECTING，未到 stallMs
   *   forced   强制重建了连接
   */
  function tick() {
    if (client.isConnected) {
      resetWatch()
      forcedCount = 0
      return { action: 'none' }
    }
    const socket = client.socket ?? null
    if (!socket) {
      // 没有 socket 说明 SDK 自己已走完 close 流程、正在退避重连。此时再 connect() 会造出
      // 第二条连接（SDK 的定时器稍后也会连），所以只观察。
      resetWatch()
      return { action: 'delegate' }
    }
    if (socket !== watchedSocket) {
      watchedSocket = socket
      stuckSince = now()
      return { action: 'watch' }
    }
    // 0 = CONNECTING（WebSocket 规范）。其它值说明这次尝试已有结论，交给 SDK 处理。
    if (socket.readyState !== 0) {
      resetWatch()
      return { action: 'settled' }
    }
    const waitedMs = now() - stuckSince
    if (waitedMs < stallMs) return { action: 'wait', waitedMs }

    forcedCount += 1
    resetWatch()
    log(`⚠️ SnowLuma WS ${Math.round(waitedMs / 1000)}s 仍卡在连接中（LLBot 端口没起或握手被拒），强制重建连接（第 ${forcedCount} 次）`)
    try {
      client.close(WATCHDOG_CLOSE_CODE, 'connect-watchdog')
    } catch (error) {
      log(`   强制关闭卡死连接失败：${describeError(error)}`)
    }
    try {
      const pending = client.connect()
      if (pending && typeof pending.catch === 'function') {
        // 不 catch 会让 Node 因 unhandled rejection 退出（connect() 在 close 时会 reject）。
        pending.catch((error) => log(`   SnowLuma 重连失败：${describeError(error)}`))
      }
    } catch (error) {
      log(`   发起重连失败：${describeError(error)}`)
    }
    const result = { action: 'forced', attempt: forcedCount, waitedMs }
    if (typeof onForced === 'function') {
      try {
        onForced(result)
      } catch (error) {
        log(`   看门狗回调异常：${describeError(error)}`)
      }
    }
    return result
  }

  function start() {
    if (timer) return stop
    timer = setIntervalImpl(tick, tickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return stop
  }

  function stop() {
    if (timer) clearIntervalImpl(timer)
    timer = null
    resetWatch()
  }

  return { tick, start, stop, stats: () => ({ forcedCount, watchingStallMs: stuckSince ? now() - stuckSince : 0 }) }
}
