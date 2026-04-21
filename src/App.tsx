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

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'authed' | 'login'>('loading')

  useEffect(() => {
    fetch(API + '/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(user => setAuthState(user ? 'authed' : 'login'))
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

  return <AuthenticatedApp />
}

function AuthenticatedApp() {
  const getToken = async () => null
  const { connected, gatewayUrl, connect, setCredentials } = useGatewayStore()
  const { setAuth, fetchOwnedSessions } = useAuthStore()
  const { activePanes, pinToPane, sessions, setSessions } = useSessionStore()
  const { labels, setLabel } = useLabelStore()
  const { hydrateFromServer: hydrateProjects } = useProjectStore()
  const { hydrateFromServer: hydrateHidden, hide: hideSession } = useHiddenStore()
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const [activeNav, setActiveNav] = useState('projects')
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
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          useGatewayStore.setState({ _reconnectAttempts: 0 })
          connect()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [connect, isMobile])

  // Fetch fresh gateway config from server on every sign-in
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${API}/api/gateway-config`, {
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`)
        const data = (await res.json()) as { url?: string; token?: string; agentId?: string; role?: string; needsSetup?: boolean }
        setUserRole(data.role || null)
        setAuth(data.role || null, null)
        void fetchOwnedSessions()
        if (data.needsSetup) {
          setNeedsSetup(true)
          return
        }
        setCredentials(data.url!, data.token!, data.agentId)
        connect()
        
        void hydrateProjects()
        void hydrateHidden()
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
            void fetchOwnedSessions()
            if (d2.needsSetup) { setNeedsSetup(true); return }
            setCredentials(d2.url!, d2.token!, d2.agentId)
            connect()
            void hydrateProjects()
            void hydrateHidden()
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
          className="text-2xl mb-2 hover:opacity-70 transition-opacity"
          title="Settings"
        >
          🐙
        </button>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setActiveNav(n.id)}
            title={n.label}
            className={`w-9 h-9 rounded-lg text-lg transition-colors flex items-center justify-center ${
              activeNav === n.id ? 'bg-[#6366f1]' : 'hover:bg-[#2a3142] text-[#6b7280]'
            }`}
          >
            {n.label.split(' ')[0]}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setShowIssueReporter(true)}
          title="Report an issue"
          className="w-9 h-9 rounded-lg text-base transition-colors flex items-center justify-center text-[#6b7280] hover:text-white hover:bg-[#2a3142]"
        >
          🐛
        </button>
        <button
          onClick={() => setShowConnect(true)}
          title={`Gateway: ${gatewayUrl || 'not configured'}`}
          className={`w-9 h-9 rounded-lg text-sm transition-colors flex items-center justify-center ${
            connected ? 'text-green-400 hover:bg-[#2a3142]' : 'text-red-400 hover:bg-[#2a3142]'
          }`}
        >
          {connected ? '🟢' : '🔴'}
        </button>
        <div className="mt-2 mb-1">
          <button
            onClick={async () => {
              await fetch(API + '/api/auth/logout', { method: 'POST', credentials: 'include' })
              window.location.reload()
            }}
            className="w-9 h-9 rounded-lg text-sm text-[#6b7280] hover:bg-[#2a3142] hover:text-white transition-colors flex items-center justify-center"
            title="Sign out"
          >
            ⏻
          </button>
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
          <SidebarWrapper onSettingsClick={() => setShowConnect(true)} />
          <div
            ref={paneContainerRef}
            className="flex flex-1 overflow-hidden relative"
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

