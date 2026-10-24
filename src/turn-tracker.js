// 「回合（turn）」追踪的纯判定逻辑。
//
// 桥接用两个内存结构描述"这个会话现在有没有回合在跑"：
//   · v2TurnStartAt：sessionId → 回合开始时间（turn/start 时写入，turn/end 时删除）
//   · collectors   ：sessionId → 回合文本收集器（把 assistant/message 累积成一条回复）
// `isConversationBusyV2()` 一旦看到其一就认为会话繁忙，不再投递唤醒。
//
// 事故（2026-10-24，用户现场「又不回消息了」）：旧代码给**每一条** session/event 都建
// 收集器，而收集器只在收到 turn/end 时才会被删除。DSH 在 turn/end **之后**还会往同一
// 会话追加回合外事件（实测：`subagent/catalog` —— mnemon 插件的"空闲检查"子 agent，
// turn/end 后 30s 到达）。于是那个收集器永远等不到结束 → 会话被永久判"繁忙" →
// 之后所有唤醒只写进 pendingWakeReasons 暂存，QQ 上一条回复都没有，而 DSH 侧会话其实
// 是空闲的、事件也在正常流入。
//
// 修法：只有「回合内事件」才允许创建收集器（见 isTurnScopedEvent），并加一个兜底回收
// （见 staleCollectorSessions）以防将来又出现漏掉 turn/end 的形态。

/**
 * 这条事件是否属于某个进行中的回合（决定要不要创建/推进收集器）。
 *
 * @param {object} input
 * @param {string} input.type           事件类型（frame.event.type）
 * @param {boolean} input.turnActive    该会话是否已有进行中的 turn（v2TurnStartAt 命中）
 * @param {boolean} input.hasCollector  该会话是否已有收集器（重连恢复的回合也靠它续上）
 */
export function isTurnScopedEvent({ type, turnActive = false, hasCollector = false } = {}) {
  // 已经有收集器：这是同一个回合的后续事件（含 turn/end，结束清理在 push 的返回值里）。
  if (hasCollector) return true
  // 有 turn 起点记录（正常情况下 turn/start 先到）。
  if (turnActive) return true
  // 回合起点本身：必须建立收集器，否则这一整个回合成不了回复。
  return type === 'turn/start'
}

/**
 * 找出「残留收集器」：判定为繁忙但回合其实早就结束/从未开始的会话。
 *
 * 两类：
 *   · no-turn-marker：有收集器但没有任何 turn 起点记录 —— 正是本次事故形态
 *     （回合外事件造出的收集器）。正常情况下不可能出现（turn/start 先写起点），
 *     所以见到即可回收。
 *   · turn-too-long：有提交记录、但回合长度超过 maxTurnMs 仍未结束。保留这一条是
 *     为了兜住「turn/end 事件在事件流断连时丢失」的形态；阈值放得很宽，宁可晚回收
 *     也不要误杀真正的长回合。
 *
 * @param {object} input
 * @param {string[]} input.sessions         当前有收集器的 sessionId 列表
 * @param {(sid: string) => number|undefined} input.turnStartedAtOf  查回合开始时间
 * @param {number} [input.now]
 * @param {number} [input.maxTurnMs]
 * @returns {Array<{sessionId: string, reason: string, ageMs: number}>}
 */
export function staleCollectorSessions({
  sessions = [],
  turnStartedAtOf = () => undefined,
  now = Date.now(),
  maxTurnMs = 30 * 60_000,
} = {}) {
  const stale = []
  for (const sessionId of sessions) {
    const startedAt = Number(turnStartedAtOf(sessionId) ?? 0)
    if (!startedAt) {
      stale.push({ sessionId, reason: 'no-turn-marker', ageMs: 0 })
      continue
    }
    const ageMs = now - startedAt
    if (ageMs > maxTurnMs) stale.push({ sessionId, reason: 'turn-too-long', ageMs })
  }
  return stale
}
