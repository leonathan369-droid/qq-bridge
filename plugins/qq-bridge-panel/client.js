/**
 * qq-bridge-panel —— 浏览器半（DSH 设置页「QQ 桥接」）
 * ============================================================================
 * ⭐ client bundle 是**自注册脚本**（不是 ESM）：window.__ModuleLoader__.load({ id, factory }).
 *    id 必须等于 package.json 的 name；factory 返回 { inject, apply(ctx) }。
 *
 * 入口位置：`settings.section` 槽位 = DSH 设置左侧导航里的一页。
 * 页面只发同源请求到 host 半（/qq-bridge-panel/*），不直接碰端口/进程/浏览器。
 *
 * 页面结构（2026-10-21 产品化）：
 *   A 标题 · B 四状态概览 · C 两个主操作 · D 服务管理 · E 运行模式
 *   F QQ 专用模型（原生风格选择器）· G 推理强度 · H 高级设置与诊断（折叠）
 *
 * 模型选择器的视觉/交互对齐 DSH 原生 `ui-model-selection`：同样的 DSH 设计变量
 * （--dsw-alias-*）、provider 分组、搜索、勾选、键盘导航、加载/失败/空态。
 * 官方组件 `ModelSelect` 是私有函数、绑定在聊天会话的 slot 上，无法在 Settings 页
 * 独立渲染（已核对 asar 内 lib/client.js）；因此这里实现"视觉与交互一致的适配层"，
 * 数据仍走 DSH 的真实模型目录（host 半通过 sessionController.modelCatalog() 读取）。
 */

window.__ModuleLoader__.load({
  id: 'qq-bridge-panel',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 与 host 半 lib/index.js 的 PANEL_ROUTE 保持一致。 */
    const API = '/qq-bridge-panel'
    const POLL_MS = 2500

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 颜色全部走 DSH 设计变量；拿不到时用中性半透明值兜底（亮/暗主题都能看）。
    const CSS = `
[data-qbp-page]{display:flex;flex-direction:column;gap:18px;padding:2px 4px 24px;max-width:760px;color:inherit;
  font-size:13px;line-height:1.5;}
[data-qbp-head]{display:flex;flex-direction:column;gap:4px;}
[data-qbp-title]{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-qbp-title-badge]{font-size:10px;font-weight:500;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));
  color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-sub]{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-section]{display:flex;flex-direction:column;gap:10px;}
[data-qbp-section-head]{display:flex;align-items:baseline;gap:8px;}
[data-qbp-section-title]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}
[data-qbp-section-note]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-card]{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));
  border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-module-platform,rgba(128,128,128,.05));}
[data-qbp-card-plain]{background:transparent;}
[data-qbp-grid]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}
@media (max-width:640px){[data-qbp-grid]{grid-template-columns:repeat(2,minmax(0,1fr));}}
[data-qbp-stat]{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));min-width:0;}
[data-qbp-stat-head]{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-stat-value]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-qbp-stat-detail]{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#8b8f96);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
[data-qbp-dot]{flex:none;width:8px;height:8px;border-radius:50%;background:rgba(140,140,140,.55);}
[data-qbp-dot][data-state="ok"]{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.16);}
[data-qbp-dot][data-state="waiting"]{background:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.16);}
[data-qbp-dot][data-state="degraded"]{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.16);}
[data-qbp-dot][data-state="down"]{background:rgba(140,140,140,.55);}
[data-qbp-dot][data-state="error"]{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16);}
[data-qbp-pill]{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));color:var(--dsw-alias-label-secondary,#5c6370);}
[data-qbp-pill][data-tone="ready"]{border-color:rgba(34,197,94,.45);color:#16a34a;background:rgba(34,197,94,.1);}
[data-qbp-pill][data-tone="partial"]{border-color:rgba(245,158,11,.45);color:#b45309;background:rgba(245,158,11,.1);}
[data-qbp-pill][data-tone="waiting"]{border-color:rgba(59,130,246,.45);color:#2563eb;background:rgba(59,130,246,.1);}
[data-qbp-pill][data-tone="error"]{border-color:rgba(239,68,68,.45);color:#dc2626;background:rgba(239,68,68,.1);}
[data-qbp-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-qbp-row-end]{margin-left:auto;}
[data-qbp-btn]{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));
  background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.08));color:inherit;font:inherit;font-size:12px;
  line-height:16px;padding:6px 12px;border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  transition:background .12s,border-color .12s;}
[data-qbp-btn]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}
[data-qbp-btn]:disabled{opacity:.45;cursor:not-allowed;}
[data-qbp-btn][data-primary]{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff;}
[data-qbp-btn][data-primary]:hover:not(:disabled){filter:brightness(1.05);}
[data-qbp-btn][data-primary]:disabled{background:rgba(128,128,128,.14);border-color:rgba(128,128,128,.25);color:inherit;filter:none;}
[data-qbp-btn][data-danger]{border-color:rgba(239,68,68,.45);color:#dc2626;}
[data-qbp-btn][data-lg]{padding:9px 18px;font-size:13px;border-radius:10px;}
[data-qbp-btn][data-active]{border-color:var(--dsw-alias-state-business-primary,#3b82f6);color:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-qbp-meta]{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8b8f96);word-break:break-all;}
[data-qbp-meta][data-warn]{color:#b45309;}
[data-qbp-code]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:rgba(128,128,128,.12);
  padding:1px 5px;border-radius:4px;word-break:break-all;}
[data-qbp-msg]{font-size:12px;line-height:1.6;padding:9px 11px;border-radius:9px;background:rgba(128,128,128,.1);white-space:pre-wrap;}
[data-qbp-msg][data-kind="err"]{background:rgba(239,68,68,.12);color:#dc2626;}
[data-qbp-msg][data-kind="ok"]{background:rgba(34,197,94,.12);color:#16a34a;}
[data-qbp-msg][data-kind="warn"]{background:rgba(245,158,11,.12);color:#b45309;}
[data-qbp-steps]{display:flex;flex-direction:column;gap:4px;margin-top:2px;}
[data-qbp-step]{display:flex;gap:8px;font-size:11px;line-height:1.5;}
[data-qbp-step-state]{flex:none;width:38px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-step][data-state="done"] [data-qbp-step-state],[data-qbp-step][data-state="already"] [data-qbp-step-state]{color:#16a34a;}
[data-qbp-step][data-state="failed"] [data-qbp-step-state]{color:#dc2626;}
[data-qbp-step][data-state="waiting"] [data-qbp-step-state]{color:#2563eb;}
[data-qbp-step][data-state="skipped"] [data-qbp-step-state]{color:#b45309;}
[data-qbp-seg]{display:flex;gap:6px;flex-wrap:wrap;}
[data-qbp-seg-item]{appearance:none;font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:transparent;color:var(--dsw-alias-label-secondary,#5c6370);}
[data-qbp-seg-item]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-qbp-seg-item][data-active]{border-color:var(--dsw-alias-state-business-primary,#3b82f6);
  color:var(--dsw-alias-state-business-primary,#3b82f6);background:rgba(59,130,246,.08);font-weight:600;}
[data-qbp-seg-item]:disabled{opacity:.45;cursor:not-allowed;}

/* ── 模型选择器（对齐 DSH 原生 ModelSelect 的视觉）──────────────────────── */
[data-qbp-model]{position:relative;display:flex;flex-direction:column;gap:8px;}
[data-qbp-model-trigger]{appearance:none;font:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;
  min-height:34px;padding:7px 10px;border-radius:var(--dsw-radius-md,8px);
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:rgba(128,128,128,.06);color:inherit;}
[data-qbp-model-trigger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}
[data-qbp-model-trigger]:disabled{opacity:.5;cursor:not-allowed;}
[data-qbp-model-provider]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96);flex:none;}
[data-qbp-model-name]{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-qbp-model-effort]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96);flex:none;}
[data-qbp-model-chevron]{margin-left:auto;flex:none;color:var(--dsw-alias-label-caption,#8b8f96);transition:transform .12s;}
[data-qbp-model-chevron][data-open]{transform:rotate(180deg);}
/* 菜单表面沿用 DSH 自己的 MenuSurface token（亮/暗由 body[data-ds-dark-theme] 决定，
   不再靠 prefers-color-scheme 猜 —— 之前 UNSET 的 --dsw-alias-bg-elevated 让浅色主题下
   菜单底色也跟着系统走了深色）。 */
[data-qbp-menu]{position:fixed;z-index:1200;display:flex;flex-direction:column;width:min(440px,calc(100vw - 32px));
  max-height:min(420px,calc(100vh - 120px));padding:4px;border-radius:var(--dsw-radius-lg,12px);
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));
  background:var(--dsw-menu-surface-fill,rgba(248,249,250,.96));
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));
  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));
  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18));overflow:hidden;color:inherit;}
[data-qbp-search-row]{flex:none;display:flex;padding:2px 2px 4px;}
[data-qbp-search]{flex:1;appearance:none;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;
  border:1px solid transparent;background:rgba(128,128,128,.1);color:inherit;outline:none;}
[data-qbp-search]:focus{border-color:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-qbp-menu-body]{flex:1;min-height:0;overflow-y:auto;}
/* 分组：标题 sticky 在**自己的分组 wrapper 内**（与 DSH 原生 MenuGroup 同构）——
   这样上一组的标题会随分组滚走，不可能和下一组的标题叠在一起。
   只有「卡住」时才铺不透明底色（原生也是这么做的），否则会让分组标题出现一条色带。 */
[data-qbp-menu-group]{position:relative;}
[data-qbp-menu-group] + [data-qbp-menu-group]{margin-top:3px;}
[data-qbp-group-label]{position:sticky;top:0;z-index:1;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;
  color:var(--dsw-alias-label-tertiary,#8b8f96);padding:4px 8px 2px;background:transparent;
  border-radius:var(--dsw-radius-sm,6px);}
[data-qbp-group-label][data-stuck]{background:var(--dsw-alias-menu-group-header-fill,rgba(248,249,250,.96));}
[data-qbp-option]{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;box-sizing:border-box;
  appearance:none;font:inherit;text-align:left;cursor:pointer;padding:5px 8px;border:none;border-radius:8px;
  background:transparent;color:inherit;}
[data-qbp-option][data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}
[data-qbp-option][data-selected]{font-weight:600;}
[data-qbp-option-copy]{display:flex;flex-direction:column;min-width:0;flex:1;}
[data-qbp-option-name]{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-qbp-option-desc]{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8f96);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-qbp-check]{flex:none;width:14px;color:var(--dsw-alias-state-business-primary,#3b82f6);}
[data-qbp-menu-note]{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8b8f96);padding:8px;}
[data-qbp-menu-error]{font-size:11px;line-height:1.5;color:#dc2626;background:rgba(239,68,68,.1);border-radius:8px;padding:7px 8px;margin:2px;}
[data-qbp-adv]{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:10px;overflow:hidden;}
[data-qbp-adv-head]{appearance:none;font:inherit;width:100%;display:flex;align-items:center;gap:8px;padding:10px 12px;
  background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;font-size:12px;font-weight:600;}
[data-qbp-adv-head]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}
[data-qbp-adv-body]{display:flex;flex-direction:column;gap:10px;padding:2px 12px 12px;}
[data-qbp-kv]{display:grid;grid-template-columns:120px minmax(0,1fr);gap:4px 10px;font-size:11px;line-height:1.5;}
[data-qbp-kv dt]{color:var(--dsw-alias-label-tertiary,#8b8f96);}
[data-qbp-kv dd]{margin:0;color:var(--dsw-alias-label-secondary,#5c6370);word-break:break-all;}
[data-qbp-log]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.5;
  max-height:140px;overflow:auto;white-space:pre-wrap;background:rgba(128,128,128,.1);border-radius:8px;padding:8px;
  color:var(--dsw-alias-label-secondary,#5c6370);}
[data-qbp-spin]{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid currentColor;
  border-right-color:transparent;animation:qbp-spin .7s linear infinite;}
@keyframes qbp-spin{to{transform:rotate(360deg);}}
`

    // ── 基础工具 ────────────────────────────────────────────────────────────
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

    const STATE_TEXT = {
      ok: '运行中',
      degraded: '异常',
      down: '已停止',
      unknown: '未知',
      waiting: '等待扫码',
      online: '在线',
      external: '外部实例',
    }
    const toneOfState = (state) => ({
      ok: 'ok',
      degraded: 'degraded',
      down: 'down',
      unknown: 'unknown',
      waiting: 'waiting',
      online: 'ok',
    }[state] ?? 'unknown')

    /** 把任意状态词收敛成 CSS 支持的五种灯色。 */
    function dotState(state) {
      if (state === 'online') return 'ok'
      if (state === 'waiting') return 'waiting'
      if (state === 'degraded' || state === 'error') return state === 'error' ? 'error' : 'degraded'
      if (state === 'down' || state === 'stopped') return 'down'
      return 'unknown'
    }

    function Dot(props) {
      return h('span', { 'data-qbp-dot': '', 'data-state': dotState(props.state), title: props.title ?? '' })
    }

    function Card(props) {
      return h('div', { 'data-qbp-card': '', ...(props.plain ? { 'data-qbp-card-plain': '' } : {}), ...props.attrs }, props.children)
    }

    function Btn({ label, onClick, disabled, primary, danger, title, busy, large, active }) {
      return h(
        'button',
        {
          'data-qbp-btn': '',
          ...(primary ? { 'data-primary': '' } : {}),
          ...(danger ? { 'data-danger': '' } : {}),
          ...(large ? { 'data-lg': '' } : {}),
          ...(active ? { 'data-active': '' } : {}),
          disabled: Boolean(disabled),
          title: title || '',
          onClick,
        },
        busy ? h('span', { 'data-qbp-spin': '' }) : null,
        busy ? `${label}…` : label,
      )
    }

    function Section({ title, note, children }) {
      return h(
        'section',
        { 'data-qbp-section': '' },
        h(
          'div',
          { 'data-qbp-section-head': '' },
          h('span', { 'data-qbp-section-title': '' }, title),
          note ? h('span', { 'data-qbp-section-note': '' }, note) : null,
        ),
        children,
      )
    }

    function Msg({ kind, text, steps }) {
      if (!text && !(steps && steps.length)) return null
      return h(
        'div',
        { 'data-qbp-msg': '', 'data-kind': kind || 'info' },
        text || null,
        steps && steps.length
          ? h(
              'div',
              { 'data-qbp-steps': '' },
              steps.map((step, index) =>
                h(
                  'div',
                  { 'data-qbp-step': '', 'data-state': step.state, key: `${step.id}-${index}` },
                  h('span', { 'data-qbp-step-state': '' }, {
                    done: '完成',
                    already: '已在跑',
                    waiting: '等待',
                    skipped: '跳过',
                    failed: '失败',
                  }[step.state] ?? step.state),
                  h('span', {}, `${step.label}${step.message ? `：${step.message}` : ''}`),
                ),
              ),
            )
          : null,
      )
    }

    // ── 模型工具 ────────────────────────────────────────────────────────────
    const findGroup = (catalog, provider) => (catalog?.groups ?? []).find((g) => g?.id === provider)
    const findModel = (catalog, provider, model) => (findGroup(catalog, provider)?.models ?? []).find((m) => m?.id === model)

    function modelLabelOf(status, provider, model) {
      const entry = findModel(status?.model?.catalog, provider, model)
      if (entry) {
        const group = findGroup(status.model.catalog, provider)
        return {
          providerName: String(group?.name ?? provider),
          modelName: String(entry.name ?? model),
          description: String(entry.description ?? ''),
          efforts: Array.isArray(entry.reasoning?.efforts)
            ? entry.reasoning.efforts.map((e) => ({ id: String(e.id), name: String(e.name ?? e.id), description: String(e.description ?? '') }))
            : [],
          defaultEffort: entry.reasoning?.defaultEffort != null ? String(entry.reasoning.defaultEffort) : null,
          entry,
        }
      }
      return { providerName: provider, modelName: model, description: '', efforts: [], defaultEffort: null, entry: null }
    }

    // ── 模型选择器 ──────────────────────────────────────────────────────────
    function ModelMenu({ status, anchorRect, current, onPick, onClose }) {
      const catalog = status?.model?.catalog
      const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const [query, setQuery] = React.useState('')
      const [active, setActive] = React.useState(0)
      const inputRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const optionRefs = React.useRef(new Map())

      // 分组结构（不是平铺 + 同级 sticky）：每个 provider 一个 wrapper，标题 sticky 在组内。
      const groupList = React.useMemo(() => {
        const q = query.trim().toLowerCase()
        const out = []
        for (const group of groups) {
          const groupName = String(group?.name ?? group?.id ?? '')
          const models = (group?.models ?? []).filter((model) => {
            if (!q) return true
            const text = `${groupName} ${group?.id ?? ''} ${model?.name ?? ''} ${model?.id ?? ''} ${model?.description ?? ''}`.toLowerCase()
            return text.includes(q)
          })
          if (!models.length) continue
          out.push({
            id: String(group?.id ?? ''),
            name: groupName,
            models: models.map((model) => ({
              provider: String(group?.id ?? ''),
              providerName: groupName,
              model: String(model?.id ?? ''),
              modelName: String(model?.name ?? model?.id ?? ''),
              description: String(model?.description ?? ''),
            })),
          })
        }
        return out
      }, [catalog, query])

      // 键盘导航用的平铺索引（渲染时按分组顺序累加，和 flat 一一对应）。
      const selectable = React.useMemo(() => {
        const out = []
        let index = 0
        for (const group of groupList) {
          for (const model of group.models) {
            out.push({ index, item: model })
            index += 1
          }
        }
        return out
      }, [groupList])

      React.useEffect(() => {
        if (inputRef.current) inputRef.current.focus()
      }, [])
      React.useEffect(() => {
        setActive(selectable.length ? selectable[0].index : 0)
      }, [query, catalog])

      // 分组标题「卡住」才铺底色：与 DSH 原生 MenuGroup 的 data-stuck 行为一致。
      // 每个标题 sticky 在自己的 group wrapper 里，因此上一组的标题会随分组一起滚走，
      // 不会和下一组叠在一起（之前是同级 sticky + 透明背景，滚动时多个标题会互相透出）。
      React.useEffect(() => {
        const body = bodyRef.current
        if (!body) return undefined
        let raf = 0
        const update = () => {
          raf = 0
          const bodyTop = body.getBoundingClientRect().top
          for (const label of body.querySelectorAll('[data-qbp-group-label]')) {
            const rect = label.getBoundingClientRect()
            const stuck = rect.top <= bodyTop + 1 && rect.bottom > bodyTop + 1
            if (stuck) label.setAttribute('data-stuck', '')
            else label.removeAttribute('data-stuck')
          }
        }
        const onScroll = () => {
          if (!raf) raf = requestAnimationFrame(update)
        }
        body.addEventListener('scroll', onScroll, { passive: true })
        update()
        return () => {
          body.removeEventListener('scroll', onScroll)
          if (raf) cancelAnimationFrame(raf)
        }
      }, [groupList])

      // 键盘上下移动时把当前项滚进视口（117 个模型时必须的，否则选中项跑出可视区）。
      React.useEffect(() => {
        const el = optionRefs.current.get(active)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [active])

      React.useEffect(() => {
        const onDocDown = (event) => {
          if (menuRef.current && !menuRef.current.contains(event.target)) onClose()
        }
        const onScroll = (event) => {
          if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return
          onClose()
        }
        document.addEventListener('mousedown', onDocDown, true)
        window.addEventListener('resize', onClose)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('mousedown', onDocDown, true)
          window.removeEventListener('resize', onClose)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [onClose])

      const move = (delta) => {
        if (!selectable.length) return
        const currentIndex = selectable.findIndex((row) => row.index === active)
        const next = (currentIndex + delta + selectable.length) % selectable.length
        setActive(selectable[next].index)
      }
      const pickActive = () => {
        const row = selectable.find((candidate) => candidate.index === active)
        if (row) onPick(row.item)
      }
      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          pickActive()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }

      const style = {
        left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 460)),
        top: Math.min(anchorRect.bottom + 6, window.innerHeight - 200),
      }

      let loading = !catalog && !status?.model?.catalogError
      return h(
        'div',
        { 'data-qbp-menu': '', ref: menuRef, style, role: 'dialog', 'aria-label': '选择 QQ 专用模型', onKeyDown },
        h(
          'div',
          { 'data-qbp-search-row': '' },
          h('input', {
            'data-qbp-search': '',
            ref: inputRef,
            value: query,
            placeholder: '搜索 Provider 或模型…',
            onChange: (event) => setQuery(event.target.value),
            'aria-label': '搜索模型',
          }),
        ),
        h(
          'div',
          { 'data-qbp-menu-body': '', ref: bodyRef, role: 'listbox' },
          loading
            ? h('div', { 'data-qbp-menu-note': '' }, '正在读取 DSH 模型目录…')
            : null,
          !loading && status?.model?.catalogError
            ? h('div', { 'data-qbp-menu-error': '' }, `模型目录不可用：${status.model.catalogError}`)
            : null,
          !loading && failures.length
            ? h(
                'div',
                { 'data-qbp-menu-error': '' },
                `以下 Provider 目录加载失败（可能是凭据缺失）：${failures.map((f) => `${f?.name ?? f?.id ?? '?'}（${f?.message ?? '未知原因'}）`).join('；')}`,
              )
            : null,
          !loading && !catalog
            ? h('div', { 'data-qbp-menu-note': '' }, '没有可用的模型目录。')
            : null,
          !loading && catalog && groupList.length === 0
            ? h('div', { 'data-qbp-menu-note': '' }, query ? '没有匹配的模型。' : '模型目录为空：先在 DSH 里配置 Provider / API Key。')
            : null,
          (() => {
            let index = -1
            return groupList.map((group) =>
              h(
                'div',
                { 'data-qbp-menu-group': '', key: `group-${group.id}` },
                h('div', { 'data-qbp-group-label': '' }, group.name || group.id),
                group.models.map((item) => {
                  index += 1
                  const itemIndex = index
                  const selected = current.provider === item.provider && current.model === item.model
                  return h(
                    'button',
                    {
                      'data-qbp-option': '',
                      ...(selected ? { 'data-selected': '' } : {}),
                      ...(itemIndex === active ? { 'data-active': '' } : {}),
                      key: `m-${item.provider}-${item.model}`,
                      role: 'option',
                      'aria-selected': selected,
                      title: `${item.provider}/${item.model}`,
                      ref: (el) => {
                        if (el) optionRefs.current.set(itemIndex, el)
                        else optionRefs.current.delete(itemIndex)
                      },
                      onMouseEnter: () => setActive(itemIndex),
                      onClick: () => onPick(item),
                    },
                    h('span', { 'data-qbp-option-copy': '' },
                      h('span', { 'data-qbp-option-name': '' }, item.modelName),
                      item.description ? h('span', { 'data-qbp-option-desc': '' }, item.description) : null,
                    ),
                    selected ? h('span', { 'data-qbp-check': '' }, '✓') : null,
                  )
                }),
              ),
            )
          })(),
        ),
        h(
          'div',
          { 'data-qbp-menu-note': '' },
          '只影响 QQ Agent；不会修改 DSH 全局默认模型、普通会话或 World Architect。↑↓ 选择 · Enter 确认 · Esc 关闭',
        ),
      )
    }

    // ── 主页面 ──────────────────────────────────────────────────────────────
    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [menuRect, setMenuRect] = React.useState(null)
      const [advancedOpen, setAdvancedOpen] = React.useState(false)
      const [advancedModeOpen, setAdvancedModeOpen] = React.useState(false)
      const triggerRef = React.useRef(null)

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

      const act = async (label, task, { poll = true } = {}) => {
        if (busy) return
        setBusy(label)
        setMessage(null)
        try {
          const out = await task()
          const kind = out?.ok === false ? 'err' : out?.warning || out?.warnings?.length ? 'warn' : 'ok'
          const extra = out?.warnings?.length ? `\n${out.warnings.join('\n')}` : ''
          setMessage({
            kind,
            text: `${out?.message ?? '完成'}${extra}`,
            steps: out?.steps,
          })
        } catch (error) {
          setMessage({ kind: 'err', text: String(error?.message ?? error) })
        } finally {
          setBusy('')
          if (poll) refresh()
        }
      }

      if (!status) {
        return h('div', { 'data-qbp-page': '' }, h('div', { 'data-qbp-meta': '' }, '正在连接面板后端…'))
      }

      const services = status.services ?? {}
      const bridge = services.bridge ?? {}
      const llbot = services.llbot ?? {}
      const qq = services.qq ?? {}
      const dsh = services.dsh ?? {}
      const mode = status.mode ?? {}
      const model = status.model ?? {}
      const panel = status.panel ?? {}
      const current = model.current ?? {}
      const info = modelLabelOf(status, current.provider, current.model)
      const catalogLoaded = Boolean(model.catalog)
      const configuredEfforts = (() => {
        if (info.efforts.length) return info.efforts
        if (Array.isArray(model.efforts) && model.efforts.length) {
          return model.efforts.map((e) => ({ id: String(e.id), name: String(e.name ?? e.id), description: String(e.description ?? '') }))
        }
        return []
      })()
      const effortSupported = configuredEfforts.length > 0
      const currentEffort = current.effortMode === 'auto' ? '' : String(current.reasoningEffort || '')

      const aggregateTone = {
        ready: 'ready',
        partial: 'partial',
        'waiting-login': 'waiting',
        error: 'error',
        stopped: 'unknown',
      }[status.aggregate] ?? 'unknown'

      const canStartAll = !busy
      const bridgeHealthy = bridge.running && bridge.health === 'ok'
      const llbotRunning = Boolean(llbot.running)
      const modeOptions = [...(mode.options ?? []), ...(mode.advanced ?? [])]

      const openModelMenu = () => {
        const rect = triggerRef.current?.getBoundingClientRect()
        if (!rect) return
        setMenuRect({ left: rect.left, bottom: rect.bottom, top: rect.top })
        setMenuOpen(true)
        refresh()
      }

      const selectModel = (item) => {
        setMenuOpen(false)
        // 切换模型时处理旧推理强度：新模型支持就保留，否则用它的默认档；不能静默提交不兼容档位。
        const target = modelLabelOf(status, item.provider, item.model)
        let nextEffort = currentEffort
        let effortNote = ''
        if (nextEffort && !target.efforts.some((e) => e.id === nextEffort)) {
          nextEffort = target.defaultEffort || ''
          effortNote = target.defaultEffort
            ? `；原推理强度在新模型上不存在，已改用它的默认档 ${target.defaultEffort}`
            : '；新模型不支持可配置推理强度，已清空该设置'
        }
        act('切换模型', () =>
          post('/model', {
            provider: item.provider,
            model: item.model,
            ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
          }).then((out) => ({ ...out, message: `${out?.message ?? ''}${effortNote}` })),
        )
      }

      const selectEffort = (effortId) => {
        act('切换推理强度', () =>
          post('/model', {
            provider: current.provider,
            model: current.model,
            ...(effortId ? { reasoningEffort: effortId } : {}),
          }),
        )
      }

      const setMode = (nextMode) => act('切换模式', () => post('/mode', { mode: nextMode }))

      // ── 渲染 ──────────────────────────────────────────────────────────────
      return h(
        'div',
        { 'data-qbp-page': '' },

        // A. 标题
        h(
          'div',
          { 'data-qbp-head': '' },
          h(
            'div',
            { 'data-qbp-title': '' },
            'QQ Bridge for macOS',
            h('span', { 'data-qbp-title-badge': '' }, `v${panel.version ?? '?'}`),
            h('span', { 'data-qbp-pill': '', 'data-tone': aggregateTone, 'data-qbp-row-end': '', title: qq.detail || '' },
              h(Dot, { state: status.aggregate === 'ready' ? 'ok' : status.aggregate === 'error' ? 'error' : status.aggregate === 'waiting-login' ? 'waiting' : status.aggregate === 'partial' ? 'degraded' : 'down' }),
              status.aggregateText ?? '未知',
            ),
          ),
          h('div', { 'data-qbp-sub': '' }, 'DeepSeek Harness · 本地 QQ Agent · 本地进程与模型控制台'),
        ),

        !panel.configFound
          ? h('div', { 'data-qbp-msg': '', 'data-kind': 'err' }, `读不到桥接配置：${panel.configFile}${panel.configError ? `（${panel.configError}）` : ''}`)
          : null,

        // B. 系统状态概览（四项独立真实健康检查）
        h(
          Section,
          { title: '系统状态', note: qq.source ? `QQ 状态来源：${qq.source}` : '' },
          h(
            'div',
            { 'data-qbp-grid': '' },
            h(
              'div',
              { 'data-qbp-stat': '' },
              h('div', { 'data-qbp-stat-head': '' }, h(Dot, { state: bridge.health }), 'QQ Bridge'),
              h('div', { 'data-qbp-stat-value': '' }, bridge.running ? (bridge.health === 'ok' ? '运行中' : '运行中（异常）') : '未运行'),
              h('div', { 'data-qbp-stat-detail': '', title: bridge.detail || '' }, bridge.detail || `端口 ${bridge.port ?? '—'}`),
            ),
            h(
              'div',
              { 'data-qbp-stat': '' },
              h('div', { 'data-qbp-stat-head': '' }, h(Dot, { state: llbot.health }), 'LLBot'),
              h('div', { 'data-qbp-stat-value': '' }, llbot.running ? (llbot.health === 'ok' ? '运行中' : '运行中（异常）') : '未运行'),
              h('div', { 'data-qbp-stat-detail': '', title: llbot.detail || '' }, llbot.detail || `端口 ${llbot.port ?? '—'}`),
            ),
            h(
              'div',
              { 'data-qbp-stat': '' },
              h('div', { 'data-qbp-stat-head': '' }, h(Dot, { state: qq.state }), 'QQ 登录'),
              h('div', { 'data-qbp-stat-value': '' }, qq.state === 'online' ? '已登录' : qq.state === 'waiting' ? '等待扫码' : '未知'),
              h('div', { 'data-qbp-stat-detail': '', title: qq.detail || '' }, qq.detail || '—'),
            ),
            h(
              'div',
              { 'data-qbp-stat': '' },
              h('div', { 'data-qbp-stat-head': '' }, h(Dot, { state: dsh.state }), 'DSH 连接'),
              h('div', { 'data-qbp-stat-value': '' }, dsh.state === 'ok' ? '已连接' : dsh.state === 'degraded' ? '未就绪' : dsh.state === 'down' ? '不可达' : '未知'),
              h('div', { 'data-qbp-stat-detail': '', title: dsh.detail || '' }, dsh.detail || dsh.baseUrl || '—'),
            ),
          ),
        ),

        // C. 两个主操作按钮
        h(
          'div',
          { 'data-qbp-row': '' },
          h(Btn, {
            primary: true,
            large: true,
            label: busy === '启动服务' ? '启动服务' : '启动服务',
            busy: busy === '启动服务',
            disabled: !canStartAll,
            onClick: () => act('启动服务', () => post('/start-all')),
            title: '幂等：已运行的服务会跳过；等待 QQ 扫码不算失败',
          }),
          h(Btn, {
            large: true,
            label: '打开控制台',
            disabled: busy !== '' || !bridgeHealthy,
            title: bridgeHealthy ? '用系统浏览器打开桥接控制台（一次性票据）' : '桥接未运行或身份未确认，暂不能打开',
            onClick: () => act('打开控制台', () => post('/open', { target: 'console' })),
          }),
          h('span', { 'data-qbp-meta': '', 'data-qbp-row-end': '' }, panel.nodePath ? `node ${panel.nodePath}` : '未找到 node'),
        ),

        // D. 服务管理
        h(
          Section,
          { title: '服务管理', note: '只允许停止面板能验证归属的进程' },
          h(
            Card,
            null,
            h(
              'div',
              { 'data-qbp-row': '' },
              h(Dot, { state: bridge.health }),
              h('strong', {}, 'QQ Bridge'),
              h('span', { 'data-qbp-meta': '' }, `端口 ${bridge.port ?? '—'} · ${bridge.owned ? '面板启动' : bridge.running ? '外部启动' : '未运行'}${bridge.ownership?.pid ? ` · pid ${bridge.ownership.pid}` : ''}`),
              h('span', { 'data-qbp-meta': '', 'data-qbp-row-end': '' }, bridge.mode ? `模式 ${bridge.mode}` : ''),
            ),
            bridge.detail ? h('div', { 'data-qbp-meta': '' }, bridge.detail) : null,
            h(
              'div',
              { 'data-qbp-row': '' },
              h(Btn, {
                label: '启动',
                primary: true,
                disabled: busy !== '' || Boolean(bridge.running),
                title: bridge.running ? '已在运行' : '启动桥接进程',
                onClick: () => act('启动桥接', () => post('/start', { service: 'bridge' })),
              }),
              h(Btn, {
                label: '停止',
                danger: true,
                disabled: busy !== '' || !bridge.running || !bridge.owned,
                title: bridge.running && !bridge.owned ? '外部实例：面板不能停止（请回你的终端/启动台）' : '',
                onClick: () => act('停止桥接', () => post('/stop', { service: 'bridge' })),
              }),
              h(Btn, {
                label: '重启',
                disabled: busy !== '' || !bridge.running || !bridge.owned,
                title: bridge.running && !bridge.owned ? '外部实例：面板不能重启' : '停止后重新启动',
                onClick: () => act('重启桥接', () => post('/restart', { service: 'bridge' })),
              }),
              h(Btn, {
                label: '打开控制台',
                disabled: busy !== '' || !bridgeHealthy,
                onClick: () => act('打开控制台', () => post('/open', { target: 'console' })),
              }),
            ),
            bridge.ownership?.pid && !bridge.owned
              ? h('div', { 'data-qbp-meta': '', 'data-warn': '' }, '登记的 pid 已无法验证归属（进程退出或 pid 被复用），已按外部实例处理。')
              : null,
          ),
          h(
            Card,
            null,
            h(
              'div',
              { 'data-qbp-row': '' },
              h(Dot, { state: llbot.health }),
              h('strong', {}, 'LLBot'),
              h('span', { 'data-qbp-meta': '' }, `端口 ${llbot.port ?? '—'} · ${llbot.owned ? '面板启动' : llbot.running ? '外部启动' : '未运行'}`),
              h('span', { 'data-qbp-meta': '', 'data-qbp-row-end': '' }, llbot.login?.state === 'online' ? `QQ ${llbot.login.uin || ''} 在线` : llbot.running ? '等待扫码' : ''),
            ),
            llbot.detail ? h('div', { 'data-qbp-meta': '' }, llbot.detail) : null,
            h(
              'div',
              { 'data-qbp-row': '' },
              llbot.startable
                ? h(Btn, {
                    label: '启动',
                    primary: true,
                    disabled: busy !== '' || llbotRunning,
                    title: llbotRunning ? '已在运行' : '按 config.json 的固定命令启动 LLBot',
                    onClick: () => act('启动 LLBot', () => post('/start', { service: 'llbot' })),
                  })
                : h(Btn, {
                    label: '启动',
                    disabled: true,
                    title: panel.llbotLaunch?.reason || '需要在 config.json 配置 panel.llbotCommand / panel.llbotQq 才能代管启动',
                  }),
              h(Btn, {
                label: '停止',
                danger: true,
                disabled: busy !== '' || !llbot.running || !llbot.owned,
                title: llbot.running && !llbot.owned ? '外部实例：面板不能停止' : '',
                onClick: () => act('停止 LLBot', () => post('/stop', { service: 'llbot' })),
              }),
              h(Btn, {
                label: '打开 WebUI',
                disabled: busy !== '' || !llbot.running,
                title: llbot.running ? '' : '先启动 LLBot（WebUI 端口监听后才能打开）',
                onClick: () => act('打开 LLBot WebUI', () => post('/open', { target: 'llbot' })),
              }),
            ),
            h(
              'div',
              { 'data-qbp-meta': '' },
              llbot.startable
                ? `代管启动命令：${panel.llbotLaunch?.display || ''}${
                    panel.llbotLaunch?.source === 'derived'
                      ? `（由 launcherPath 派生${panel.llbotLaunch?.qqSource ? ` · QQ 号来源：${panel.llbotLaunch.qqSource}` : ''}）`
                      : '（来自 config.json 的 panel.llbotCommand）'
                  }`
                : `LLBot 是第三方程序，默认由你自己启动。要让面板代管启停：${panel.llbotLaunch?.reason || '在 config.json 里配置 panel.llbotCommand 或 panel.llbotQq'}`,
            ),
            !llbot.startable
              ? h(
                  'div',
                  { 'data-qbp-row': '' },
                  h('span', { 'data-qbp-meta': '' }, '配置示例：'),
                  h('code', { 'data-qbp-code': '' }, '{"panel":{"llbotQq":"<你的QQ号>"}}'),
                  h(Btn, {
                    label: '复制',
                    title: '复制到剪贴板，粘贴进桥接的 config.json',
                    onClick: async () => {
                      const text = '{"panel":{"llbotQq":"<你的QQ号>"}}'
                      try {
                        await navigator.clipboard.writeText(text)
                        setMessage({ kind: 'ok', text: '已复制。把它合并进桥接的 config.json（snowluma.launcherPath 需指向 llbot.js），保存后点「刷新状态」。' })
                      } catch {
                        setMessage({ kind: 'warn', text: `复制失败（浏览器拒绝了剪贴板权限）。请手动添加：${text}` })
                      }
                    },
                  }),
                )
              : null,
            !llbot.startable
              ? h('div', { 'data-qbp-meta': '' }, '也可以在 config.json 里给出完整命令数组 panel.llbotCommand（不接受字符串/shell），或用 snowluma.launcherPath + panel.llbotQq 让面板派生 [node, llbot.js, --qq, <QQ号>]。')
              : null,
          ),
        ),

        // E. 运行模式
        h(
          Section,
          { title: '运行模式', note: mode.source ? `当前生效值来源：${mode.source}` : '' },
          h(
            Card,
            null,
            h(
              'div',
              { 'data-qbp-row': '' },
              h('strong', {}, mode.current ? `当前：${mode.current}` : '当前模式未知'),
              h('span', { 'data-qbp-meta': '' }, mode.verified ? '已通过桥接实时状态确认' : '未确认（可能只是配置值）'),
            ),
            h(
              'div',
              { 'data-qbp-seg': '' },
              (mode.options ?? ['chat', 'reserved', 'reserved2']).map((option) =>
                h(
                  'button',
                  {
                    'data-qbp-seg-item': '',
                    ...(mode.current === option ? { 'data-active': '' } : {}),
                    key: option,
                    disabled: busy !== '',
                    title: mode.labels?.[option] ?? option,
                    onClick: () => setMode(option),
                  },
                  option,
                ),
              ),
            ),
            h(
              'div',
              { 'data-qbp-row': '' },
              h(Btn, {
                label: advancedModeOpen ? '收起高级模式' : '高级：closed-agent…',
                disabled: busy !== '',
                onClick: () => setAdvancedModeOpen((value) => !value),
              }),
              mode.current === 'closed-agent'
                ? h('span', { 'data-qbp-meta': '', 'data-warn': '' }, '当前处于 closed-agent（完整本地工具面）')
                : null,
            ),
            advancedModeOpen
              ? h(
                  'div',
                  { 'data-qbp-msg': '', 'data-kind': 'warn' },
                  `权限风险：${mode.risk?.['closed-agent'] ?? 'closed-agent 会挂载完整本地工具面'}\n仅 owner 私聊会进入该模式；切换前请确认你信任当前环境。`,
                  h('div', { 'data-qbp-row': '', style: { marginTop: 8 } },
                    h(Btn, {
                      label: mode.current === 'closed-agent' ? '已在 closed-agent' : '仍然切换到 closed-agent',
                      danger: true,
                      disabled: busy !== '' || mode.current === 'closed-agent',
                      onClick: () => setMode('closed-agent'),
                    }),
                  ),
                )
              : null,
            h('div', { 'data-qbp-meta': '' }, '切换模式不会改动白名单、模型、工具权限或其它设置。'),
          ),
        ),

        // F + G. QQ 专用模型 + 推理强度
        h(
          Section,
          { title: 'QQ 专用模型', note: '只影响 QQ Agent' },
          h(
            Card,
            null,
            h(
              'div',
              { 'data-qbp-model': '' },
              h(
                'button',
                {
                  'data-qbp-model-trigger': '',
                  ref: triggerRef,
                  disabled: busy !== '',
                  title: catalogLoaded ? '打开 DSH 模型目录' : (model.catalogError || '模型目录不可用'),
                  onClick: openModelMenu,
                },
                h('span', { 'data-qbp-model-provider': '' }, info.providerName || '—'),
                h('span', { 'data-qbp-model-name': '' }, info.modelName || '（未配置）'),
                h('span', { 'data-qbp-model-effort': '' }, currentEffort ? `· ${currentEffort}` : (effortSupported ? '· 适配器默认' : '')),
                h('span', { 'data-qbp-model-chevron': '', ...(menuOpen ? { 'data-open': '' } : {}) }, '▾'),
              ),
              h('div', { 'data-qbp-meta': '' },
                `${current.provider ?? '?'}/${current.model ?? '?'} · 来源 ${model.source ?? '未知'}`,
                model.catalogError ? ` · 目录：${model.catalogError}` : '',
              ),
              !catalogLoaded && model.catalogError
                ? h('div', { 'data-qbp-meta': '', 'data-warn': '' }, '模型目录读不到时仍显示桥接当前真实配置，但无法列出可选模型。')
                : null,
              h(
                'div',
                { 'data-qbp-meta': '' },
                model.scope === 'global'
                  ? '⚠️ 当前 dsh.modelScope=global：应用模型时会同时写 DSH 全局默认模型（旧行为）'
                  : '会话作用域：模型只写入 QQ 会话的 model/selection，不写 DSH 全局默认模型。',
              ),
            ),

            // G. 推理强度
            h(
              'div',
              { 'data-qbp-row': '' },
              h('span', { 'data-qbp-meta': '', style: { minWidth: 64 } }, '推理强度'),
              effortSupported
                ? configuredEfforts.map((effort) =>
                    h(
                      'button',
                      {
                        'data-qbp-seg-item': '',
                        key: effort.id,
                        ...(currentEffort === effort.id ? { 'data-active': '' } : {}),
                        disabled: busy !== '',
                        title: effort.description || `${effort.name}（${effort.id}）`,
                        onClick: () => selectEffort(effort.id),
                      },
                      effort.name || effort.id,
                    ),
                  )
                : h('span', { 'data-qbp-meta': '' }, catalogLoaded
                    ? '当前模型不支持可配置推理强度（该项已隐藏）'
                    : '能力未确认：模型目录不可用，无法判断该模型支持哪些推理档位'),
            ),
            h(
              'div',
              { 'data-qbp-meta': '' },
              effortSupported
                ? `档位来自该模型公布的 reasoning.efforts；当前 ${currentEffort || '适配器默认'}${info.defaultEffort ? ` · 模型默认 ${info.defaultEffort}` : ''}${model.effortChecked === false ? ' · 能力未确认' : ''}`
                : '',
            ),
            // 多模态能力：DSH 目录没有 inputModalities 字段，不能按模型名猜。
            h(
              'div',
              { 'data-qbp-meta': '' },
              '图片/表情能力：DSH 模型目录未公布输入模态元数据 —— 能力未确认（不会按模型名推断）。',
            ),
          ),
        ),

        // H. 高级设置与诊断
        h(
          'div',
          { 'data-qbp-adv': '' },
          h(
            'button',
            { 'data-qbp-adv-head': '', onClick: () => setAdvancedOpen((value) => !value) },
            advancedOpen ? '▾' : '▸',
            '高级设置与诊断',
            h('span', { 'data-qbp-meta': '', 'data-qbp-row-end': '' }, '路径 · 端口 · 启动选项 · 日志 · 最近错误 · 进程归属'),
          ),
          advancedOpen
            ? h(
                'div',
                { 'data-qbp-adv-body': '' },
                h(
                  'dl',
                  { 'data-qbp-kv': '' },
                  h('dt', {}, '桥接仓库'), h('dd', {}, panel.repoDir || '—'),
                  h('dt', {}, '配置文件'), h('dd', {}, panel.configFile || '—'),
                  h('dt', {}, 'DSH 地址'), h('dd', {}, dsh.baseUrl || '—'),
                  h('dt', {}, '桥接端口'), h('dd', {}, String(bridge.port ?? '—')),
                  h('dt', {}, 'LLBot WebUI'), h('dd', {}, llbot.url || '—'),
                  h('dt', {}, '控制台令牌'), h('dd', {}, bridge.tokenConfigured ? (bridge.tokenMasked || '已配置') : '未配置（控制台将拒绝所有请求）'),
                  h('dt', {}, '面板状态目录'), h('dd', {}, panel.stateDir || '—'),
                  h('dt', {}, '日志目录'), h('dd', {}, panel.logDir || '—'),
                  h('dt', {}, '进程归属'), h('dd', {}, bridge.owned ? '桥接：面板启动（登记可验证）' : bridge.running ? '桥接：外部进程（面板不会停止它）' : '桥接：未运行'),
                  h('dt', {}, '服务管理模式'), h('dd', {}, '面板管理（pid 登记 + 命令行指纹 + 端口三重校验；DSH 重启后仍能识别）'),
                  h('dt', {}, '启动选项'), h('dd', {}, `LLBot：${panel.llbotLaunch?.available ? panel.llbotLaunch.display : '未配置代管'}${panel.nodePath ? ` · node ${panel.nodePath}` : ''}`),
                ),
                h(
                  'div',
                  null,
                  h('div', { 'data-qbp-meta': '', style: { marginBottom: 4 } }, '桥接最近日志'),
                  h('div', { 'data-qbp-log': '' }, bridge.lastLog || '（暂无面板捕获的日志：外部启动的实例不写面板日志）'),
                  h('div', { 'data-qbp-meta': '', style: { margin: '10px 0 4px' } }, 'LLBot 最近日志'),
                  h('div', { 'data-qbp-log': '' }, llbot.lastLog || '（暂无面板捕获的日志）'),
                ),
                h(
                  'div',
                  null,
                  h('div', { 'data-qbp-meta': '', style: { marginBottom: 4 } }, '最近错误'),
                  h('div', { 'data-qbp-log': '' }, panel.lastError || '（无）'),
                  panel.lastAction
                    ? h('div', { 'data-qbp-meta': '', style: { marginTop: 6 } },
                        `最近操作：${panel.lastAction.action} · ${panel.lastAction.ok ? '成功' : '失败'} · ${panel.lastAction.at}`)
                    : null,
                ),
                h(
                  'div',
                  { 'data-qbp-row': '' },
                  h(Btn, { label: '刷新状态', disabled: busy !== '', onClick: () => act('刷新', refresh, { poll: false }) }),
                  h(Btn, { label: '打开 LLBot WebUI', disabled: busy !== '' || !llbot.running, onClick: () => act('打开 LLBot WebUI', () => post('/open', { target: 'llbot' })) }),
                ),
              )
            : null,
        ),

        // 操作结果
        message ? h(Msg, { kind: message.kind, text: message.text, steps: message.steps }) : null,

        // 模型菜单（fixed 定位，避免被设置页滚动容器裁剪）
        menuOpen && menuRect
          ? h(ModelMenu, {
              status,
              anchorRect: menuRect,
              current,
              onPick: selectModel,
              onClose: () => setMenuOpen(false),
            })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 加载自检：host 半 /status.panel.client.seen 靠这一次 ping 置位（不影响功能）。
        fetch(API + '/ping', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => {})

        // 样式：先移除旧节点（HMR 会重复 apply）。
        for (const stale of document.querySelectorAll('style[data-plugin-css="qq-bridge-panel"]')) stale.remove()
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
