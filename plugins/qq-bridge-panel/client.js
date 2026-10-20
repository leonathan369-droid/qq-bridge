/**
 * qq-bridge-panel —— 浏览器半（DSH 设置页「QQ 桥接」）
 * ============================================================================
 * ⭐ client bundle 是**自注册脚本**（不是 ESM）：window.__ModuleLoader__.load({ id, factory }).
 *    id 必须等于 package.json 的 name；factory 返回 { inject, apply(ctx) }。
 *
 * 入口位置：`settings.section` 槽位 = DSH 设置左侧导航里的一页（与 dsh-bili-scroll
 * 的「刷B站」同一写法）。页面本身只发同源请求到 host 半的
 * `/qq-bridge-panel/{status,start,stop,open}`，不直接碰端口/进程/剪贴板。
 *
 * 交互约定（用户 2026-10-21 明确要求）：
 *   · 「启动 / 停止」是端口的开关；
 *   · 「打开控制台 / 打开 LLBot WebUI」只有在对应端口**已监听**时才可点，
 *     否则保持禁用并显示原因（不能让人点了没反应）。
 */
window.__ModuleLoader__.load({
  id: 'qq-bridge-panel',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 与 host 半 lib/index.js 的 PANEL_ROUTE 保持一致。 */
    const API = '/qq-bridge-panel'
    const POLL_MS = 2500

    const CSS = `
[data-qbp-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:680px;color:inherit;}
[data-qbp-title]{font-size:15px;font-weight:600;}
[data-qbp-sub]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-card]{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid rgba(128,128,128,.22);border-radius:12px;}
[data-qbp-card-head]{display:flex;align-items:center;gap:8px;}
[data-qbp-card-name]{font-size:13px;font-weight:600;flex:1;min-width:0;}
[data-qbp-dot]{flex:none;width:8px;height:8px;border-radius:4px;background:rgba(128,128,128,.45);}
[data-qbp-dot][data-on]{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);}
[data-qbp-meta]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b8f96);word-break:break-all;}
[data-qbp-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-qbp-btn]{appearance:none;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.10);color:inherit;
  font-size:12px;line-height:16px;padding:6px 12px;border-radius:8px;cursor:pointer;}
[data-qbp-btn]:hover:not(:disabled){background:rgba(128,128,128,.18);}
[data-qbp-btn]:disabled{opacity:.42;cursor:not-allowed;}
[data-qbp-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-qbp-btn][data-primary]:hover:not(:disabled){background:#2f74e0;}
[data-qbp-btn][data-danger]{border-color:rgba(239,68,68,.5);color:#ef4444;}
[data-qbp-btn][data-primary]:disabled,[data-qbp-btn][data-danger]:disabled{background:rgba(128,128,128,.10);border-color:rgba(128,128,128,.25);color:inherit;}
[data-qbp-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-msg]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.10);}
[data-qbp-msg][data-kind="err"]{background:rgba(239,68,68,.12);color:#ef4444;}
[data-qbp-msg][data-kind="ok"]{background:rgba(34,197,94,.12);color:#16a34a;}
`

    const asJson = async (res) => {
      let data = {}
      try {
        data = await res.json()
      } catch {}
      if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
      return data
    }

    const request = async (path, init) => {
      const res = await fetch(API + path, { credentials: 'same-origin', ...init })
      return asJson(res)
    }

    const post = (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    function Dot(props) {
      return h('span', { 'data-qbp-dot': '', ...(props.on ? { 'data-on': '' } : {}) })
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await request('/status'))
        } catch (error) {
          setMessage({ kind: 'err', text: `面板后端不可用：${String(error?.message ?? error)}` })
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) refresh()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      const act = async (label, task) => {
        if (busy) return
        setBusy(label)
        setMessage(null)
        try {
          const out = await task()
          setMessage({ kind: out?.ok === false ? 'err' : 'ok', text: String(out?.message ?? '完成') })
        } catch (error) {
          setMessage({ kind: 'err', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
          refresh()
        }
      }

      const bridge = status?.bridge
      const llbot = status?.llbot
      const nodeReady = Boolean(status?.nodePath)
      const bridgeOpen = Boolean(bridge?.open)
      const llbotOpen = Boolean(llbot?.open)
      const bridgeDisabled = busy !== '' || bridgeOpen

      return h(
        'div',
        { 'data-qbp-page': '' },
        h('div', { 'data-qbp-title': '' }, 'QQ 桥接'),
        h(
          'div',
          { 'data-qbp-sub': '' },
          '管理桥接进程与控制台端口，并在端口就绪后打开控制台或 LLBot WebUI。',
        ),
        status && !status.configFound
          ? h('div', { 'data-qbp-msg': '', 'data-kind': 'err' }, `读不到桥接配置：${status.configFile}${status.configError ? `（${status.configError}）` : ''}`)
          : null,

        // ── 桥接控制台 ────────────────────────────────────────────────────
        h(
          'div',
          { 'data-qbp-card': '' },
          h(
            'div',
            { 'data-qbp-card-head': '' },
            h(Dot, { on: bridgeOpen }),
            h('span', { 'data-qbp-card-name': '' }, '桥接控制台'),
            h('span', { 'data-qbp-meta': '' }, bridge ? `端口 ${bridge.port}` : ''),
          ),
          h(
            'div',
            { 'data-qbp-meta': '' },
            bridgeOpen
              ? `运行中${bridge.owned ? '（面板启动）' : '（外部启动，面板不能停止）'}${
                  bridge?.mode ? ` · 模式 ${bridge.mode}` : ''
                }${bridge?.dshReady ? ' · DSH 已就绪' : ''}${bridge?.tokenConfigured ? '' : ' · ⚠️ 未配置控制台令牌'}`
              : '未运行（端口未监听）',
          ),
          h(
            'div',
            { 'data-qbp-row': '' },
            h(
              'button',
              {
                'data-qbp-btn': '',
                'data-primary': '',
                disabled: bridgeDisabled || !nodeReady,
                title: nodeReady ? '' : '找不到 node，无法启动',
                onClick: () => act('启动桥接', () => post('/start', { service: 'bridge' })),
              },
              busy === '启动桥接' ? '启动中…' : '启动桥接',
            ),
            h(
              'button',
              {
                'data-qbp-btn': '',
                'data-danger': '',
                disabled: busy !== '' || !bridgeOpen || !bridge.owned,
                title: bridgeOpen && !bridge.owned ? '该实例不是面板启动的' : '',
                onClick: () => act('停止桥接', () => post('/stop', { service: 'bridge' })),
              },
              '停止桥接',
            ),
            h(
              'button',
              {
                'data-qbp-btn': '',
                disabled: busy !== '' || !bridgeOpen,
                title: bridgeOpen ? '' : '先启动桥接（端口监听后才能打开）',
                onClick: () => act('打开控制台', () => post('/open', { target: 'console' })),
              },
              '打开控制台',
            ),
          ),
          h(
            'div',
            { 'data-qbp-note': '' },
            '停止只对面板自己启动的实例生效；终端或启动台启动的桥接请回去停止，避免误杀正在处理的 QQ 消息。',
          ),
        ),

        // ── LLBot WebUI ───────────────────────────────────────────────────
        h(
          'div',
          { 'data-qbp-card': '' },
          h(
            'div',
            { 'data-qbp-card-head': '' },
            h(Dot, { on: llbotOpen }),
            h('span', { 'data-qbp-card-name': '' }, 'LLBot WebUI'),
            h('span', { 'data-qbp-meta': '' }, llbot?.port ? `端口 ${llbot.port}` : '未配置'),
          ),
          h(
            'div',
            { 'data-qbp-meta': '' },
            llbotOpen ? `运行中${llbot.owned ? '（面板启动）' : '（外部启动）'} · ${llbot.url}` : '未运行（端口未监听）',
          ),
          h(
            'div',
            { 'data-qbp-row': '' },
            llbot?.startable
              ? h(
                  'button',
                  {
                    'data-qbp-btn': '',
                    disabled: busy !== '' || llbotOpen,
                    onClick: () => act('启动 LLBot', () => post('/start', { service: 'llbot' })),
                  },
                  '启动 LLBot',
                )
              : null,
            llbot?.owned
              ? h(
                  'button',
                  {
                    'data-qbp-btn': '',
                    'data-danger': '',
                    disabled: busy !== '',
                    onClick: () => act('停止 LLBot', () => post('/stop', { service: 'llbot' })),
                  },
                  '停止 LLBot',
                )
              : null,
            h(
              'button',
              {
                'data-qbp-btn': '',
                disabled: busy !== '' || !llbotOpen,
                title: llbotOpen ? '' : '先启动 LLBot（WebUI 端口监听后才能打开）',
                onClick: () => act('打开 LLBot', () => post('/open', { target: 'llbot' })),
              },
              '打开 WebUI',
            ),
          ),
          h(
            'div',
            { 'data-qbp-note': '' },
            'LLBot 是第三方程序，默认由你自己启动；面板只在 config.json 配置了 panel.llbotCommand 时才代管启停。',
          ),
        ),

        message ? h('div', { 'data-qbp-msg': '', 'data-kind': message.kind }, message.text) : null,
        status?.nodePath ? h('div', { 'data-qbp-note': '' }, `node：${status.nodePath}`) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 加载自检：host 半的 /status.client.seen 靠这一次 ping 置位（不影响任何功能）。
        fetch(API + '/ping', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => {})

        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'qq-bridge-panel')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'qq-bridge-panel: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'qq-bridge-panel', order: 31, label: 'QQ 桥接' },
            () => h(Panel),
          ),
        )
      },
    }
  },
})
