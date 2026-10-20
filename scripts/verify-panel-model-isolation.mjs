#!/usr/bin/env node
/**
 * 面板「QQ 专用模型」作用域验收脚本（需要 DSH 与桥接都已加载 v0.3.0 代码）。
 * ============================================================================
 * 它验证的是本轮最核心的承诺：**切换 QQ 模型不会修改 DSH 全局默认模型**。
 *
 * 证据链：
 *   1. 读 ~/.dsh/profiles/<profile>/cordis.patch.yml 的 `agent-default-model.config`（全局默认模型）；
 *   2. GET 面板 /status，确认面板 host 半是新版本（否则说明 DSH 还没重启）；
 *   3. POST 面板 /model 切换 QQ 模型（写桥接 config.json，作用域 session）；
 *   4. POST 面板 /model/apply 对**真实 QQ 会话**做会话局部应用；
 *   5. 解码该会话的 session.v4.jsonl.zstd，确认最后一条 `model/selection` 就是新模型；
 *   6. 再次读全局默认模型，必须与第 1 步**逐字节一致**；
 *   7. 默认把 QQ 模型恢复成原值（--keep 可保留）。
 *
 * 用法：
 *   node scripts/verify-panel-model-isolation.mjs
 *   node scripts/verify-panel-model-isolation.mjs --keep --json-out /tmp/evidence.json
 *   node scripts/verify-panel-model-isolation.mjs --target deepseek-official/deepseek-flash --effort high
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境未就绪（需要重启 DSH/桥接）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const flag = (name) => args.includes(name)
const PANEL = argOf('--panel', 'http://127.0.0.1:19387').replace(/\/+$/, '')
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const PROFILE = argOf('--profile', 'desktop')
const KEEP = flag('--keep')
const JSON_OUT = argOf('--json-out', '')

const evidence = { startedAt: new Date().toISOString(), panel: PANEL, profile: PROFILE, steps: [], globalBefore: null, globalAfter: null }
const pass = (name, detail = '') => {
  evidence.steps.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail ? `（${detail}）` : ''}`)
}
const fail = (name, detail = '') => {
  evidence.steps.push({ name, ok: false, detail })
  console.error(`FAIL  ${name}${detail ? `：${detail}` : ''}`)
}
const info = (text) => console.log(`      ${text}`)

async function jsonRequest(pathname, init) {
  const res = await fetch(PANEL + pathname, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body, text }
}

/** 从 profile 的 cordis.patch.yml 里取 agent-default-model.config（全局默认模型）。 */
function readGlobalDefaultModel() {
  const file = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  if (!existsSync(file)) return { file, found: false, error: '找不到 profile 的 cordis.patch.yml' }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => /^-\s*id:\s*agent-default-model\s*$/.test(line.trim()))
  if (start < 0) return { file, found: false, error: 'cordis.patch.yml 里没有 agent-default-model 条目' }
  const config = {}
  let inConfig = false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^-\s/.test(line)) break
    if (/^\s+config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    const match = line.match(/^\s+(provider|model|reasoningEffort):\s*(.+?)\s*$/)
    if (match) config[match[1]] = match[2].replace(/^["']|["']$/g, '')
    else if (/^\s+\S/.test(line) && Object.keys(config).length > 0) break
  }
  const raw = lines.slice(start, Math.min(lines.length, start + 12)).join('\n')
  return { file, found: true, config, raw }
}

/** 解码 zstd 的会话日志（优先 zstd CLI，Node 的 zlib 只能读第一帧）。 */
function decodeSessionLog(file) {
  try {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch {
    try {
      return zlib.zstdDecompressSync(readFileSync(file)).toString('utf8')
    } catch {
      return ''
    }
  }
}

function lastModelSelection(file) {
  if (!existsSync(file)) return null
  const text = decodeSessionLog(file)
  if (!text) return null
  let last = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'model/selection' && event.data) last = { seq: event.seq, time: event.time, ...event.data }
  }
  return last
}

function sessionLogPath(repoDir, sessionId) {
  const base = path.join(DSH_HOME, 'sessions')
  if (!existsSync(base)) return ''
  const target = String(sessionId).replace(/^session-/, '')
  for (const workspace of readDirSafe(base)) {
    const candidate = path.join(base, workspace, String(sessionId))
    if (existsSync(candidate)) return path.join(candidate, 'session.v4.jsonl.zstd')
    if (!String(sessionId).startsWith('session-')) {
      const alt = path.join(base, workspace, `session-${target}`)
      if (existsSync(alt)) return path.join(alt, 'session.v4.jsonl.zstd')
    }
  }
  return ''
}

function readDirSafe(dir) {
  try {
    return execFileSync('ls', ['-1', dir], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function main() {
  // ── 1. 全局默认模型快照 ──────────────────────────────────────────────────
  const globalBefore = readGlobalDefaultModel()
  evidence.globalBefore = globalBefore
  if (!globalBefore.found) {
    fail('读取 DSH 全局默认模型', globalBefore.error)
    return finish(2)
  }
  pass('读取 DSH 全局默认模型', `${globalBefore.config.provider}/${globalBefore.config.model} (${globalBefore.config.reasoningEffort ?? '无档位'})`)

  // ── 2. 面板 host 半版本 ─────────────────────────────────────────────────
  const statusRes = await jsonRequest('/qq-bridge-panel/status')
  if (!statusRes.body?.ok) {
    fail('面板 host 半可用', statusRes.text?.slice(0, 200) || `HTTP ${statusRes.status}`)
    info('需要重启 DSH 让新的 host 半加载（ESM 模块缓存，改文件不会热替换）。')
    return finish(2)
  }
  const status = statusRes.body
  evidence.panelVersion = status.panel?.version
  if (!String(status.panel?.version ?? '').startsWith('0.3')) {
    fail('面板 host 半版本', `当前 ${status.panel?.version ?? '未知'}，期望 0.3.x（需要重启 DSH）`)
    return finish(2)
  }
  pass('面板 host 半版本', `v${status.panel.version}`)

  if (!status.model?.catalog?.groups?.length) {
    fail('DSH 模型目录可用', status.model?.catalogError || '目录为空')
    return finish(2)
  }
  pass('DSH 模型目录可用', `${status.model.catalog.groups.length} 个 provider / ${status.model.catalog.groups.reduce((n, g) => n + (g.models?.length ?? 0), 0)} 个模型`)

  // ── 3. 找真实 QQ 会话 ───────────────────────────────────────────────────
  const repoDir = status.panel?.repoDir || REPO_ROOT
  const sessionMapFile = path.join(repoDir, 'state', 'sessions.json')
  let sessionMap = {}
  try {
    sessionMap = JSON.parse(readFileSync(sessionMapFile, 'utf8')).sessions ?? {}
  } catch {}
  const entries = Object.entries(sessionMap)
  if (entries.length === 0) {
    fail('找到 QQ 会话映射', `state/sessions.json 为空（${sessionMapFile}）`)
    return finish(2)
  }
  const [sessionKey, sessionId] = entries[0]
  const logPath = sessionLogPath(repoDir, sessionId)
  if (!logPath) {
    fail('找到 QQ 会话日志', `session ${sessionId} 的日志文件不存在`)
    return finish(2)
  }
  const beforeSelection = lastModelSelection(logPath)
  evidence.qqSession = { key: sessionKey, sessionId, logPath, beforeSelection }
  pass('找到真实 QQ 会话', `${sessionKey} → ${sessionId}，当前 selection ${beforeSelection ? `${beforeSelection.provider}/${beforeSelection.model}` : '无'}`)

  // ── 4. 选择目标模型 ─────────────────────────────────────────────────────
  const current = status.model.current ?? {}
  const targetArg = argOf('--target', '')
  let target = null
  if (targetArg && targetArg.includes('/')) {
    const [provider, model] = targetArg.split('/')
    target = { provider, model }
  } else {
    for (const group of status.model.catalog.groups) {
      for (const model of group.models ?? []) {
        if (group.id === current.provider && model.id === current.model) continue
        if (group.id === current.provider) {
          target = { provider: group.id, model: model.id }
          break
        }
      }
      if (target) break
    }
    if (!target) {
      for (const group of status.model.catalog.groups) {
        for (const model of group.models ?? []) {
          if (group.id === current.provider && model.id === current.model) continue
          target = { provider: group.id, model: model.id }
          break
        }
        if (target) break
      }
    }
  }
  if (!target) {
    fail('选择目标模型', '目录里没有与当前不同的模型，无法验证切换')
    return finish(1)
  }
  const targetGroup = status.model.catalog.groups.find((g) => g.id === target.provider)
  const targetModel = targetGroup?.models?.find((m) => m.id === target.model)
  const efforts = (targetModel?.reasoning?.efforts ?? []).map((e) => String(e.id))
  let effort = argOf('--effort', '')
  if (!effort) {
    const currentEffort = current.effortMode === 'auto' ? '' : String(current.reasoningEffort ?? '')
    effort = currentEffort && efforts.includes(currentEffort) ? currentEffort : (targetModel?.reasoning?.defaultEffort ?? '')
  }
  if (effort && efforts.length && !efforts.includes(effort)) {
    fail('推理档位兼容', `模型 ${target.provider}/${target.model} 不支持 ${effort}（支持 ${efforts.join('/')}）`)
    return finish(1)
  }
  evidence.target = { ...target, ...(effort ? { reasoningEffort: effort } : {}) }
  pass('选择目标模型', `${target.provider}/${target.model}${effort ? ` · ${effort}` : ' · 适配器默认'}（当前 ${current.provider}/${current.model}）`)

  // ── 5. 切换 QQ 模型（面板 → 桥接 config.json）────────────────────────────
  const setRes = await jsonRequest('/qq-bridge-panel/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...target, ...(effort ? { reasoningEffort: effort } : {}) }),
  })
  evidence.setModel = setRes.body
  if (!setRes.body?.ok) {
    fail('切换 QQ 模型', setRes.body?.message || `HTTP ${setRes.status}`)
    info('如果是「旧版桥接没有 POST /api/dsh/model」，需要重启桥接进程让新代码生效。')
    return finish(2)
  }
  pass('切换 QQ 模型', setRes.body.message || 'ok')

  // ── 6. 会话局部应用 ─────────────────────────────────────────────────────
  const applyRes = await jsonRequest('/qq-bridge-panel/model/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, ...target, ...(effort ? { reasoningEffort: effort } : {}) }),
  })
  evidence.applyModel = applyRes.body
  if (!applyRes.body?.ok) {
    fail('会话局部应用模型', applyRes.body?.message || `HTTP ${applyRes.status}`)
    return finish(1)
  }
  pass('会话局部应用模型', `scope=${applyRes.body.scope ?? '?'} · globalDefaultUntouched=${applyRes.body.globalDefaultUntouched}`)

  // ── 7. 会话日志里出现新的 model/selection ────────────────────────────────
  let afterSelection = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    afterSelection = lastModelSelection(logPath)
    if (afterSelection?.provider === target.provider && afterSelection?.model === target.model) break
    await new Promise((r) => setTimeout(r, 250))
  }
  evidence.qqSession.afterSelection = afterSelection
  if (afterSelection?.provider === target.provider && afterSelection?.model === target.model) {
    pass('QQ 会话已切到新模型', `model/selection seq=${afterSelection.seq} ${afterSelection.provider}/${afterSelection.model}${afterSelection.reasoningEffort ? ` (${afterSelection.reasoningEffort})` : ''}`)
  } else {
    fail('QQ 会话已切到新模型', `最后一条 selection 仍是 ${afterSelection ? `${afterSelection.provider}/${afterSelection.model}` : '无'}`)
  }

  // ── 8. 全局默认模型必须完全没变（核心断言）──────────────────────────────
  const globalAfter = readGlobalDefaultModel()
  evidence.globalAfter = globalAfter
  const same = JSON.stringify(globalBefore.config) === JSON.stringify(globalAfter.config)
  if (same) {
    pass('DSH 全局默认模型未变', `${globalAfter.config.provider}/${globalAfter.config.model} (${globalAfter.config.reasoningEffort ?? '无档位'}) —— 前后逐字段一致`)
  } else {
    fail('DSH 全局默认模型未变', `before=${JSON.stringify(globalBefore.config)} after=${JSON.stringify(globalAfter.config)}`)
  }

  // ── 9. 恢复原模型（默认）─────────────────────────────────────────────────
  if (!KEEP) {
    const restore = await jsonRequest('/qq-bridge-panel/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: current.provider, model: current.model, ...(current.effortMode === 'auto' ? {} : { reasoningEffort: current.reasoningEffort }) }),
    })
    if (restore.body?.ok) {
      await jsonRequest('/qq-bridge-panel/model/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, provider: current.provider, model: current.model, ...(current.effortMode === 'auto' ? {} : { reasoningEffort: current.reasoningEffort }) }),
      })
      pass('已恢复原 QQ 模型', `${current.provider}/${current.model}`)
    } else {
      fail('恢复原 QQ 模型', restore.body?.message || `HTTP ${restore.status}`)
    }
  }

  const failed = evidence.steps.filter((step) => !step.ok).length
  return finish(failed === 0 ? 0 : 1)
}

function finish(code) {
  evidence.finishedAt = new Date().toISOString()
  evidence.ok = code === 0
  if (JSON_OUT) {
    try {
      writeFileSync(JSON_OUT, JSON.stringify(evidence, null, 2))
      console.log(`\n证据已写入 ${JSON_OUT}`)
    } catch (error) {
      console.error(`写证据文件失败：${error?.message ?? error}`)
    }
  }
  const passed = evidence.steps.filter((step) => step.ok).length
  console.log(`\n${passed}/${evidence.steps.length} 项通过${code === 0 ? ' —— 模型作用域隔离成立' : ''}`)
  if (code === 2) console.log('环境未就绪：请先重启 DSH（加载面板 host 半）与桥接进程（加载面板路由/票据/模型接口）。')
  process.exitCode = code
  return code
}

await main()
