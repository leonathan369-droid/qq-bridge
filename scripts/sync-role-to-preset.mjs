#!/usr/bin/env node
// 把 `roles/<名字>.md` 的角色卡同步进 agent preset 的常驻人格（persona.prefix）。
//
// 为什么需要它（真实坑，2026-10-24）：
//   · 设在 `config.role.injectPerMessage=false` 时，角色卡不再逐条注入，人格实际由
//     **preset 的 system prompt** 承载（qq-chat / qq-chat-v2 的 persona.prefix 里各嵌了一份全文）；
//   · 但仓库里没有任何脚本把 `roles/*.md` 同步过去 —— 那份是**手工副本**。
//     于是"在控制台改了角色卡、QQ 里的 AI 一点没变"这种问题没有任何提示。
//
// 做法：preset 里角色卡前后有 `<!-- ROLE-CARD:BEGIN/END -->` 标记，本脚本只替换标记之间的内容：
//   默认 --check：只校验，不一致时打印差异行数并以 1 退出（适合放进回归/CI）；
//   --write     ：把卡文件内容写进标记之间（保留标记行的缩进）。
//
// 用法：
//   node scripts/sync-role-to-preset.mjs --check
//   node scripts/sync-role-to-preset.mjs --write
//   node scripts/sync-role-to-preset.mjs --check --role 傲娇助手 --root /tmp/x
//
// 改完 preset 源文件后还要重新生成 DSH patch（scripts/build-agent-preset-patches.mjs），
// 并按 DSH 的加载方式重载（host 侧改动需重启 DSH）——脚本成功后会提示。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PRESETS = ['qq-chat', 'qq-chat-v2']
const BEGIN_RE = /^(?<indent>[ \t]*)<!--\s*ROLE-CARD:BEGIN/
const END_RE = /^[ \t]*<!--\s*ROLE-CARD:END\s*-->[ \t]*$/

/** 读角色卡文件；统一换行、去掉行尾空白与结尾空行。 */
export function readRoleCard(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n')
  const lines = raw.split('\n').map((line) => line.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 校验/同步一份 preset。返回 { ok, driftLines, message, before, after }。
 * 不写文件；写盘由调用方按 write 开关决定（保持纯函数便于测试）。
 */
export function planPresetSync({ presetPath, cardLines, write = false }) {
  const original = fs.readFileSync(presetPath, 'utf8')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)

  const beginIndexes = []
  const endIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/<!--\s*ROLE-CARD:BEGIN/.test(lines[i])) beginIndexes.push(i)
    if (END_RE.test(lines[i])) endIndexes.push(i)
  }
  if (beginIndexes.length !== 1 || endIndexes.length !== 1) {
    return {
      ok: false,
      driftLines: 0,
      message: `标记异常（BEGIN ${beginIndexes.length} 个 / END ${endIndexes.length} 个）；`
        + '请确认 preset 里角色卡前后各有一个 <!-- ROLE-CARD:BEGIN/END --> 标记',
    }
  }
  const begin = beginIndexes[0]
  const end = endIndexes[0]
  if (end <= begin + 1) {
    return { ok: false, driftLines: 0, message: 'END 标记必须在 BEGIN 之后（且中间是角色卡正文）' }
  }
  const indent = (lines[begin].match(BEGIN_RE)?.groups?.indent) ?? '      '
  const expected = cardLines.map((line) => (line === '' ? '' : indent + line))
  const current = lines.slice(begin + 1, end)

  const sameLength = current.length === expected.length
  const differing = sameLength
    ? expected.reduce((count, line, index) => count + (line === current[index] ? 0 : 1), 0)
    : Math.max(current.length, expected.length)

  if (sameLength && differing === 0) {
    return { ok: true, driftLines: 0, message: '已同步', indent }
  }
  const updated = `${lines.slice(0, begin + 1).join(newline)}${newline}`
    + `${expected.join(newline)}${newline}`
    + `${lines.slice(end).join(newline)}`
  if (write) fs.writeFileSync(presetPath, updated, 'utf8')
  return {
    ok: false,
    driftLines: differing,
    message: `与角色卡不一致（行数 ${current.length} → ${expected.length}，差异 ${differing} 行）`,
    indent,
    written: write,
  }
}

/** 解析默认角色名：state/current-role.json → 第一个 roles/*.md。 */
export function detectRoleName({ root, roleName }) {
  if (roleName) return String(roleName)
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'current-role.json'), 'utf8'))
    if (state?.role) return String(state.role)
  } catch {}
  const dir = path.join(root, 'roles')
  const first = fs.readdirSync(dir).find((name) => name.endsWith('.md') && name !== 'README.md')
  if (first) return first.replace(/\.md$/, '')
  throw new Error('找不到角色卡：请用 --role 指定，或先创建 roles/<名字>.md')
}

export function runSync({ root, roleName, presets = DEFAULT_PRESETS, write = false }) {
  const name = detectRoleName({ root, roleName })
  const cardPath = path.join(root, 'roles', `${name}.md`)
  if (!fs.existsSync(cardPath)) throw new Error(`角色卡不存在：${path.relative(root, cardPath)}`)
  const cardLines = readRoleCard(cardPath)
  const results = presets.map((preset) => {
    const presetPath = path.join(root, 'dsh', 'agent-presets', preset, 'agent.cordis.yml')
    if (!fs.existsSync(presetPath)) return { preset, ok: false, driftLines: 0, message: 'preset 文件不存在' }
    return { preset, ...planPresetSync({ presetPath, cardLines, write }) }
  })
  return { role: name, cardPath, cardLines, results }
}

function main(argv) {
  const args = argv.slice(2)
  const has = (flag) => args.includes(flag)
  const valueOf = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  const root = path.resolve(valueOf('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
  const write = has('--write')
  const presets = valueOf('--presets') ? String(valueOf('--presets')).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_PRESETS
  const roleName = valueOf('--role')

  let out
  try {
    out = runSync({ root, roleName, presets, write })
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exit(2)
  }

  console.log(`角色卡：${out.role}（${path.relative(root, out.cardPath)}，${out.cardLines.length} 行）`)
  let failed = 0
  for (const row of out.results) {
    const tag = row.ok ? '✅' : write && row.driftLines > 0 ? '✏️ ' : '❌'
    console.log(`${tag} ${row.preset}: ${row.message}${row.ok && write ? '' : ''}`)
    if (!row.ok && !(write && row.driftLines > 0)) failed += 1
  }
  if (write) {
    const wrote = out.results.some((row) => row.driftLines > 0)
    if (wrote) {
      console.log('\n已写入 preset 源文件。下一步：')
      console.log('  1) node scripts/build-agent-preset-patches.mjs   # 重新生成 DSH patch')
      console.log('  2) 重启 DSH（Cmd+Q 再打开）让新人格生效')
    } else {
      console.log('\n无需写入：preset 已与角色卡一致。')
    }
    return
  }
  if (failed > 0) {
    console.log('\n角色卡与 preset 不一致。执行 `node scripts/sync-role-to-preset.mjs --write` 同步后重新生成 patch。')
    process.exit(1)
  }
  console.log('全部 preset 已与角色卡一致。')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv)
