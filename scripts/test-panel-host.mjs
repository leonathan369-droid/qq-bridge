#!/usr/bin/env node
/**
 * qq-bridge-panel host 半的离线回归。
 * ============================================================================
 * 不启动 DSH、不碰真实桥接、不开浏览器：
 *   · 在临时目录里造一个"仓库"（config.json + 假 src/bridge.js）；
 *   · 假 bridge 是真实 Node 进程，监听临时端口并回 `/api/status`；
 *   · 用真实的 createServiceManager 跑 status / start / stop / open（open 被记录而不是执行）；
 *   · 覆盖"外部实例不能停"和"LLBot 未配置启动命令"两条边界。
 *
 * 运行：node scripts/test-panel-host.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createServiceManager,
  probePort,
  resolveRepoDir,
  waitPort,
} from '../plugins/qq-bridge-panel/lib/panel-core.js'

const results = []
function check(name, fn) {
  return (async () => {
    try {
      await fn()
      results.push({ name, ok: true })
      console.log(`PASS  ${name}`)
    } catch (error) {
      results.push({ name, ok: false, error })
      console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
    }
  })()
}

/** 让系统分配一个空闲端口，然后立刻释放，交给被测进程去监听。 */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

const DUMMY_BRIDGE = `// 假桥接：只回 /api/status，其它路径回 ok。由测试脚本写进临时仓库。
const http = require('node:http')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (String(req.url).startsWith('/api/status')) {
    res.end(JSON.stringify({ ok: true, mode: 'reserved2', dshReady: true }))
    return
  }
  res.end(JSON.stringify({ ok: true }))
})
server.listen(config.consolePort, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

const root = await mkdtemp(path.join(tmpdir(), 'qq-panel-test-'))
const repoDir = path.join(root, 'repo')
const bridgePort = await freePort()
const llbotPort = await freePort()
let manager = null
let external = null

try {
  await mkdir(path.join(repoDir, 'src'), { recursive: true })
  await writeFile(
    path.join(repoDir, 'config.json'),
    `${JSON.stringify(
      {
        consolePort: bridgePort,
        consoleToken: 'test-token',
        snowluma: { webuiUrl: `http://127.0.0.1:${llbotPort}` },
        panel: { llbotCommand: [], llbotCwd: '' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(path.join(repoDir, 'src', 'bridge.js'), DUMMY_BRIDGE, 'utf8')

  const opened = []
  manager = createServiceManager({
    repoDir,
    resolveNode: async () => process.execPath,
    openImpl: async (url, options) => {
      opened.push({ url, options })
    },
    platform: 'darwin',
    startTimeoutMs: 15000,
    stopTimeoutMs: 8000,
  })

  await check('resolveRepoDir 能从插件目录找到仓库根', async () => {
    assert.equal(resolveRepoDir(path.join(repoDir, 'plugins', 'qq-bridge-panel')), repoDir)
  })

  await check('status：未启动时两个端口都报未监听，配置可读', async () => {
    const status = await manager.status()
    assert.equal(status.ok, true)
    assert.equal(status.configFound, true)
    assert.equal(status.bridge.port, bridgePort)
    assert.equal(status.bridge.open, false)
    assert.equal(status.bridge.owned, false)
    assert.equal(status.bridge.tokenConfigured, true)
    assert.equal(status.llbot.open, false)
    assert.equal(status.llbot.startable, false)
    assert.ok(status.nodePath, '应解析出 node 路径')
  })

  await check('start(bridge)：真实进程起来，status 看到端口/模式/DSH 就绪', async () => {
    const out = await manager.start('bridge')
    assert.equal(out.ok, true, out.message)
    const status = await manager.status()
    assert.equal(status.bridge.open, true)
    assert.equal(status.bridge.owned, true)
    assert.equal(status.bridge.mode, 'reserved2')
    assert.equal(status.bridge.dshReady, true)
  })

  await check('start(bridge) 重复调用不会起第二个实例', async () => {
    const out = await manager.start('bridge')
    assert.equal(out.ok, true)
    assert.equal(out.already, true)
  })

  await check('open(console)：URL 带 ?token=，交给系统打开器', async () => {
    opened.length = 0
    const out = await manager.open('console')
    assert.equal(out.ok, true)
    assert.equal(opened.length, 1)
    assert.equal(opened[0].url, `http://127.0.0.1:${bridgePort}/?token=test-token`)
  })

  await check('open(llbot)：使用配置里的 WebUI 地址', async () => {
    opened.length = 0
    const out = await manager.open('llbot')
    assert.equal(out.ok, true)
    assert.equal(opened[0].url, `http://127.0.0.1:${llbotPort}`)
  })

  await check('stop(bridge)：端口关闭，状态回到未监听', async () => {
    const out = await manager.stop('bridge')
    assert.equal(out.ok, true, out.message)
    assert.equal(await probePort(bridgePort), false)
    const status = await manager.status()
    assert.equal(status.bridge.open, false)
    assert.equal(status.bridge.owned, false)
  })

  await check('stop(bridge) 重复调用安全', async () => {
    const out = await manager.stop('bridge')
    assert.equal(out.ok, true)
    assert.equal(out.already, true)
  })

  await check('外部启动的实例：stop 拒绝并且不杀进程', async () => {
    external = spawn(process.execPath, [path.join(repoDir, 'src', 'bridge.js')], {
      cwd: repoDir,
      stdio: 'ignore',
    })
    assert.equal(await waitPort(bridgePort, true, 10000), true, '外部实例没起来')
    const out = await manager.stop('bridge')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'external')
    assert.equal(await probePort(bridgePort), true, '面板不应杀掉外部实例')
    external.kill('SIGTERM')
    await waitPort(bridgePort, false, 8000)
    external = null
  })

  await check('LLBot 未配置 panel.llbotCommand 时拒绝启动，但状态仍可见', async () => {
    const out = await manager.start('llbot')
    assert.equal(out.ok, false)
    assert.match(out.message, /panel\.llbotCommand/)
    const status = await manager.status()
    assert.equal(status.llbot.startable, false)
    assert.equal(status.llbot.port, llbotPort)
  })

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  try {
    manager?.dispose()
  } catch {}
  try {
    external?.kill('SIGKILL')
  } catch {}
  await waitPort(bridgePort, false, 5000).catch(() => {})
  await rm(root, { recursive: true, force: true })
}
