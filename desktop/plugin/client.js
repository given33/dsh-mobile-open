// Browser half of the dsh-mobile-link DSH plugin.
//
// Desktop mode: mounts a "手机连接" button in the sidebar footer, a pairing QR
// modal, and lightweight focus reporting so phones can optionally follow the
// desktop's active session.
//
// Mobile mode (`globalThis.__DSH_MOBILE_SHELL__`): hides the desktop QR UI and
// bridges official Cordis services (layout, uiWorkspace, connection, sessions)
// to the mobile shell & iOS host for native sidebar swipe, follow-desktop jump,
// and instant network recovery.
window.__ModuleLoader__.load({
  id: 'dsh-mobile-link',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const API = '/dsh-mobile-link'

    const EN = {
      '下载原文件':'Download original', '请先打开文件所在的会话':'Open the file’s session first', '文件读取不完整':'Incomplete file', '无法下载文件':'Unable to download the file', '文件已更改，请重试':'File changed; try again',
      '手机连接': 'Phone link',
      '用 DSH Mobile 扫码，在手机上实时同步查看和操作这台电脑上的 DSH。': 'Scan with DSH Mobile to mirror and control this computer’s DSH live on your phone.',
      '允许手机连接': 'Allow phone connections',
      '允许手机操作': 'Allow phone actions',
      '允许手机使用终端': 'Allow phone terminal access',
      '允许已配对手机向此电脑的 Harness 终端输入。': 'Let paired phones send input to this computer’s Harness terminals.',
      '已配对的手机可以发消息、切换模型、回答和审批，并与桌面端实时双向同步。': 'Paired phones can send messages, switch models, answer questions and approve actions with live two-way sync.',
      '关闭时，已配对的手机仍可实时查看全部任务与工作流细节。': 'While off, paired phones can still watch all tasks and workflow details live in read-only mode.',
      '连接全程加密，手机只信任这台电脑的密钥。': 'The connection is encrypted and pinned to this computer’s key.',
      '关闭': 'Close',
      '正在监听端口 {port}': 'Listening on port {port}',
      '已关闭，手机无法连接这台电脑。': 'Off. Phones cannot connect to this computer.',
      '端口 {port} 已被占用。请在插件配置里换一个端口后重启 DSH。': 'Port {port} is in use. Choose another port in the plugin config and restart DSH.',
      '无法开始监听：{message}': 'Could not start listening: {message}',
      '开启后显示配对二维码。': 'Turn this on to show the pairing QR code.',
      '首次开启时，Windows 可能询问是否允许访问网络，请只勾选「专用网络」。': 'Windows may ask for network access the first time. Allow private networks only.',
      '没有找到局域网地址。请确认电脑已连接 Wi-Fi 或有线网络。': 'No local network address found. Check that this computer is on Wi-Fi or Ethernet.',
      '配对二维码': 'Pairing QR code',
      '{time} 后刷新': 'Refreshes in {time}',
      '刷新二维码': 'New code',
      '安全码': 'Safety code',
      '首次连接时，手机上显示的安全码应与这里一致。': 'On first connect, the phone shows the same safety code.',
      '电脑地址': 'Addresses',
      '局域网': 'LAN',
      'Tailscale': 'Tailscale',
      '手动': 'Manual',
      '其他': 'Other',
      '扫不了码？复制配对链接': 'Can’t scan? Copy the pairing link',
      '已复制': 'Copied',
      '复制失败，请手动选择链接文本。': 'Copy failed. Select the link text manually.',
      '已配对的手机': 'Paired phones',
      '还没有配对的手机。': 'No phones paired yet.',
      '在线': 'Online',
      '上次连接 {time}': 'Last seen {time}',
      '移除': 'Remove',
      '移除后，这部手机需要重新扫码才能连接。': 'The phone will need to scan again to reconnect.',
      '刚刚': 'just now',
      '{n} 分钟前': '{n} min ago',
      '{n} 小时前': '{n} h ago',
      '{n} 天前': '{n} d ago',
      '读取状态失败，正在重试…': 'Could not read the status. Retrying…',
      '操作失败，请重试。': 'That did not work. Try again.',
      '手机已连接': 'A phone is connected',
    }
    const english = (() => {
      try { return /^en\b/i.test(document.documentElement.lang || navigator.language || '') } catch { return false }
    })()
    const t = (zh, vars) => {
      let text = english ? (EN[zh] ?? zh) : zh
      if (vars) for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v))
      return text
    }

    /** Detect the session currently retained by the main view through ctx.sessions. */
    function readCurrentSession(ctx) {
      try {
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        if (!sessions?.list?.getSnapshot) return null
        const list = sessions.list.getSnapshot()
        if (!list?.ids || !list?.byId) return null
        for (const id of list.ids) {
          const row = list.byId[id]
          if (row?.retainedBy?.mainView > 0) return { sessionId: id, title: row.title || '' }
        }
        if (list.ids.length && !list.byId[list.ids[0]]?.retainedBy && typeof sessions.retainInfo === 'function') {
          for (const id of list.ids) {
            const info = sessions.retainInfo(id)?.getSnapshot?.()
            if (info?.retainedBy?.mainView > 0) {
              const row = list.byId[id]
              return { sessionId: id, title: row?.title || '' }
            }
          }
        }
        // Fallback for older DSH versions where SessionListState carried currentSessionId.
        const fallbackId = list.currentSessionId ?? list.selectedSessionId ?? null
        if (typeof fallbackId === 'string' && fallbackId) {
          return { sessionId: fallbackId, title: list.byId[fallbackId]?.title || '' }
        }
      } catch {}
      return null
    }

    // Panel open state, shared by the footer button and the overlay entry.
    let open = false
    const listeners = new Set()
    const setOpen = (value) => { open = value; for (const fn of listeners) fn() }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const getOpen = () => open
    // Online flag for the footer dot, refreshed by a light background poll.
    let online = false
    const setOnline = (value) => { if (online !== value) { online = value; for (const fn of listeners) fn() } }
    const getOnline = () => online

    async function call(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined
        ? { credentials: 'same-origin', cache: 'no-store' }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    const css = `
.dml-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.2))}
.dml-card{width:min(452px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;padding:20px 22px 18px;border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #0000000a,0 0 20px #0000000d);font-family:var(--dsw-font-family,system-ui);font-size:14px;line-height:22px}
.dml-head{display:flex;align-items:flex-start;gap:12px}
.dml-title{margin:0;font-size:16px;line-height:24px;font-weight:600}
.dml-intro{margin:2px 0 0;color:var(--dsw-alias-label-secondary,#61666b);font-size:13px;line-height:20px}
.dml-icon-button{margin-left:auto;flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}
.dml-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a);color:var(--dsw-alias-label-primary,#0f1115)}
.dml-row{display:flex;align-items:center;gap:12px;margin-top:16px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-specific-sidebar-fill,#f9fafb)}
.dml-row-text{min-width:0;flex:1}
.dml-row-title{font-weight:500}
.dml-sub{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}
.dml-error{color:var(--dsw-alias-state-error-primary,#ec1313);font-size:12px;line-height:18px}
.dml-switch{flex:none;position:relative;width:36px;height:22px;border:0;border-radius:11px;padding:0;cursor:pointer;background:var(--dsw-alias-border-l4,#0000001f);transition:background var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease)}
.dml-switch[aria-checked=true]{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dml-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #00000033;transition:transform var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease)}
.dml-switch[aria-checked=true]::after{transform:translateX(14px)}
.dml-switch:disabled{opacity:.5;cursor:default}
.dml-pair{display:grid;grid-template-columns:auto 1fr;gap:16px;margin-top:16px;align-items:start}
.dml-qr{width:196px;height:196px;padding:10px;box-sizing:content-box;border-radius:var(--dsw-radius-md,12px);background:#fff;box-shadow:0 0 0 .5px var(--dsw-alias-border-l3,#00000029)}
.dml-qr img{display:block;width:196px;height:196px;image-rendering:pixelated}
.dml-facts{display:flex;flex-direction:column;gap:12px;min-width:0}
.dml-label{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}
.dml-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px;letter-spacing:.04em;font-variant-numeric:tabular-nums}
.dml-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.dml-chip{max-width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;padding:1px 8px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-interactive-bg-hover,#0000000a);color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}
.dml-chip-kind{font-family:var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-tertiary,#81858c)}
.dml-addresses{margin-top:14px}
.dml-link-button{border:0;background:none;padding:0;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-link,#4176e6);cursor:pointer}
.dml-link-button:hover{text-decoration:underline}
.dml-placeholder{margin-top:16px;padding:18px;border-radius:var(--dsw-radius-md,12px);border:.5px dashed var(--dsw-alias-border-l4,#0000001f);color:var(--dsw-alias-label-secondary,#61666b);font-size:13px;line-height:20px}
.dml-raw{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,#f9fafb);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;word-break:break-all;user-select:all;color:var(--dsw-alias-label-secondary,#61666b)}
.dml-section{margin-top:20px}
.dml-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#61666b);margin:0 0 6px}
.dml-device{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2,#0000000f)}
.dml-device:first-of-type{border-top:0}
.dml-device-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dml-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;vertical-align:1px;background:var(--dsw-alias-state-success-primary,#22c55e)}
.dml-remove{margin-left:auto;flex:none;border:0;border-radius:var(--dsw-radius-sm,8px);padding:3px 10px;font:inherit;font-size:12px;line-height:20px;background:transparent;color:var(--dsw-alias-state-error-primary,#ec1313);cursor:pointer}
.dml-remove:hover{background:var(--dsw-alias-interactive-bg-hover-danger,#ec131314)}
.dml-note{margin:18px 0 0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}
.dml-footer-button{cursor:pointer;background:transparent;border:0;color:inherit;font:inherit;display:flex;align-items:center;position:relative;box-sizing:border-box;border-radius:var(--dsw-radius-sm,8px)}
.dml-footer-button:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a)}
.dml-footer-dot{position:absolute;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,#f9fafb)}
.dml-backdrop :focus-visible,.dml-footer-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.dml-switch,.dml-switch::after{transition:none}}
`

    const PhoneIcon = ({ size }) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', 'aria-hidden': true, focusable: false, style: { flex: 'none' } },
      h('rect', { x: 4.25, y: 1.5, width: 7.5, height: 13, rx: 1.75 }),
      h('path', { d: 'M7 12.25h2' }))

    const CloseIcon = () => h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', 'aria-hidden': true },
      h('path', { d: 'M4 4l8 8M12 4l-8 8' }))

    function relative(ms) {
      const minutes = Math.floor((Date.now() - ms) / 60000)
      if (minutes < 1) return t('刚刚')
      if (minutes < 60) return t('{n} 分钟前', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('{n} 小时前', { n: hours })
      return t('{n} 天前', { n: Math.floor(hours / 24) })
    }

    const KIND = { lan: '局域网', tailnet: 'Tailscale', manual: '手动', other: '其他' }

    function useNow(active) {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [active])
      return now
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [problem, setProblem] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [copied, setCopied] = React.useState('')
      const [showLink, setShowLink] = React.useState(false)
      const closeRef = React.useRef(null)
      const now = useNow(!!status?.pairing)

      const load = React.useCallback(async () => {
        try { const next = await call('/status'); setStatus(next); setProblem(''); setOnline(next.devices.some(d => d.online)) } catch { setProblem(t('读取状态失败，正在重试…')) }
      }, [])
      React.useEffect(() => {
        load()
        const off = subscribe(loadOnPresence)
        function loadOnPresence() { if(open) load() }
        const timer = setInterval(load, 3000)
        return () => { clearInterval(timer); off() }
      }, [load])
      React.useEffect(() => {
        closeRef.current?.focus()
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      // A code that has just expired is replaced on the next status read.
      React.useEffect(() => { if (status?.pairing && now >= status.pairing.expiresAt) load() }, [now, status, load])

      const act = async (path, body) => {
        setBusy(true)
        try { setStatus(await call(path, body)); setProblem('') } catch { setProblem(t('操作失败，请重试。')) } finally { setBusy(false) }
      }
      const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); setCopied(t('已复制')) } catch { setCopied(t('复制失败，请手动选择链接文本。')); setShowLink(true) }
        setTimeout(() => setCopied(''), 2500)
      }

      const s = status
      const remaining = s?.pairing ? Math.max(0, Math.ceil((s.pairing.expiresAt - now) / 1000)) : 0
      const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
      let state = ''
      if (s?.error?.code === 'port-in-use') state = h('div', { className: 'dml-error' }, t('端口 {port} 已被占用。请在插件配置里换一个端口后重启 DSH。', { port: s.error.port }))
      else if (s?.error) state = h('div', { className: 'dml-error' }, t('无法开始监听：{message}', { message: s.error.message ?? s.error.code }))
      else if (s?.listening) state = h('div', { className: 'dml-sub' }, t('正在监听端口 {port}', { port: s.port }))
      else if (s) state = h('div', { className: 'dml-sub' }, t('已关闭，手机无法连接这台电脑。'))

      let body
      if (!s) body = null
      else if (!s.listening) body = h('div', { className: 'dml-placeholder' }, t('开启后显示配对二维码。'), h('br'), t('首次开启时，Windows 可能询问是否允许访问网络，请只勾选「专用网络」。'))
      else if (!s.pairing) body = h('div', { className: 'dml-placeholder' }, t('没有找到局域网地址。请确认电脑已连接 Wi-Fi 或有线网络。'))
      else body = h(React.Fragment, null,
        h('div', { className: 'dml-pair' },
          h('div', { className: 'dml-qr' }, h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.pairing.qrSvg)}`, alt: t('配对二维码') })),
          h('div', { className: 'dml-facts' },
            h('div', null,
              h('div', { className: 'dml-label' }, t('{time} 后刷新', { time: clock })),
              h('button', { type: 'button', className: 'dml-link-button', disabled: busy, onClick: () => act('/code', {}) }, t('刷新二维码'))),
            h('div', null,
              h('div', { className: 'dml-label' }, t('安全码')),
              h('div', { className: 'dml-code' }, s.safetyCode),
              h('div', { className: 'dml-sub' }, t('首次连接时，手机上显示的安全码应与这里一致。'))),
            )),
        h('div', { className: 'dml-addresses' },
          h('div', { className: 'dml-label' }, t('电脑地址')),
          h('div', { className: 'dml-chips' }, s.addresses.map(a => h('span', { key: a.address, className: 'dml-chip', title: a.iface },
            a.address, h('span', { className: 'dml-chip-kind' }, ` · ${t(KIND[a.kind] ?? '其他')}`))))),
        h('div', { style: { marginTop: 10 } },
          h('button', { type: 'button', className: 'dml-link-button', onClick: () => copy(s.pairing.link) }, copied || t('扫不了码？复制配对链接'))),
        showLink ? h('div', { className: 'dml-raw' }, s.pairing.link) : null)

      const devices = s?.devices ?? []
      return h('div', { className: 'dml-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false) } },
        h('section', { className: 'dml-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dml-title' },
          h('div', { className: 'dml-head' },
            h('div', null,
              h('h2', { id: 'dml-title', className: 'dml-title' }, t('手机连接')),
              h('p', { className: 'dml-intro' }, t('用 DSH Mobile 扫码，在手机上实时同步查看和操作这台电脑上的 DSH。'))),
            h('button', { ref: closeRef, type: 'button', className: 'dml-icon-button', 'aria-label': t('关闭'), onClick: () => setOpen(false) }, h(CloseIcon))),
          h('div', { className: 'dml-row' },
            h('div', { className: 'dml-row-text' }, h('div', { className: 'dml-row-title' }, t('允许手机连接')), state),
            h('button', {
              type: 'button', role: 'switch', className: 'dml-switch', 'aria-checked': !!s?.enabled, 'aria-label': t('允许手机连接'),
              disabled: !s || busy, onClick: () => act('/enabled', { enabled: !s.enabled }),
            })),
          s?.listening ? h('div', { className: 'dml-row' },
            h('div', { className: 'dml-row-text' }, h('div', { className: 'dml-row-title' }, t('允许手机操作')),
              h('div', { className: 'dml-sub' }, t(s.actions ? '已配对的手机可以发消息、切换模型、回答和审批，并与桌面端实时双向同步。' : '关闭时，已配对的手机仍可实时查看全部任务与工作流细节。'))),
            h('button', { type: 'button', role: 'switch', className: 'dml-switch', 'aria-checked': !!s.actions,
              'aria-label': t('允许手机操作'), disabled: busy, onClick: () => act('/actions', { enabled: !s.actions }) })) : null,
          s?.listening && s?.actions ? h('div', { className: 'dml-row' },
            h('div', { className: 'dml-row-text' }, h('div', { className: 'dml-row-title' }, t('允许手机使用终端')),
              h('div', { className: 'dml-sub' }, t('允许已配对手机向此电脑的 Harness 终端输入。'))),
            h('button', { type: 'button', role: 'switch', className: 'dml-switch', 'aria-checked': !!s.terminal,
              'aria-label': t('允许手机使用终端'), disabled: busy, onClick: () => act('/terminal', { enabled: !s.terminal }) })) : null,
          body,
          problem ? h('div', { className: 'dml-error', style: { marginTop: 10 } }, problem) : null,
          h('div', { className: 'dml-section' },
            h('h3', { className: 'dml-section-title' }, t('已配对的手机')),
            devices.length === 0
              ? h('div', { className: 'dml-sub' }, t('还没有配对的手机。'))
              : devices.map(d => h('div', { key: d.id, className: 'dml-device' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'dml-device-name' }, d.name),
                  h('div', { className: 'dml-sub' },
                    d.online ? h(React.Fragment, null, h('span', { className: 'dml-dot', 'aria-hidden': true }), t('在线')) : t('上次连接 {time}', { time: relative(d.lastSeenAt ?? d.pairedAt) }),
                    [d.model, d.system].filter(Boolean).length ? ` · ${[d.model, d.system].filter(Boolean).join(' · ')}` : '')),
                h('button', { type: 'button', className: 'dml-remove', disabled: busy, title: t('移除后，这部手机需要重新扫码才能连接。'), onClick: () => act('/devices/remove', { id: d.id }) }, t('移除'))))),
          h('p', { className: 'dml-note' }, t('连接全程加密，手机只信任这台电脑的密钥。'))))
    }

    function FooterButton(props) {
      const isOpen = React.useSyncExternalStore(subscribe, getOpen)
      const isOnline = React.useSyncExternalStore(subscribe, getOnline)
      const wide = !!props.wide
      return h('button', {
        type: 'button', className: 'dml-footer-button', title: isOnline ? `${t('手机连接')} · ${t('手机已连接')}` : t('手机连接'),
        'aria-label': t('手机连接'), 'aria-pressed': isOpen, onClick: () => setOpen(!isOpen),
        style: wide
          ? { width: 'calc(100% + 4px)', height: 36, margin: '2px -2px', padding: '0 10px 0 8px', gap: 8, justifyContent: 'flex-start' }
          : { width: 36, height: 36, margin: '3px 0', justifyContent: 'center' },
      },
      h(PhoneIcon, { size: wide ? 18 : 20 }),
      wide ? h('span', null, t('手机连接')) : null,
      isOnline ? h('span', { className: 'dml-footer-dot', 'aria-hidden': true, style: wide ? { left: 20, top: 8 } : { right: 7, top: 7 } }) : null)
    }

    function OverlayEntry() {
      const isOpen = React.useSyncExternalStore(subscribe, getOpen)
      return isOpen ? h(Panel) : null
    }

    // The desktop launcher deliberately focuses Lexical on mousedown AND click.
    // Touch launch is a separate path: only an explicit editor tap needs the IME.
    function mobileCommands(ctx) {
      return ctx.effect(() => {
        const events = new AbortController(), opts = {capture:true, signal:events.signal}
        const menuSel='[data-trigger-menu]', plusSel='[data-composer-card] button[aria-haspopup="listbox"]:has(~ input[type=file])'
        const face = () => {
          const id=readCurrentSession(ctx)?.sessionId, binding=id && ctx.sessions.binding(id)
          if (!binding) return null
          return {input:ctx.conversation.input.for(binding.ctx), triggers:ctx.inputTriggers.sessionOf(binding.ctx)}
        }
        const stop=e=>{if(e.cancelable)e.preventDefault();e.stopImmediatePropagation()}
        const on=(type,fn)=>window.addEventListener(type,fn,opts)
        let pressed=null, eat=null
        function cancel(input) {
          const doc=input.draftSnapshot, token=doc?.command?.token?.trimEnd()
          if(!token || !doc.text.startsWith(token) || input.snapshot.phase!=='claimed') return false
          const n=token.length+(doc.text[token.length]===' '?1:0), shift=a=>a.map(x=>({...x,offset:x.offset-n}))
          input.setDraft({text:doc.text.slice(n),references:shift(doc.references),quotes:shift(doc.quotes||[])})
          return true
        }
        function cancelRow(input,triggers,el) {
          const menu=el.closest('[data-composer-card]')?.querySelector('[data-trigger-menu]')
          if(!menu || !input.snapshot.claim || menu.querySelector('[data-dml-cancel]'))return
          const button=document.createElement('button');button.type='button';button.dataset.dmlCancel=''
          button.textContent=(english?'Remove command ':'取消指令 ')+input.snapshot.claim.token.trimEnd()
          button.addEventListener('mousedown',e=>{e.preventDefault();if(cancel(input))triggers.dismiss()})
          menu.prepend(button)
        }
        function toggle(el) {
          const f=face(); if (!f || el.disabled) return
          const {input,triggers}=f, state=input.snapshot
          if (!['claimed','plain'].includes(state.phase)) return
          const end=state.claim?.token?.trimEnd().length || 0
          // Host commands need a leading span. Insertion before text preserves the
          // whole message; replacing an existing chip keeps its arguments intact.
          const open=triggers.menu.getSnapshot().open
          if (!open && document.activeElement?.isContentEditable) document.activeElement.blur()
          input.dismissPopup()
          triggers.toggleSource('command',{trigger:'/',query:'',quoted:false,position:'leading',span:{start:0,end,draftRev:state.draftRev}})
          if(!open) requestAnimationFrame(()=>{
            if(state.claim)cancelRow(input,triggers,el)
            globalThis.__DSH_MOBILE_BRIDGE__?.refreshCommandMenu?.()
          })
        }
        function pick(el) {
          const f=face(), index=/^dsh-slash-option-command-(\d+)$/.exec(el.id)
          const item=index && f?.triggers.menu.getSnapshot().groups?.find(g=>g.source==='command')?.items?.[Number(index[1])]
          const launcher=f?.triggers.launcher.getSnapshot()==='command'
          if(launcher && item && item.name!=='file' && item.hint===undefined && !item.drill) {
            // Bare commands are editable input on a phone. Enter still goes
            // through the host's normal command/permission adjudication.
            const input=f.input, doc=input.draftSnapshot, head=doc.command?.token.trimEnd() || ''
            const cut=head && doc.text.startsWith(head)?head.length:0, prefix='/'+item.name+' ', rest=doc.text.slice(cut)
            const delta=prefix.length-cut, shift=a=>a.map(x=>({...x,offset:x.offset+delta}))
            input.setDraft({text:prefix+rest,references:shift(doc.references),quotes:shift(doc.quotes||[])})
            input.focus();f.triggers.dismiss();return
          }
          el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0,view:window}))
          // The desktop pick assumes that the editor already owned focus. On
          // touch it didn't: restore the caret *after* the newly inserted chip,
          // never before it (typing there converts the chip to literal text).
          if(launcher && item && f.input.snapshot.claim?.name===item.name){
            f.input.focus()
            const root=f.input.editor.getRootElement(), chip=root?.querySelector('[data-composer-command]')
            const after=chip?.nextSibling?.firstChild
            if(after?.nodeType===Node.TEXT_NODE) getSelection()?.collapse(after,/^\s/.test(after.data)?1:0)
          }
        }
        const closest=(e,s)=>e.target?.closest?.(s)
        on('mousedown', e=>{if(closest(e,plusSel) || (eat && Date.now()<eat.until && e.isTrusted)) stop(e)})
        on('pointerdown',e=>{
          eat=null; pressed=null
          const plus=closest(e,plusSel), menu=document.querySelector(menuSel)
          if(plus) { if(e.button===0 && !plus.disabled){e.preventDefault();pressed={el:plus,x:e.clientX,y:e.clientY,id:e.pointerId,kind:'plus'}}; return }
          if(!menu || e.button!==0) return
          const within=menu.contains(e.target), el=within?closest(e,'[role="button"],button'):null
          if(!within && closest(e,'[contenteditable="true"]')) return
          if(!within || el) {pressed={el,x:e.clientX,y:e.clientY,id:e.pointerId,kind:within?'item':'outside'}; if(!within){stop(e)} else e.preventDefault()}
        })
        on('pointercancel',()=>{pressed=null})
        on('pointerup',e=>{
          const p=pressed; pressed=null; if(!p||p.id!==e.pointerId)return
          stop(e); eat={until:Date.now()+440}
          if(Math.hypot(p.x-e.clientX,p.y-e.clientY)>10)return
          if(p.kind==='plus') toggle(p.el)
          else if(p.kind==='outside') face()?.triggers.dismiss()
          else if(p.el.isConnected && !p.el.disabled) pick(p.el)
        })
        on('click',e=>{
          if(eat && Date.now()<eat.until && e.isTrusted){eat=null;stop(e);return}
          const plus=closest(e,plusSel); if(plus){stop(e);toggle(plus);return}
          const row=closest(e,'[data-trigger-menu] button'); if(row && e.detail===0){stop(e);pick(row)}
          const chip=closest(e,'[data-composer-command]'); if(chip){const f=face(); if(f && cancel(f.input))stop(e)}
        })
        for(const type of ['touchmove','wheel','selectstart','contextmenu']) window.addEventListener(type,e=>{
          const menu=document.querySelector(menuSel); if(menu && (!menu.contains(e.target)||type==='selectstart'||type==='contextmenu'))stop(e)
        },{...opts,passive:false})
        function deletion(e){
          const root=closest(e,'[contenteditable="true"]'); if(!root || e.isComposing)return
          const chip=root.querySelector('[data-composer-command]'), sel=getSelection(); if(!chip||!sel?.isCollapsed||!root.contains(sel.anchorNode))return
          const r=sel.getRangeAt(0).cloneRange(); const boundary=document.createRange();boundary.setStartAfter(chip);boundary.collapse(true)
          if(r.compareBoundaryPoints(Range.START_TO_START,boundary)<0)return
          r.setStartAfter(chip)
          if(r.toString().length>1 || r.toString().trim())return
          const f=face(); if(f && cancel(f.input))stop(e)
        }
        on('beforeinput',e=>{if(e.inputType==='deleteContentBackward')deletion(e)})
        on('keydown',e=>{if(e.key==='Backspace' && !e.altKey && !e.metaKey && !e.ctrlKey)deletion(e)})
        return ()=>events.abort()
      })
    }

    function readCurrentSessionRow(ctx) {
      try {
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        if (!sessions?.list?.getSnapshot) return null
        const list = sessions.list.getSnapshot()
        const cur = readCurrentSession(ctx)
        if (!cur?.sessionId) return null
        return list?.byId?.[cur.sessionId] ?? null
      } catch {}
      return null
    }

    function isSessionRunning(ctx, list, id) {
      const row = list?.byId?.[id]
      if (!row || row.origin === 'subagent' || row.blank) return false
      const statuses = ctx.get?.('sessionStatus')?.getSnapshot?.() ?? ctx.sessions?.statuses?.getSnapshot?.()
      const st = statuses?.get?.(id)
      if (st?.running === true || st?.pendingInteraction !== undefined) return true
      if (row.running === true || row.pendingInteraction !== undefined) return true
      for (const cid of list.ids) {
        const child = list.byId[cid]
        if (!child || child.origin !== 'subagent') continue
        if ((child.parentSessionId ?? child.parentId) !== id) continue
        const cst = statuses?.get?.(cid)
        if ((cst?.running ?? child.running) === true) return true
      }
      return false
    }

    function isSessionPending(ctx, list, id) {
      const row = list?.byId?.[id]
      if (!row || row.origin === 'subagent' || row.blank) return false
      const statuses = ctx.get?.('sessionStatus')?.getSnapshot?.() ?? ctx.sessions?.statuses?.getSnapshot?.()
      const st = statuses?.get?.(id)
      if (st?.pendingInteraction !== undefined || row.pendingInteraction !== undefined) return true
      for (const cid of list.ids) {
        const child = list.byId[cid]
        if (!child || child.origin !== 'subagent') continue
        if ((child.parentSessionId ?? child.parentId) !== id) continue
        const cst = statuses?.get?.(cid)
        if (cst?.pendingInteraction !== undefined || child.pendingInteraction !== undefined) return true
      }
      return false
    }

    function findRunningSession(ctx, list) {
      if (!list?.ids || !list?.byId) return null
      const focusedId = globalThis.__DSH_MOBILE_BRIDGE__?.snapshot?.()?.desktopFocus?.sessionId
      if (focusedId && list.ids.includes(focusedId) && isSessionRunning(ctx, list, focusedId)) {
        return list.byId[focusedId]
      }
      let best = null, bestTs = -1
      for (const id of list.ids) {
        if (!isSessionRunning(ctx, list, id)) continue
        const row = list.byId[id]
        const ts = Number(row.updatedAt ?? row.lastActivityAt ?? row.createdAt ?? 0)
        if (!best || ts > bestTs) { best = row; bestTs = ts }
      }
      return best
    }

    function mobileNavigation(ctx) {
      return ctx.effect(() => {
        const sessions=ctx.sessions, ws=ctx.workspaces, nav=ctx.uiWorkspace, leases=new Map()
        // One navigation intent per document, not per Cordis lifecycle/generation.
        const native = !!(globalThis.__DSH_MOBILE_LAUNCH__ || globalThis.webkit?.messageHandlers?.dshMobile)
        let stored
        if (native) {
          try {
            stored = localStorage.getItem('dml.lastSession')
            if (!stored) {
              const snap = JSON.parse(localStorage.getItem('dml.visualSnap.v1') || 'null')
              if (snap && typeof snap.sessionId === 'string' && snap.sessionId) stored = snap.sessionId
            }
          } catch {}
        }
        const launch = globalThis.__DSH_MOBILE_ROUTE_STATE__ ??= {
          intent: native,
          pending: false,
          saved: globalThis.__DSH_MOBILE_LAUNCH__?.resume || stored || undefined,
          settledOnce: false,
          settleWaitStart: 0,
        }
        const remember = id => {
          if (!native) return
          if (id && id !== launch.saved) {
            launch.saved = id
            try { localStorage.setItem('dml.lastSession', id) } catch {}
          }
        }
        const reselectIfNeeded = () => {
          if (!native || launch.intent) return
          const list = sessions.list.getSnapshot()
          const id = readCurrentSession(ctx)?.sessionId
          const cur = id ? list?.byId?.[id] : null
          // A blank workspace session is still an explicit phone selection.
          if (!cur || (launch.saved && launch.saved !== id)) {
            launch.intent = true
            launch.awaiting = undefined
            launch.executed = false
            launch.settleWaitStart = 0
          }
        }
        let active, frame=0, live=true
        function release(id){const item=leases.get(id); if(!item)return; leases.delete(id);clearTimeout(item.timer);item.ref.release()}
        function clear(){for(const id of [...leases.keys()])release(id);active=undefined}
        function retainReady(id) {
          let item=leases.get(id)
          if(item)return item
          const ref=sessions.retain(id,{source:'dshMobileHistory'})
          item={ref,ready:false};leases.set(id,item)
          ref.ready.then(()=>{if(leases.get(id)===item){item.ready=true;schedule()}},()=>{
            if(leases.get(id)===item){release(id);launch.retryAt=Date.now()+1500;schedule()}
          })
          return item
        }
        function tick(){frame=0;if(!live||document.hidden)return
          const list=sessions.list.getSnapshot(), spaces=ws.list.getSnapshot(); if(list.phase!=='ready'||spaces.phase!=='ready')return
          const id=readCurrentSession(ctx)?.sessionId
          const selected=id ? list.byId[id] : undefined
          if(launch.intent && ctx.connection.state.getSnapshot()==='connected'){
            if(launch.pending)return
            const savedRow = launch.saved && list.ids.includes(launch.saved) ? list.byId[launch.saved] : null
            const target = savedRow || findRunningSession(ctx, list)
            const chosen=spaces.items.find(s=>s.sessionIds.includes(id)) || spaces.items[0]
            const apply=operation=>{
              launch.pending=true
              Promise.resolve().then(operation).then(()=>{launch.executed=true},()=>{launch.awaiting=undefined;launch.retryAt=Date.now()+1500}).finally(()=>{launch.pending=false;schedule()})
            }
            if(Date.now() < (launch.retryAt||0))return
            if(target && target.id!==id){
              launch.settleWaitStart = 0
              if(launch.awaiting!==target.id){launch.awaiting=target.id;apply(()=>nav.openSession(target.id))}
              return
            }
            if(!target && !selected?.blank && !globalThis.__DSH_MOBILE_SHELL__?.readOnly && (chosen || id)){
              launch.settleWaitStart = 0
              if(launch.awaiting!=='new'){launch.awaiting='new';apply(()=>chosen?nav.openWorkspace(chosen.workspaceId):nav.startSession())}
              if(chosen || !launch.executed || id)return
            }
            // The first active DOM can still contain cached history. Wait for
            // the host's current retained snapshot before presenting it.
            if(id && sessions.binding(id) && !retainReady(id).ready)return
            // Do not acknowledge a retain on a still-unpainted or still-settling previous view.
            const content=[...document.querySelectorAll('[data-conversation-content]')].find(el=>el.getClientRects().length)
            if(!content || (id && content.dataset.conversationSession!==id) || !content.querySelector('[data-composer-card]'))return
            const phase = content.dataset.contentPhase || content.closest?.('[data-phase]')?.getAttribute('data-phase') || ''
            const expectActive = !!(target && !target.blank)
            const hasRenderedTurns = !expectActive || !!content.querySelector?.('[data-chat-turn], [data-message-bubble], [data-chat-flow] > *')
            if (phase === 'settling' || (expectActive && phase === 'hero')) return
            // Some non-blank sessions have no renderable turns. Only allow that
            // exception once the correct active view (never the hero) is mounted.
            if (expectActive && !hasRenderedTurns) {
              if (!launch.settleWaitStart) launch.settleWaitStart = Date.now()
              if (Date.now() - launch.settleWaitStart < 5500) return
            }
            const coldLaunch=!launch.settledOnce
            launch.intent=false;launch.awaiting=undefined;launch.retryAt=0;launch.settledOnce=true;launch.settleWaitStart=0
            stopLaunchWatch()
            const settledId = id
            const settledBlank = !!selected?.blank
            const notify = () => {
              globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({type:'launch-applied',sessionId:settledId,isBlank:settledBlank})
            }
            if (typeof globalThis.__DSH_MOBILE_BRIDGE__?.onLaunchHydrated === 'function') {
              globalThis.__DSH_MOBILE_BRIDGE__.onLaunchHydrated(notify,{latest:coldLaunch})
            } else {
              document.documentElement.removeAttribute('data-dml-routing')
              if (document.documentElement.style?.backgroundColor) {
                document.documentElement.style.backgroundColor = ''
              }
              if (typeof requestAnimationFrame === 'function' && globalThis.webkit?.messageHandlers?.dshMobile) {
                void document.documentElement.offsetWidth
                requestAnimationFrame(notify)
              } else {
                notify()
              }
            }
          }
          if(launch.intent || id===active || ctx.connection.state.getSnapshot()!=='connected')return
          remember(id)
          const old=active; active=id
          globalThis.__DSH_MOBILE_BRIDGE__?.reportSelection?.()
          if(old && leases.has(old))leases.get(old).timer=setTimeout(()=>release(old),120000)
          if(!id || !sessions.binding(id))return
          const current=leases.get(id); if(current){clearTimeout(current.timer);leases.delete(id);leases.set(id,current)}
          else retainReady(id)
          // Current plus the two most recent views; no fetch for unopened rows.
          while(leases.size>3)release(leases.keys().next().value)
        }
        const schedule=()=>{if(!frame&&live)frame=requestAnimationFrame(tick)}
        let launchObserver = null, launchTimer = 0
        function stopLaunchWatch() {
          if (launchObserver) { launchObserver.disconnect(); launchObserver = null }
          if (launchTimer) { if (typeof clearInterval === 'function') clearInterval(launchTimer); launchTimer = 0 }
        }
        function startLaunchWatch() {
          if (!launch.intent || !live) return
          if (!launchObserver && typeof MutationObserver === 'function') {
            const rootEl = document.getElementById?.('root')
            if (rootEl) {
              launchObserver = new MutationObserver(schedule)
              launchObserver.observe(rootEl, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['data-content-phase', 'data-phase', 'data-conversation-session'],
              })
            }
          }
          if (!launchTimer && typeof setInterval === 'function') launchTimer = setInterval(() => { if (launch.intent && !document.hidden) schedule(); else stopLaunchWatch() }, 400)
        }
        const vis=()=>{if(document.hidden){if(!launch.intent)remember(readCurrentSession(ctx)?.sessionId);stopLaunchWatch();launch.wasHidden=true}else{if(launch.wasHidden){reselectIfNeeded();startLaunchWatch()};launch.wasHidden=false;schedule()}}
        const transport=()=>{if(ctx.connection.state.getSnapshot()!=='connected')launch.wasDown=true;else if(launch.wasDown){launch.wasDown=false;reselectIfNeeded();startLaunchWatch()} schedule()}
        const onUserNav = (e) => {
          if (e?.target?.closest?.('[data-sidebar-drawer] button, [data-sidebar-drawer] a, [data-sidebar-drawer] [role="button"]')) {
            if (launch.intent) {
              launch.intent = false; launch.awaiting = undefined; launch.settleWaitStart = 0
              stopLaunchWatch()
              if (typeof globalThis.__DSH_MOBILE_CLEAR_SNAP__ === 'function') {
                globalThis.__DSH_MOBILE_CLEAR_SNAP__()
              } else {
                document.documentElement?.removeAttribute?.('data-dml-routing')
                if (document.documentElement?.style?.backgroundColor) document.documentElement.style.backgroundColor = ''
              }
            }
          }
        }
        const statusSub = ctx.get?.('sessionStatus')?.subscribe?.(schedule)
        const offs=[sessions.list.subscribe(schedule),ws.list.subscribe(schedule),ctx.connection.state.subscribe(transport),...(statusSub?[statusSub]:[])]
        startLaunchWatch()
        document.addEventListener?.('click', onUserNav, true)
        document.addEventListener('visibilitychange',vis);schedule()
        return ()=>{live=false;stopLaunchWatch();cancelAnimationFrame(frame);offs.forEach(off=>off());document.removeEventListener?.('click',onUserNav,true);document.removeEventListener?.('visibilitychange',vis);clear()}
      })
    }

    let hubState = { open: false, tab: 'tasks' }
    const hubListeners = new Set()
    const notifyHub = () => { for (const fn of hubListeners) { try { fn() } catch {} } }
    const subscribeHub = (fn) => { hubListeners.add(fn); return () => hubListeners.delete(fn) }
    const getHubSnapshot = () => hubState
    const setHubState = (next) => { hubState = { ...hubState, ...next }; notifyHub() }

    function readDraftStorage(sessionId) {
      if (!sessionId) return null
      try {
        const raw = globalThis.localStorage?.getItem('dml.draft.' + sessionId)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) return null
        if (Date.now() - Number(parsed.ts || 0) > 600_000) {
          globalThis.localStorage?.removeItem('dml.draft.' + sessionId)
          return null
        }
        return parsed.text
      } catch {
        return null
      }
    }
    function writeDraftStorage(sessionId, text) {
      if (!sessionId) return
      try {
        const trimmed = typeof text === 'string' ? text.trim() : ''
        if (!trimmed) {
          globalThis.localStorage?.removeItem('dml.draft.' + sessionId)
        } else {
          globalThis.localStorage?.setItem('dml.draft.' + sessionId, JSON.stringify({
            text: text.slice(0, 16384),
            ts: Date.now(),
          }))
        }
        notifyHub()
      } catch {}
    }
    function clearDraftStorage(sessionId) {
      if (!sessionId) return
      try {
        globalThis.localStorage?.removeItem('dml.draft.' + sessionId)
        notifyHub()
      } catch {}
    }

    function applyMobileBridge(ctx) {
      let conversationSvc = null
      ctx.inject?.(['conversation'], scope => {
        conversationSvc = scope.conversation || null
      })
      const getInputFor = (sessionId) => {
        if (!sessionId) return null
        try {
          const conv = conversationSvc ?? ctx.get?.('conversation')
          const binding = ctx.sessions?.binding?.(sessionId)
          return binding && conv?.input?.for?.(binding.ctx)
        } catch {
          return null
        }
      }
      const api = {
        toggleSidebar() {
          const layout = ctx.get?.('layout') ?? ctx.layout
          if (typeof layout?.toggleSidebar === 'function') {
            layout.toggleSidebar()
            return true
          }
          return false
        },
        toggleRightPanel() {
          const layout = ctx.get?.('layout') ?? ctx.layout
          if (typeof layout?.toggleRightSidebar === 'function') {
            layout.toggleRightSidebar()
            return true
          }
          if (typeof layout?.toggleInspector === 'function') {
            layout.toggleInspector()
            return true
          }
          const btn = [...(document.querySelectorAll?.('[data-sidebar-right-toggle], [data-sidebar-right-expand], [data-conversation-header-corner] button') ?? [])]
            .find(el => {
              if (el.disabled || el.closest?.('[inert], [hidden]')) return false
              const r = el.getBoundingClientRect?.()
              return r && r.width > 2 && r.height > 2 && r.right > 0 && r.left < (globalThis.innerWidth || 9999)
            })
          if (btn && typeof btn.click === 'function') {
            btn.click()
            return true
          }
          return false
        },
        openSession(sessionId) {
          const ws = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
          if (typeof ws?.openSession === 'function') {
            ws.openSession(sessionId)
            return true
          }
          return false
        },
        newSession() {
          const ws = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
          if (typeof ws?.startSession === 'function') {
            ws.startSession()
            return true
          }
          const spaces = (ctx.get?.('workspaces') ?? ctx.workspaces)?.list?.getSnapshot?.()
          const curId = readCurrentSession(ctx)?.sessionId
          const chosen = spaces?.items?.find(s => s.sessionIds?.includes(curId)) || spaces?.items?.[0]
          if (chosen && typeof ws?.openWorkspace === 'function') {
            ws.openWorkspace(chosen.workspaceId)
            return true
          }
          return false
        },
        insertDraft(text, opts = {}) {
          if (typeof text !== 'string' || !text) return false
          const id = readCurrentSession(ctx)?.sessionId
          const input = getInputFor(id)
          if (input && typeof input.setDraft === 'function') {
            const doc = input.draftSnapshot || { text: '', references: [], quotes: [] }
            const existing = typeof doc.text === 'string' ? doc.text : ''
            const replace = opts.replace === true
            const sep = !replace && existing && !/\s$/.test(existing) ? '\n' : ''
            const nextText = replace ? text : (existing + sep + text)
            input.setDraft({
              text: nextText,
              references: replace ? [] : (doc.references || []),
              quotes: replace ? [] : (doc.quotes || []),
            })
            if (opts.focus !== false) input.focus?.()
            clearDraftStorage(id)
            return true
          }
          const editor = document.querySelector?.('[data-composer-card] [contenteditable="true"]')
          if (opts.focus !== false && editor && typeof editor.focus === 'function') {
            editor.focus()
            if (typeof document.execCommand === 'function') {
              document.execCommand('insertText', false, text)
              clearDraftStorage(id)
              return true
            }
          }
          return false
        },
        reconnect() {
          const conn = ctx.get?.('connection') ?? ctx.connection
          if (typeof conn?.reconnect === 'function') {
            conn.reconnect()
            return true
          }
          return false
        },
        openHub(tab = 'tasks') {
          setHubState({ open: true, tab: typeof tab === 'string' && tab ? tab : 'tasks' })
          return true
        },
        closeHub() {
          setHubState({ open: false })
          return true
        },
        getCurrentSessionId() {
          return readCurrentSession(ctx)?.sessionId ?? null
        },
        isCurrentSessionBlank() {
          return !!readCurrentSessionRow(ctx)?.blank
        },
        isCurrentSessionRunning() {
          const sessions = ctx.get?.('sessions') ?? ctx.sessions
          const list = sessions?.list?.getSnapshot?.()
          const id = readCurrentSession(ctx)?.sessionId
          if (!list || !id) return false
          return isSessionRunning(ctx, list, id)
        },
        listSessions() {
          const sessions = ctx.get?.('sessions') ?? ctx.sessions
          const list = sessions?.list?.getSnapshot?.()
          if (!list?.ids || !list?.byId) return []
          const workspaceList = (ctx.get?.('workspaces') ?? ctx.workspaces)?.list?.getSnapshot?.()
          const spaces = workspaceList?.items ?? []
          const archivedIds = new Set(workspaceList?.archivedSessionIds ?? [])
          const wsMap = new Map()
          for (const ws of spaces) {
            const label = ws.name || ws.title || String(ws.cwd || '').split(/[\\/]/).filter(Boolean).pop() || ''
            for (const sid of ws.sessionIds ?? []) wsMap.set(sid, { id: ws.workspaceId, name: label })
          }
          const curId = readCurrentSession(ctx)?.sessionId ?? null
          const out = []
          for (const id of list.ids) {
            const row = list.byId[id]
            if (!row || row.origin === 'subagent') continue
            const wsInfo = wsMap.get(id)
            const running = isSessionRunning(ctx, list, id)
            const pendingInteraction = isSessionPending(ctx, list, id)
            const updatedAt = Number(row.updatedAt ?? row.lastActivityAt ?? row.createdAt ?? 0)
            out.push({
              id,
              title: row.title?.trim() || (row.blank ? t('新会话') : id.slice(0, 8)),
              blank: !!row.blank,
              workspaceId: wsInfo?.id || row.workspaceId || '',
              workspaceName: wsInfo?.name || '',
              running,
              pendingInteraction,
              updatedAt,
              archived: archivedIds.has(id),
              isCurrent: id === curId,
            })
          }
          out.sort((a, b) => (
            (b.pendingInteraction - a.pendingInteraction) ||
            (b.running - a.running) ||
            (b.updatedAt - a.updatedAt)
          ))
          return out
        },
        async setSessionsArchived(ids, archive) {
          if (globalThis.__DSH_MOBILE_SHELL__?.readOnly) throw Error('电脑未开启手机操作权限')
          const nav = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
          const action = archive ? nav?.archiveSession : nav?.unarchiveSession
          if (typeof action !== 'function') throw Error('当前电脑端不支持此操作')
          const rows = new Map(api.listSessions().map(row => [row.id, row]))
          const changed = [], failed = []
          // Use the official workspace service: it checks access/activity again on
          // the host and publishes the updated archive set to both clients.
          for (const id of new Set(ids)) {
            const row = rows.get(id)
            if (!row || row.archived === archive || (archive && (row.running || row.pendingInteraction))) {
              failed.push(id)
              continue
            }
            try { await action.call(nav, id); changed.push(id) } catch { failed.push(id) }
          }
          return { changed, failed }
        },
        getPendingApprovals() {
          const curId = readCurrentSession(ctx)?.sessionId ?? null
          return api.listSessions()
            .filter(s => s.pendingInteraction && !s.archived)
            .map(s => ({ sessionId: s.id, title: s.title, isCurrent: s.id === curId }))
        },
        getSavedDraft(sessionId) {
          return readDraftStorage(sessionId || readCurrentSession(ctx)?.sessionId)
        },
        clearSavedDraft(sessionId) {
          clearDraftStorage(sessionId || readCurrentSession(ctx)?.sessionId)
        },
      }
      globalThis.__DSH_MOBILE_CORDIS__ = api
      globalThis.__DSH_MOBILE_BRIDGE__?.followFocus?.()
      ctx.effect(() => () => {
        if (globalThis.__DSH_MOBILE_CORDIS__ === api) delete globalThis.__DSH_MOBILE_CORDIS__
      }, 'dsh-mobile-link: mobile cordis bridge')

      // Forward live DSH connection state directly to the iOS host when available.
      ctx.effect(() => {
        const conn = ctx.get?.('connection') ?? ctx.connection
        const source = conn?.state
        if (typeof source?.subscribe !== 'function') return undefined
        const push = () => {
          const state = source.getSnapshot?.()
          if (state) {
            globalThis.__DSH_MOBILE_BRIDGE__?.setLogicalConnection?.(state)
            try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'ws', state }) } catch {}
          }
        }
        push()
        return source.subscribe(push)
      }, 'dsh-mobile-link: mobile connection state')

      // Stream live task running / completion / pending approval state to iOS host and hub UI.
      ctx.effect(() => {
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        const status = ctx.get?.('sessionStatus')
        const prevMap = new Map()
        let seeded = false
        const scan = () => {
          const list = sessions?.list?.getSnapshot?.()
          if (list?.ids && list?.byId) {
            for (const id of list.ids) {
              const row = list.byId[id]
              if (!row || row.origin === 'subagent') continue
              const running = isSessionRunning(ctx, list, id)
              const pending = isSessionPending(ctx, list, id)
              const title = row.title?.trim() || id.slice(0, 8)
              const prev = prevMap.get(id)
              if (seeded && prev) {
                if (!prev.running && running) {
                  clearDraftStorage(id)
                }
                if (prev.running && !running && !row.blank) {
                  const evt = { kind: 'completed', sessionId: id, title }
                  globalThis.__DSH_MOBILE_BRIDGE__?.onTaskEvent?.(evt)
                  try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'task-event', ...evt }) } catch {}
                }
                if (!prev.pending && pending) {
                  const evt = { kind: 'approval', sessionId: id, title }
                  globalThis.__DSH_MOBILE_BRIDGE__?.onTaskEvent?.(evt)
                  try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'task-event', ...evt }) } catch {}
                }
              }
              prevMap.set(id, { running, pending, title })
            }
            if (list.phase === 'ready' || list.ids.length > 0) seeded = true
          }
          globalThis.__DSH_MOBILE_BRIDGE__?.reportUi?.()
          setHubState({})
        }
        const offs = []
        if (typeof status?.subscribe === 'function') offs.push(status.subscribe(scan))
        if (typeof sessions?.list?.subscribe === 'function') offs.push(sessions.list.subscribe(scan))
        const workspaces = (ctx.get?.('workspaces') ?? ctx.workspaces)?.list
        if (typeof workspaces?.subscribe === 'function') offs.push(workspaces.subscribe(() => setHubState({})))
        scan()
        return () => {
          for (const off of offs) {
            try { off?.() } catch {}
          }
        }
      }, 'dsh-mobile-link: mobile task status')

      // Debounced auto-save for unsent composer drafts across accidental reloads or disconnects.
      ctx.effect(() => {
        if (typeof document.addEventListener !== 'function') return undefined
        let draftTimer = 0
        const saveNow = () => {
          draftTimer = 0
          const cur = readCurrentSession(ctx)
          if (!cur?.sessionId) return
          const input = getInputFor(cur.sessionId)
          let text = input?.draftSnapshot?.text
          if (typeof text !== 'string') {
            text = document.querySelector?.('[data-composer-card] [contenteditable="true"]')?.textContent || ''
          }
          if (text.trim().length >= 4) writeDraftStorage(cur.sessionId, text)
          else if (!text.trim()) clearDraftStorage(cur.sessionId)
        }
        const onInput = (e) => {
          if (!e?.target?.closest?.('[data-composer-card]')) return
          if (typeof clearTimeout === 'function') clearTimeout(draftTimer)
          if (typeof setTimeout === 'function') draftTimer = setTimeout(saveNow, 400)
        }
        const onKeyDown = (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e?.target?.closest?.('[data-composer-card]')) {
            const id = readCurrentSession(ctx)?.sessionId
            if (id) clearDraftStorage(id)
          }
        }
        document.addEventListener('input', onInput, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(draftTimer)
          document.removeEventListener('input', onInput, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, 'dsh-mobile-link: draft autosave')
    }

    function applyDesktopFocusReporter(ctx) {
      ctx.effect(() => {
        let lastKey = '', pending = false, dirty = false, closed = false, timer
        const schedule = () => {
          if (!closed && !timer) timer = setTimeout(() => { timer = undefined; report() }, 50)
        }
        const report = () => {
          if (closed || document.visibilityState === 'hidden') return
          if (pending) { dirty = true; return }
          const active = readCurrentSession(ctx)
          const key = (active?.sessionId || '') + '|' + (active?.title || '')
          if (key === lastKey) return
          pending = true
          call('/desktop-focus', { sessionId: active?.sessionId ?? null, title: active?.title ?? '' })
            .then(() => { lastKey = key }, () => {})
            .finally(() => { pending = false; if (dirty) { dirty = false; schedule() } })
        }
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        const off = sessions?.list?.subscribe?.(schedule)
        // A main-view retain can change without changing the list snapshot.
        document.addEventListener('click', schedule, true)
        document.addEventListener('visibilitychange', schedule)
        const fallback = setInterval(report, 1500)
        report()
        return () => {
          closed = true; clearTimeout(timer); clearInterval(fallback); off?.()
          document.removeEventListener('click', schedule, true)
          document.removeEventListener('visibilitychange', schedule)
        }
      }, 'dsh-mobile-link: desktop focus sync')
    }

    // Only the workspace browser gets this view of the host list. The composer,
    // blank reuse, model state, navigation and workspace membership stay official.
    function installWorkspaceSessions(ctx) {
      const slot = 'sidebar.workspaces'
      return ctx.effect(() => {
        let entry, original, wrapper
        function restore() {
          if (entry && entry.component === wrapper) entry.component = original
          entry = original = wrapper = undefined
        }
        function reconcile() {
          const next = ctx.slots.entries(slot).find(e => e.children?.['sidebar.workspaces.session.row.action'] && typeof e.component === 'function')
          if (entry === next) return
          restore()
          if (!next) return
          const Browser = next.component
          // Keep the registered entry itself: its child slots, menus, locale,
          // persisted order and injected capabilities belong to this exact owner.
          function SharedWorkspaceBrowser(props) {
            const label = props.t('session.new')
            const useSessions = React.useMemo(() => {
              let last, projected
              return function useWorkspaceSessionList(select) {
                return props.useSessions(list => {
                  if (list !== last) {
                    let byId
                    for (const id of list.ids) {
                      const row = list.byId[id]
                      if (!row?.blank || row.origin === 'subagent' || row.retainedBy?.mainView) continue
                      byId ??= { ...list.byId }
                      byId[id] = { ...row, blank: false, title: row.title?.trim() || label }
                    }
                    projected = byId ? { ...list, byId } : list
                    last = list
                  }
                  return select(projected)
                })
              }
            }, [props.useSessions, label])
            return h(Browser, { ...props, useSessions })
          }
          entry = next; original = Browser; wrapper = SharedWorkspaceBrowser
          entry.component = wrapper
        }
        const unsubscribe = ctx.slots.subscribe(slot, reconcile)
        reconcile()
        return () => { unsubscribe(); restore() }
      }, 'dsh-mobile-link: shared workspace session rows')
    }

    // Tighten the native readings uniformly only if their actual localized values overflow the single row.
    function fitMobileReadings(dock) {
      let frame = 0
      function fit() {
        frame = 0
        dock.removeAttribute('data-dml-stats-fit')
        const labels = [...dock.querySelectorAll('[data-composer-stat] svg + span')]
        const pills = [...dock.querySelectorAll('[data-composer-stat] > button, [data-composer-stat] > span')]
        if (!dock.clientWidth || !labels.length) return
        const overflows = () =>
          dock.scrollWidth > dock.clientWidth + 1 ||
          labels.some(el => el.scrollWidth > el.clientWidth + 1) ||
          pills.some(el => el.scrollWidth > el.clientWidth + 1)
        if (!overflows()) return
        dock.dataset.dmlStatsFit = 'tight'
        if (!overflows()) return
        dock.dataset.dmlStatsFit = 'text'
        if (!overflows()) return
        for (const label of labels) {
          const full = label.textContent
          const short = full.replace(/缓存命中\s*/g, '命中').replace(/Cache hit\s+/gi, 'Hit ')
            .replace(/(\d)\s+轮\s*/g, '$1轮 ').replace(/(\d)\s+步/g, '$1步')
            .replace(/\s+turns?\b/gi, 'T').replace(/\s+steps?\b/gi, 'S')
            .replace(/\s*·\s*/g, '·')
          if (short !== full) label.parentElement.dataset.dmlShortReading = short
          else label.parentElement.removeAttribute('data-dml-short-reading')
        }
        dock.dataset.dmlStatsFit = 'short'
      }
      const schedule = () => { if (!frame) frame = requestAnimationFrame(fit) }
      const resize = new ResizeObserver(schedule), changes = new MutationObserver(schedule)
      resize.observe(dock)
      changes.observe(dock, { childList: true, characterData: true, subtree: true })
      document.fonts?.addEventListener('loadingdone', schedule)
      fit()
      return () => {
        cancelAnimationFrame(frame); resize.disconnect(); changes.disconnect()
        document.fonts?.removeEventListener('loadingdone', schedule)
        dock.removeAttribute('data-dml-stats-fit')
        for (const el of dock.querySelectorAll('[data-dml-short-reading]')) el.removeAttribute('data-dml-short-reading')
      }
    }

    function MobileStatsFit() {
      const ref = React.useRef(null)
      React.useLayoutEffect(() => {
        const dock = ref.current?.closest('[data-composer-dock]')
        if (dock && typeof ResizeObserver === 'function') return fitMobileReadings(dock)
      }, [])
      return h('span', {ref, hidden:true})
    }

    async function copyMobileText(text) {
      if (typeof text !== 'string' || !text) return false
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {}
      try {
        const ta = document.createElement?.('textarea')
        if (!ta || !document.body) return false
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand?.('copy')
        ta.remove()
        return !!ok
      } catch {
        return false
      }
    }

    let mobileRpcSeq = 0
    async function rpcMobile(method, args = {}, signal) {
      const rpcId = 'dmr-' + ++mobileRpcSeq + '-' + Date.now().toString(36)
      const res = await fetch('/api/' + method, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      })
      if (!res.ok) throw Error('HTTP ' + res.status)
      const env = await res.json()
      if (env?.result?.ok !== true) throw Error(env?.result?.error?.message || 'RPC 失败')
      return env.result.value
    }

    // Fast host-side Office/delimited reader for mobile (zero full-file download, zero CJK/Symbol mojibake).
    // DSH's built-in Office/PDF and Excel renderers stay one tap away in the toolbar switcher.
    function installReader(ctx) {
      const id = 'dsh-mobile-link/original-text',
        exts = ['docx', 'doc', 'pptx', 'odt', 'odp', 'ods', 'xlsx', 'csv', 'tsv'],
        binaryExts = ['docx', 'doc', 'pptx', 'odt', 'odp', 'ods', 'xlsx']
      const cache = new Map()
      let rpcSeq = 0

      function parseSessionFile(address) {
        if (typeof address !== 'string' || !address.startsWith('dsh-resource://file/')) return null
        const end = address.search(/[?#]/)
        const parts = address.slice(20, end === -1 ? undefined : end).split('/')
        if (parts[0] !== 'session' || parts.length < 3 || !parts[1]) return null
        try {
          return {
            sessionId: decodeURIComponent(parts[1]),
            path: parts.slice(2).map(decodeURIComponent).join('/'),
          }
        } catch {
          return null
        }
      }

      function blockPlainText(b) {
        if (!b) return ''
        if (b.type === 'table' && Array.isArray(b.rows)) return b.rows.map(r => r.join('\t')).join('\n')
        return String(b.text || '')
      }

      function Reader({ resourceAddress, content, scrollportRef }) {
        const request = content?.kind === 'renderer' ? content : null
        const revision = request?.revision ?? 0
        const [result, set] = React.useState(null)
        const [limit, setLimit] = React.useState(120)
        const [tocOpen, setTocOpen] = React.useState(false)
        const [searchOpen, setSearchOpen] = React.useState(false)
        const [query, setQuery] = React.useState('')
        const [matchIdx, setMatchIdx] = React.useState(0)
        const [fontSize, setFontSize] = React.useState(() => {
          try {
            const saved = Number(globalThis.localStorage?.getItem('dml.reader.fontSize'))
            return saved >= 13 && saved <= 22 ? saved : 15
          } catch {
            return 15
          }
        })
        const [progress, setProgress] = React.useState(0)
        const sentinelRef = React.useRef(null)
        const articleElRef = React.useRef(null)
        const searchInputRef = React.useRef(null)
        const loadedRef = React.useRef(request?.loaded)
        const failedRef = React.useRef(request?.failed)
        loadedRef.current = request?.loaded
        failedRef.current = request?.failed
        const setScrollport = React.useCallback((el) => {
          articleElRef.current = el
          if (typeof scrollportRef === 'function') scrollportRef(el)
          else if (scrollportRef && typeof scrollportRef === 'object') scrollportRef.current = el
        }, [scrollportRef])

        React.useEffect(() => {
          if (!resourceAddress || !request) return undefined
          const key = resourceAddress + '@' + revision
          setLimit(120)
          setTocOpen(false)
          setQuery('')
          setMatchIdx(0)
          setProgress(0)
          if (cache.has(key)) {
            const hit = cache.get(key)
            set(hit)
            if (hit.error) failedRef.current?.()
            else loadedRef.current?.(hit.version || '')
            return undefined
          }
          set(null)
          const file = parseSessionFile(resourceAddress)
          if (!file) {
            const err = { error: '无法解析当前文档地址' }
            set(err)
            failedRef.current?.()
            return undefined
          }
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 25000)
          ;(async () => {
            try {
              const rpcId = 'mo-' + ++rpcSeq + '-' + Date.now().toString(36)
              const res = await fetch('/api/mobileOffice/read', {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                  type: 'client-request',
                  rpcId,
                  method: 'mobileOffice/read',
                  payload: { args: { sessionId: file.sessionId, path: file.path } },
                }),
              })
              if (!res.ok) throw Error('读取文档失败 (' + res.status + ')')
              const envelope = await res.json()
              if (controller.signal.aborted) return
              if (envelope?.result?.ok !== true) {
                throw Error(envelope?.result?.error?.message || '文档无法读取')
              }
              const value = envelope.result.value
              cache.set(key, value)
              while (cache.size > 16) cache.delete(cache.keys().next().value)
              set(value)
              loadedRef.current?.(value.version || '')
            } catch (error) {
              if (controller.signal.aborted) return
              const msg = error?.name === 'AbortError' ? '文档读取超时' : error?.message || '文档无法读取'
              set({ error: msg })
              failedRef.current?.()
            } finally {
              clearTimeout(timer)
            }
          })()
          return () => {
            clearTimeout(timer)
            controller.abort()
          }
        }, [resourceAddress, revision, !!request])

        React.useEffect(() => {
          const el = sentinelRef.current
          if (!el || !result?.blocks || limit >= result.blocks.length || typeof IntersectionObserver !== 'function') {
            return undefined
          }
          const observer = new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                setLimit((cur) => Math.min(result.blocks.length, cur + 120))
              }
            },
            { rootMargin: '260px' },
          )
          observer.observe(el)
          return () => observer.disconnect()
        }, [result, limit])

        React.useEffect(() => {
          const el = articleElRef.current
          if (!el || typeof el.addEventListener !== 'function') return undefined
          const update = () => {
            const max = el.scrollHeight - el.clientHeight
            setProgress(max > 10 ? Math.min(100, Math.max(0, Math.round((el.scrollTop / max) * 100))) : 0)
          }
          update()
          el.addEventListener('scroll', update, { passive: true })
          return () => el.removeEventListener('scroll', update)
        }, [result, limit])

        const toc = React.useMemo(() => {
          if (!Array.isArray(result?.blocks)) return []
          const items = []
          for (let i = 0; i < result.blocks.length; i++) {
            const b = result.blocks[i]
            if ((b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'slide') && b.text?.trim()) {
              items.push({ idx: i, kind: b.type, text: b.text.trim() })
            }
          }
          return items
        }, [result])

        const qLower = query.trim().toLowerCase()
        const matches = React.useMemo(() => {
          if (!qLower || !Array.isArray(result?.blocks)) return []
          const hits = []
          for (let i = 0; i < result.blocks.length; i++) {
            const txt = blockPlainText(result.blocks[i]).toLowerCase()
            if (txt.includes(qLower)) hits.push(i)
          }
          return hits
        }, [result, qLower])

        const safeMatchIdx = matches.length ? Math.min(matchIdx, matches.length - 1) : 0
        const activeBlockIdx = matches.length ? matches[safeMatchIdx] : -1

        React.useEffect(() => {
          if (activeBlockIdx < 0) return
          if (activeBlockIdx >= limit) {
            setLimit(Math.min(result?.blocks?.length || activeBlockIdx + 1, activeBlockIdx + 40))
            return
          }
          const node = articleElRef.current?.querySelector?.(`[data-block-idx="${activeBlockIdx}"]`)
          node?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
        }, [activeBlockIdx, limit, result])

        React.useEffect(() => {
          if (searchOpen) searchInputRef.current?.focus?.()
        }, [searchOpen])

        function jumpToBlock(idx) {
          setTocOpen(false)
          if (idx >= limit) {
            setLimit(Math.min(result?.blocks?.length || idx + 1, idx + 40))
            requestAnimationFrame(() => {
              articleElRef.current?.querySelector?.(`[data-block-idx="${idx}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
            })
          } else {
            articleElRef.current?.querySelector?.(`[data-block-idx="${idx}"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
          }
        }

        function stepFont(delta) {
          setFontSize((cur) => {
            const next = Math.max(13, Math.min(22, cur + delta))
            try { globalThis.localStorage?.setItem('dml.reader.fontSize', String(next)) } catch {}
            return next
          })
        }

        function highlightText(str, blockIdx) {
          if (!qLower || typeof str !== 'string') return str
          const low = str.toLowerCase()
          let pos = low.indexOf(qLower)
          if (pos === -1) return str
          const out = []
          let last = 0, part = 0
          while (pos !== -1 && part < 40) {
            if (pos > last) out.push(str.slice(last, pos))
            out.push(h('mark', {
              key: 'm' + part++,
              className: 'dml-mark',
              'data-active': blockIdx === activeBlockIdx ? 'true' : undefined,
            }, str.slice(pos, pos + qLower.length)))
            last = pos + qLower.length
            pos = low.indexOf(qLower, last)
          }
          if (last < str.length) out.push(str.slice(last))
          return out
        }

        function renderBlock(block, idx) {
          if (block.type === 'h1') return h('h2', { dir: 'auto', key: idx, 'data-kind': 'h1', 'data-block-idx': idx }, highlightText(block.text, idx))
          if (block.type === 'h2') return h('h3', { dir: 'auto', key: idx, 'data-kind': 'h2', 'data-block-idx': idx }, highlightText(block.text, idx))
          if (block.type === 'h3') return h('h4', { dir: 'auto', key: idx, 'data-kind': 'h3', 'data-block-idx': idx }, highlightText(block.text, idx))
          if (block.type === 'slide') return h('div', { key: idx, className: 'dml-reader-slide', 'data-kind': 'slide', 'data-block-idx': idx }, highlightText(block.text, idx))
          if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length) {
            const hasHeader = block.rows.length > 1
            const headRows = hasHeader ? [block.rows[0]] : []
            const bodyRows = hasHeader ? block.rows.slice(1) : block.rows
            return h(
              'div',
              { key: idx, className: 'dml-reader-table-wrap', 'data-kind': 'table', 'data-block-idx': idx },
              h(
                'table',
                { className: 'dml-reader-table' },
                headRows.length
                  ? h(
                      'thead',
                      null,
                      ...headRows.map((row, r) =>
                        h('tr', { key: r }, ...row.map((cell, c) => h('th', { key: c, dir: 'auto' }, highlightText(cell, idx)))),
                      ),
                    )
                  : null,
                h(
                  'tbody',
                  null,
                  ...bodyRows.map((row, r) =>
                    h('tr', { key: r }, ...row.map((cell, c) => h('td', { key: c, dir: 'auto' }, highlightText(cell, idx)))),
                  ),
                ),
              ),
            )
          }
          return h('p', { dir: 'auto', key: idx, 'data-kind': block.type || 'p', 'data-block-idx': idx }, highlightText(block.text, idx))
        }

        if (!result || result.error) {
          return h(
            'div',
            { ref: setScrollport, className: 'dml-reader dml-reader-status', role: 'status' },
            h(
              'p',
              null,
              result?.error
                ? result.error + '。可在右上角切换原版式（如可用），或下载原文件。'
                : '正在极速解析文档…',
            ),
            result?.error &&
              typeof request?.reload === 'function' &&
              h('button', { type: 'button', className: 'dml-reader-btn', onClick: request.reload }, '重试'),
          )
        }

        const isSheet = ['xlsx', 'csv', 'tsv', 'ods'].includes(result.format)
        const remaining = result.blocks.length - limit
        const fileName = parseSessionFile(resourceAddress)?.path?.split('/').pop() || '文档'
        const canWrite = !globalThis.__DSH_MOBILE_SHELL__?.readOnly
        return h(
          'article',
          {
            ref: setScrollport,
            className: 'dml-reader',
            'aria-label': '原文阅读',
            'data-format': result.format || '',
            style: { fontSize: fontSize + 'px' },
          },
          h('div', { className: 'dml-reader-bar' },
            h('div', { className: 'dml-reader-progress', style: { width: progress + '%' } }),
            toc.length >= 2 && h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              'data-active': tocOpen ? 'true' : undefined,
              onClick: () => setTocOpen(v => !v),
            }, `目录 (${toc.length})`),
            h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              'data-active': searchOpen ? 'true' : undefined,
              onClick: () => setSearchOpen(v => { if (v) { setQuery(''); setMatchIdx(0); } return !v }),
            }, '搜索'),
            h('button', { type: 'button', className: 'dml-reader-chip', 'aria-label': '缩小字号', onClick: () => stepFont(-1) }, 'A-'),
            h('button', { type: 'button', className: 'dml-reader-chip', 'aria-label': '放大字号', onClick: () => stepFont(1) }, 'A+'),
            h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              onClick: async () => {
                const text = result.blocks.map(blockPlainText).filter(Boolean).join('\n\n')
                if (await copyMobileText(text)) {
                  globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已复制文档全文')
                  try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'haptic', style: 'light' }) } catch {}
                }
              },
            }, '复制'),
            canWrite && h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              onClick: () => {
                const focusIdx = activeBlockIdx >= 0 ? activeBlockIdx : 0
                const excerpt = (activeBlockIdx >= 0
                  ? blockPlainText(result.blocks[focusIdx])
                  : result.blocks.slice(0, 6).map(blockPlainText).filter(Boolean).join('\n')
                ).slice(0, 520)
                if (excerpt && globalThis.__DSH_MOBILE_BRIDGE__?.insertDraft?.(`【参考 ${fileName}】\n${excerpt}`)) {
                  globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已引用到对话输入框')
                  try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'haptic', style: 'light' }) } catch {}
                }
              },
            }, '引用'),
          ),
          searchOpen && h('div', { className: 'dml-reader-search' },
            h('input', {
              ref: searchInputRef,
              type: 'search',
              value: query,
              placeholder: '在文档中查找内容…',
              onChange: (e) => { setQuery(e.target.value); setMatchIdx(0) },
            }),
            qLower && h('span', { className: 'dml-reader-count' }, matches.length ? `${safeMatchIdx + 1}/${matches.length}` : '0/0'),
            h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              disabled: !matches.length,
              onClick: () => setMatchIdx(i => (i - 1 + matches.length) % matches.length),
            }, '↑'),
            h('button', {
              type: 'button',
              className: 'dml-reader-chip',
              disabled: !matches.length,
              onClick: () => setMatchIdx(i => (i + 1) % matches.length),
            }, '↓'),
          ),
          tocOpen && toc.length >= 2 && h('nav', { className: 'dml-reader-toc', 'aria-label': '文档目录' },
            ...toc.map((item) => h('button', {
              key: item.idx,
              type: 'button',
              className: 'dml-reader-toc-item',
              'data-level': item.kind,
              onClick: () => jumpToBlock(item.idx),
            }, item.text)),
          ),
          h(
            'small',
            { className: 'dml-reader-note' },
            isSheet
              ? '表格极速阅读 · 支持左右滑动查看完整列；切换原版式可看原始样式'
              : '原文极速阅读 · 已优化中文与数学符号编码；看图片与分页请切换原版式',
          ),
          ...result.blocks.slice(0, limit).map(renderBlock),
          remaining > 0 &&
            h(
              'div',
              { ref: sentinelRef, className: 'dml-reader-more' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dml-reader-btn',
                  onClick: () => setLimit((cur) => Math.min(result.blocks.length, cur + 120)),
                },
                '继续加载更多（剩余 ' + remaining + ' 段）',
              ),
            ),
          result.truncated &&
            h(
              'small',
              { className: 'dml-reader-note dml-reader-trunc' },
              '文档较长，已优先展示前部正文；查看完整内容请切换原版式或下载原文件。',
            ),
        )
      }

      ctx.effect(() =>
        ctx.documentPreviews.register({
          id,
          extensions: exts,
          binaryExtensions: binaryExts,
          title: () => '原文阅读',
          loading: 'renderer',
          wrap: false,
        }),
      )
      ctx.slots.inject('sidebar.right.tab.document', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document', key: id }, Reader),
      )
    }

    function installFileExport(ctx) {
      function FileExport({ absolutePath, sessionId, emptyState }) {
        const [busy, setBusy] = React.useState(false)
        const active = React.useRef(null)
        React.useEffect(() => {
          setBusy(false)
          return () => { active.current?.abort(); active.current = null }
        }, [absolutePath, sessionId])
        async function save() {
          if (active.current) return
          const control = new AbortController(); active.current = control; setBusy(true)
          try {
            const remote = ctx.get?.('remote') ?? ctx.remote
            const id = sessionId || readCurrentSession(ctx)?.sessionId
            if (!id || !remote?.workspaceFiles?.readBytes) throw Error(t('请先打开文件所在的会话'))
            const chunks = []; let offset = 0, version
            for (;;) {
              const result = await remote.workspaceFiles.readBytes(id, absolutePath, {range:{offset}}, control.signal)
              control.signal.throwIfAborted()
              if (!result.ok) throw Error(result.error?.message || t('无法下载文件'))
              const part = result.value
              if (part.offset !== offset || (offset && part.version !== version)) throw Error(t('文件已更改，请重试'))
              if (!(part.data instanceof Uint8Array) || (!part.data.length && !part.eof)) throw Error(t('文件读取不完整'))
              version = part.version; chunks.push(part.data); offset += part.data.length
              if (part.eof) { if (part.bytes != null && part.bytes !== offset) throw Error(t('文件读取不完整')); break }
            }
            const blob=new Blob(chunks,{type:'application/octet-stream'});
            if(globalThis.__dmlSave){if(!globalThis.__dmlSave.start(blob,absolutePath.split(/[\\/]/).pop()||'download'))throw Error('已有保存任务，或文件超过 128 MiB');return}
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a'); a.href = url; a.download = absolutePath.split(/[\\/]/).pop() || 'download'
            document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000)
          } catch (error) { if (!control.signal.aborted) globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.(error.message || t('无法下载文件')) }
          finally { if (active.current === control) { active.current = null; setBusy(false) } }
        }
        return h('button', {type:'button', disabled:busy, title:t('下载原文件'), 'aria-label':t('下载原文件'), onClick:save}, busy ? '…' : emptyState ? t('下载原文件') : '↓')
      }
      for (const name of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable']) {
        ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'mobile-original', order: -200,
          inject: sessionId => ({sessionId, emptyState: name.endsWith('.unpreviewable')}) }, FileExport))
      }
    }

    function installMobileHub(ctx) {
      if (typeof React?.createElement !== 'function' || typeof ctx.slots?.register !== 'function') return
      const sessionTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

      const BUILTIN_SNIPPETS = [
        { id: 'b-summary', title: '总结进展', text: '请简要总结目前完成的改动、验证结果和剩余待办。' },
        { id: 'b-debug', title: '排查修复', text: '请定位当前报错或异常的根本原因，给出最小修复并运行验证。' },
        { id: 'b-tests', title: '补充测试', text: '请为上述改动编写覆盖关键边界条件的单元测试并运行验证。' },
        { id: 'b-review', title: '代码审查', text: '请审查当前工作区的 Git 变更，检查潜在 Bug、性能及边界问题。' },
        { id: 'b-continue', title: '继续推进', text: '继续执行后续步骤直到全部完成并验证通过。' },
        { id: 'b-explain', title: '原理解析', text: '请解释这部分代码的工作流程与关键状态流转（暂不修改文件）。' },
      ]

      function readCustomSnippets() {
        try {
          const parsed = JSON.parse(globalThis.localStorage?.getItem('dml.snippets.v1') || '[]')
          return Array.isArray(parsed) ? parsed.filter(x => x && typeof x.title === 'string' && typeof x.text === 'string') : []
        } catch {
          return []
        }
      }
      function writeCustomSnippets(items) {
        try { globalThis.localStorage?.setItem('dml.snippets.v1', JSON.stringify(items)) } catch {}
      }
      function readPref(key, fallback) {
        try {
          const v = globalThis.localStorage?.getItem(key)
          return v === null || v === undefined ? fallback : v
        } catch {
          return fallback
        }
      }
      function writePref(key, value) {
        try { globalThis.localStorage?.setItem(key, String(value)) } catch {}
        globalThis.__DSH_MOBILE_BRIDGE__?.applyDisplayPrefs?.()
      }
      function formatBytes(n) {
        if (!Number.isFinite(n) || n <= 0) return '0 B'
        const gb = n / (1024 * 1024 * 1024)
        if (gb >= 1) return gb.toFixed(1) + ' GB'
        return Math.round(n / (1024 * 1024)) + ' MB'
      }
      function formatDuration(sec) {
        sec = Math.max(0, Math.floor(sec || 0))
        const d = Math.floor(sec / 86400)
        const h2 = Math.floor((sec % 86400) / 3600)
        const m = Math.floor((sec % 3600) / 60)
        if (d > 0) return `${d}天 ${h2}小时`
        if (h2 > 0) return `${h2}小时 ${m}分`
        return `${m}分钟`
      }

      const HubIcon = () => h('svg', { width: 17, height: 17, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 2.5, width: 5, height: 5, rx: 1.3 }),
        h('rect', { x: 10.5, y: 2.5, width: 5, height: 5, rx: 1.3 }),
        h('rect', { x: 2.5, y: 10.5, width: 5, height: 5, rx: 1.3 }),
        h('rect', { x: 10.5, y: 10.5, width: 5, height: 5, rx: 1.3 }))

      function MobileHubTrigger(props) {
        const variant = props?.variant === 'floating' ? 'floating' : 'header'
        const snap = React.useSyncExternalStore(subscribeHub, getHubSnapshot)
        React.useEffect(() => {
          if (variant !== 'header') return undefined
          setHubState({ headerCount: (hubState.headerCount || 0) + 1 })
          return () => {
            setHubState({ headerCount: Math.max(0, (hubState.headerCount || 0) - 1) })
          }
        }, [variant])
        const list = (globalThis.__DSH_MOBILE_CORDIS__?.listSessions?.() ?? []).filter(s => !s.archived)
        const pendingCount = list.filter(s => s.pendingInteraction).length
        const runningCount = list.filter(s => s.running).length
        const badge = pendingCount > 0 ? 'approval' : runningCount > 0 ? 'running' : undefined
        return h('button', {
          type: 'button',
          'data-dml-hub-trigger': variant,
          className: variant === 'floating' ? 'dml-hub-trigger dml-hub-trigger-floating' : 'dml-hub-trigger',
          title: '移动端工具箱',
          'aria-label': '移动端工具箱',
          'aria-expanded': snap.open,
          'data-badge': badge,
          onClick: () => {
            try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'haptic', style: 'light' }) } catch {}
            setHubState({ open: !snap.open })
          },
        }, h(HubIcon), badge ? h('span', { className: 'dml-hub-dot', 'data-kind': badge }) : null)
      }

      function MobileHubOverlay() {
        const snap = React.useSyncExternalStore(subscribeHub, getHubSnapshot)
        const [sessionFilter, setSessionFilter] = React.useState('')
        const [taskLimits, setTaskLimits] = React.useState({})
        const [archivedView, setArchivedView] = React.useState(false)
        const [selection, setSelection] = React.useState(null)
        const [archiveBusy, setArchiveBusy] = React.useState(false)
        const [archiveNotice, setArchiveNotice] = React.useState('')
        const [snippets, setSnippets] = React.useState(readCustomSnippets)
        const [addingSnippet, setAddingSnippet] = React.useState(false)
        const [newTitle, setNewTitle] = React.useState('')
        const [newText, setNewText] = React.useState('')
        const [gitState, setGitState] = React.useState({ loading: false, error: '', files: [], selected: null, diff: '', diffLoading: false })
        const [hostInfo, setHostInfo] = React.useState({ loading: false, error: '', data: null })
        const [pingStats, setPingStats] = React.useState({ running: false, samples: [], error: '' })
        const [fontScale, setFontScale] = React.useState(() => readPref('dml.pref.fontScale', '100'))
        const [codeWrap, setCodeWrap] = React.useState(() => readPref('dml.pref.codeWrap', 'false') === 'true')
        const [amoledMode, setAmoledMode] = React.useState(() => readPref('dml.pref.amoled', 'false') === 'true')
        const [taskAlerts, setTaskAlerts] = React.useState(() => readPref('dml.pref.taskAlerts', 'true') !== 'false')
        const [dismissedDraftFor, setDismissedDraftFor] = React.useState('')
        const [showFloating, setShowFloating] = React.useState(true)
        const openSwipeRow = React.useRef(null)
        const dragStartY = React.useRef(null)
        const rightFrameRef = React.useRef(null)
        const hubDialogRef = React.useRef(null)
        const hubBodyRef = React.useRef(null)
        const taskScroll = React.useRef(0)
        const archiveInFlight = React.useRef(false)

        const bridge = globalThis.__DSH_MOBILE_CORDIS__
        const sessions = bridge?.listSessions?.() ?? []
        const curSessionId = bridge?.getCurrentSessionId?.() ?? null
        const curSession = sessions.find(s => s.isCurrent) || null
        const otherPending = sessions.find(s => s.pendingInteraction && !s.isCurrent && !s.archived) || null
        const savedDraft = !snap.open && curSessionId && dismissedDraftFor !== curSessionId ? readDraftStorage(curSessionId) : null
        const canWrite = !globalThis.__DSH_MOBILE_SHELL__?.readOnly
        const toggleSelected = (id) => setSelection(previous => {
          const next = new Set(previous)
          if (!next.delete(id)) next.add(id)
          return next
        })
        const changeArchived = async (ids) => {
          if (!canWrite || archiveInFlight.current || !ids.length) return
          archiveInFlight.current = true
          setArchiveBusy(true)
          setArchiveNotice('')
          const label = archivedView ? '恢复' : '归档'
          try {
            const { changed, failed } = await bridge.setSessionsArchived(ids, !archivedView)
            setSelection(previous => previous && new Set([...previous].filter(id => !changed.includes(id))))
            setArchiveNotice(`已${label} ${changed.length} 个会话${failed.length ? `；${failed.length} 个未能${label}（会话可能已变化或无权限）` : ''}`)
          } catch (error) {
            setArchiveNotice(error?.message || `${label}失败`)
          } finally {
            archiveInFlight.current = false
            setArchiveBusy(false)
          }
        }
        const openListedSession = (id) => {
          if (!bridge?.openSession?.(id)) return
          taskScroll.current = hubBodyRef.current?.scrollTop ?? 0
          if (document.querySelector('[data-sidebar-drawer]:not([data-sidebar-collapsed])')) bridge.toggleSidebar?.()
          setHubState({ open: false })
        }
        const editorEmpty = (() => {
          try {
            return !(document.querySelector?.('[data-composer-card] [contenteditable="true"]')?.textContent || '').trim()
          } catch {
            return true
          }
        })()

        const loadGit = React.useCallback(async () => {
          if (!curSessionId) {
            setGitState({ loading: false, error: '当前没有激活的会话，打开含本地仓库的会话后可查看 Git 变更。', files: [], selected: null, diff: '', diffLoading: false })
            return
          }
          setGitState(prev => ({ ...prev, loading: true, error: '' }))
          try {
            const files = await rpcMobile('mobileGit/status', { sessionId: curSessionId })
            setGitState({ loading: false, error: '', files: Array.isArray(files) ? files : [], selected: null, diff: '', diffLoading: false })
          } catch (e) {
            setGitState({ loading: false, error: e?.message || '无法读取工作区 Git 状态', files: [], selected: null, diff: '', diffLoading: false })
          }
        }, [curSessionId])

        const loadDiff = React.useCallback(async (file) => {
          if (!curSessionId || !file?.path) return
          setGitState(prev => ({ ...prev, selected: file, diff: '', diffLoading: true, error: '' }))
          try {
            let text = await rpcMobile('mobileGit/diff', { sessionId: curSessionId, path: file.path, staged: false })
            if (!text && file.index && file.index !== '?' && file.index !== ' ') {
              text = await rpcMobile('mobileGit/diff', { sessionId: curSessionId, path: file.path, staged: true })
            }
            setGitState(prev => prev.selected?.path === file.path ? { ...prev, diffLoading: false, diff: text || '（无文本差异，可能为未跟踪或二进制文件）' } : prev)
          } catch (e) {
            setGitState(prev => prev.selected?.path === file.path ? { ...prev, diffLoading: false, diff: '', error: e?.message || '读取 Diff 失败' } : prev)
          }
        }, [curSessionId])

        const loadHostStatus = React.useCallback(async () => {
          setHostInfo(prev => ({ ...prev, loading: true, error: '' }))
          try {
            const data = await rpcMobile('mobileHost/status', {})
            setHostInfo({ loading: false, error: '', data })
          } catch (e) {
            setHostInfo({ loading: false, error: e?.message || '无法获取电脑状态', data: null })
          }
        }, [])

        const runPingBenchmark = React.useCallback(async () => {
          setPingStats({ running: true, samples: [], error: '' })
          const samples = []
          let wsAlive = null
          try {
            for (let i = 0; i < 3; i++) {
              const t0 = typeof performance?.now === 'function' ? performance.now() : Date.now()
              const res = await fetch('/mobile/v1/ping', { credentials: 'same-origin', cache: 'no-store' })
              if (!res.ok) throw Error('HTTP ' + res.status)
              const body = await res.json()
              wsAlive = body?.wsAlive
              const dt = Math.max(1, Math.round((typeof performance?.now === 'function' ? performance.now() : Date.now()) - t0))
              samples.push(dt)
            }
            setPingStats({ running: false, samples, wsAlive, error: '' })
          } catch (e) {
            setPingStats({ running: false, samples, wsAlive, error: e?.message || '测速失败' })
          }
        }, [])

        const dismissSheet = React.useCallback(() => setHubState({ open: false }), [])
        React.useLayoutEffect(() => {
          if (!snap.open) return undefined
          const dialog = hubDialogRef.current
          if (!dialog) return undefined
          if (!dialog.open) dialog.showModal()
          const closeOnEscape = (e) => {
            if (!dialog.open || e.key !== 'Escape' || e.isComposing) return
            e.preventDefault()
            e.stopImmediatePropagation()
            dismissSheet()
          }
          window.addEventListener('keydown', closeOnEscape, true)
          return () => {
            window.removeEventListener('keydown', closeOnEscape, true)
            if (dialog.open) dialog.close()
          }
        }, [snap.open, dismissSheet])

        React.useLayoutEffect(() => {
          if (!snap.open || !hubBodyRef.current) return
          hubBodyRef.current.scrollTop = snap.tab === 'tasks' ? taskScroll.current : 0
        }, [snap.open, snap.tab, archivedView])

        React.useEffect(() => {
          if (!snap.open) return
          if (snap.tab === 'git') loadGit()
          if (snap.tab === 'tools') loadHostStatus()
        }, [snap.open, snap.tab, curSessionId, loadGit, loadHostStatus])

        // Observe ONLY drawer/rightbar attribute flips (subtree: false) — ZERO document.body subtree
        // observation so Lexical typing and streaming chat never trigger synchronous reflows!
        React.useEffect(() => {
          if (typeof document === 'undefined' || !document.body) return undefined
          let raf = 0
          let retryTimer = 0
          const observed = new Set()
          const mo = typeof MutationObserver === 'function' ? new MutationObserver(() => sched()) : null
          const bindFrames = () => {
            const drawer = document.querySelector('[data-sidebar-drawer]')
            const rightEl = document.querySelector('[data-rightbar-collapsed], [data-rightbar-fullscreen]') || rightFrameRef.current
            if (rightEl) rightFrameRef.current = rightEl
            for (const target of [drawer, drawer?.parentElement, rightEl]) {
              if (target && mo && !observed.has(target)) {
                observed.add(target)
                mo.observe(target, {
                  attributes: true,
                  subtree: false,
                  attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
                })
              }
            }
          }
          const check = () => {
            raf = 0
            bindFrames()
            const drawerOpen = !!document.querySelector('[data-sidebar-drawer]:not([data-sidebar-collapsed])')
            const rf = rightFrameRef.current
            const rightOpen = !!(rf && rf.isConnected && !rf.hasAttribute('data-rightbar-collapsed') && document.querySelector('[data-sidebar-right-toggle]'))
            const headerMounted = (snap.headerCount || 0) > 0
            const next = !snap.open && !drawerOpen && !rightOpen && !headerMounted
            setShowFloating(prev => prev === next ? prev : next)
          }
          const sched = () => { if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(check) }
          check()
          if (!observed.size) retryTimer = setTimeout(check, 450)
          window.addEventListener?.('resize', sched, { passive: true })
          return () => {
            if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
            if (retryTimer) clearTimeout(retryTimer)
            mo?.disconnect()
            window.removeEventListener?.('resize', sched)
          }
        }, [snap.open, snap.headerCount, curSessionId])

        if (!snap.open) {
          return h(React.Fragment, null,
            showFloating && h(MobileHubTrigger, { variant: 'floating' }),
            h('div', { className: 'dml-floating-pills' },
            otherPending && h('button', {
              type: 'button',
              className: 'dml-approval-pill',
              onClick: () => {
                try { globalThis.webkit?.messageHandlers?.dshMobile?.postMessage({ type: 'haptic', style: 'medium' }) } catch {}
                bridge?.openSession?.(otherPending.sessionId)
              },
            }, '⚠ 后台任务待确认：' + otherPending.title + '（轻点处理）'),
            canWrite && savedDraft && editorEmpty && h('div', { className: 'dml-draft-pill' },
              h('button', {
                type: 'button',
                className: 'dml-draft-restore',
                onClick: () => {
                  if (bridge?.insertDraft?.(savedDraft, { replace: true })) {
                    clearDraftStorage(curSessionId)
                    setDismissedDraftFor(curSessionId)
                    globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已恢复上次未发送草稿')
                  }
                },
              }, '恢复未发送草稿（' + savedDraft.trim().slice(0, 14) + (savedDraft.trim().length > 14 ? '…' : '') + '）'),
              h('button', {
                type: 'button',
                className: 'dml-draft-close',
                'aria-label': '关闭草稿提示',
                onClick: () => { clearDraftStorage(curSessionId); setDismissedDraftFor(curSessionId) },
              }, '×'),
            ),
          ))
        }

        const tabs = [
          ['tasks', '任务'],
          ['snippets', '指令'],
          ['git', 'Git'],
          ['tools', '工具'],
        ]

        let tabBody = null
        if (snap.tab === 'tasks') {
          const candidates = sessions.filter(s => !!s.archived === archivedView)
          const groups = globalThis.__DSH_MOBILE_BRIDGE__?.groupMobileTasks?.(candidates, sessionFilter) || { history: candidates }
          const selectable = Object.values(groups).flat().filter(s => archivedView || !(s.running || s.pendingInteraction))
          const selectedIds = selectable.filter(s => selection?.has(s.id)).map(s => s.id)
          const taskSections = [['approval', '待确认'], ['running', '运行中'], ['history', archivedView ? '已归档' : '历史会话']].flatMap(([key, label]) => {
            const rows = groups[key] || []
            if (!rows.length) return []
            const limit = taskLimits[key] ?? (key === 'history' ? 24 : 12)
            return [h('section', { key, className: 'dml-hub-task-group', 'aria-labelledby': 'dml-hub-tasks-' + key },
              h('h3', { className: 'dml-hub-task-heading', id: 'dml-hub-tasks-' + key }, label, h('span', null, rows.length)),
              h('div', { className: 'dml-hub-list' },
                ...rows.slice(0, limit).map(s => {
                  const enabled = canWrite && (archivedView || !(s.running || s.pendingInteraction))
                  const date = Number.isFinite(s.updatedAt) && s.updatedAt > 0 ? new Date(s.updatedAt) : null
                  const hasDate = date && Number.isFinite(date.getTime())
                  const swipe = enabled && selection === null
                  return h('div', {
                    key: s.id, className: 'dml-session-row', 'data-swipe': swipe || undefined,
                    onScroll: swipe ? e => {
                      const row = e.currentTarget
                      row.style.setProperty('--dml-action-reveal', Math.min(72, Math.max(0, row.scrollLeft)) + 'px')
                      if (row.scrollLeft < 1 || openSwipeRow.current === row) return
                      const previous = openSwipeRow.current
                      openSwipeRow.current = row
                      if (previous?.isConnected) previous.scrollLeft = 0
                    } : undefined,
                    onKeyDown: swipe ? e => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                      e.preventDefault()
                      e.currentTarget.scrollLeft = e.key === 'ArrowLeft' ? e.currentTarget.scrollWidth : 0
                    } : undefined,
                  },
                    h('button', {
                      type: 'button', className: 'dml-hub-item',
                      'data-current': s.isCurrent ? 'true' : undefined,
                      'aria-current': s.isCurrent ? 'true' : undefined,
                      'aria-label': '进入会话：' + s.title,
                      onClick: e => {
                        const row = e.currentTarget.parentElement
                        if (swipe && row.scrollLeft > 1) row.scrollLeft = 0
                        else openListedSession(s.id)
                      },
                    },
                    h('div', { className: 'dml-hub-item-main' },
                      h('span', { className: 'dml-hub-item-title' }, s.title),
                      s.workspaceName && h('span', { className: 'dml-hub-tag' }, s.workspaceName),
                      hasDate && h('time', { className: 'dml-hub-tag', dateTime: date.toISOString() }, '更新于 ' + sessionTime.format(date)),
                    ),
                    s.isCurrent && h('span', { className: 'dml-hub-badge', 'data-kind': 'current' }, '当前'),
                    h('span', { 'aria-hidden': 'true' }, '›')),
                    canWrite && (selection !== null
                      ? h('label', { className: 'dml-session-check' }, h('input', {
                        type: 'checkbox', 'aria-label': '选择会话：' + s.title,
                        checked: selection.has(s.id), disabled: !enabled || archiveBusy,
                        onChange: () => toggleSelected(s.id),
                      }))
                      : swipe && h('button', {
                        type: 'button', className: 'dml-swipe-action', disabled: archiveBusy,
                        'aria-label': (archivedView ? '恢复会话：' : '归档会话：') + s.title,
                        onClick: () => changeArchived([s.id]),
                      }, archivedView ? '恢复' : '归档')),
                  )
                })),
              rows.length > limit && h('button', {
                type: 'button', className: 'dml-hub-pill-btn dml-hub-more',
                onClick: () => setTaskLimits(previous => ({ ...previous, [key]: limit + 24 })),
              }, '显示更多' + label + '（' + (rows.length - limit) + '）'),
            )]
          })
          tabBody = h('div', { className: 'dml-hub-section' },
            h('div', { className: 'dml-hub-actions' },
              canWrite && h('button', {
                type: 'button', className: 'dml-hub-pill-btn',
                onClick: () => { bridge?.newSession?.(); setHubState({ open: false }) },
              }, '+ 新会话'),
              h('button', {
                type: 'button', className: 'dml-hub-pill-btn',
                onClick: () => { setHubState({ open: false }); bridge?.toggleRightPanel?.() },
              }, '文件栏'),
              h('button', {
                type: 'button', className: 'dml-hub-pill-btn',
                onClick: () => { globalThis.__DSH_MOBILE_BRIDGE__?.wakeCheck?.(); setHubState({ open: false }); globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已触发重连校验') },
              }, '↻ 重连'),
              h('button', {
                type: 'button', className: 'dml-hub-pill-btn',
                onClick: () => { setHubState({ open: false }); globalThis.__DSH_MOBILE_BRIDGE__?.scrollToTop?.() },
              }, '↑ 顶部'),
            ),
            h('input', {
              type: 'search',
              className: 'dml-hub-input',
              value: sessionFilter,
              'aria-label': '搜索会话标题或工作区',
              placeholder: '搜索会话标题或工作区…',
              onChange: (e) => { setSessionFilter(e.target.value); setTaskLimits({}); setSelection(previous => previous === null ? null : new Set()) },
            }),
            h('div', { className: 'dml-hub-actions', 'aria-label': '会话管理操作' },
              h('button', { type: 'button', className: 'dml-hub-pill-btn', disabled: archiveBusy,
                onClick: () => { taskScroll.current = 0; setArchivedView(!archivedView); setSelection(null); setArchiveNotice(''); setTaskLimits({}) },
              }, archivedView ? '返回未归档' : '查看已归档'),
              canWrite && h('button', { type: 'button', className: 'dml-hub-pill-btn', disabled: archiveBusy,
                onClick: () => { setSelection(selection === null ? new Set() : null); setArchiveNotice('') },
              }, selection !== null ? '取消多选' : '多选'),
              canWrite && selection !== null && h('button', { type: 'button', className: 'dml-hub-pill-btn', disabled: archiveBusy || !selectable.length,
                onClick: () => setSelection(new Set(selectedIds.length === selectable.length ? [] : selectable.map(s => s.id))),
              }, selectable.length > 0 && selectedIds.length === selectable.length ? '取消全选' : '全选筛选结果'),
              canWrite && selection !== null && h('button', { type: 'button', className: 'dml-hub-pill-btn', disabled: archiveBusy || !selectedIds.length,
                onClick: () => changeArchived(selectedIds),
              }, `${archivedView ? '恢复' : '归档'}所选 (${selectedIds.length})`),
            ),
            archiveNotice && h('div', { className: 'dml-hub-hint', role: 'status' }, archiveNotice),
            ...(taskSections.length ? taskSections : [h('div', { key: 'empty', className: 'dml-hub-empty' }, '暂无匹配的会话')]),
          )
        } else if (snap.tab === 'snippets') {
          const allSnippets = [...snippets, ...BUILTIN_SNIPPETS]
          tabBody = h('div', { className: 'dml-hub-section' },
            h('div', { className: 'dml-hub-row-head' },
              h('span', { className: 'dml-hub-hint' }, canWrite ? '轻点直接插入对话输入框' : '只读模式：轻点复制到剪贴板'),
              h('button', {
                type: 'button', className: 'dml-hub-pill-btn',
                onClick: () => setAddingSnippet(v => !v),
              }, addingSnippet ? '收起' : '+ 新建模板'),
            ),
            addingSnippet && h('div', { className: 'dml-hub-card dml-hub-form' },
              h('input', {
                type: 'text', className: 'dml-hub-input', placeholder: '模板名称（如：解释这段报错）',
                value: newTitle, onChange: (e) => setNewTitle(e.target.value),
              }),
              h('textarea', {
                className: 'dml-hub-textarea', rows: 3, placeholder: '模板内容…',
                value: newText, onChange: (e) => setNewText(e.target.value),
              }),
              h('button', {
                type: 'button', className: 'dml-hub-primary-btn',
                disabled: !newTitle.trim() || !newText.trim(),
                onClick: () => {
                  const next = [{ id: 'c-' + Date.now(), title: newTitle.trim(), text: newText.trim(), custom: true }, ...snippets]
                  setSnippets(next)
                  writeCustomSnippets(next)
                  setNewTitle(''); setNewText(''); setAddingSnippet(false)
                },
              }, '保存模板'),
            ),
            h('div', { className: 'dml-hub-list' },
              ...allSnippets.map(item => h('div', { key: item.id, className: 'dml-hub-snippet-row' },
                h('button', {
                  type: 'button',
                  className: 'dml-hub-snippet-btn',
                  onClick: async () => {
                    if (canWrite && bridge?.insertDraft?.(item.text)) {
                      setHubState({ open: false })
                      globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已插入：「' + item.title + '」')
                    } else if (await copyMobileText(item.text)) {
                      setHubState({ open: false })
                      globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已复制：「' + item.title + '」')
                    }
                  },
                },
                h('div', { className: 'dml-hub-item-title' }, item.title),
                h('div', { className: 'dml-hub-item-sub' }, item.text)),
                item.custom && h('button', {
                  type: 'button',
                  className: 'dml-hub-del',
                  'aria-label': '删除模板',
                  onClick: () => {
                    const next = snippets.filter(s => s.id !== item.id)
                    setSnippets(next)
                    writeCustomSnippets(next)
                  },
                }, '删'),
              )),
            ),
          )
        } else if (snap.tab === 'git') {
          tabBody = h('div', { className: 'dml-hub-section' },
            h('div', { className: 'dml-hub-row-head' },
              h('span', { className: 'dml-hub-hint' }, curSession?.workspaceName ? '工作区：' + curSession.workspaceName : '当前会话工作区'),
              h('button', { type: 'button', className: 'dml-hub-pill-btn', onClick: loadGit }, '刷新'),
            ),
            gitState.loading && h('div', { className: 'dml-hub-empty' }, '正在读取 Git 变更…'),
            gitState.error && h('div', { className: 'dml-hub-empty' }, gitState.error),
            !gitState.loading && !gitState.error && !gitState.selected && (
              gitState.files.length === 0
                ? h('div', { className: 'dml-hub-empty' }, '工作区干净，暂无未提交改动')
                : h('div', { className: 'dml-hub-list' },
                    ...gitState.files.map((f, idx) => {
                      const code = (f.worktree && f.worktree !== ' ' ? f.worktree : f.index) || 'M'
                      return h('button', {
                        key: f.path + '-' + idx,
                        type: 'button',
                        className: 'dml-hub-item',
                        onClick: () => loadDiff(f),
                      },
                      h('span', { className: 'dml-git-code', 'data-code': code }, code),
                      h('span', { className: 'dml-hub-item-title dml-git-path' }, f.path))
                    }),
                  )
            ),
            gitState.selected && h('div', { className: 'dml-git-detail' },
              h('div', { className: 'dml-hub-row-head' },
                h('button', {
                  type: 'button', className: 'dml-hub-pill-btn',
                  onClick: () => setGitState(prev => ({ ...prev, selected: null, diff: '', error: '' })),
                }, '← 返回列表'),
                h('div', { className: 'dml-hub-actions' },
                  gitState.diff && h('button', {
                    type: 'button', className: 'dml-hub-pill-btn',
                    onClick: async () => {
                      if (await copyMobileText(gitState.diff)) globalThis.__DSH_MOBILE_BRIDGE__?.showToast?.('已复制 Diff')
                    },
                  }, '复制'),
                  canWrite && gitState.diff && h('button', {
                    type: 'button', className: 'dml-hub-pill-btn',
                    onClick: () => {
                      const snippet = '```diff\n' + gitState.diff.slice(0, 1800) + '\n```'
                      if (bridge?.insertDraft?.(`请分析 ${gitState.selected.path} 的以下变更：\n` + snippet)) {
                        setHubState({ open: false })
                      }
                    },
                  }, '引用到对话'),
                ),
              ),
              h('div', { className: 'dml-git-filename' }, gitState.selected.path),
              gitState.diffLoading
                ? h('div', { className: 'dml-hub-empty' }, '加载差异中…')
                : h('pre', { className: 'dml-git-diff' },
                    ...gitState.diff.split('\n').slice(0, 260).map((line, idx) => {
                      const kind = line.startsWith('@@') ? 'hunk'
                        : (line.startsWith('+') && !line.startsWith('+++')) ? 'add'
                        : (line.startsWith('-') && !line.startsWith('---')) ? 'del'
                        : undefined
                      return h('span', { key: idx, className: 'dml-diff-line', 'data-kind': kind }, line + '\n')
                    }),
                  ),
            ),
          )
        } else {
          const minPing = pingStats.samples.length ? Math.min(...pingStats.samples) : null
          const maxPing = pingStats.samples.length ? Math.max(...pingStats.samples) : null
          const avgPing = pingStats.samples.length ? Math.round(pingStats.samples.reduce((a, b) => a + b, 0) / pingStats.samples.length) : null
          const hd = hostInfo.data
          const memUsed = hd ? formatBytes((hd.memTotalBytes || 0) - (hd.memFreeBytes || 0)) : ''
          const memTotal = hd ? formatBytes(hd.memTotalBytes || 0) : ''
          tabBody = h('div', { className: 'dml-hub-section' },
            h('div', { className: 'dml-hub-card' },
              h('div', { className: 'dml-hub-card-title' }, '阅读与显示偏好'),
              h('div', { className: 'dml-hub-pref-row' },
                h('span', null, '对话字号'),
                h('div', { className: 'dml-hub-seg' },
                  ...['90', '100', '110', '120'].map(val => h('button', {
                    key: val, type: 'button', className: 'dml-hub-seg-btn',
                    'data-active': fontScale === val ? 'true' : undefined,
                    onClick: () => { setFontScale(val); writePref('dml.pref.fontScale', val) },
                  }, val + '%')),
                ),
              ),
              h('label', { className: 'dml-hub-toggle' },
                h('span', null, '代码块自动换行（减少左右滑动）'),
                h('input', {
                  type: 'checkbox',
                  checked: codeWrap,
                  onChange: (e) => { setCodeWrap(e.target.checked); writePref('dml.pref.codeWrap', e.target.checked ? 'true' : 'false') },
                }),
              ),
              h('label', { className: 'dml-hub-toggle' },
                h('span', null, 'AMOLED 纯黑模式（深色主题 OLED 省电）'),
                h('input', {
                  type: 'checkbox',
                  'data-dml-amoled-toggle': 'true',
                  checked: amoledMode,
                  onChange: (e) => { setAmoledMode(e.target.checked); writePref('dml.pref.amoled', e.target.checked ? 'true' : 'false') },
                }),
              ),
              h('label', { className: 'dml-hub-toggle' },
                h('span', null, '任务完成 / 待审批震动提醒'),
                h('input', {
                  type: 'checkbox',
                  checked: taskAlerts,
                  onChange: (e) => { setTaskAlerts(e.target.checked); writePref('dml.pref.taskAlerts', e.target.checked ? 'true' : 'false') },
                }),
              ),
            ),
            h('div', { className: 'dml-hub-card' },
              h('div', { className: 'dml-hub-row-head' },
                h('span', { className: 'dml-hub-card-title' }, '连接测速与电脑状态'),
                h('button', {
                  type: 'button', className: 'dml-hub-pill-btn',
                  disabled: pingStats.running,
                  onClick: runPingBenchmark,
                }, pingStats.running ? '测速中…' : '立即测速'),
              ),
              avgPing !== null && h('div', { className: 'dml-hub-stat-grid' },
                h('div', null, '平均延迟：', avgPing, ' ms（', minPing, '–', maxPing, ' ms）'),
                h('div', null, '实时通道：', pingStats.wsAlive ? '在线 (WebSocket)' : '重连中'),
              ),
              pingStats.error && h('div', { className: 'dml-hub-empty' }, pingStats.error),
              hostInfo.loading && !hd && h('div', { className: 'dml-hub-empty' }, '正在读取电脑状态…'),
              hostInfo.error && h('div', { className: 'dml-hub-empty' }, hostInfo.error),
              hd && h('div', { className: 'dml-hub-stat-grid' },
                h('div', null, '电脑：', hd.hostname, '（', hd.platform, '/', hd.arch, '）'),
                h('div', null, 'CPU：', hd.cpuCount, ' 核 · 负载 ', (hd.loadAvg || []).join(' / ')),
                h('div', null, '内存：', memUsed, ' / ', memTotal),
                h('div', null, '运行：系统 ', formatDuration(hd.uptimeSec), ' · 活跃会话 ', hd.activeSessions ?? '-'),
              ),
            ),
          )
        }

        return h('dialog', {
          ref: hubDialogRef,
          className: 'dml-hub-backdrop',
          'aria-label': '移动端工具箱',
          onCancel: (e) => { e.preventDefault(); dismissSheet() },
          onClick: (e) => { if (e.target === e.currentTarget) dismissSheet() },
        },
        h('section', { className: 'dml-hub-sheet' },
          h('div', {
            className: 'dml-hub-head',
            onTouchStart: (e) => { if (e.touches?.length === 1) dragStartY.current = e.touches[0].clientY },
            onTouchEnd: (e) => {
              const startY = dragStartY.current
              dragStartY.current = null
              const endY = e.changedTouches?.[0]?.clientY
              if (startY != null && endY != null && endY - startY > 55) dismissSheet()
            },
          },
          h('div', { className: 'dml-hub-handle' }),
          h('div', { className: 'dml-hub-tabs', role: 'tablist' },
            ...tabs.map(([key, label]) => h('button', {
              key,
              type: 'button',
              role: 'tab',
              className: 'dml-hub-tab',
              'aria-selected': snap.tab === key ? 'true' : 'false',
              'data-active': snap.tab === key ? 'true' : undefined,
              onClick: () => {
                if (snap.tab === 'tasks') taskScroll.current = hubBodyRef.current?.scrollTop ?? 0
                setHubState({ tab: key })
              },
            }, label)),
            h('button', {
              type: 'button',
              className: 'dml-hub-close',
              'aria-label': '关闭工具箱',
              onClick: dismissSheet,
            }, '×'),
          )),
          h('div', { className: 'dml-hub-body', ref: hubBodyRef }, tabBody),
        ))
      }

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-mobile-hub-btn', order: -100, label: '移动端工具箱' }, MobileHubTrigger))
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'dsh-mobile-hub-overlay', order: 120, label: '移动端工具箱' }, MobileHubOverlay))

    }

    function apply(ctx) {
      installWorkspaceSessions(ctx)
      // Inside the paired phone's WebView, skip the desktop QR UI and wire Cordis services.
      if (globalThis.__DSH_MOBILE_SHELL__?.active) {
        ctx.inject(['documentPreviews'], installReader)
        ctx.inject(['remote.workspaceFiles'], scope => installFileExport(scope))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name:'conversation.composer.dock', id:'mobile-stats-fit' }, MobileStatsFit))
        ctx.inject(['conversation','inputTriggers'], mobileCommands)
        ctx.inject(['sessions','workspaces','uiWorkspace','connection'], mobileNavigation)
        applyMobileBridge(ctx)
        installMobileHub(ctx)
        return
      }
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dshMobileLink = ''
        style.textContent = css
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-mobile-link: panel styles')
      // Keep the footer dot current without opening the panel.
      ctx.effect(() => {
        // State-only desktop stream: no repeated QR generation, no 15 s polling lag.
        const stream = new EventSource(API + '/presence')
        stream.onmessage = e => { try { setOnline(JSON.parse(e.data).online === true) } catch {} }
        return () => stream.close()
      }, 'dsh-mobile-link: phone presence')
      applyDesktopFocusReporter(ctx)
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'dsh-mobile-link', order: 90, label: t('手机连接') },
        (props) => h(FooterButton, props)))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-mobile-link-panel', order: 110, label: t('手机连接') },
        () => h(OverlayEntry)))
    }

    module.exports.apply = apply
    module.exports.inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'connection', 'remote']
    return module.exports
  },
})
