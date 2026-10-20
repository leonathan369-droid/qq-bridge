# QQ Bridge for macOS · v0.3.0 发布准备

> 状态：**发布材料已就绪，尚未公开发布**（按本轮要求只做准备工作）。
> 本文件是"要发布时照做"的清单，不是发布公告。

## 1. 身份与定位

| 项 | 内容 |
| --- | --- |
| 对外名称 | **QQ Bridge for macOS** |
| 副标题 | DeepSeek Harness · 本地 QQ Agent |
| 包 / 插件名 | 仓库 `qq-bridge`；DSH 插件 `qq-bridge-panel` / `qq-agent-presets` / `qq-mode-console` |
| 版本 | `0.3.0`（前序 `0.2.0-r3`） |
| 定位 | **第三方社区集成**，不是 DeepSeek 官方发布。页面标题与 README 都必须写清这一点，不得使用官方 logo/名义。 |
| 许可 | MIT（仓库根 `LICENSE`，含「数据出机清单」） |
| 目标平台 | macOS Apple Silicon 为主要验证平台；代码本身跨平台（Windows 的 `.bat` 与 `chcp` 逻辑仍在，Linux 未实测） |

## 2. 兼容性声明

- DSH Desktop / Web **0.2.0-rc.2**（本轮全部改动在这版实测；0.1.7 的路径仍在代码注释里，但未逐项回归）
- Node.js ≥ 22.13（桥接与 MCP server 用内置 `fetch`/`WebSocket`）
- LLBot / OneBot 11（本机验证组合：LLBot + `ob11.ws/3001` + `ob11.http/3000`）；SnowLuma 仍是文档支持的 OneBot 实现
- 面板 host 半依赖 DSH 的 `sessionController.modelCatalog()` / `llm.resolveCallConfig()` /
  `sessionController.agents.selectForNextRequest()`。**最后一个是实例字段（非 RPC）**：
  DSH 升级若改内部结构，面板会在 `/status` 的 `model.catalogError` 与
  `POST /model/apply` 的返回里明确报"不兼容"，而不是静默降级。

## 3. 首次安装

```bash
git clone <repo> qq-bridge && cd qq-bridge
cp config.example.json config.json          # 至少填 snowluma.webuiUrl / consoleToken / dsh.baseUrl
node scripts/setup-dsh.mjs [profile]        # 注册三个 bundle（含 qq-bridge-panel）
# 重启 DSH；设置 → QQ 桥接
```

- **不依赖任何外部启动台**：面板自己就能启动/停止桥接与 LLBot。
  · 桥接：面板用绝对路径 detached 启动，登记 pid + 命令行指纹 + 端口，随时可停；
  · LLBot：需要一次性配置「怎么启动它」——`panel.llbotCommand`（固定命令数组）、
    或 `snowluma.launcherPath` + `panel.llbotQq`、或只给 `launcherPath` 让面板从
    LLBot `data/config_<QQ>.json` 自动识别账号（仅单账号时；多账号要求显式指定）。
  · 不配置时面板只探测与打开 WebUI，**不会**杀你自己启动的 LLBot（安全设计）。
- `dsh.modelScope` 默认 `session`（推荐）。**不要**在没有明确理由时改 `global`。

## 4. 升级与迁移（0.2.0-r3 → 0.3.0）

| 变化 | 迁移动作 |
| --- | --- |
| 面板从「启停开关」升级为控制中心 | 无：同一张设置页，同一路由前缀；旧书签/习惯不变 |
| 桥接新增 `POST /api/dsh/model`、`POST /api/console/ticket`、`GET /auth/ticket` | 重启桥接进程即生效；面板对旧桥接有回退（`?token=` 打开 + 写 config.json 待重启），不会假装成功 |
| QQ 模型默认改会话作用域 | 无：`dsh.modelScope` 缺省即 `session`。旧行为可用 `global` 显式找回（面板会警告） |
| 等待接口的权限复核修复 | 无（纯行为修复） |
| `state/panel-services.json`、`state/panel-logs/` | 新增运行时文件，可安全删除；`state/` 已在 `.gitignore` |

升级后建议跑一次：

```bash
npm run test:audit                 # 期望 32/32
npm run verify:panel-isolation     # 期望「模型作用域隔离成立」，且全局默认模型前后一致
```

## 5. 卸载与回滚

**卸载面板（保留桥接与 LLBot）**

1. 编辑 `~/.dsh/profiles/<profile>/package.json`：从 `dependencies` 删 `qq-bridge-panel`，
   从 `dsh.profile.bundles` 删对应条目；
2. 删除 `node_modules/qq-bridge-panel`（若是 `link:` 软链，只删链）；
3. 重启 DSH；删除 `state/panel-services.json` 与 `state/panel-logs/`（可选）。

**回滚到上一版面板**（不丢其它开发成果）

```bash
cd <repo>
git log --oneline -- plugins/qq-bridge-panel scripts/test-panel-host.mjs
git checkout 76124b2 -- plugins/qq-bridge-panel scripts/test-panel-host.mjs   # 面板基线版本
node scripts/setup-dsh.mjs && # 重启 DSH
```

> 不要用 `git reset --hard` / `git checkout -- .`：工作区可能还有其它未提交成果。
> 桥接侧的新接口对旧面板**向前兼容**（旧面板继续用 `?token=` 打开），所以只回滚面板是安全的。

## 5.5 生成物与隐私（发布前必须确认）

| 项 | 规则 |
| --- | --- |
| `plugins/qq-agent-presets/presets/*.patch.yml` | **生成物，不进版本控制**（`.gitignore`）。内含本机 node 路径与仓库路径，由 `setup-dsh.mjs` 在安装时生成。源文件里只有占位符 `__QQ_BRIDGE_NODE__` / `__QQ_BRIDGE_ROOT__`。 |
| `docs/images/*.png` | 仅用于 README 展示；截图中的路径/QQ 号已脱敏为示例值（`/opt/...`、`100000000`）。 |
| 仓库内不得出现的 | 作者本机绝对路径（`/Users/<name>`、`/home/<name>`）、真实 QQ 号/群号、控制台令牌、LLBot 密码、聊天记录、学习数据、`state/`、`config.json`。 |
| 提交历史 | 发布前用 `git filter-branch`/`filter-repo` 清理历史里的本机路径与个人 committer 邮箱（本仓库发布时已做过一次）。发布前可复查：`git log -p --all | grep -E "/Users/[a-z]"`。 |

## 6. 发布包内容检查（必做）

发布 zip / Release 资产前逐项确认**不包含**：

- [ ] `config.json`、`state/`（聊天记录、收藏表情、学习数据、令牌）、`*.bak*`
- [ ] `~/.dsh` 相关路径、本机用户名/工作盘、真实 QQ 号/群号
- [ ] API Key、`consoleToken`、LLBot WebUI 密码/令牌、QQ 登录凭据
- [ ] `node_modules/`、`.DS_Store`、本地调研/审计文档（`.gitignore` 已覆盖 `docs/audits|design|legacy|research`）

```bash
npm run privacy-scan     # 仓库自带扫描
git status --porcelain   # 应为空
git archive --format=zip -o /tmp/qq-bridge-0.3.0.zip HEAD   # 只打包已提交内容
```

## 7. 第三方许可义务（发布前核对）

| 组件 | 关系 | 义务 |
| --- | --- | --- |
| 上游 [qq-bridge](https://github.com/Derpyu520/qq-bridge) | fork 基线 | 保留上游 LICENSE 与版权声明；README 注明衍生关系与本机适配改动 |
| LLBot / LuckyLilliaBot | 外部程序，**不打包** | 不随发布分发其二进制；只在文档里说明"需要用户自行安装"，并声明本项目与其无隶属关系 |
| SnowLuma（OneBot 实现） | 外部程序，不打包 | 同上；`scripts/patch-snowluma-sdk.mjs` 只在本机 patch，发布包不含其产物 |
| QQ 表情 ID 映射 / 收藏表情 | 用户数据 | 映射表是接口字段名，不含图片；用户收藏表情只在本地 `state/stickers/`，不打包 |
| @deepseek-ai/* | DSH 宿主依赖（peer） | 不打包、不重分发；只通过 DSH 插件机制使用其公开接口 |

## 8. 已知限制（发布说明里必须写）

1. 群聊模式的 MCP 工具在**执行期**被白名单拒绝，但 schema 里仍会列出 agent 级 scoped 工具
   （`send_message` / `team_task_*` / `schedule_*` 等）——这是 DSH 架构限制，已在
   `plugins/qq-agent-presets/qq-global-tool-deny.mjs` 与 RULES 里写明。
2. DSH 模型目录没有输入模态（图片/视觉）元数据，模型选择器只能显示「能力未确认」，不按模型名推断。
3. 面板 host 半改了要重启 DSH 才生效（ESM 模块缓存）；client 半可随页面刷新生效。
4. macOS 上 Chcp/`.bat` 相关逻辑只在 Windows 生效；测试已按平台 SKIP 并说明原因。
5. LLBot 未登录时 OneBot 端口通常不开放 —— 面板显示「等待扫码」，这不是启动失败。
