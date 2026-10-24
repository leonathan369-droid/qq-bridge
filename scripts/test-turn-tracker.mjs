// 回合追踪回归测试（纯逻辑，不连 DSH/QQ/LLBot）。
//
// 事故（2026-10-24，用户现场「又不回消息了」）：
//   · 16:24:14 会话 turn 3 正常 `turn/end {kind:"completed"}`；
//   · 16:24:44 DSH 往**同一会话**追加了一条回合外事件 `subagent/catalog`
//     （mnemon 插件的空闲检查子 agent）；
//   · 旧代码对每一条 session/event 都建"回合收集器"，而收集器只在收到 turn/end 时删除
//     → 这条收集器永远等不到结束；
//   · `isConversationBusyV2()` 里 `collectors.has(sid) → true`，于是之后每一次唤醒
//     （question/poke/keyword/atMention…）都只被写进 pendingWakeReasons「暂存」，
//     一条都不投递 —— QQ 上完全静默，而 DSH 侧会话空闲、事件也照常流入。
//
// 这里钉住两件事：① 回合外事件绝不能建收集器；② 万一还是残留了，兜底回收能发现它。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { isTurnScopedEvent, staleCollectorSessions } = await import(pathToFileURL(path.join(ROOT, 'src/turn-tracker.js')).href)

let failed = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) failed += 1
}

// ── ① 正常回合：turn/start 建收集器，回合内事件继续推进，turn/end 结束 ─────────────
{
  check('turn/start 必须建收集器（否则整轮回复丢失）',
    isTurnScopedEvent({ type: 'turn/start', turnActive: false, hasCollector: false }) === true)
  check('回合进行中的 assistant/message 继续推进收集器',
    isTurnScopedEvent({ type: 'assistant/message', turnActive: true, hasCollector: true }) === true)
  check('回合进行中、收集器刚被清掉的边界（有起点无收集器）仍然跟踪',
    isTurnScopedEvent({ type: 'assistant/message', turnActive: true, hasCollector: false }) === true)
  check('turn/end 交给收集器处理并清理',
    isTurnScopedEvent({ type: 'turn/end', turnActive: true, hasCollector: true }) === true)
}

// ── ② 事故形态：turn/end 之后到达的回合外事件，绝不能建收集器 ─────────────────────
{
  const outOfTurn = [
    'subagent/catalog',   // 实测触发本事故的事件类型
    'session/updated',
    'step/start',
    'usage/updated',
  ]
  for (const type of outOfTurn) {
    check(`回合外事件 ${type} 不建收集器（否则会话会被永久判繁忙）`,
      isTurnScopedEvent({ type, turnActive: false, hasCollector: false }) === false)
  }
  check('回合外事件即使类型未知也不建收集器（默认失败关闭）',
    isTurnScopedEvent({ type: 'whatever/new-event', turnActive: false, hasCollector: false }) === false)
}

// ── ③ 兜底回收：残留收集器（无回合起点）必须被发现 ──────────────────────────────
{
  const stale = staleCollectorSessions({
    sessions: ['session-ok', 'session-stale'],
    turnStartedAtOf: (sid) => (sid === 'session-ok' ? 1_000_000 : undefined),
    now: 1_000_000 + 5_000,
  })
  check('无回合起点的收集器被判为残留', stale.length === 1 && stale[0].sessionId === 'session-stale')
  check('残留原因标明 no-turn-marker', stale[0]?.reason === 'no-turn-marker')
  check('正常进行中的回合不动它', !stale.some((s) => s.sessionId === 'session-ok'))
}

// ── ④ 兜底回收：漏掉 turn/end 的超长回合（宽阈值，别误杀长回合） ──────────────────
{
  const turnStart = 5_000_000
  const justUnder = staleCollectorSessions({
    sessions: ['s'],
    turnStartedAtOf: () => turnStart,
    now: turnStart + 29 * 60_000,
  })
  check('29 分钟的回合不回收（长回合合法）', justUnder.length === 0)

  const over = staleCollectorSessions({
    sessions: ['s'],
    turnStartedAtOf: () => turnStart,
    now: turnStart + 31 * 60_000,
  })
  check('超过 30 分钟仍未结束 → 回收（兜住漏掉的 turn/end）', over.length === 1 && over[0].reason === 'turn-too-long')
  check('回收项带出已持续时长，日志可解释', over[0]?.ageMs === 31 * 60_000)

  const many = staleCollectorSessions({
    sessions: ['a', 'b', 'c'],
    turnStartedAtOf: () => undefined,
    now: 0,
  })
  check('多个残留一次全清（不会只清一个）', many.length === 3)
}

// ── ⑤ 边界：空输入不炸 ─────────────────────────────────────────────────────────
{
  check('没有收集器时不产生任何回收', staleCollectorSessions({ sessions: [] }).length === 0)
  check('无参数调用安全', staleCollectorSessions().length === 0)
  check('isTurnScopedEvent 无参数安全', isTurnScopedEvent() === false)
}

// ── ⑥ 端到端接线契约：bridge.js 必须真的用这两个判定（防"改回去"） ──────────────
{
  const fs = await import('node:fs')
  const source = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')
  check('bridge.js 引用 isTurnScopedEvent', source.includes('isTurnScopedEvent('))
  check('bridge.js 引用 staleCollectorSessions', source.includes('staleCollectorSessions('))
  check('收集器创建前有回合内判定（不再无条件 createTurnCollector）',
    /isTurnScopedEvent\(\{[\s\S]{0,400}?createTurnCollector\(\)/.test(source))
  check('重连恢复回合时补记回合起点', /rebuildInFlightCollector[\s\S]{0,2000}?v2TurnStartAt\.set/.test(source))
  check('看门狗已挂到启动流程', source.includes('startTurnWatchdog()'))
}

console.log(failed === 0 ? '\n✅ 回合追踪回归测试通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
