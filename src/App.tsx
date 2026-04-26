import React, { useState, useEffect, useRef, useCallback } from 'react'
import LoginPage from './components/LoginPage'
import { useGatewayStore, useSessionStore, useLabelStore, useProjectStore, useHiddenStore, Session } from './store/gatewayStore'
import { useAuthStore } from './store/authStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import CostsPanel from './components/CostsPanel'
import MemoryPanel from './components/MemoryPanel'
import SettingsPanel from './components/SettingsPanel'
import MobileApp from './components/MobileApp'
import AuthGate from './components/AuthGate'
import SetupScreen from './components/SetupScreen'
import ProjectsGrid, { type Project } from './components/ProjectsGrid'
import ProjectView from './components/ProjectView'
import IssueReporter from './components/IssueReporter'
import { useHotkeys } from './hooks/useHotkeys'
import { useSessionPreloader } from './hooks/useSessionPreloader'

// Detect mobile: narrow viewport AND touch-capable device.
// Desktop browsers (no touch) never trigger mobile mode regardless of zoom/window width.
function useIsMobile(): boolean {
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const [mobile, setMobile] = useState(() => isTouchDevice && window.innerWidth < 1024)
  useEffect(() => {
    if (!isTouchDevice) return // desktop always stays in desktop mode
    const handler = () => setMobile(window.innerWidth < 1024)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [isTouchDevice])
  return mobile
}

const NAV_ALL = [
  { id: 'projects', label: '🐙 Projects' },
  { id: 'sessions', label: '💬 Sessions' },
  { id: 'costs', label: '💰 Costs', ownerOnly: true },
  { id: 'memory', label: '🧠 Memory', ownerOnly: true },
]

const API = (import.meta.env.VITE_API_URL as string) || ''

type GatewayConfig = { url?: string; token?: string; agentId?: string; role?: string; needsSetup?: boolean }

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'authed' | 'login'>('loading')
  const [preloadedConfig, setPreloadedConfig] = useState<GatewayConfig | null>(null)

  useEffect(() => {
    // Single fetch: gateway-config doubles as the auth check (returns 401 if not authed).
    // This eliminates the /api/auth/me → /api/gateway-config waterfall and cuts cold render time in half.
    // cache: 'no-store' bypasses the SW's NetworkFirst cache so we always get a fresh response.
    fetch(API + '/api/gateway-config', { credentials: 'include', cache: 'no-store' })
      .then(r => {
        if (r.status === 401 || r.status === 403) { setAuthState('login'); return null }
        if (!r.ok) { setAuthState('login'); return null }
        return r.json() as Promise<GatewayConfig>
      })
      .then(data => {
        if (!data) return
        setPreloadedConfig(data)
        setAuthState('authed')
      })
      .catch(() => setAuthState('login'))
  }, [])

  // Global 401 interceptor — any authFetch() that gets a 401 fires this event
  useEffect(() => {
    const handle = () => setAuthState('login')
    window.addEventListener('octis-unauthorized', handle)
    return () => window.removeEventListener('octis-unauthorized', handle)
  }, [])

  if (authState === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1117]">
        <div className="w-8 h-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (authState === 'login') return <LoginPage API={API} onLogin={() => setAuthState('authed')} />

  return <AuthenticatedApp preloadedConfig={preloadedConfig} />
}

function AuthenticatedApp({ preloadedConfig }: { preloadedConfig?: GatewayConfig | null }) {
  const getToken = async () => null
  const { connected, gatewayUrl, connect, setCredentials } = useGatewayStore()
  const { setAuth, fetchOwnedSessions } = useAuthStore()
  const { activePanes, pinToPane, sessions, setSessions, paneLayout, setPaneLayout } = useSessionStore()

  // Background preload: cache chat history for top 10 sessions on connect
  useSessionPreloader()
  const { labels, setLabel } = useLabelStore()
  const { hydrateFromServer: hydrateProjects } = useProjectStore()
  const { hydrateFromServer: hydrateHidden, hide: hideSession } = useHiddenStore()
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const [showStatusMenu, setShowStatusMenu] = useState(false)
  const [showHotkeys, setShowHotkeys] = useState(false)
  const statusMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showStatusMenu) return
    const handler = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showStatusMenu])
  const [activeNav, setActiveNav] = useState('projects')
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [archiveToast, setArchiveToast] = useState<string | null>(null)
  const archiveToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [renameRequestPanes, setRenameRequestPanes] = useState<number[]>([0, 0, 0])
  const isMobile = useIsMobile()
  // Track which pane the user last interacted with (for hotkey targets)
  const focusedPaneRef = useRef<number>(0)
  const [focusedPane, setFocusedPane] = useState(0)

  // Drag-and-drop state for pane reordering
  const dragSourceRef = useRef<number | null>(null)
  const [dragOverPane, setDragOverPane] = useState<number | null>(null)
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const paneContainerRef = useRef<HTMLDivElement | null>(null)

  const NAV = NAV_ALL.filter(n => !n.ownerOnly || userRole === 'owner')

  // Reconnect when app returns from background — desktop only.
  // MobileApp has its own visibilitychange handler; running both causes double-connect
  // (gateway sees rapid open/close → code=1006 disconnect).
  useEffect(() => {
    if (isMobile) return // MobileApp handles its own reconnect
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const { ws } = useGatewayStore.getState()
        // Reconnect if WS is dead OR stuck in CONNECTING state
        // (CONNECTING can get stuck after OS sleep + deploy restart cycle)
        const needsReconnect = !ws ||
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING ||
          ws.readyState === WebSocket.CONNECTING
        if (needsReconnect) {
          useGatewayStore.setState({ _reconnectAttempts: 0 })
          connect()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [connect, isMobile])

  // Fetch fresh gateway config from server on every sign-in.
  // If a preloadedConfig was already fetched during the auth check, use it directly.
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        // Use preloaded config if available (avoids a second round-trip on page load)
        const data = preloadedConfig ?? await fetch(`${API}/api/gateway-config`, {
          credentials: 'include',
        }).then(r => { if (!r.ok) throw new Error(`Config fetch failed: ${r.status}`); return r.json() }) as GatewayConfig
        setUserRole(data.role || null)
        setAuth(data.role || null, null)
        if (data.agentId) useAuthStore.getState().setMainAgentId(data.agentId)
        void fetchOwnedSessions()
        if (data.needsSetup) {
          setNeedsSetup(true)
          return
        }
        setCredentials(data.url!, data.token!, data.agentId)
        // Instantly populate sessions from localStorage cache (updated each time WS returns fresh list)
        try {
          const cacheKey = `octis-session-cache-${data.agentId || 'default'}`
          const cached = localStorage.getItem(cacheKey)
          if (cached) {
            const cachedSessions = JSON.parse(cached) as Array<{ key?: string; sessionKey?: string }>
            if (Array.isArray(cachedSessions) && cachedSessions.length > 0) {
              useSessionStore.getState().setSessions(cachedSessions)
            }
          }
        } catch {}
        connect()
        
        void hydrateProjects()
        void hydrateHidden()
        void useSessionStore.getState().hydrateHiddenFromServer()
      } catch (e) {
        console.error('[octis] Failed to fetch gateway config:', e)
        // Retry once after 3s before showing the connect modal.
        // Covers the case where the API server is mid-restart (race on app load).
        setTimeout(async () => {
          try {
            const r2 = await fetch(`${API}/api/gateway-config`, { credentials: 'include' })
            if (!r2.ok) { setShowConnect(true); return }
            const d2 = await r2.json() as { url?: string; token?: string; agentId?: string; role?: string; needsSetup?: boolean }
            setUserRole(d2.role || null)
            setAuth(d2.role || null, null)
            if (d2.agentId) useAuthStore.getState().setMainAgentId(d2.agentId)
            void fetchOwnedSessions()
            if (d2.needsSetup) { setNeedsSetup(true); return }
            setCredentials(d2.url!, d2.token!, d2.agentId)
            connect()
            void hydrateProjects()
            void hydrateHidden()
            void useSessionStore.getState().hydrateHiddenFromServer()
          } catch { setShowConnect(true) }
        }, 3000)
      }
    }
    void fetchConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-hydrate project tags + hidden sessions when user returns to tab — desktop only
  // (MobileApp calls hydrateAll on mount; running both causes redundant re-fetches)
  useEffect(() => {
    if (isMobile) return
    let hydrateTimer: ReturnType<typeof setTimeout> | null = null
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (hydrateTimer) clearTimeout(hydrateTimer)
        hydrateTimer = setTimeout(() => {
          void hydrateProjects()
          void hydrateHidden()
          void useSessionStore.getState().hydrateHiddenFromServer()
        }, 2000)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      if (hydrateTimer) clearTimeout(hydrateTimer)
    }
  }, [hydrateProjects, hydrateHidden])

  // Seed session labels from DB on mount
  useEffect(() => {
    void fetch(`${API}/api/session-labels`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (typeof data === 'object' && !('error' in data)) {
          // Set all keys from response (includes UUIDs, thread IDs, renamed keys)
          Object.entries(data).forEach(([key, label]) => {
            if (!labels[key]) setLabel(key, label)
          })
          sessions.forEach((s: Session) => {
            const gKey = s.key
            if (!gKey) return
            // Try UUID match
            const uuid = s.id || s.sessionId
            if (uuid && data[uuid] && !labels[gKey]) setLabel(gKey, data[uuid])
            // Try thread ID match (last segment of gateway key)
            const threadId = gKey.split(':').pop() || ''
            if (threadId && data[threadId] && !labels[gKey]) setLabel(gKey, data[threadId])
          })
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-seed when sessions load from gateway
  useEffect(() => {
    if (!sessions.length) return
    void fetch(`${API}/api/session-labels`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (typeof data === 'object' && !('error' in data)) {
          sessions.forEach((s: Session) => {
            const gKey = s.key
            if (!gKey) return
            const uuid = s.id || s.sessionId
            if (uuid && data[uuid] && !labels[gKey]) setLabel(gKey, data[uuid])
            const threadId = gKey.split(':').pop() || ''
            if (threadId && data[threadId] && !labels[gKey]) setLabel(gKey, data[threadId])
          })
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length])

  if (needsSetup) return (
    <SetupScreen
      getToken={getToken}
      onComplete={(role) => {
        setUserRole(role)
        setNeedsSetup(false)
      }}
    />
  )

  if (isMobile) return <MobileApp />

  const visiblePanes = activePanes.filter(Boolean)

  // ── Hotkeys ───────────────────────────────────────────────────────────────
  // N            → new session (bare key, ignores inputs)
  // E            → archive focused pane's session (bare key, ignores inputs)
  // Ctrl/Cmd+Z   → undo last archive (restore session + re-pin)
  // Ctrl/Cmd+Y   → redo (re-archive restored session)

  // Undo/redo stack for archive operations
  // Each entry: { session, paneIndex, extraKeys }
  const archiveUndoStack = useRef<Array<{ session: Session; paneIndex: number; extraKeys: string[] }>>([])
  const archiveRedoStack = useRef<Array<{ session: Session; paneIndex: number; extraKeys: string[] }>>([])

  const handleNewSessionHotkey = useCallback(() => {
    if (activeNav !== 'sessions') setActiveNav('sessions')
    const key = `session-${Date.now()}`
    setSessions([{ key, label: 'New session', sessionKey: key } as Session, ...sessions])
    const emptyPane = activePanes.findIndex((p) => !p)
    pinToPane(emptyPane >= 0 ? emptyPane : 0, key)
  }, [activeNav, sessions, activePanes, setSessions, pinToPane])

  const handleArchiveHotkey = useCallback(() => {
    const fi = focusedPaneRef.current
    const sessionKey = activePanes[fi] ?? activePanes.find(Boolean)
    if (!sessionKey) return
    const s = sessions.find((x: Session) => x.key === sessionKey)
    if (!s) return
    // Show archive toast
    const label = s.label || 'Unnamed session'
    setArchiveToast(label)
    if (archiveToastTimer.current) clearTimeout(archiveToastTimer.current)
    archiveToastTimer.current = setTimeout(() => setArchiveToast(null), 3000)
    // Record for undo
    const extraKeys: string[] = []
    if (s.id) extraKeys.push(s.id)
    if (s.sessionId) extraKeys.push(s.sessionId)
    archiveUndoStack.current.push({ session: s, paneIndex: fi, extraKeys })
    archiveRedoStack.current = [] // new action clears redo stack
    // Perform archive
    hideSession(sessionKey)
    extraKeys.forEach(k => hideSession(k))
    setSessions(sessions.filter((x: Session) => x.key !== sessionKey))
    activePanes.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
  }, [activePanes, sessions, hideSession, setSessions, pinToPane])

  const handleUndoArchive = useCallback(() => {
    const entry = archiveUndoStack.current.pop()
    if (!entry) return
    const { session: s, paneIndex, extraKeys } = entry
    archiveRedoStack.current.push(entry)
    // Unhide all keys
    useHiddenStore.getState().unhide(s.key)
    extraKeys.forEach(k => useHiddenStore.getState().unhide(k))
    // Restore to session list
    setSessions([s, ...useSessionStore.getState().sessions.filter((x: Session) => x.key !== s.key)])
    // Re-pin to original pane (or first empty)
    const { activePanes: ap } = useSessionStore.getState()
    const emptyPane = ap.findIndex((p: string | null) => !p)
    pinToPane(emptyPane >= 0 ? emptyPane : paneIndex, s.key)
  }, [setSessions, pinToPane])

  const handleRedoArchive = useCallback(() => {
    const entry = archiveRedoStack.current.pop()
    if (!entry) return
    const { session: s, paneIndex, extraKeys } = entry
    archiveUndoStack.current.push(entry)
    hideSession(s.key)
    extraKeys.forEach(k => hideSession(k))
    const current = useSessionStore.getState().sessions
    setSessions(current.filter((x: Session) => x.key !== s.key))
    useSessionStore.getState().activePanes.forEach((p: string | null, i: number) => {
      if (p === s.key) pinToPane(i, null)
    })
    void paneIndex // satisfy exhaustive-deps
  }, [hideSession, setSessions, pinToPane])

  const handleRenameHotkey = useCallback(() => {
    const fi = focusedPaneRef.current
    setRenameRequestPanes(prev => prev.map((v, i) => i === fi ? Date.now() : v))
  }, [])

  useHotkeys([
    { key: 'n', handler: handleNewSessionHotkey, ignoreInputs: true },
    { key: 'e', handler: handleArchiveHotkey, ignoreInputs: true },
    { key: 'r', handler: handleRenameHotkey, ignoreInputs: true },
    { key: 'z', cmdOrCtrl: true, handler: handleUndoArchive },
    { key: 'y', cmdOrCtrl: true, handler: handleRedoArchive },
    { key: '?', handler: () => setShowHotkeys(v => !v), ignoreInputs: true },
  ])
  // ─────────────────────────────────────────────────────────────────────────

  // Compact panes on close: null out the slot, remaining visible panes auto-derive from filter(Boolean)
  const handleClosePane = (i: number) => {
    const filled = activePanes.map((v, idx) => ({ v, idx })).filter(x => x.v)
    const target = filled[i]
    if (target) pinToPane(target.idx, null)
  }

  // Drag-and-drop handlers — pointer-event based for custom ghost
  const handlePaneDragStart = (i: number, e: React.PointerEvent, label: string) => {
    dragSourceRef.current = i
    setDragGhost({ x: e.clientX, y: e.clientY, label })
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const handlePanePointerMove = (e: React.PointerEvent) => {
    if (dragSourceRef.current === null) return
    setDragGhost(g => g ? { ...g, x: e.clientX, y: e.clientY } : null)
    // Determine drop target from element under cursor
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const paneEl = el?.closest('[data-pane-index]') as HTMLElement | null
    const idx = paneEl ? parseInt(paneEl.dataset.paneIndex!) : null
    setDragOverPane(idx !== null && !isNaN(idx) ? idx : null)
  }
  const handlePanePointerUp = () => {
    const src = dragSourceRef.current
    const dst = dragOverPane
    dragSourceRef.current = null
    setDragGhost(null)
    setDragOverPane(null)
    if (src === null || dst === null || src === dst) return
    // Swap the two pane slots
    const srcKey = activePanes[src]
    const dstKey = activePanes[dst]
    pinToPane(src, dstKey)
    pinToPane(dst, srcKey)
  }
  const handlePaneDragOver = (_i: number, e: React.DragEvent) => { e.preventDefault() }
  const handlePaneDrop = () => {}
  const handlePaneDragEnd = () => {}

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117]">
      {/* Left nav */}
      <div className="flex flex-col w-14 bg-[#181c24] border-r border-[#2a3142] items-center py-4 gap-2 shrink-0">
        <button
          onClick={() => setShowSettings(true)}
          className="mb-2 hover:opacity-70 transition-opacity"
          title="Settings"
        >
          <img src={`${import.meta.env.BASE_URL}octis-logo.svg`} alt="Octis" className="w-9 h-9" />
        </button>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => {
              if (n.id === 'sessions' && activeNav === 'sessions') {
                setSessionSidebarCollapsed(v => !v)
              } else {
                setActiveNav(n.id)
                setSessionSidebarCollapsed(false)
              }
            }}
            title={n.label}
            className={`w-9 h-9 rounded-lg text-lg transition-colors flex items-center justify-center ${
              activeNav === n.id ? 'bg-[#6366f1]' : 'hover:bg-[#2a3142] text-[#6b7280]'
            }`}
          >
            {n.id === 'projects' ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="6.5" height="6.5" rx="1.5" fill="currentColor" opacity="0.9"/>
                <rect x="10.5" y="1" width="6.5" height="6.5" rx="1.5" fill="currentColor" opacity="0.9"/>
                <rect x="1" y="10.5" width="6.5" height="6.5" rx="1.5" fill="currentColor" opacity="0.9"/>
                <rect x="10.5" y="10.5" width="6.5" height="6.5" rx="1.5" fill="currentColor" opacity="0.9"/>
              </svg>
            ) : n.label.split(' ')[0]}
          </button>
        ))}
        <div className="flex-1" />
        {/* Hotkey guide */}
        <button
          onClick={() => setShowHotkeys(true)}
          title="Keyboard shortcuts"
          className="w-9 h-9 rounded-lg transition-colors flex items-center justify-center hover:bg-[#2a3142] text-[#6b7280] hover:text-white text-sm font-medium mb-1"
        >
          ?
        </button>
        {/* Status dot — click to open menu with bug report + logout */}
        <div ref={statusMenuRef} className="relative mb-1">
          <button
            onClick={() => setShowStatusMenu(v => !v)}
            title={connected ? 'Connected' : 'Not connected'}
            className="w-9 h-9 rounded-lg transition-colors flex items-center justify-center hover:bg-[#2a3142]"
          >
            <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          </button>
          {showStatusMenu && (
            <div
              className="absolute bottom-full left-full mb-1 ml-1 w-44 bg-[#1e2333] border border-[#2a3142] rounded-xl shadow-2xl z-50 overflow-hidden py-1"
              onMouseLeave={() => setShowStatusMenu(false)}
            >
              <div className="px-3 py-1.5 text-[10px] text-[#4b5563] font-medium uppercase tracking-wide border-b border-[#2a3142] mb-1">
                {connected ? '• Connected' : '• Disconnected'}
              </div>
              <button
                onClick={() => { setShowIssueReporter(true); setShowStatusMenu(false) }}
                className="w-full text-left px-3 py-2 text-xs text-[#e8eaf0] hover:bg-[#2a3142] transition-colors flex items-center gap-2"
              >
                🐛 Report a bug
              </button>
              <button
                onClick={async () => {
                  setShowStatusMenu(false)
                  await fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'include' })
                  window.location.reload()
                }}
                className="w-full text-left px-3 py-2 text-xs text-[#e8eaf0] hover:bg-[#2a3142] transition-colors flex items-center gap-2"
              >
                ⏻ Sign out
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main content */}

      {/* Projects grid — only shown when on projects tab with no active project */}
      {activeNav === 'projects' && !activeProject && (
        <ProjectsGrid onOpenProject={(p) => { setActiveProject(p); setActiveNav('projects') }} />
      )}

      {/* ProjectView — kept mounted whenever a project is active; hidden (not unmounted) on other tabs */}
      {activeProject && (
        <div className={`flex flex-1 overflow-hidden ${activeNav === 'projects' ? '' : 'hidden'}`}>
          <ProjectView
            project={activeProject}
            onBack={() => setActiveProject(null)}
          />
        </div>
      )}

      {activeNav === 'sessions' && (
        <>
          {!sessionSidebarCollapsed && <SidebarWrapper onSettingsClick={() => setShowConnect(true)} />}
          <div
            ref={paneContainerRef}
            className="flex-1 overflow-hidden"
            style={paneLayout === 'grid' && visiblePanes.length > 1 ? {
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.ceil(visiblePanes.length / 2)}, 1fr)`,
              gridTemplateRows: 'repeat(2, 1fr)',
            } : { display: 'flex' }}
            onPointerMove={handlePanePointerMove}
            onPointerUp={handlePanePointerUp}
          >
            {visiblePanes.map((sessionKey, i) => (
              sessionKey ? (
                <ChatPane
                  key={sessionKey}
                  sessionKey={sessionKey}
                  paneIndex={i}
                  onClose={() => handleClosePane(i)}
                  onFocus={() => { focusedPaneRef.current = i; setFocusedPane(i) }}
                  isFocused={focusedPane === i}
                  isFeatured={paneLayout === 'featured' && i === (focusedPane ?? 0)}
                  onDragStart={(e, label) => handlePaneDragStart(i, e, label)}
                  onDragOver={(e) => handlePaneDragOver(i, e)}
                  onDrop={() => handlePaneDrop()}
                  onDragEnd={handlePaneDragEnd}
                  isDragOver={dragOverPane === i && dragSourceRef.current !== i}
                  renameRequested={renameRequestPanes[i]}
                />
              ) : null
            ))}
            {/* Custom drag ghost */}
            {dragGhost && (
              <div
                className="pointer-events-none fixed z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#6366f1] bg-[#1a1d2e]/80 backdrop-blur-sm shadow-[0_8px_32px_rgba(99,102,241,0.35)] text-white text-sm font-medium"
                style={{ left: dragGhost.x + 16, top: dragGhost.y - 20, transform: 'rotate(1.5deg)' }}
              >
                <span className="text-[#6366f1]">⠿</span>
                <span className="max-w-[160px] truncate">{dragGhost.label || 'Pane'}</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* Costs + Memory kept mounted (hidden) so they don't re-fetch on every tab switch */}
      <div className={`flex flex-col flex-1 overflow-hidden ${activeNav === 'costs' ? '' : 'hidden'}`}>
        <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <h1 className="text-white font-semibold">💰 Costs</h1>
        </div>
        <CostsPanel />
      </div>

      <div className={`flex flex-col flex-1 overflow-hidden ${activeNav === 'memory' ? '' : 'hidden'}`}>
        <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <h1 className="text-white font-semibold">🧠 Memory</h1>
        </div>
        <MemoryPanel />
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showHotkeys && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowHotkeys(false)}>
          <div className="bg-[#1e2333] border border-[#2a3142] rounded-2xl shadow-2xl w-96 p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-white font-semibold text-base">Keyboard shortcuts</h2>
              <button onClick={() => setShowHotkeys(false)} className="text-[#6b7280] hover:text-white text-lg leading-none">✕</button>
            </div>
            <div className="space-y-1 text-sm">
              {([
                { group: 'Sessions' },
                { key: 'N', desc: 'New session' },
                { key: 'E', desc: 'Archive focused pane' },
                { key: 'R', desc: 'AI auto-rename focused pane' },
                { group: 'Panes' },
                { key: '💬 icon (again)', desc: 'Toggle sessions sidebar' },
                { key: 'all / none', desc: 'Open or close all panes' },
                { group: 'History' },
                { key: '⌘Z', desc: 'Undo archive' },
                { key: '⌘Y', desc: 'Redo archive' },
                { group: 'Chat' },
                { key: 'Enter', desc: 'Send message' },
                { key: 'Shift+Enter', desc: 'New line' },
                { key: 'Esc', desc: 'Cancel rename' },
              ] as { group?: string; key?: string; desc?: string }[]).map((item, i) =>
                item.group
                  ? <div key={i} className="pt-3 pb-1 text-[10px] text-[#4b5563] font-semibold uppercase tracking-wider first:pt-0">{item.group}</div>
                  : <div key={i} className="flex items-center justify-between py-1">
                      <span className="text-[#9ca3af]">{item.desc}</span>
                      <kbd className="bg-[#0f1117] border border-[#2a3142] text-[#e8eaf0] text-xs px-2 py-0.5 rounded font-mono">{item.key}</kbd>
                    </div>
              )}
            </div>
            <p className="text-[#4b5563] text-xs mt-5">Bare-key shortcuts (N, E, R) fire only when no input is focused.</p>
          </div>
        </div>
      )}
      {showIssueReporter && (
        <IssueReporter
          onClose={() => setShowIssueReporter(false)}
          context={{ view: activeNav + (activeProject ? `/${activeProject.name}` : '') }}
        />
      )}

      {/* Archive toast */}
      {archiveToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#1e2330] border border-[#2a3142] text-white text-sm px-4 py-2 rounded-lg shadow-lg flex items-center gap-2">
          <span>🗂 Archived: {archiveToast}</span>
          <span className="text-[#6b7280] ml-2 text-xs">⌘Z to undo</span>
        </div>
      )}
    </div>
  )
}

function SidebarWrapper({ onSettingsClick }: { onSettingsClick: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('octis-sidebar-width')
    return saved ? Math.max(220, Math.min(700, Number(saved))) : 320
  })
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = sidebarWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const delta = ev.clientX - startX.current
      const next = Math.max(220, Math.min(700, startWidth.current + delta))
      setSidebarWidth(next)
    }
    const onUp = () => {
      isResizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setSidebarWidth(w => { localStorage.setItem('octis-sidebar-width', String(w)); return w })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="flex shrink-0 overflow-hidden">
      {collapsed ? (
        <div className="w-10 bg-[#181c24] border-r border-[#2a3142] flex flex-col items-center py-3 gap-3">
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="w-7 h-7 rounded-lg text-[#6b7280] hover:text-white hover:bg-[#2a3142] flex items-center justify-center text-sm transition-colors"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="relative flex flex-col h-screen" style={{ width: sidebarWidth }}>
          <div className="flex-1 min-h-0 overflow-hidden">
            <Sidebar onSettingsClick={onSettingsClick} />
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={onResizeMouseDown}
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-20 group"
            title="Drag to resize sidebar"
          >
            <div className="absolute right-0 top-0 bottom-0 w-1 bg-transparent group-hover:bg-[#6366f1]/50 transition-colors" />
          </div>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-full bg-[#2a3142] border border-[#3a4152] text-[#6b7280] hover:text-white flex items-center justify-center text-xs transition-colors shadow-lg"
          >
            ‹
          </button>
        </div>
      )}
    </div>
  )
}

