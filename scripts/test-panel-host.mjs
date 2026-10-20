#!/usr/bin/env node
/**
 * qq-bridge-panel host 半的离线回归（2026-10-21 产品化后重写）。
 * ============================================================================
 * 不启动 DSH、不碰真实桥接/LLBot、不开浏览器、不发 QQ 消息：
 *   · 在临时目录里造"仓库"（config.json + 假 src/bridge.js）；
 *   · 假桥接 / 假 LLBot 都是真实的 Node HTTP 服务（随机端口），行为可配置；
 *   · start/stop/restart 用真实子进程（监听临时端口），验证进程归属确实落盘；
 *   · open 被注入函数记录，不执行系统 open；
 *   · 覆盖：四状态矩阵 / 一键启动 / 幂等 / 外部实例保护 / 归属跨 manager 重建 /
 *     运行模式写穿与回读 / 模型目录校验与不兼容档位拒绝 / 会话局部应用 / URL 安全。
 *
 * 运行：node scripts/test-panel-host.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertLoopbackUrl,
  createServiceManager,
  llbotLaunchPlanOf,
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
      console.log(`FAIL  ${name}\n      ${error?.stack ?? error?.message ?? error}`)
    }
  })()
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/** 读请求体（JSON）。 */
function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolveBody(text ? JSON.parse(text) : null)
      } catch {
        resolveBody(text)
      }
    })
  })
}

/** 假桥接控制台：行为可按测试用例覆盖。 */
async function startFakeBridge({ mode = 'reserved2', dshReady = true, token = 'test-token', supportTicket = true, modelPostSupported = true, modelState } = {}) {
  const calls = []
  const state = {
    mode,
    dshReady,
    provider: modelState?.provider ?? 'amd-qq',
    model: modelState?.model ?? 'DeepSeek-V4-Flash-Vision-Exp',
    reasoningEffort: modelState?.reasoningEffort ?? 'high',
    tickets: new Set(),
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : null
    calls.push({ method: req.method, path: url.pathname, body, headers: req.headers })
    const json = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname === '/api/status') {
      json({ ok: true, mode: state.mode, dshReady: state.dshReady, snowluma: { connected: true, accountOnline: null, degraded: false } })
      return
    }
    if (url.pathname === '/api/mode' && req.method === 'POST') {
      state.mode = String(body?.mode ?? '')
      json({ ok: true, mode: state.mode, dshSynced: true })
      return
    }
    if (url.pathname === '/api/dsh/model' && req.method === 'GET') {
      json({
        provider: state.provider,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        options: ['low', 'high', 'max'],
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
        reasoningSupported: true,
        effortChecked: true,
        effortMode: 'explicit',
        modelScope: 'session',
        globalSideEffect: false,
      })
      return
    }
    if (url.pathname === '/api/dsh/model' && req.method === 'POST') {
      if (!modelPostSupported) {
        json({ ok: false, error: 'not found' }, 404)
        return
      }
      state.provider = String(body?.provider ?? state.provider)
      state.model = String(body?.model ?? state.model)
      state.reasoningEffort = String(body?.reasoningEffort ?? state.reasoningEffort)
      json({ ok: true, selected: { provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort }, modelScope: 'session', globalSideEffect: false })
      return
    }
    if (url.pathname === '/api/console/ticket' && req.method === 'POST') {
      if (!supportTicket) {
        json({ ok: false, error: 'not found' }, 404)
        return
      }
      const ticket = `ticket-${state.tickets.size + 1}`
      state.tickets.add(ticket)
      json({ ok: true, ticket, expiresInMs: 60000 })
      return
    }
    json({ ok: true })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

/** 假 LLBot WebUI：/api/login-info 返回登录态。 */
async function startFakeLlbot({ online = false, uin = '', nick = '', password = 'pw' } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ path: req.url, headers: req.headers })
    res.setHeader('content-type', 'application/json')
    if (String(req.url).startsWith('/api/login-info')) {
      res.end(JSON.stringify({ success: true, data: { uid: uin, uin, nick, online, mode: 'direct' } }))
      return
    }
    res.end(JSON.stringify({ success: false, message: 'not found' }),)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    password,
    calls,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}

/** 假 LLBot 进程：只监听一个端口（验证 spawn 与归属）。 */
function dummyLlbotSource() {
  return `const http=require('node:http')
const port=Number(process.argv[2])
http.createServer((req,res)=>{res.setHeader('content-type','application/json')
  if(String(req.url).startsWith('/api/login-info')){res.end(JSON.stringify({success:true,data:{uin:'',nick:'',online:false}}));return}
  res.end('{"success":false}')}).listen(port,'127.0.0.1')
process.on('SIGTERM',()=>process.exit(0))
`
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
const cleanup = []
let manager = null

const fakeCatalog = {
  default: { provider: 'amd-qq', model: 'DeepSeek-V4-Flash-Vision-Exp', reasoningEffort: 'high' },
  groups: [
    {
      id: 'amd-qq',
      name: 'AMD 内部路由',
      models: [
        {
          id: 'DeepSeek-V4-Flash-Vision-Exp',
          name: 'DeepSeek V4 Flash（视觉实验）',
          description: '多模态',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
        },
        { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', reasoning: { efforts: [], defaultEffort: null } },
      ],
    },
    {
      id: 'deepseek-official',
      name: 'DeepSeek 官方',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek Flash',
          reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' },
        },
      ],
    },
  ],
  failures: [{ id: 'openai', name: 'OpenAI', message: '缺少 API Key' }],
}

try {
  await mkdir(path.join(repoDir, 'src'), { recursive: true })
  await writeFile(
    path.join(repoDir, 'config.json'),
    `${JSON.stringify(
      {
        consolePort: bridgePort,
        consoleToken: 'test-token',
        snowluma: { webuiUrl: `http://127.0.0.1:${llbotPort}`, webuiPassword: 'pw' },
        dsh: { baseUrl: 'http://127.0.0.1:19387', provider: 'amd-qq', model: 'DeepSeek-V4-Flash-Vision-Exp', reasoningEffort: 'high', modelScope: 'session' },
        panel: { llbotCommand: [], llbotCwd: '' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(path.join(repoDir, 'src', 'bridge.js'), DUMMY_BRIDGE, 'utf8')

  const opened = []
  const makeManager = (overrides = {}) => createServiceManager({
    repoDir,
    resolveNode: async () => process.execPath,
    openImpl: async (url, options) => {
      opened.push({ url, options })
    },
    platform: 'darwin',
    startTimeoutMs: 15000,
    stopTimeoutMs: 8000,
    catalogProvider: async () => fakeCatalog,
    readSettingsMode: async () => null,
    writeSettingsMode: async () => ({ ok: true }),
    applySessionModel: async (request) => ({ ok: true, selected: { provider: request.provider, model: request.model }, scope: 'session', globalDefaultUntouched: true }),
    ...overrides,
  })
  manager = makeManager()

  await check('resolveRepoDir 能从插件目录找到仓库根', async () => {
    assert.equal(resolveRepoDir(path.join(repoDir, 'plugins', 'qq-bridge-panel')), repoDir)
  })

  await check('status：全部停止时四项都为 down，综合状态 stopped', async () => {
    const status = await manager.status()
    assert.equal(status.ok, true)
    assert.equal(status.panel.configFound, true)
    assert.equal(status.services.bridge.port, bridgePort)
    assert.equal(status.services.bridge.running, false)
    assert.equal(status.services.llbot.running, false)
    assert.equal(status.services.qq.state, 'unknown')
    assert.equal(status.aggregate, 'stopped')
    assert.equal(status.aggregateText, '全部停止')
    assert.equal(status.panel.version.length > 0, true)
    assert.equal(status.services.bridge.tokenConfigured, true)
    assert.equal(status.services.bridge.tokenMasked.includes('test'), false, 'status 不能返回完整 token')
  })

  await check('start(bridge)：真实进程起来，状态健康，归属落盘', async () => {
    const out = await manager.start('bridge')
    assert.equal(out.ok, true, out.message)
    const status = await manager.status()
    assert.equal(status.services.bridge.running, true)
    assert.equal(status.services.bridge.owned, true)
    assert.equal(status.services.bridge.mode, 'reserved2')
    assert.equal(status.services.bridge.dshReady, true)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'state', 'panel-services.json'), 'utf8'))
    assert.ok(saved.bridge?.pid > 0, '应把 pid 写入归属登记')
    assert.ok(saved.bridge.fingerprint.includes('src/bridge.js'))
  })

  await check('start(bridge) 重复调用：幂等，不重复启动', async () => {
    const out = await manager.start('bridge')
    assert.equal(out.ok, true)
    assert.equal(out.already, true)
  })

  await check('owner 重建（模拟 DSH 重启）：新 manager 仍能凭登记停止桥接', async () => {
    const fresh = makeManager()
    const status = await fresh.status()
    assert.equal(status.services.bridge.owned, true, '归属不应只活在内存里')
    const out = await fresh.stop('bridge')
    assert.equal(out.ok, true, out.message)
    assert.equal(await probePort(bridgePort), false)
    // 复用的 manager 也应看到已停止
    const after = await manager.status()
    assert.equal(after.services.bridge.running, false)
  })

  await check('外部启动的实例：stop 拒绝且不杀进程', async () => {
    const external = spawn(process.execPath, [path.join(repoDir, 'src', 'bridge.js')], { cwd: repoDir, stdio: 'ignore' })
    cleanup.push(external)
    assert.equal(await waitPort(bridgePort, true, 10000), true, '外部实例没起来')
    const out = await manager.stop('bridge')
    assert.equal(out.ok, false)
    assert.equal(out.code, 'external')
    assert.equal(await probePort(bridgePort), true, '面板不应杀掉外部实例')
    external.kill('SIGTERM')
    await waitPort(bridgePort, false, 8000)
  })

  await check('LLBot 未配置代管命令时拒绝启动，但状态可见', async () => {
    const out = await manager.start('llbot')
    assert.equal(out.ok, false)
    assert.match(out.message, /panel\.llbotCommand|panel\.llbotQq/)
    const status = await manager.status()
    assert.equal(status.services.llbot.startable, false)
    assert.equal(status.services.llbot.port, llbotPort)
  })

  await check('LLBot 等待扫码：状态 waiting，不算服务异常', async () => {
    const fakeLlbot = await startFakeLlbot({ online: false })
    cleanup.push(fakeLlbot)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.snowluma.webuiUrl = fakeLlbot.url
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const fakeBridge = await startFakeBridge({ mode: 'reserved2' })
    cleanup.push(fakeBridge)
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const status = await local.status()
    assert.equal(status.services.llbot.running, true)
    assert.equal(status.services.llbot.login.state, 'waiting')
    assert.equal(status.services.qq.state, 'waiting')
    assert.equal(status.aggregate, 'waiting-login')
    assert.match(status.services.qq.detail, /扫码/)
  })

  await check('LLBot 已登录：QQ online，四项齐全时综合状态 ready', async () => {
    const fakeLlbot = await startFakeLlbot({ online: true, uin: '12345678', nick: '测试号' })
    cleanup.push(fakeLlbot)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.snowluma.webuiUrl = fakeLlbot.url
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const bridge = await manager.start('bridge')
    assert.equal(bridge.ok, true, bridge.message)
    const local = makeManager()
    const status = await local.status()
    assert.equal(status.services.qq.state, 'online')
    assert.match(status.services.qq.detail, /测试号/)
    assert.equal(status.aggregate, 'ready', status.aggregateText)
    await local.stop('bridge')
  })

  await check('open(console)：优先一次性票据，URL 里不含长期 token', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2', supportTicket: true })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    opened.length = 0
    const local = makeManager()
    const out = await local.open('console')
    assert.equal(out.ok, true, out.message)
    assert.equal(out.mode, 'ticket')
    assert.equal(opened.length, 1)
    assert.match(opened[0].url, /\/auth\/ticket\?t=ticket-/)
    assert.equal(opened[0].url.includes('test-token'), false, '长期 token 不得进入浏览器 URL')
  })

  await check('open(console)：旧版桥接不支持票据时回退 ?token= 并明确警告', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2', supportTicket: false })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    opened.length = 0
    const local = makeManager()
    const out = await local.open('console')
    assert.equal(out.ok, true)
    assert.equal(out.mode, 'token')
    assert.match(out.warning, /一次性票据/)
    assert.match(opened[0].url, /token=test-token/)
  })

  await check('open(console)：桥接没跑时拒绝并说明原因（按钮禁用逻辑的依据）', async () => {
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = await freePort()
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.open('console')
    assert.equal(out.ok, false)
    assert.match(out.message, /未运行/)
  })

  await check('setMode：通过桥接 /api/mode 写入并回读确认', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2' })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.setMode('chat')
    assert.equal(out.ok, true, out.message)
    assert.equal(out.effective, 'chat')
    assert.equal(out.verified, true)
    const status = await local.status()
    assert.equal(status.mode.current, 'chat')
    assert.equal(status.mode.source, 'bridge /api/status')
  })

  await check('setMode：未知模式被拒绝（不允许任意字符串进配置）', async () => {
    const local = makeManager()
    const out = await local.setMode('pwned')
    assert.equal(out.ok, false)
    assert.match(out.message, /未知模式/)
  })

  await check('setMode：桥接不在时退回 DSH settings，并回读校验', async () => {
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = await freePort()
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const writes = []
    const local = makeManager({
      readSettingsMode: async () => ({ mode: 'reserved', ownerQQ: '' }),
      writeSettingsMode: async (mode) => {
        writes.push(mode)
        return { ok: true }
      },
    })
    const out = await local.setMode('reserved')
    assert.equal(out.ok, true, out.message)
    assert.deepEqual(writes, ['reserved'])
    assert.equal(out.source, 'DSH settings qq-mode')
  })

  await check('setModel：目录校验 + 不兼容推理档位被拒绝，桥接不被调用', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2' })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const before = fakeBridge.calls.filter((c) => c.path === '/api/dsh/model' && c.method === 'POST').length
    const bad = await local.setModel({ provider: 'amd-qq', model: 'DeepSeek-V4-Flash', reasoningEffort: 'max' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /不支持/)
    const unknown = await local.setModel({ provider: 'nope', model: 'nope' })
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /不在 DSH 当前可路由/)
    const after = fakeBridge.calls.filter((c) => c.path === '/api/dsh/model' && c.method === 'POST').length
    assert.equal(after, before, '被拒绝的请求不能透传给桥接')
  })

  await check('setModel：合法选择透传桥接（provider/model/effort 完整关系）', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2' })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.setModel({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.equal(out.ok, true, out.message)
    assert.deepEqual(out.selected, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.equal(out.modelScope, 'session')
    assert.equal(out.globalSideEffect, false)
    const call = fakeBridge.calls.filter((c) => c.path === '/api/dsh/model' && c.method === 'POST').at(-1)
    assert.deepEqual(call.body, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
  })

  await check('setModel：桥接在线但版本旧（无 POST /api/dsh/model）时写 config.json + 明确提示需重启桥接', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2', modelPostSupported: false })
    cleanup.push(fakeBridge)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.setModel({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.pendingRestart, true, '旧版桥接不能被假装成已生效')
    assert.match(out.message, /旧版桥接没有 POST \/api\/dsh\/model/)
    const file = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    assert.equal(file.dsh.model, 'deepseek-flash')
  })

  await check('setModel：桥接未运行时写 config.json（权限 0600，下次启动生效）', async () => {
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = await freePort()
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.setModel({ provider: 'amd-qq', model: 'DeepSeek-V4-Flash', reasoningEffort: '' })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.pendingRestart, true)
    const file = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    assert.equal(file.dsh.provider, 'amd-qq')
    assert.equal(file.dsh.model, 'DeepSeek-V4-Flash')
    const mode = (await stat(path.join(repoDir, 'config.json'))).mode & 0o777
    assert.equal(mode, 0o600, `config.json 权限应为 600，实际 ${mode.toString(8)}`)
  })

  await check('applyModelToSession：委托给宿主实现，回显 sessionId 与作用域', async () => {
    const seen = []
    const local = makeManager({
      applySessionModel: async (request) => {
        seen.push(request)
        return { ok: true, selected: { provider: request.provider, model: request.model }, scope: 'session', globalDefaultUntouched: true }
      },
    })
    const out = await local.applyModelToSession({ sessionId: 'sess-1', provider: 'amd-qq', model: 'DeepSeek-V4-Flash-Vision-Exp', reasoningEffort: 'high' })
    assert.equal(out.ok, true)
    assert.equal(out.sessionId, 'sess-1')
    assert.deepEqual(seen, [{ sessionId: 'sess-1', provider: 'amd-qq', model: 'DeepSeek-V4-Flash-Vision-Exp', reasoningEffort: 'high' }])
    const missing = await local.applyModelToSession({ provider: 'amd-qq', model: 'x' })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /sessionId/)
  })

  await check('startAll：全部已在运行时每一步都是 already，不重复启动', async () => {
    const fakeBridge = await startFakeBridge({ mode: 'reserved2' })
    const fakeLlbot = await startFakeLlbot({ online: true, uin: '12345678', nick: '测试号' })
    cleanup.push(fakeBridge, fakeLlbot)
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = fakeBridge.port
    saved.snowluma.webuiUrl = fakeLlbot.url
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.startAll()
    assert.equal(out.ok, true, JSON.stringify(out.steps))
    assert.equal(out.aggregate, 'ready')
    const bridgeStep = out.steps.find((s) => s.id === 'bridge')
    const llbotStep = out.steps.find((s) => s.id === 'llbot')
    assert.equal(llbotStep.state, 'already')
    assert.equal(bridgeStep.state, 'already')
    assert.equal(out.steps.some((s) => s.state === 'failed'), false, '幂等启动不应产生失败步骤')
  })

  await check('startAll：LLBot 未配置时跳过而非失败，桥接照常启动（部分成功如实展示）', async () => {
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.consolePort = await freePort()
    saved.snowluma.webuiUrl = `http://127.0.0.1:${await freePort()}`
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.startAll()
    const llbotStep = out.steps.find((s) => s.id === 'llbot')
    const bridgeStep = out.steps.find((s) => s.id === 'bridge')
    assert.equal(llbotStep.state, 'skipped', JSON.stringify(llbotStep))
    assert.equal(bridgeStep.state, 'done', JSON.stringify(bridgeStep))
    assert.equal(out.partial, true)
    await local.stop('bridge')
  })

  await check('LLBot 代管启动：从 launcherPath + panel.llbotQq 派生固定命令并真实拉起', async () => {
    const llbotScript = path.join(repoDir, 'llbot', 'llbot.js')
    await mkdir(path.dirname(llbotScript), { recursive: true })
    await writeFile(llbotScript, dummyLlbotSource(), 'utf8')
    const port = await freePort()
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.snowluma.webuiUrl = `http://127.0.0.1:${port}`
    saved.snowluma.launcherPath = llbotScript
    saved.panel = { llbotCommand: [process.execPath, llbotScript, String(port)], llbotCwd: path.dirname(llbotScript) }
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const plan = llbotLaunchPlanOf(saved, { repoDir, nodePath: process.execPath })
    assert.equal(plan.available, true)
    assert.equal(plan.source, 'config')
    const out = await local.start('llbot')
    assert.equal(out.ok, true, out.message)
    assert.equal(await probePort(port), true)
    const status = await local.status()
    assert.equal(status.services.llbot.owned, true)
    assert.equal(status.services.llbot.login.state, 'waiting')
    assert.equal(out.waitingLogin, true, '起来了但没登录必须如实标记等待扫码')
    const stopped = await local.stop('llbot')
    assert.equal(stopped.ok, true, stopped.message)
  })

  await check('LLBot 代管启动：只给 launcherPath 时从 data/config_<QQ>.json 自动推导账号', async () => {
    const llbotScript = path.join(repoDir, 'llbot-auto', 'llbot.js')
    const dataDir = path.join(repoDir, 'llbot-auto', 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(llbotScript, dummyLlbotSource(), 'utf8')
    await writeFile(path.join(dataDir, 'config_123456789.json'), '{}', 'utf8')
    const plan = llbotLaunchPlanOf(
      { snowluma: { launcherPath: llbotScript }, panel: {} },
      { repoDir, nodePath: process.execPath },
    )
    assert.equal(plan.available, true, plan.reason)
    assert.equal(plan.source, 'derived')
    assert.equal(plan.qq, '123456789')
    assert.match(plan.qqSource, /config_123456789\.json/)
    assert.deepEqual(plan.command.slice(-2), ['--qq', '123456789'])
  })

  await check('LLBot 多账号时不猜：要求显式 panel.llbotQq', async () => {
    const llbotScript = path.join(repoDir, 'llbot-multi', 'llbot.js')
    const dataDir = path.join(repoDir, 'llbot-multi', 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(llbotScript, dummyLlbotSource(), 'utf8')
    await writeFile(path.join(dataDir, 'config_111111111.json'), '{}', 'utf8')
    await writeFile(path.join(dataDir, 'config_222222222.json'), '{}', 'utf8')
    const plan = llbotLaunchPlanOf(
      { snowluma: { launcherPath: llbotScript }, panel: {} },
      { repoDir, nodePath: process.execPath },
    )
    assert.equal(plan.available, false, '多账号时必须拒绝自动推导')
    assert.match(plan.reason, /多个账号/)
    assert.match(plan.reason, /panel\.llbotQq/)
  })

  await check('安全：非回环 URL 一律拒绝打开/探测', async () => {
    assert.throws(() => assertLoopbackUrl('http://evil.com/'), /回环/)
    assert.throws(() => assertLoopbackUrl('file:///etc/passwd'), /http/)
    assert.equal(assertLoopbackUrl('http://127.0.0.1:3101').port, '3101')
    const saved = JSON.parse(await readFile(path.join(repoDir, 'config.json'), 'utf8'))
    saved.snowluma.webuiUrl = 'http://evil.example.com:3080'
    await writeFile(path.join(repoDir, 'config.json'), JSON.stringify(saved, null, 2), 'utf8')
    const local = makeManager()
    const out = await local.open('llbot')
    assert.equal(out.ok, false)
    assert.match(out.message, /回环/)
  })

  await check('安全：LLBot 启动计划不接受任意字符串命令', async () => {
    const plan = llbotLaunchPlanOf({ panel: { llbotCommand: 'rm -rf /' } }, { repoDir, nodePath: process.execPath })
    assert.equal(plan.available, false, '字符串命令必须被忽略（只认数组）')
    const derived = llbotLaunchPlanOf({ snowluma: { launcherPath: '/nope/llbot.js' }, panel: { llbotQq: '12345678' } }, { repoDir, nodePath: process.execPath })
    assert.equal(derived.available, false)
    assert.match(derived.reason, /不存在|launcherPath/)
  })

  await check('诊断：高级区要用的日志/路径/最近错误都来自真实字段', async () => {
    const status = await manager.status()
    assert.ok(status.panel.repoDir.endsWith('repo'))
    assert.ok(status.panel.configFile.endsWith('config.json'))
    assert.ok(status.panel.logDir.includes('panel-logs'))
    assert.equal(typeof status.panel.lastError, 'string')
    assert.equal(typeof status.services.bridge.lastLog, 'string')
    assert.equal(status.services.bridge.tokenConfigured, true)
    assert.equal(status.model.scope, 'session')
    assert.ok(Array.isArray(status.model.catalog.groups))
    assert.equal(status.model.catalog.failures.length, 1)
  })

  const failed = results.filter((row) => !row.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  try {
    manager?.dispose()
  } catch {}
  for (const item of cleanup) {
    try {
      if (typeof item.close === 'function') await item.close()
      else item.kill?.('SIGKILL')
    } catch {}
  }
  await waitPort(bridgePort, false, 5000).catch(() => {})
  await rm(root, { recursive: true, force: true })
}
