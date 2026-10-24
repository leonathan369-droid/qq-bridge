# Release v0.3.3 — 「看不到图」、角色卡工具死链、角色卡→preset 同步

- **日期**：2026-10-24
- **上一个版本**：[v0.3.2](RELEASE-v0.3.2.md)（同日，修回合追踪把会话永久判繁忙）
- **影响面**：桥接进程（`src/safe-fetch.js`、`src/bridge.js`）、预设源文件（加标记）、
  生成脚本（`scripts/build-agent-preset-patches.mjs`）。**面板逻辑未改**。
- **是否需要重启 DSH**：本次不需要 —— 预设产物的渲染结果与之前**逐字节一致**（见 §3.3 的自检），
  只是多了同步脚本与标记；桥接重启即可生效。

## 1. 现象

QQ 里发的图片/表情，AI **永远看不到**，一直回复"看不到图/图糊了"。桥接日志在每次图片消息时刷：

```
get_image 解析失败: 域名解析到内网/本机地址，已阻止
图片 URL 抓取失败: 域名解析到内网/本机地址，已阻止
```

## 2. 根因（实测）

**本机在跑 TUN + fake-IP 代理**（Clash/Surge/sing-box 一类）。实测 DNS：

| 域名 | 解析结果 |
| --- | --- |
| `multimedia.nt.qq.com.cn`（QQ 图床） | `198.18.0.9` |
| `gchat.qpic.cn` / `c2cpicdw.qpic.cn` | `198.18.0.15` / `198.18.0.16` |
| `www.baidu.com` / `github.com` | `198.18.0.17` / `198.18.0.18` |

`safe-fetch.js` 的 SSRF 防护把 `198.18.0.0/15`（IETF 基准测试保留段，fake-IP 默认段）
当作内网 → **所有**图片/表情/`web_fetch` 抓取被拦。代理 TUN 会把实际流量接管，
所以这是"防护误杀"，不是网络不通（用 curl 直连同一 URL 也能拿到内容）。

代码里其实早有一个手动开关 `QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1`，但默认关闭，普通用户
既不知道也不会设 → 100% 复现"消息能看到、图永远看不到"。

## 3. 修复

### 3.1 自动识别 fake-IP 环境（`src/safe-fetch.js`）

- 探测 3 个**固定公网域名**（`www.baidu.com` / `www.qq.com` / `example.com`）：
  若 ≥2 个答出来、且解析结果**全部**落在 `198.18.0.0/15` → 判定为 fake-IP 环境，自动放行该段。
- 结果缓存 5 分钟（中途开/关代理不必重启桥接）；探测失败一律按"不是"处理，绝不影响抓取。
- 仍可手动覆盖：`QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1` 强制放行、`=0` 强制严格。
- 被拦时的错误信息会直接给出诊断提示（含"看起来本机在用 TUN fake-IP 代理"）。

### 3.2 安全边界：只放行"域名 → 保留段"，绝不放开内网

| 场景 | 修复后 |
| --- | --- |
| 域名解析到 `198.18.x.x`（fake-IP） | ✅ 放行（自动识别时） |
| URL 里直接写 `198.18.0.9`（IP 字面量） | ❌ 仍拦（fake-IP 是 DNS 现象，不是直连许可） |
| `127/10/172.16/192.168/169.254/CGNAT/0.0.0.0` | ❌ 仍拦 |
| `::1` / `fe80::/10` / `::ffff:192.168.1.1` 等 IPv6 内网 | ❌ 仍拦 |
| `localhost` / `.local` | ❌ 仍拦 |

回归 `scripts/test-safe-fetch-fakeip.mjs`（28 条断言）把上表逐条钉住。

### 3.3 桥接自检与可观测

- 启动时探测一次并打日志：
  `检测到 TUN fake-IP 代理环境（公网域名解析到 198.18.0.0/15）：已自动放行该保留段的公网抓取…`
- `GET /api/status` 新增 `network.proxyFakeIp`（`null` 未探测 / `true` 已识别并放行），
  面板/排查时一眼可辨。

### 3.4 `qq_get_prompt` 能真的拿到角色卡了

上一版遗留的不一致：`config.role.injectPerMessage=false` 时，逐条注入关掉是对的，
但 `qq_get_prompt` 走了**同一个开关** → `role.hint` 恒为空（实测长度 **0**），
而唤醒提示里却写着"完整角色卡请调用 qq_get_prompt 查看" → 死链。

现在两个 hint 函数都接受 `ignoreInjectPerMessage`，`qq_get_prompt` 传 `true`：
工具是**按需调用**，不存在"每条消息都进历史"的 token 成本。实测同一接口：

| | 修复前 | 修复后 |
| --- | --- | --- |
| `role.hint` 长度 | 0 | **4994**（v2 过滤后全文，已剔除一代 `[SILENT]` 指令） |

### 3.5 角色卡 → preset 常驻人格：同步脚本 + 标记

问题：`injectPerMessage=false` 时人格实际由 preset 的 `persona.prefix` 承载（里面是
**手工副本**），但仓库里没有任何同步机制 → "控制台改了角色卡，QQ 里的 AI 一点没变"。

修法：

1. 在 `dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml` 的角色卡前后插入
   `<!-- ROLE-CARD:BEGIN/END -->` 标记；
2. 新增 `scripts/sync-role-to-preset.mjs`：
   - `--check`（默认）：比对 `roles/<当前角色>.md` 与两份 preset，不一致时打印差异行数并以 1 退出；
   - `--write`：替换标记之间的内容（保留缩进与后续段落），并提示重跑 `build-agent-preset-patches.mjs`；
   - 便捷入口：`npm run check:role` / `npm run sync:role`。
3. **标记绝不进 prompt**：`build-agent-preset-patches.mjs` 在生成 patch 时剥掉标记行。
   自检结果：加标记前后生成的 `plugins/qq-agent-presets/presets/*.patch.yml`
   **逐字节一致**（`--check` 输出"已是最新"）—— 证明零行为漂移。
4. 回归 `scripts/test-role-preset-sync.mjs`（23 条断言）：仓库当前必须同步、漂移能检出、
   `--write` 后严格等于卡文件、标记缺失时明确报错且不写盘、CLI 退出码、生成产物无标记。

## 4. 回归

| 套件 | 结果 |
| --- | --- |
| `npm run test:audit` | **37/37**（原 35，新增 `test-safe-fetch-fakeip.mjs`、`test-role-preset-sync.mjs`） |
| `npm run test:panel` | 33/33（本次未改面板） |
| `npm run privacy-scan` | ✅ |

## 5. 现场验证（本机，2026-10-24 19:27 后）

- 桥接重启日志出现 fake-IP 自检行；`/api/status.network.proxyFakeIp = true`。
- 真实 QQ 图片经工具端点 `/api/images/message` 返回 **1.1 MB** base64（`image/gif`，GIF 魔数正确）。
- 另两条新鲜 QQ 图床 URL 直接抓取成功（133 KB / 1.1 MB）；`www.baidu.com`、`www.google.com` 的 PNG 也正常。
- 旧缓存 URL 报 `download url has expired` 属 QQ 侧正常过期（curl 同样 400），与本次修复无关。
- `qq_get_prompt` 的 `role.hint` 长度 0 → 4994。

## 6. 边界与已知限制

- fake-IP 识别依赖 DNS 探测：若代理只在**部分**域名上启用 fake-IP（分流规则），可能识别不出；
  此时手动设 `QQ_BRIDGE_ALLOW_PROXY_FAKE_IP=1` 仍可放行。
- 放行范围严格限定 `198.18.0.0/15` 且仅限域名路径；其它保留段/私网段与 IP 字面量一律不变。
- QQ 图片下载 URL 有有效期（服务端过期返回 `download url has expired`）。桥接是"收到消息即取"，
  正常路径不受影响；翻很久以前的消息取图可能失败，这是 QQ 侧限制。
- 角色卡同步只覆盖 `persona.prefix` 里那份副本；若你在别处（MCP prompt、控制台二代提示词）另写了
  人设，那些不归本脚本管。
- 改了角色卡后仍需 `npm run sync:role` → 重新生成 patch → 重启 DSH 才在运行中的 agent 生效。
