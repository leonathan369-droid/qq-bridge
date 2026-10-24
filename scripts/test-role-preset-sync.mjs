// 角色卡 → preset 人格同步的回归测试（纯文件操作，不连 DSH/QQ）。
//
// 背景（2026-10-24 真实坑）：`config.role.injectPerMessage=false` 时角色卡不再逐条注入，
// 人格实际由 preset（qq-chat / qq-chat-v2）的 persona.prefix 里那份**手工副本**承载。
// 以前没有任何脚本同步它 → 「在控制台改了角色卡，QQ 里的 AI 一点没变」，而且毫无提示。
//
// 现在两份 preset 里角色卡前后有 `<!-- ROLE-CARD:BEGIN/END -->` 标记，
// scripts/sync-role-to-preset.mjs 负责 --check / --write。本测试钉住：
//   ① 仓库当前状态是同步的（否则说明有人改了卡没同步）；
//   ② 漂移能被检出，--write 能修好且严格等于卡文件；
//   ③ 标记缺失时明确报错，不会瞎写；
//   ④ qq_get_prompt 在 injectPerMessage=false 时仍返回角色卡全文（源码契约）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { runSync, planPresetSync, readRoleCard } = await import(pathToFileURL(path.join(ROOT, 'scripts/sync-role-to-preset.mjs')).href)

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failed += 1
}

const PRESETS = ['qq-chat', 'qq-chat-v2']

// ── ① 仓库当前状态必须同步 ────────────────────────────────────────────────────
{
  const out = runSync({ root: ROOT })
  check('两份 preset 都存在 ROLE-CARD 标记且与角色卡一致', out.results.every((r) => r.ok),
    out.results.map((r) => `${r.preset}:${r.ok ? 'ok' : r.message}`).join(' | '))
  check('当前角色名可解析（state/current-role.json 或 roles/*.md）', Boolean(out.role), out.role)
  for (const preset of PRESETS) {
    const text = fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', preset, 'agent.cordis.yml'), 'utf8')
    check(`${preset} 含 BEGIN/END 标记各一个`,
      (text.match(/ROLE-CARD:BEGIN/g) ?? []).length === 1 && (text.match(/ROLE-CARD:END/g) ?? []).length === 1)
    check(`${preset} 的常驻人格里含角色卡正文`, text.includes('# 角色卡：DeepSeek 小鲸鱼'))
  }
}

// ── ② 临时仓库：检测漂移 → --write 修好 ──────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-role-sync-'))
const writeFile = (rel, content) => {
  const file = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}
const read = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8')
const presetWith = (cardLines, indent = '      ') => [
  '    prefix: |-',
  '      【角色设定（常驻人格，优先级最高）】',
  `${indent}<!-- ROLE-CARD:BEGIN -->`,
  ...cardLines.map((line) => (line ? indent + line : '')),
  `${indent}<!-- ROLE-CARD:END -->`,
  '',
  '      【运行规则】',
  '      测试用内容。',
  '',
].join('\n')

try {
  const cardV1 = ['# 角色卡：测试人格', '', '## 一、你是谁', '你是测试角色。']
  for (const preset of PRESETS) writeFile(`dsh/agent-presets/${preset}/agent.cordis.yml`, presetWith(cardV1))
  writeFile('roles/测试人格.md', `${cardV1.join('\n')}\n`)
  writeFile('state/current-role.json', JSON.stringify({ role: '测试人格', mode: 'active' }))

  const synced = runSync({ root: tmp })
  check('临时仓库初始状态同步', synced.results.every((r) => r.ok), synced.results.map((r) => r.message).join(' | '))

  // 改卡 → 检出漂移（但不写盘）
  writeFile('roles/测试人格.md', `${[...cardV1, '', '新增一行人设。'].join('\n')}\n`)
  const drifted = runSync({ root: tmp })
  check('改了角色卡后 --check 能检出漂移', drifted.results.every((r) => !r.ok && r.driftLines > 0),
    drifted.results.map((r) => r.message).join(' | '))
  check('--check 不写文件（preset 内容未被改动）',
    read('dsh/agent-presets/qq-chat/agent.cordis.yml').includes('ROLE-CARD:BEGIN')
    && !read('dsh/agent-presets/qq-chat/agent.cordis.yml').includes('新增一行人设'))

  // --write → 同步
  const wrote = runSync({ root: tmp, write: true })
  check('--write 报告已写入', wrote.results.every((r) => r.driftLines > 0))
  const after = runSync({ root: tmp })
  check('--write 之后 --check 通过', after.results.every((r) => r.ok), after.results.map((r) => r.message).join(' | '))
  const cardLines = readRoleCard(path.join(tmp, 'roles/测试人格.md'))
  for (const preset of PRESETS) {
    const text = read(`dsh/agent-presets/${preset}/agent.cordis.yml`)
    const expected = cardLines.map((line) => (line ? `      ${line}` : '')).join('\n')
    check(`${preset} 写入内容严格等于角色卡（含缩进）`, text.includes(expected))
    check(`${preset} 写入保留标记与后续段落`, text.includes('ROLE-CARD:END') && text.includes('【运行规则】'))
  }

  // 标记缺失 → 明确报错，不写盘
  const broken = presetWith(cardLines).replace(/<!--\s*ROLE-CARD:BEGIN[^\n]*\n/, '')
  writeFile('dsh/agent-presets/qq-chat-v2/agent.cordis.yml', broken)
  const brokenOut = planPresetSync({
    presetPath: path.join(tmp, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'),
    cardLines,
    write: true,
  })
  check('缺 BEGIN 标记时报错且不静默写入', brokenOut.ok === false && /标记异常/.test(brokenOut.message), brokenOut.message)
  check('缺标记时文件保持原样（未被破坏）',
    read('dsh/agent-presets/qq-chat-v2/agent.cordis.yml') === broken)

  // CLI 退出码：--check 不一致时 1、一致时 0
  writeFile('dsh/agent-presets/qq-chat-v2/agent.cordis.yml', presetWith(cardV1))
  const cliDrift = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-role-to-preset.mjs'), '--check', '--root', tmp], { encoding: 'utf8' })
  check('CLI --check 漂移时退出码 1', cliDrift.status === 1, `status=${cliDrift.status}`)
  const cliFix = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-role-to-preset.mjs'), '--write', '--root', tmp], { encoding: 'utf8' })
  check('CLI --write 退出码 0', cliFix.status === 0, `status=${cliFix.status}`)
  const cliOk = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sync-role-to-preset.mjs'), '--check', '--root', tmp], { encoding: 'utf8' })
  check('CLI --check 同步后退出码 0', cliOk.status === 0, `status=${cliOk.status}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ── ③ 生成产物不得带同步标记（标记只是给脚本看的，进 prompt 就是噪声） ─────────
{
  const build = await import(pathToFileURL(path.join(ROOT, 'scripts/build-agent-preset-patches.mjs')).href)
  check('剥离函数可用', typeof build.stripRoleCardMarkers === 'function')
  check('标记行被完整剥掉（不留空行）',
    build.stripRoleCardMarkers('a\n  <!-- ROLE-CARD:BEGIN -->\nb\n  <!-- ROLE-CARD:END -->\nc') === 'a\nb\nc')
  check('正文里的普通 HTML 注释不受影响',
    build.stripRoleCardMarkers('a\n<!-- 普通注释 -->\nb') === 'a\n<!-- 普通注释 -->\nb')
  for (const preset of PRESETS) {
    const rendered = build.renderPatch(preset)
    check(`${preset} 生成的 patch 不含 ROLE-CARD 标记`, !rendered.includes('ROLE-CARD'))
    check(`${preset} 生成的 patch 仍含角色卡正文`, rendered.includes('# 角色卡：DeepSeek 小鲸鱼'))
  }
}

// ── ④ qq_get_prompt 源码契约：injectPerMessage=false 也要给全文 ────────────────
{
  const source = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')
  check('qq_get_prompt 传 ignoreInjectPerMessage=true',
    /currentRoleHintV2\(\{\s*ignoreInjectPerMessage:\s*true\s*\}\)/.test(source)
    && /currentRoleHint\(\{\s*ignoreInjectPerMessage:\s*true\s*\}\)/.test(source))
  const v1 = source.match(/function currentRoleHint\(\{[^}]*ignoreInjectPerMessage[^}]*\}[^)]*\)\s*\{[\s\S]{0,1200}?\n  \}/)
  const v2 = source.match(/function currentRoleHintV2\(\{[^}]*ignoreInjectPerMessage[^}]*\}[^)]*\)\s*\{[\s\S]{0,1600}?\n  \}/)
  check('currentRoleHint 的开关判断受 ignoreInjectPerMessage 影响',
    Boolean(v1) && /if \(!ignoreInjectPerMessage && cfg\.role\?\.injectPerMessage === false\) return ''/.test(v1[0]))
  check('currentRoleHintV2 的开关判断受 ignoreInjectPerMessage 影响',
    Boolean(v2) && /if \(!ignoreInjectPerMessage && cfg\.role\?\.injectPerMessage === false\) return ''/.test(v2[0]))
}

console.log(failed === 0 ? '\n✅ 角色卡→preset 同步回归测试通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
