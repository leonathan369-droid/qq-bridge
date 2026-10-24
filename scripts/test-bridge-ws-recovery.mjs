// 端到端回归：**真实 bridge 进程**在 LLBot 晚于桥接启动时，必须自己把 WS 连上。
//
// 事故（2026-10-24，用户现场）：面板「一键启动」先起桥接，LLBot 还在等扫码（OneBot WS
// 端口未监听）。桥接首次 WS 连接失败后**永不重试**（Node 22 内置 WebSocket 连不上只发
// error 不发 close → SDK 的 connectPromise 永不 settle），用户扫码登录成功后依旧一条
// 消息都收不到，面板却显示「全部就绪」。
//
// 这个测试复现完整时序，不需要真实 QQ / DSH / LLBot：
//   ① 在临时目录造一份"仓库"（复制 src/、软链 node_modules、写一份最小 config.json）；
//   ② DSH / LLBot（HTTP + WebUI）全部指向没在监听的端口，于是桥接既连不上 DSH 也连不上 LLBot；
//   ③ 启动真实 bridge.js，确认它卡在 WS 连接中、且此时**没有**连接；
//   ④ 在桥接配置的 WS 端口上起一个只做 101 握手的假 OneBot；
//   ⑤ 断言桥接在有限时间内自己打出「SnowLuma 已连接」——靠的是 ws-supervisor 的强制重建。
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failed += 1
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

/** 只做 101 握手的假 OneBot WS：证明"桥接确实连上了"，不模拟任何业务。 */
function startFakeOneBotWs(port) {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const server = http.createServer((req, res) => {
    res.writeHead(426)
    res.end('upgrade required')
  })
  const sockets = new Set()
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        async close() {
          for (const socket of sockets) socket.destroy()
          await new Promise((done) => server.close(done))
        },
      })
    })
  })
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ws-recovery-'))
let child = null
let fakeOnebot = null
try {
  // ── ① 临时"仓库" ──────────────────────────────────────────────────────────
  fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'))
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir')

  const consolePort = await freePort()
  const wsPort = await freePort()
  const deadDshPort = await freePort()     // 没人监听：桥接会一直重试但不会碰真实 DSH
  const deadHttpPort = await freePort()
  fs.writeFileSync(path.join(tmp, 'config.json'), `${JSON.stringify({
    consolePort,
    consoleToken: 'e2e-ws-recovery-token-0123456789',
    ownerQQ: 100000000,
    agentPreset: 'qq-chat',
    workspaceTitle: 'WS 恢复测试',
    allow: { private: [100000000], groups: [] },
    deny: { private: [], groups: [] },
    allowAllWhenEmpty: false,
    sendDelayMs: 0,
    mode: 'chat',
    dsh: { baseUrl: `http://127.0.0.1:${deadDshPort}`, provider: 'test', model: 'test', modelScope: 'session' },
    snowluma: {
      wsUrl: `ws://127.0.0.1:${wsPort}`,
      wsToken: undefined,
      httpUrl: `http://127.0.0.1:${deadHttpPort}`,
      webuiUrl: `http://127.0.0.1:${deadHttpPort}`,
      // 指向不存在的目录：禁止它去读本机真实 SnowLuma/LLBot 的 per-account token
      homeDir: path.join(tmp, 'no-such-snowluma-home'),
      accessToken: 'dead-token',
    },
    social: { enabled: false },
    slang: { enabled: false },
    socialV2: { enabled: false, sticker: { enabled: false } },
  }, null, 2)}\n`, 'utf8')

  // ── ③ 启动真实桥接（LLBot 还没起来）────────────────────────────────────────
  let output = ''
  child = spawn(process.execPath, [path.join(tmp, 'src', 'bridge.js')], {
    cwd: tmp,
    env: { ...process.env, SNOWLUMA_HOME: path.join(tmp, 'no-such-snowluma-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8') })

  const waitFor = async (predicate, timeoutMs, label) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true
      await sleep(200)
    }
    console.log(`   （等待超时：${label}）`)
    return false
  }

  const sawAnyError = await waitFor(() => /SnowLuma (错误|首次连接未成功)/.test(output), 8000, '首次连接失败日志')
  check('桥接启动后尝试连接 LLBot 并留下可读错误（不再是 `{}`）', sawAnyError, firstMatch(output, /SnowLuma (?:错误|首次连接未成功)[^\n]*/))
  check('LLBot 没起来时不会假装已连接', !output.includes('SnowLuma 已连接'))

  // ── ④ LLBot 晚到：此时才把 OneBot WS 起来 ─────────────────────────────────
  fakeOnebot = await startFakeOneBotWs(wsPort)

  // ── ⑤ 断言桥接自己连上（无需重启）────────────────────────────────────────
  const recovered = await waitFor(() => output.includes('SnowLuma 已连接'), 20000, '看门狗强制重建后连上')
  check('LLBot 晚到后桥接自动连上（不需要人工重启）', recovered)
  check('日志能看出是看门狗强制重建促成的恢复', /卡在连接中[\s\S]*SnowLuma 已连接/.test(output), firstMatch(output, /⚠️ SnowLuma WS[^\n]*/))
  check('全程只显示一条连接建立（没有重复连接/连接风暴）', (output.match(/SnowLuma 已连接/g) ?? []).length === 1)

  if (!recovered) {
    console.log('\n----- 桥接日志 -----')
    console.log(output.split('\n').filter((line) => !line.includes('连接 DSH 事件流')).join('\n'))
  }
} finally {
  try { child?.kill('SIGKILL') } catch {}
  try { await fakeOnebot?.close() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

function firstMatch(text, re) {
  const match = text.match(re)
  return match ? match[0] : ''
}

console.log(failed === 0 ? '\n✅ 桥接 WS 自动恢复端到端测试通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
