# Release v0.3.1 — 修「面板全绿、消息一条进不来」（消息链路 / WS 重连）

- **日期**：2026-10-24
- **上一个版本**：[v0.3.0](RELEASE-v0.3.0.md)（2026-10-21，控制中心 + 会话作用域模型）
- **影响面**：桥接进程（`src/`）、DSH 插件面板（`plugins/qq-bridge-panel/`）
- **是否需要动 DSH**：**是**。面板 host 半有改动，DSH 的 host 插件走 ESM 缓存，**必须完全退出 DSH
  再打开**（Cmd+Q → 重新打开）才会加载新判定；桥接进程只需重启（面板「重启桥接」即可）。
- **数据兼容**：`config.json` / `state/*` 无字段变化，直接覆盖代码即可。

## 1. 事故现象

用户在 DSH 设置页「QQ Bridge」里点**一键启动**（面板先起桥接、再起 LLBot），然后去 LLBot WebUI
扫码登录（登录成功，QQ 显示已登录），给 bot 发私聊 —— **完全没有任何回复**，而面板显示
**「全部就绪」**，四项健康检查全绿。

## 2. 根因（实测，不是推测）

链路是 `QQ → LLBot(OneBot WS 3001) → bridge → DSH → 回复`。断在第二跳。

1. 面板「一键启动」先起桥接，此时 LLBot 还没登录，OneBot WS 端口（3001）**尚未监听**。
2. 桥接用 `@snowluma/sdk` 的 `SnowLumaWebSocketClient` 连 3001，失败。
3. **Node 22 内置 WebSocket 连一个没在监听的端口时只发 `error`、不发 `close`**，
   `readyState` 永远停在 0（CONNECTING）。用桥接同一个 Node 二进制实测：
   ```
   node v22.23.2  WebSocket: function
   error 2ms  Received network error or non-101 status code.
   5s 后：既没有 open 也没有 close，readyState = 0
   ```
4. SDK 的 `connect()` 只在 `close` 回调里 `this.connectPromise = null` 并 reject；于是
   - 那个 promise **永不 settle**；
   - 之后每次 `connect()` 都在第一行 `return this.connectPromise`，返回**同一个 pending promise**；
   - 没有 `close` ⇒ `scheduleReconnect()` 永不排期 ⇒ **永久放弃重连**；
   - 没有 `close` ⇒ 挂在 `close` 上的 `healTokenIfStale()`（换账号 token 自愈）也**永不执行**。
5. 用户扫码登录成功、3001 起来之后，桥接**再也没有发起过连接**（`lsof` 里 pid 到 3001 无任何连接）。
6. 旧面板的健康判断只看「端口通不通 / HTTP 接口通不通」：
   - 桥接 `/api/status` 健康（`get_status` 走 **HTTP 3000**，是通的，`good: true`）；
   - LLBot WebUI 健康、QQ `online: true`、DSH 就绪 ⇒ `aggregate = "ready"`「全部就绪」。

一句话：**HTTP 健康 ≠ 收发健康**；而「连不上时的重连」这条路径在 Node 22 + 该 SDK 组合下根本不存在。

## 3. 修复

### 3.1 桥接：常驻 WS 连接看门狗（`src/ws-supervisor.js` + `src/bridge.js`）

- 新增 `createWsSupervisor()`：每 2s 检查一次，**socket 一直卡在 `CONNECTING` 超过 8s** 就
  `close()`（由 SDK 清掉 `socket` / `connectPromise`）再 `connect()`。
- 不接管 SDK 正常的退避重连（`socket === null` 时不动），避免造出第二条连接。
- 连续卡死时每 3 次强制重建顺带 `healTokenIfStale()` —— 覆盖「`close` 从不触发，token 自愈从不跑」。
- 连接错误日志改为带 message：原来 `log('SnowLuma 错误:', error)` 打出来是 `SnowLuma 错误: {}`
  （`Error.message` 是非枚举属性，`JSON.stringify` 抓不到），事故现场毫无线索。

### 3.2 面板：把「消息链路」单列为独立健康项

- `panel-core.js` 新增 `messagePathOf()`：读 `snowluma.connected`
  （`true` / `false` / 缺失=`unknown`，老桥接不上报时**如实标未知**，既不误报也不吓人）；
- 综合状态新增一档 **`upstream` =「收发链路中断」**（服务都在跑、QQ 已登录，但 `connected === false`），
  排在「全部就绪」之前，绝不冒充 ready；
- 客户端新增第 5 张状态卡「消息链路」，中断时顶部出现红色提示条 + 一键「**重启桥接**」
  （外部启动的实例仍然不给按钮，保持原有归属策略）。

## 4. 回归

| 套件 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:audit` | **34/34**（原 32） | 新增 2 个测试脚本 |
| `npm run test:panel` | **33/33**（原 28） | 新增 4 条健康判定 + 1 条客户端契约 |
| `npm run privacy-scan` | ✅ | 无新增隐私面 |

新增测试：

- `scripts/test-ws-supervisor.mjs`（30 条断言）：先用 FakeClient 复现 SDK 的三个死锁前提
  （pending promise 复用、永不第二次尝试、无 close），再断言看门狗能救回来；
  另含「健康连接不打扰」「SDK 退避时不插手」「定时器接线」「错误文本不再为 `{}`」，
  以及一条本机真实 WebSocket 行为探针（会打印 `error` 而不 `close` —— 即事故形态）。
- `scripts/test-bridge-ws-recovery.mjs`（**端到端**）：临时目录里跑**真实 `src/bridge.js`**，
  DSH / LLBot 全部指向死端口，先把桥接启动起来（复现"LLBot 还没登录"），
  再在同一端口起一个只做 101 握手的假 OneBot —— 断言桥接**在 20s 内自己打出
  `SnowLuma 已连接`**，且全程只有一条连接（没有连接风暴）。约 12s。
- `scripts/test-panel-host.mjs` 新增 4 条：链路中断必须是 `upstream` 而不是 `ready`；
  连上后回到 `ready`；老桥接缺字段时标 `unknown` 且不报故障；等待扫码时不抢「等待登录」的结论。
  另加 1 条客户端静态契约（`aggregate=upstream` 有色调映射、有状态卡、有重启按钮、`client.js` 语法可解析）。

## 5. 现场恢复步骤（本次已在用户机器上执行并验证）

1. 面板「重启桥接」→ 桥接重新连上 LLBot（`SnowLuma 已连接`，`lsof` 可见到 3001 的 ESTABLISHED）。
2. 升级到本版本后，同样的「先启桥接、后扫码登录」顺序不再需要人工干预：
   桥接在 LLBot 就绪后 ≤8s 自动连上。
3. 面板新判定生效需要 **完全退出 DSH 再打开**（host 半 ESM 缓存）。

## 6. 边界与已知限制

- 看门狗只处理「socket 卡在 CONNECTING」这一种死法（事故形态）。
  若 SDK/Node 将来改成「失败时会发 close」，看门狗自然退化为无操作（有断言保证不打扰）；
  若失败时 `readyState` 停在别的值，看门狗不接管 —— 届时需要按实际形态扩展 `tick()`。
- `snowluma.connected` 是桥接进程内真实 WS 状态，**跨进程不可伪造**；但桥接进程挂掉时
  面板只能看到"端口没了"（走 `stopped/down` 分支），不是本判定能覆盖的。
- 判定为「收发链路中断」时**不代表** QQ 侧接收链路健康 —— 那是 SnowLuma `[Hook]` 的
  `status.good` 范畴，见 README「SnowLuma 版本与上游健康」。
