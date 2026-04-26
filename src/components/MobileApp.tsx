import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../lib/auth'
import { authFetch } from '../lib/authFetch'
import { useGatewayStore, useSessionStore, useHiddenStore, useProjectStore, useLabelStore, Session } from '../store/gatewayStore'

const API = (import.meta.env.VITE_API_URL as string) || ''
import MobileSessionCard from './MobileSessionCard'
import MobileFullChat from './MobileFullChat'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'
import ConnectModal from './ConnectModal'
import ProjectsGrid, { type Project } from './ProjectsGrid'
import MobileProjectView from './MobileProjectView'
import IssueReporter from './IssueReporter'
import AgentsPage from './AgentsPage'

const TABS = [
  { id: 'projects', icon: '🐙', label: 'Projects' },
  { id: 'sessions', icon: '💬', label: 'Sessions' },
  { id: 'costs', icon: '💰', label: 'Costs' },
  { id: 'memory', icon: '🧠', label: 'Memory' },
  { id: 'agents', icon: '🤖', label: 'Agents' },
]

type FilterType = 'all' | 'active' | 'idle'

export default function MobileApp() {
  const { getToken } = useAuth()
  // Selective Zustand subscriptions: only subscribe to fields this component actually renders.
  // Without selectors, useStore() returns the full state and re-renders on ANY store change —
  // including sessionActivity (every WS chat event) and sessionMeta (every streaming token).
  // With selectors, MobileApp only re-renders when connected or sessions actually change.
  const connected = useGatewayStore(s => s.connected)
  const gatewayUrl = useGatewayStore(s => s.gatewayUrl)
  const connect = useGatewayStore(s => s.connect)
  const sessions = useSessionStore(s => s.sessions)           // re-renders only when session list changes (~30s)
  const getStatus = useSessionStore(s => s.getStatus)         // stable function ref
  const getLastActivityMs = useSessionStore(s => s.getLastActivityMs) // stable function ref
  const setSessions = useSessionStore(s => s.setSessions)     // stable function ref
  const { hidden, isHidden, hide: hideSession, hydrateFromServer: hydrateHidden } = useHiddenStore()
  const { hydrateFromServer: hydrateProjects } = useProjectStore()
  const { labels, setLabel } = useLabelStore()

  const hydrateAll = useCallback(async () => {
    const token = await getToken() || undefined
    await Promise.all([
      hydrateHidden(token),
      hydrateProjects(token),
    ])
    // Hydrate archived session details from server (independent of gateway WS — ensures
    // old/inactive archived sessions appear even if gateway doesn't include them in sessions.list)
    void useSessionStore.getState().hydrateHiddenFromServer(token)
    // Fetch server-side session labels
    const authHeader = {}
    fetch(`${API}/api/session-labels`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: Record<string, string>) => {
        if (typeof data === 'object' && !('error' in data)) {
          Object.entries(data).forEach(([key, lbl]) => {
            if (!labels[key]) setLabel(key, lbl)
          })
          // Also match by thread ID from gateway key
          sessions.forEach((s: Session) => {
            const gKey = s.key
            if (!gKey || labels[gKey]) return
            const threadId = gKey.split(':').pop() || ''
            if (threadId && data[threadId]) setLabel(gKey, data[threadId])
          })
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken])

  useEffect(() => { void hydrateAll() }, [hydrateAll])

    // Track last received WS message time — used to detect zombie connections.
  const lastRxRef = useRef<number>(Date.now())
  useEffect(() => {
    const unsub = useGatewayStore.getState().subscribe(() => { lastRxRef.current = Date.now() })
    return unsub
  }, [])

  // Watchdog: fire every 30s. If connected but 60s of silence — zombie TCP, force reconnect.
  // Keepalive ping fires every 45s, so 60s of silence means the ping response never came.
  useEffect(() => {
    const t = setInterval(() => {
      if (!useGatewayStore.getState().connected) return
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRxRef.current > 60_000) {
        console.log('[octis] Watchdog: 60s silence — zombie TCP, reconnecting')
        useGatewayStore.setState({ _reconnectAttempts: 0 })
        useGatewayStore.getState().forceReconnect()
      }
    }, 30_000)
    return () => clearInterval(t)
  }, [])

  // Visibility handler: reconnect on return from background.
  // Handles both disconnected state AND zombie (connected=true but WS is dead).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      setTimeout(() => {
        if (document.visibilityState !== 'visible') return
        const { connected } = useGatewayStore.getState()
        useGatewayStore.setState({ _reconnectAttempts: 0 })
        if (!connected) {
          console.log('[octis] Visible + disconnected — reconnecting')
          useGatewayStore.getState().connect()
        } else {
          // Zombie check: if connected but silent for >20s, the WS is likely dead.
          // iOS kills the TCP connection when backgrounded but onclose may not fire.
          const silentMs = Date.now() - lastRxRef.current
          if (silentMs > 20_000) {
            console.log(`[octis] Visible + zombie (${silentMs}ms silent) — force reconnecting`)
            useGatewayStore.getState().forceReconnect()
          }
        }
      }, 600)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // HTTP sessions fallback — fetches sessions when WS is dead or on first load.
  // Runs every 20s so the session list stays fresh even without WS.
  useEffect(() => {
    const fetchSessions = async () => {
      const { connected: c, agentId } = useGatewayStore.getState()
      if (c) return // WS is fine, no need
      try {
        const url = `${API}/api/sessions-list${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`
        const r = await authFetch(url)
        if (!r.ok) return
        const data = await r.json() as { ok: boolean; sessions?: Session[] }
        if (data.ok && data.sessions?.length) {
          useSessionStore.getState().setSessions(data.sessions)
        }
      } catch { /* best-effort */ }
    }
    // Fetch immediately on mount (covers the window before WS connects after hard refresh)
    void fetchSessions()
    const t = setInterval(fetchSessions, 20000)
    return () => clearInterval(t)
  }, [])

  // Fetch projects list for new-session picker
  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then((data: {projects?: Array<{id: string; name: string; slug: string; emoji?: string; color?: string}>} | Array<{id: string; name: string; slug: string; emoji?: string; color?: string}>) => {
        const list = Array.isArray(data) ? data : (data.projects || [])
        setAvailableProjects(list.filter(p => p.slug !== 'others'))
        // Publish to global store so emoji prefixes work everywhere
        const meta: Record<string, { emoji: string; name: string; color: string }> = {}
        for (const p of list) meta[p.slug] = { emoji: p.emoji || '📁', name: p.name, color: p.color || '#6366f1' }
        useProjectStore.getState().setProjectMeta(meta)
      })
      .catch(() => {})
  }, [])
  const [tab, setTab] = useState('projects')
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [fullChatSession, setFullChatSession] = useState<Session | null>(null)
  // Track placeholder key so we can swap to real gateway key when it appears
  const pendingNewSessionRef = useRef<string | null>(null)
  const [showConnect, setShowConnect] = useState(!gatewayUrl)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [showNewSessionSheet, setShowNewSessionSheet] = useState(false)
  const [availableProjects, setAvailableProjects] = useState<Array<{id: string; name: string; slug: string; emoji?: string; color?: string}>>([])
  const [archiveToast, setArchiveToast] = useState<string | null>(null)
  const [longPressSessionKey, setLongPressSessionKey] = useState<string | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressDetectedRef = useRef(false)
  const [showMoveSheet, setShowMoveSheet] = useState(false)

  const handleSessionLongPressStart = (s: Session) => {
    longPressDetectedRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressDetectedRef.current = true
      setLongPressSessionKey(s.key)
      setShowMoveSheet(true)
    }, 500)
  }

  const handleSessionLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const handleMoveSessionTo = async (sessionKey: string, projectSlug: string) => {
    useProjectStore.getState().setTag(sessionKey, projectSlug)
    setShowMoveSheet(false)
    setLongPressSessionKey(null)
    authFetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, projectTag: projectSlug }),
    }).catch(() => {})
  }

  const handleArchive = (session: Session) => {
    const lbl = labels[session.key] || session.label || 'Session'
    hideSession(session.key)
    if (session.id) hideSession(session.id)
    if (session.sessionId) hideSession(session.sessionId)
    setArchiveToast(`🗂 Archived: ${lbl}`)
    setTimeout(() => setArchiveToast(null), 3000)
  }

  const handleNewSession = (projectSlug?: string) => {
    const key = `session-${Date.now()}`
    const newSession: Session = { key, label: 'New session', sessionKey: key } as Session
    setSessions([newSession, ...sessions])
    pendingNewSessionRef.current = key
    if (projectSlug) {
      useProjectStore.getState().setTag(key, projectSlug)
    }
    setShowNewSessionSheet(false)
    setFullChatSession(newSession)
    setTab('sessions')
  }

  // When the gateway returns the real key (agent:main:session-<ts>), update fullChatSession
  useEffect(() => {
    if (!pendingNewSessionRef.current) return
    const pendingKey = pendingNewSessionRef.current
    const tsMatch = pendingKey.match(/^session-(\d+)$/)
    if (!tsMatch) return
    const ts = tsMatch[1]
    const matched = sessions.find((s: Session) => s.key.endsWith(`:session-${ts}`))
    if (!matched) return
    pendingNewSessionRef.current = null
    setFullChatSession(matched)
  }, [sessions])

  const hideAgentSessions = true // Hide background subagent workers (not user-spawned ACP sessions)
  const isAgentSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    // Only hide true background subagents — NOT :acp: sessions (those are user-spawned harnesses like Codex/Claude Code)
    if (key.includes(':subagent:')) return true
    // Also filter model-fallback sessions (OpenClaw auto-retry on timeout)
    const lbl = (s.label || '').toLowerCase()
    if (lbl.startsWith('continue where you left off')) return true
    return false
  }
  const hideHeartbeat = localStorage.getItem('octis-show-heartbeat-sessions') !== 'true'
  const hideCron = localStorage.getItem('octis-show-cron-sessions') !== 'true'
  const isHeartbeatOrCron = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    return key.includes(':cron:')
  }

  // Stable session fingerprint — only recompute visibleSessions when keys/statuses actually change
  const sessionFingerprint = sessions.map(s => `${s.key}:${getStatus(s)}`).join('|')
  const visibleSessions = useMemo(() => sessions.filter((s: Session) => {
    if (!s.key || isHidden(s.key) || isHidden(s.id || '') || isHidden(s.sessionId || '')) return false
    if (/^session-\d+$/.test(s.key)) return false
    if (hideAgentSessions && isAgentSession(s)) return false
    if ((hideHeartbeat || hideCron) && isHeartbeatOrCron(s)) return false
    return true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionFingerprint, hideAgentSessions, hideHeartbeat, hideCron, hidden])

  const filtered = useMemo(() => visibleSessions.filter((s: Session) => {
    const st = getStatus(s)
    if (filter === 'active') return st === 'active'
    if (filter === 'idle') return st === 'quiet'
    return true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visibleSessions, filter])

  const counts = useMemo(() => ({
    active: visibleSessions.filter((s: Session) => getStatus(s) === 'active').length,
    idle: visibleSessions.filter((s: Session) => getStatus(s) === 'quiet').length,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visibleSessions])

  // Stable slice — new array ref only when visibleSessions actually changes
  const recentSessions = useMemo(() => visibleSessions.slice(0, 10), [visibleSessions])

  // Ref so archive callback always sees the current session (closure would be stale after session switch)
  const fullChatSessionRef = useRef(fullChatSession)
  fullChatSessionRef.current = fullChatSession

  return (
    <>
    <div
      className="flex flex-col bg-[#0f1117] overflow-hidden"
      style={{ height: '100dvh' }}
    >
      {/* Status bar area */}
      <div
        className="bg-[#181c24] border-b border-[#2a3142] shrink-0"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <img src={`${import.meta.env.BASE_URL}octis-logo.svg`} alt="Octis" className="w-6 h-6" />
            <span className="text-white font-semibold text-base tracking-tight">Octis</span>
          </div>
          <button
            onClick={() => setShowConnect(true)}
            className="flex items-center gap-1.5 text-xs text-[#6b7280] hover:text-white transition-colors"
          >
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* ProjectsGrid kept mounted — re-fetches on every unmount/mount causing "loading" flash */}
        <div className={tab === 'projects' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
          <ProjectsGrid onOpenProject={(p) => setActiveProject(p)} />
        </div>

        <div className={tab === 'sessions' ? 'flex-1 overflow-hidden flex flex-col' : 'hidden'}>
        {true && (
          <>
            {/* Filter pills + New Session */}
            <div className="flex gap-2 px-4 pt-3 pb-2 shrink-0 items-center">
              {(
                [
                  { id: 'all', label: `All ${visibleSessions.length}` },
                  { id: 'active', label: `🟢 ${counts.active}` },
                  { id: 'idle', label: `🟡 ${counts.idle}` },
                ] as { id: FilterType; label: string }[]
              ).map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    filter === f.id
                      ? 'bg-[#6366f1] text-white'
                      : 'bg-[#1e2330] text-[#6b7280] active:bg-[#2a3142]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <button
                onClick={() => setShowNewSessionSheet(true)}
                className="ml-auto px-4 py-1.5 rounded-full text-xs font-semibold bg-[#6366f1] text-white active:bg-[#818cf8] shrink-0 flex items-center gap-1"
              >
                <span className="text-sm leading-none">＋</span> New Session
              </button>
            </div>

            {/* Flat inbox list — tap to open chat directly */}
            {filtered.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center px-8">
                  <img src={`${import.meta.env.BASE_URL}octis-logo.svg`} alt="Octis" className="w-16 h-16 mx-auto mb-3" />
                  <div className="text-[#6b7280] text-sm">
                    {sessions.length === 0
                      ? 'No sessions yet. Connect to your gateway to get started.'
                      : 'No sessions match this filter.'}
                  </div>
                  {!connected && (
                    <button
                      onClick={() => setShowConnect(true)}
                      className="mt-4 bg-[#6366f1] text-white text-sm px-5 py-2.5 rounded-xl"
                    >
                      Connect to Gateway
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}>
                {filtered.map((s: Session) => {
                  const st = getStatus(s)
                  const projEmoji = useProjectStore.getState().getProjectEmoji(useProjectStore.getState().getTag(s.key).project || '')
                  const lbl = labels[s.key] || s.label || s.key
                  const actMs = getLastActivityMs(s)
                  const ago = actMs ? (() => {
                    const mins = Math.floor((Date.now() - actMs) / 60000)
                    if (mins < 1) return 'just now'
                    if (mins < 60) return `${mins}m`
                    const hrs = Math.floor(mins / 60)
                    if (hrs < 24) return `${hrs}h`
                    return `${Math.floor(hrs / 24)}d`
                  })() : ''
                  const statusColor =
                    st === 'working' ? '#a855f7'
                    : st === 'needs-you' ? '#3b82f6'
                    : st === 'stuck' ? '#f59e0b'
                    : st === 'active' ? '#22c55e'
                    : '#6b7280'
                  const statusLabel =
                    st === 'working' ? 'Working'
                    : st === 'needs-you' ? 'Needs you'
                    : st === 'stuck' ? 'Stuck?'
                    : st === 'active' ? 'Active'
                    : 'Quiet'
                  return (
                    <div
                      key={s.key}
                      className="flex items-center border-b border-[#1e2330]"
                    >
                      <button
                        onClick={() => { if (longPressDetectedRef.current) { longPressDetectedRef.current = false; return } setFullChatSession(s) }}
                        onTouchStart={() => handleSessionLongPressStart(s)}
                        onTouchEnd={handleSessionLongPressEnd}
                        onTouchMove={handleSessionLongPressEnd}
                        className="flex-1 flex items-center gap-3 px-4 py-3.5 active:bg-[#1e2330] text-left min-w-0"
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                        {projEmoji && <span className="text-sm shrink-0">{projEmoji}</span>}
                        <span className="flex-1 text-sm text-white truncate min-w-0">{lbl}</span>
                        <span className="text-xs shrink-0 font-medium" style={{ color: statusColor }}>{statusLabel}</span>
                        {ago && <span className="text-xs text-[#4b5563] shrink-0">{ago}</span>}
                        {(() => { const cost = useSessionStore.getState().sessionMeta[s.key]?.lastExchangeCost; return cost != null ? <span className="text-[10px] text-[#4b5563] shrink-0 font-mono">${(cost * 100).toFixed(1)}¢</span> : null })()}
                        <span className="text-[#4b5563] shrink-0">›</span>
                      </button>
                      <button
                        onClick={() => {
                          handleArchive(s)
                        }}
                        className="px-3 py-3.5 text-[#374151] hover:text-red-400 active:text-red-400 shrink-0 transition-colors"
                        title="Archive"
                      >
                        🗑
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
        </div>

        {/* Costs + Memory kept mounted so they don't re-fetch every tab switch */}
        <div className={`flex-1 overflow-hidden flex flex-col ${tab === 'costs' ? '' : 'hidden'}`}>
          <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold text-sm">💰 Costs</h1>
          </div>
          <CostsPanel />
        </div>

        <div className={`flex-1 overflow-hidden flex flex-col ${tab === 'memory' ? '' : 'hidden'}`}>
          <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold text-sm">🧠 Memory</h1>
          </div>
          <MemoryPanel />
        </div>

        <div className={tab === 'agents' ? 'flex-1 min-h-0 flex flex-col overflow-y-auto' : 'hidden'}>
          <AgentsPage onStartSession={() => setTab('sessions')} />
        </div>
      </div>

      {/* Bottom tab bar */}
      <div
        className="bg-[#181c24] border-t border-[#2a3142] shrink-0"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${
                tab === t.id ? 'text-[#6366f1]' : 'text-[#6b7280]'
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span className="text-[10px] font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </div>



      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}

      {/* New Session + Project Picker sheet */}
      {showNewSessionSheet && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={() => setShowNewSessionSheet(false)}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative bg-[#181c24] rounded-t-2xl w-full max-h-[70vh] overflow-y-auto border-t border-[#2a3142]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <span className="text-white font-semibold text-base">New Session</span>
              <button
                onClick={() => setShowNewSessionSheet(false)}
                className="text-[#6b7280] hover:text-white text-lg w-8 h-8 flex items-center justify-center"
              >✕</button>
            </div>
            <div className="pb-8">
              {/* No project option */}
              <button
                onClick={() => handleNewSession()}
                className="w-full flex items-center gap-3 px-5 py-4 border-b border-[#2a3142] active:bg-[#2a3142] text-left"
              >
                <span className="text-lg">💬</span>
                <span className="text-sm text-white">No project</span>
              </button>
              {/* Project list */}
              {availableProjects.map(p => (
                <button
                  key={p.slug}
                  onClick={() => handleNewSession(p.slug)}
                  className="w-full flex items-center gap-3 px-5 py-4 border-b border-[#2a3142] active:bg-[#2a3142] text-left"
                >
                  <span className="text-lg">{p.emoji || '📁'}</span>
                  <span className="text-sm text-white">{p.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {showIssueReporter && (
        <IssueReporter onClose={() => setShowIssueReporter(false)} context={{ view: tab }} />
      )}

      {/* Move to project bottom sheet */}
      {showMoveSheet && longPressSessionKey && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          onClick={() => { setShowMoveSheet(false); setLongPressSessionKey(null) }}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative bg-[#181c24] rounded-t-3xl border-t border-[#2a3142] px-4 pt-4 pb-6"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-[#2a3142] rounded-full mx-auto mb-4" />
            <div className="text-[#6b7280] text-xs font-medium mb-1 px-1">Move to project</div>
            <div className="text-white text-sm font-medium mb-3 px-1 truncate">
              {labels[longPressSessionKey] || sessions.find(s => s.key === longPressSessionKey)?.label || longPressSessionKey}
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {availableProjects.map(p => (
                <button
                  key={p.slug}
                  onClick={() => handleMoveSessionTo(longPressSessionKey, p.slug)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[#2a3142] transition-colors active:bg-[#2a3142]"
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
                    style={{ background: (p.color || '#6366f1') + '22', border: `1px solid ${(p.color || '#6366f1')}44` }}
                  >
                    {p.emoji || '📁'}
                  </div>
                  <span className="text-sm font-medium text-white">{p.name}</span>
                </button>
              ))}
              {useProjectStore.getState().getTag(longPressSessionKey).project && (
                <button
                  onClick={() => handleMoveSessionTo(longPressSessionKey, '')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[#2a3142] transition-colors active:bg-[#2a3142]"
                >
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-gray-800 border border-gray-700">
                    📂
                  </div>
                  <span className="text-sm font-medium text-[#6b7280]">Move to Others (unassign)</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Archive toast */}
      {archiveToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-[#1e2330] border border-[#2a3142] text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-lg pointer-events-none whitespace-nowrap">
          {archiveToast}
        </div>
      )}
    </div>

    {/* Project view overlay */}
    {activeProject && (
      <div className="fixed inset-0 z-20 bg-[#0f1117]">
        <MobileProjectView
          project={activeProject}
          onBack={() => setActiveProject(null)}
          onSwitchProject={(p) => setActiveProject(p)}
        />
      </div>
    )}

    {/* Full chat from sessions list — overlay so ProjectsGrid/Costs/Memory stay mounted */}
    {fullChatSession && (
      <div className="fixed inset-0 z-20 bg-[#0f1117]">
        <MobileFullChat
          session={fullChatSession}
          onBack={() => setFullChatSession(null)}
          recentSessions={recentSessions}
          onSwitch={(s) => setFullChatSession(s)}
          onArchive={() => {
            const current = fullChatSessionRef.current
            if (!current) return
            const archivedKey = current.key
            hideSession(archivedKey)
            if (current.id) hideSession(current.id)
            const next = visibleSessions.find(s => s.key !== archivedKey)
            setFullChatSession(next || null)
          }}
          onNewSession={() => handleNewSession()}
        />
      </div>
    )}
    </>
  )
}
