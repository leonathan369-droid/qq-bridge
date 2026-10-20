// QQ 仿真会话：把**继承来的全局工具**逐个动态 deny，preset 自己注册的 scoped 工具保留。
//
// 为什么这样做（实测 0.2.0-rc.2）：
//   dsh-tools 的可见性规则（lib/index.js view()）：
//     - inherited（全局层 + 祖先 scope 注册的工具）→ 逐个过所有 restriction 层；
//     - 只有**当前查看 scope 自己的 layer** 里的工具享有「scoped registrations remain visible」。
//   所以：
//     1) 逐名 deny 的硬编码名单会漏 —— restrict() 对"调用时尚不存在"的名字抛
//        `names unknown global tool`，qq-tool-restrict 里逐条 catch 后静默跳过；
//        preset 挂载早于 agent-team / schedule / bili-scroll / computer-use / mnemon
//        这批全局 bundle，它们的工具正好全部漏网（实测 qq-chat-v2 拿到 145 个工具，
//        其中 55 个 cua_driver_native__*）。
//     2) 反过来用 `restrict({ allow: [] })` 会把 preset 自己的 scoped 工具也一起隐藏
//        （agent 视角下 preset 挂载的工具同样是 inherited）—— 实测只剩 13 个 agent 级工具。
//   因此唯一正确的口径是：**只 deny 全局层里的名字，且要动态覆盖后注册的**。
//
// 实现：`ctx.tools.view(undefined).restrictableNames` 返回全局层（无 scope overlay）
// 里所有可被 restrict 的工具名（view(undefined) 的 chainLayers 为空、own 为空）。
// 首次同步 + 每次 `tools/change` 增量 deny 新出现的名字；restrict 层挂在 preset 的
// mounted scope 上，agent 继承该 restriction，于是 schema 里不再出现任何全局工具。
// preset 自己挂的 persona/tool-web/tool-ask-user/tool-todo/MCP 工具都不是全局层，
// 不会被 deny，仍然可见。
//
// 边界（DSH 架构限制，不是本文件能解决的）：
//   `send_message` / `spawn_teammate` / `wait_agent` / `team_task_*` / `schedule_*`
//   是 host bundle 通过 `agent.ctx.tools.register()` 注册的 **agent 级 scoped 工具**，
//   它们属于 agent 自己的 layer，按 dsh-tools 契约「scoped registrations remain visible」
//   不受 restriction 影响。qq-tool-restrict 的执行期 guard 会拒绝它们（不在白名单），
//   但 schema 仍会列出。要彻底隐藏需要上游提供 per-preset 能力开关。
export const name = 'qq-global-tool-deny'

export const inject = ['tools']

export function apply(ctx) {
  const covered = new Set()

  const sync = () => {
    let restrictable
    try {
      restrictable = ctx.tools.view(undefined)?.restrictableNames
    } catch (error) {
      console.error(`[qq-global-tool-deny] cannot read global tool names: ${error?.message ?? error}`)
      return
    }
    if (!restrictable) return
    const fresh = []
    for (const name of restrictable) {
      if (covered.has(name)) continue
      covered.add(name)
      fresh.push(name)
    }
    if (fresh.length === 0) return
    try {
      ctx.tools.restrict({ deny: fresh })
    } catch (error) {
      // 失败不能让 preset 挂载失败：执行期还有 guard 兜底，但 schema 可能残留，必须留痕。
      console.error(`[qq-global-tool-deny] deny failed for ${fresh.join(', ')}: ${error?.message ?? error}`)
    }
  }

  sync()
  // 后注册的全局工具（agent-team / schedule / bili-scroll / computer-use / mnemon …）
  // 会在 tools/change 之后再被 deny 一次。global: true 表示跨 scope 接收（事件由根 ctx 发出）。
  ctx.on('tools/change', sync, { global: true })
}
