# Release v0.3.2 — 修「又不回消息了」：回合外事件把会话永久判成"繁忙"

- **日期**：2026-10-24
- **上一个版本**：[v0.3.1](RELEASE-v0.3.1.md)（同日，修 WS 死锁 / 消息链路判定）
- **影响面**：桥接进程（`src/turn-tracker.js`、`src/bridge.js`）。**面板无需改动**，
  因此这次**不需要重启 DSH**，重启桥接即可（`state/*`、`config.json` 无字段变化）。
- **与 v0.3.1 的关系**：两个独立故障，都表现为"QQ 上发消息没反应"，但**位置不同**：
  v0.3.1 是「桥接 ↔ LLBot」的 OneBot WS 没连上（消息进不来）；
  v0.3.2 是「桥接 → DSH agent」这一跳：消息进来了、会话也建好了，但桥接误判会话"繁忙"，
  唤醒只写进暂存队列，永不投递。

## 1. 事故现象

v0.3.1 修好后桥接正常收发（群消息 1/1 发送成功、心跳正常、`connected: true`）。
但 16:24 之后再度完全静默：群里 @、拍一拍、关键词、提问全都没反应，`unreadCount` 涨到 13。

桥接日志只有一种新行，且反复出现：

```
[reserved2] 会话繁忙，暂存唤醒原因 group:<群号>（question@seq458）
[reserved2] 会话繁忙，暂存唤醒原因 group:<群号>（poke@seq461）
...（每次都换一个唤醒原因，说明消息确实进来了，只是永远不投递）
```

## 2. 根因（证据链）

**DSH 侧其实是空闲的。** 会话日志（`~/.dsh/sessions/…/session-<id>….jsonl.zstd`）末尾：

```
211  16:24:14  assistant/message
212  16:24:14  step/end
213  16:24:14  turn/end {"kind":"completed"}      ← 回合并未卡住
214  16:24:44  subagent/catalog  "Mnemon idle checkpoint review"   ← 回合外事件
```

**桥接的两个"繁忙"来源**（`isConversationBusyV2()`）：

```js
const sid = state.sessions[key];
if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
```

`collectors` 里的收集器本该在 `turn/end` 时删除。但旧代码在 `pumpMux()` 的
`session/event` 分支里对**每一条事件**都执行：

```js
const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
collectors.set(frame.sessionId, collector);
const ended = collector.push(frame.event);   // 只有 turn/end 才 ended=true
```

`turn/end` 之后 30 秒到达的 `subagent/catalog`（mnemon 插件的空闲检查子 agent，
它只在"回合结束后、会话空闲"时才跑）因此**造出了一个永远等不到结束的收集器** →
`collectors.has(sid)` 从此恒为 true → 之后每一次唤醒都被 `sendWakePromptV2()` 挡在
「会话繁忙，暂存唤醒原因」分支里。**这不是"忙"，是永久哑火**，而且会一直哑到重启进程。

为什么以前没炸：触发它需要「turn/end 之后还有回合外事件」这个组合，
mnemon 的空闲检查子 agent 正是这样的调用方；一旦某轮结束恰好触发它，会话就锁死。

## 3. 修复

### 3.1 只给「回合内事件」建收集器（`src/turn-tracker.js`）

新增纯逻辑 `isTurnScopedEvent({ type, turnActive, hasCollector })`：

| 情况 | 结论 |
| --- | --- |
| 已有收集器 | 回合内 → 继续推进（含 `turn/end`） |
| `v2TurnStartAt` 有该会话 | 回合内 → 推进 |
| 事件就是 `turn/start` | 回合起点 → 必须建收集器 |
| 其它（`subagent/catalog`、`session/updated`…） | **回合外 → 跳过，不建收集器** |

未知事件类型默认「不建」——失败关闭，宁可少一次无关事件的收集，也不要锁死会话。

### 3.2 兜底回收看门狗

`startTurnWatchdog()`：60 秒校正一次，只回收真正异常的两类收集器：

- **no-turn-marker**：有收集器、却没有回合起点 —— 正是本次事故形态，立即回收；
- **turn-too-long**：回合已持续 **> 30 分钟**仍未结束（兜住"事件流断连导致漏掉
  `turn/end`"的形态；阈值放得很宽，29 分钟的长回合有断言保证不会误杀）。

回收时打日志（含会话 key 与原因）并同时清 `v2TurnStartAt`，会话立刻恢复可唤醒。

### 3.3 重连恢复的回合补记起点

`rebuildInFlightCollector()`（DSH 重连后恢复进行中的回合）过去只 `collectors.set(...)`。
现在同时 `v2TurnStartAt.set(...)`，保证「有收集器 ⇒ 有回合起点」这条不变量成立，
否则 3.2 的回收会把一个**真正进行中**的回合误判成残留。

## 4. 回归

| 套件 | 结果 |
| --- | --- |
| `npm run test:audit` | **35/35**（原 34，新增 `test-turn-tracker.mjs`） |
| `npm run test:panel` | 33/33（本次未改面板） |
| `npm run privacy-scan` | ✅ |

`scripts/test-turn-tracker.mjs`（24 条断言）分三组：

1. **正常回合**：`turn/start` 必须建收集器、回合内事件继续推进（否则整轮回复丢失）；
2. **事故形态**：`subagent/catalog` / `session/updated` / `step/start` / `usage/updated`
   以及任意未知类型，在「无回合起点」时**一律不建收集器**；
3. **兜底回收**：无起点的残留必须被发现（带原因）、正常回合不动、29 分钟不回收、
   31 分钟回收、多个残留一次全清；
4. **接线契约**：`bridge.js` 必须引用这两个判定、收集器创建前有判定、恢复回合时补起点、
   看门狗挂在启动流程上 —— 防以后被改回去。

## 5. 现场恢复

1. 面板「重启桥接」→ 内存里的残留收集器清空（本次已在用户机器上执行并验证：
   重启后唤醒恢复正常，`unreadCount` 被新回合消费）。
2. 升级到本版本后不再复发：回合外事件不会建收集器，万一还有其它形态由看门狗 60 秒内回收。

## 6. 边界与已知限制

- 看门狗是**兜底**，不是主逻辑：正常路径靠 3.1 的判定，收集器不会残留。
- `turn-too-long` 阈值 30 分钟是经验值：超过它的回合会被当成"漏了 turn/end"而解除繁忙，
  若那一刻真的还有回合在跑，桥接可能向 DSH 投递一次 prompt 并在 API 侧被拒（会记日志，
  不会崩）。取舍是"宁可偶尔被拒一次，也不要永久静默"。
- 本修复不改变 `reserved2` 的语义：AI 仍然**自己决定**要不要回应（可以主动沉默）；
  这里的故障是"它根本没收到唤醒"，两者要看日志区分：
  `会话繁忙，暂存唤醒原因` = 本 bug；`无行动` / `mark_read` = AI 主动收尾。
