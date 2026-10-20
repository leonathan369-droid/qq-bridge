# 「设置 → QQ 桥接」控制中心（plugins/qq-bridge-panel）

> 适用：DSH Desktop / Web 0.2.0-rc.2 及以上；macOS Apple Silicon 为当前主要验证平台。
> 这一页**不是**第二个配置面板，而是桥接的本地控制中心：它把「桥接进程 / LLBot / QQ 登录 /
> DSH 连接」四件事的真实状态、启停、运行模式、QQ 专用模型与推理强度集中在一页里。

## 1. 页面结构

| 区块 | 内容 |
| --- | --- |
| A 标题 | `QQ Bridge for macOS` · `DeepSeek Harness · 本地 QQ Agent` · 面板版本 · 综合状态胶囊 |
| B 系统状态 | 四项独立健康检查：QQ Bridge / LLBot / QQ 登录 / DSH 连接。综合状态区分 **全部就绪 / 部分就绪 / 等待 QQ 登录 / 服务异常 / 全部停止** |
| C 主操作 | **启动服务**（一键启动编排）· **打开控制台**（桥接健康时才可点） |
| D 服务管理 | 两个服务行：端口、归属（面板/外部）、启动/停止/重启（按归属提供）、打开控制台 / WebUI |
| E 运行模式 | chat / reserved / reserved2；`closed-agent` 在「高级」里并提示权限风险；显示**真实生效值**与来源 |
| F QQ 专用模型 | DSH 原生风格的模型选择器：Provider 分组、搜索、勾选、键盘导航、加载/失败/空态 |
| G 推理强度 | 跟随所选模型公布的 `reasoning.efforts` 动态显示；模型不支持时隐藏并说明 |
| H 高级设置与诊断 | 路径、端口、令牌状态（掩码）、启动选项、服务管理模式、桥接/LLBot 日志尾部、最近错误、最近操作 |

## 2. 状态是"真实健康检查"，不是"端口开着"

| 服务 | 判定依据 | 不算健康的反例 |
| --- | --- | --- |
| QQ Bridge | 控制台 `GET /api/status`（带 `x-console-token`）返回 JSON 且含 `mode` | 端口被别的程序占着 / 返回 HTML |
| LLBot | WebUI `GET /api/login-info`（`X-Webui-Token = sha256(密码)`）可解析 | 只有 TCP 端口监听 |
| QQ 登录 | `login-info.data.online === true && uin` 非空；桥接在线时也参考 `snowluma.accountOnline` | "LLBot WebUI 能打开" ≠ 已登录 |
| DSH 连接 | 桥接 `/api/status.dshReady`（桥接→DSH 的 RPC 通道）；桥接离线时只报"DSH 在监听"而**不**宣称已连接 | 端口 19387 开着 |

综合状态规则（`panel-core.js`）：

- **全部停止**：两个服务都没在跑
- **服务异常**：任一在跑的服务健康检查为 `degraded/unknown`（例如桥接在跑但上游接收链路异常）
- **等待 QQ 登录**：LLBot 在跑、`online=false` → 显示「等待扫码」并开放「打开 LLBot WebUI」，**不判为启动失败**
- **部分就绪**：服务都正常但 DSH 连接未就绪
- **全部就绪**：四项都正常

## 3. 一键启动（幂等）

`POST /qq-bridge-panel/start-all` 按固定顺序执行，每一步都有独立超时与结果：

1. LLBot 已在跑 → `already`；没配置代管命令 → `skipped`（说明原因）；否则按固定命令启动并等 WebUI 端口
2. 检查 QQ 登录 → 在线 `done` / 等待扫码 `waiting`（附"点打开 LLBot WebUI 扫码"的指引）
3. OneBot 连接：未登录时通常端口未开放，属预期 `waiting`，不算失败
4. 桥接已在跑 → `already`；否则启动并等待控制台端口
5. DSH 连通：`dshReady`

返回值里每一步带 `state ∈ done / already / waiting / skipped / failed`，页面按真实情况逐条展示（部分成功不会被包装成成功）。

**LLBot 启动只使用固定命令**：`config.json` 的 `panel.llbotCommand`（数组）优先；
否则用 `snowluma.launcherPath` + `panel.llbotQq` 派生 `[node, launcherPath, --qq, <qq>]`。
字符串命令、浏览器提交的命令、任意 shell 一律拒绝。

## 4. 进程归属： почему 不能只靠内存 PID

面板启动的服务以 `detached` 方式运行，并把
`{pid, command, fingerprint, cwd, startedAt, port}` 记到 `state/panel-services.json`。
之后每次判定归属都做**三重校验**：

1. `pid` 仍存活（`kill(pid, 0)`）
2. `ps -p <pid> -o command=` 仍包含启动指纹（防 pid 复用）
3. 端口仍在监听

三条同时成立才允许停止。因此：

- DSH 重启 / HMR / 面板刷新后，面板仍能认出"这是我启动的桥接"并允许停止；
- 终端、启动台、其它管理器启动的实例永远是 `external`，面板**不会杀**；
- DSH 退出时面板**刻意不杀**子进程（服务独立存活），下次打开面板自动重新接管。

## 5. 打开控制台：一次性票据（不再把长期令牌塞进地址栏）

旧实现把 `?token=<consoleToken>` 直接交给浏览器，令牌会进入历史记录、可能出现在 Referer。
现在的流程：

1. 面板 host 半带着 `consoleToken` 调桥接 `POST /api/console/ticket`；
2. 桥接返回 **60 秒、一次性** 票据；
3. 浏览器只打开 `http://127.0.0.1:<port>/auth/ticket?t=<票据>`；
4. 桥接校验并消费票据，签发 **HttpOnly + SameSite=Strict** 的会话 Cookie（8 小时，仅存内存），302 到控制台首页。

桥接重启会让 Cookie 失效（重新从面板打开即可）。旧版桥接没有票据接口时，面板回退 `?token=` 并在页面上**明确警告**令牌会进地址栏。

## 6. 运行模式

- 优先：`POST /qq-bridge-panel/mode` → 桥接 `POST /api/mode`（桥接自己写穿 DSH `qq-mode` 设置 + 本地 `state/mode.json`，并重建二代定时器等）
- 桥接不在：写 DSH `settings` 的 `qq-mode` 命名空间（`settings.update('qq-mode', {mode}, revision)`），桥接下次启动以它为准
- 无论走哪条路，返回前都**回读真实生效值**；不一致就把 `verified:false` 与原因告诉页面
- 切换模式**不会**改动白名单、模型、工具权限或其它设置
- `closed-agent` 收在「高级」里，切换前显示权限风险说明（完整本地工具面，仅 owner 私聊可能进入）

## 7. QQ 专用模型与推理强度（作用域是重点）

### 数据来源

- 模型目录：DSH `sessionController.modelCatalog()`（与官方模型选择器同一个实现），
  返回 `{ groups[{id,name,models[{id,name,description,reasoning{efforts[{id,name,description}],defaultEffort}}]}], default, failures }`
- 目录里没有 per-model 可用性字段：**在 groups 里 = 可路由**；Provider 级失败在 `failures`（通常是凭据缺失）
- 目录里**没有**输入模态（图片/视觉）元数据 —— 所以面板显示「能力未确认」，绝不按模型名猜

### 为什么不能直接调 `session/selectModel`

DSH 0.2.0 的 `session/selectModel` 除了安装会话局部选择，还会 **fire-and-forget** 调
`agentDefaultModel.saveSelection(selected)` —— 无条件写 DSH 全局默认模型
（`~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `agent-default-model.config`）。
RPC 参数里没有 `remember/persist/scope` 之类的开关，调用方关不掉它。
原版 qq-bridge 正是用它，于是"只想给 QQ 助手换模型"会悄悄改掉 Web GUI 新会话的默认模型。

### 现在的实现

```
面板选择模型
  → POST /qq-bridge-panel/model
      → 校验：模型在目录里？推理档位被该模型支持？
      → 桥接在线：POST /api/dsh/model（桥接写 config.json + 递增 modelSelectionEpoch）
        桥接离线：直接写 config.json（0600，原子替换），下次启动生效
  → QQ 会话下一次请求前，桥接 ensureChatModel()
      → POST http://127.0.0.1:<dsh>/qq-bridge-panel/model/apply {sessionId, provider, model, reasoningEffort}
          → 面板 host：sessionController.resolveAgent()
                       → llm.resolveCallConfig()（物化 provider/model/effort）
                       → agents.serializeImageAdmission(agent, () => agents.selectForNextRequest(agent, selected))
          → 结果：会话日志追加 `model/selection` 事件（会话局部、可持久化）
  → 全局默认模型：**全程不写**
```

- `selectForNextRequest` 与官方 `selectModel` 前面几步完全一致，只少了最后那句 `saveSelection`
- 因此 QQ 会话的模型在 DSH 重启后仍然保留（`model/selection` 在会话日志里）
- 生效时机：新会话立即生效；已有会话在**下一条消息**生效；正在执行的回合不被打断
- `config.json` 的 `dsh.modelScope` 默认 `session`；设为 `global` 才回到旧行为（会写全局默认，面板显示警告）

### 推理强度

- 档位来自所选模型的 `reasoning.efforts[].id`（适配器自定义：核心 deepseek 是 `off/low/high/max`，
  amd-qq 路由是 `disabled/low/high/max`），**不再写死 `low/high/max`**
- 模型不支持可配置推理强度 → 整行隐藏并说明；目录不可用 → 显示「能力未确认」
- 切换模型时：旧档位被新模型支持就保留，否则改用新模型的 `defaultEffort`；没有则记 `auto`
  （= 不传 `reasoningEffort`，交给适配器默认），**绝不把不兼容档位静默提交**

## 8. 安全边界

| 面 | 措施 |
| --- | --- |
| 网络 | 面板路由只接受回环来源；打开的 URL 必须是 `127.0.0.1/localhost/[::1]`（`assertLoopbackUrl`），配置被改成外网地址会被拒绝 |
| CSRF | 所有写操作要求 `application/json` + Origin 同源校验 + 8K/64K body 上限 |
| 令牌 | `consoleToken` 不返回页面（只给"已配置（N 位）"），打开浏览器走一次性票据 |
| 进程 | 只停止三重校验通过的自己启动的进程；外部实例返回 `code:'external'` 且不发送任何信号 |
| 命令 | LLBot 启动只认固定命令数组/派生命令；浏览器只能提交 service 名，不能提交命令 |
| 模型 | 只接受目录里存在的模型与该模型公布的推理档位；会话必须已存在于 DSH |
| MCP | 面板不注册、不恢复任何全局 MCP；QQ MCP 仍只挂在 `qq-chat` / `qq-chat-v2` preset 上 |

## 9. 安装 / 升级 / 卸载

```bash
# 仓库内（开发）
node scripts/setup-dsh.mjs                # 注册三个 bundle（含 qq-bridge-panel）
# 之后重启 DSH
```

- **升级**：面板版本写在 `status.panel.version`；改 host 半（`lib/*.js`）必须重启 DSH 才生效（ESM 模块缓存），
  改 client 半（`client.js`）会随插件热更新/刷新页面生效。
- **卸载**：从 profile 的 `package.json` 里移除 `qq-bridge-panel` 依赖与 bundles 条目，删除 `node_modules/qq-bridge-panel` 链接，
  重启 DSH。桥接与 LLBot 本身不受影响；`state/panel-services.json` 与 `state/panel-logs/` 可安全删除。
- **回滚**：本页所有状态都在 `state/` 与桥接 `config.json`；回到旧版面板插件即可，桥接侧改动（票据、
  `POST /api/dsh/model`、`modelScope`）对旧面板是**向前兼容**的（旧面板继续用 `?token=` 打开）。

## 10. 常见问题

- **「启动」按钮是灰的**：LLBot 需要 `panel.llbotCommand` 或 `launcherPath + panel.llbotQq`；桥接需要 node 可解析。
- **QQ 一直「等待扫码」**：打开 LLBot WebUI 用手机 QQ 扫码；这不是启动失败。
- **「打开控制台」灰着**：桥接未运行，或端口上不是桥接（控制台 `/api/status` 不返回 JSON），或没配 `consoleToken`。
- **模型菜单打不开 / 显示目录不可用**：DSH 没有可路由模型（Provider 凭据缺失）；`failures` 会列出原因。
- **改了模型，普通会话的默认模型变了吗**：不会（`dsh.modelScope=session`）。可在 DSH 设置里查看默认模型确认；
  若你显式设成 `global`，面板会用醒目文字提示该副作用。
