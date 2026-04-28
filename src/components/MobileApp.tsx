import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '../lib/auth'
import { authFetch } from '../lib/authFetch'
import { useGatewayStore, useSessionStore, useHiddenStore, useProjectStore, useLabelStore, Session } from '../store/gatewayStore'
import { useAuthStore } from '../store/authStore'

const API = (import.meta.env.VITE_API_URL as string) || ''
import MobileSessionCard from './MobileSessionCard'
import MobileFullChat from './MobileFullChat'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'
import ConnectModal from './ConnectModal'
import ProjectsGrid, { type Project } from './ProjectsGrid'
import MobileProjectView from './MobileProjectView'
import IssueReporter from './IssueReporter'
import SettingsPanel from './SettingsPanel'
import { DeleteConfirmModal } from './DeleteConfirmModal'

const TABS = [
  { id: 'projects', icon: '🐙', label: 'Projects' },
  { id: 'sessions', icon: '💬', label: 'Sessions' },
  { id: 'costs', icon: '💰', label: 'Costs' },
  { id: 'memory', icon: '🧠', label: 'Memory' },
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
  const { hydrateFromServer: hydrateProjects, projectMeta, getTag } = useProjectStore()
  const { labels, setLabel, getLabel } = useLabelStore()

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
        setAvailableProjects(list.filter((p: any) => p.slug !== 'others' && !p.hide_from_sessions))
        // Publish to global store so emoji prefixes + hide-from-sessions work everywhere
        const meta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }> = {}
        for (const p of list) meta[p.slug] = { emoji: (p as any).emoji || '📁', name: p.name, color: (p as any).color || '#6366f1', hideFromSessions: !!(p as any).hide_from_sessions }
        useProjectStore.getState().setProjectMeta(meta)
      })
      .catch(() => {})
  }, [])
  const VALID_TABS = ['projects', 'sessions', 'costs', 'memory']
  const [tab, setTab] = useState(() => {
    // Hash first (refresh), sessionStorage fallback (PWA home screen launch strips hash)
    const h = window.location.hash.replace('#', '')
    if (VALID_TABS.includes(h)) return h
    const s = sessionStorage.getItem('octis-active-tab')
    if (s && VALID_TABS.includes(s)) return s
    return 'projects'
  })
  const isPopStateRef = useRef(false)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [fullChatSession, setFullChatSession] = useState<Session | null>(null)
  // Track placeholder key so we can swap to real gateway key when it appears
  const pendingNewSessionRef = useRef<string | null>(null)
  const [showConnect, setShowConnect] = useState(!gatewayUrl)
  const [showIssueReporter, setShowIssueReporter] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [filter, setFilter] = useState<FilterType>('all')
  const [showNewSessionSheet, setShowNewSessionSheet] = useState(false)
  const [availableProjects, setAvailableProjects] = useState<Array<{id: string; name: string; slug: string; emoji?: string; color?: string}>>([])
  const [archiveToast, setArchiveToast] = useState<string | null>(null)
  const [showArchivedSection, setShowArchivedSection] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('octis-mobile-collapsed-groups')
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set()
    } catch { return new Set() }
  })
  // Reactive archived sessions — sorted by lastActivity desc (same as Projects ARCHIVED view)
  const hiddenSessionsRaw = useSessionStore(s => s.hiddenSessions)
  const archivedSessions = [...hiddenSessionsRaw].sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity as string).getTime() : 0
    const tb = b.lastActivity ? new Date(b.lastActivity as string).getTime() : 0
    return tb - ta
  })
  const [archivedLoading, setArchivedLoading] = useState(false)
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

  // Navigation helpers — push browser history entries for deep navigation
  // Must be defined before handleNewSession which calls openChat
  const openProject = useCallback((p: Project | null) => {
    if (p) history.pushState({ view: 'project', projectSlug: p.slug, tab: 'projects' }, '', '#projects')
    setActiveProject(p)
  }, [])

  const openChat = useCallback((s: Session | null) => {
    if (s) history.pushState({ view: 'chat', sessionKey: s.key, tab: 'sessions' }, '', '#sessions')
    setFullChatSession(s)
  }, [])

  // Switch between already-open chats without adding a browser history entry.
  // Use this for tab-strip switches and swipe-to-switch so back/edge-swipe
  // returns to the session list rather than cycling through past chat tabs.
  const switchChat = useCallback((s: Session | null) => {
    if (s) history.replaceState({ view: 'chat', sessionKey: s.key, tab: 'sessions' }, '', '#sessions')
    setFullChatSession(s)
  }, [])

  const handleArchive = (session: Session) => {
    const lbl = labels[session.key] || session.label || 'Session'
    hideSession(session.key)
    if (session.id) hideSession(session.id)
    if (session.sessionId) hideSession(session.sessionId)
    setArchiveToast(`🗂 Archived: ${lbl}`)
    setTimeout(() => setArchiveToast(null), 3000)
  }

  const [deleteConfirmSession, setDeleteConfirmSession] = useState<Session | null>(null)
  const [selectedArchived, setSelectedArchived] = useState<Set<string>>(new Set())
  const [archiveSelectMode, setArchiveSelectMode] = useState(false)

  const handleArchivedToggle = (key: string) => {
    setSelectedArchived(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const handleBulkArchivedRestore = async () => {
    const toRestore = archivedSessions.filter(s => selectedArchived.has(s.key))
    setSelectedArchived(new Set())
    setArchiveSelectMode(false)
    for (const s of toRestore) {
      const { unhide } = useHiddenStore.getState()
      unhide(s.key)
      if (s.id) unhide(s.id)
      if (s.sessionId) unhide(s.sessionId)
      try {
        const r = await authFetch(`${API}/api/session-projects`)
        if (r.ok) {
          const rows: { session_key: string; project: string }[] = await r.json()
          const row = rows.find(r => r.session_key === s.key)
          if (row?.project) useProjectStore.getState().setTag(s.key, row.project)
        }
      } catch { /* best-effort */ }
    }
    setArchiveToast(`↩ Restored ${toRestore.length} session(s)`)
    setTimeout(() => setArchiveToast(null), 3000)
  }

  const handleBulkArchivedDelete = () => {
    const count = selectedArchived.size
    if (!window.confirm(`Delete ${count} session(s) permanently? This cannot be undone.`)) return
    const keys = Array.from(selectedArchived)
    setSelectedArchived(new Set())
    setArchiveSelectMode(false)
    for (const key of keys) {
      // Keep in hidden filter so WS can't revive; remove from Archives display
      useHiddenStore.getState().hide(key)
      useSessionStore.getState().setHiddenSessions(
        useSessionStore.getState().hiddenSessions.filter(s => s.key !== key)
      )
      authFetch(`${API}/api/session-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: key }),
      }).catch(() => {})
      localStorage.removeItem(`octis-msgs-${key}`)
      localStorage.removeItem(`octis-draft-${key}`)
    }
    setArchiveToast(`🗑️ Deleted ${count} session(s)`)
    setTimeout(() => setArchiveToast(null), 3000)
  }
  const handleDeleteRequest = (session: Session) => {
    setShowMoveSheet(false)
    setDeleteConfirmSession(session)
  }
  const handleDeleteConfirm = async () => {
    const session = deleteConfirmSession
    if (!session) return
    setDeleteConfirmSession(null)
    // Keep in hidden filter so WS sessions.list can't revive it
    useHiddenStore.getState().hide(session.key)
    // Remove from Archives display
    useSessionStore.getState().setHiddenSessions(
      useSessionStore.getState().hiddenSessions.filter(s => s.key !== session.key)
    )
    setSessions(sessions.filter(s => s.key !== session.key))
    // If this is the currently open chat, go back
    if (fullChatSession?.key === session.key) setFullChatSession(null)
    // Call server
    authFetch(`${API}/api/session-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: session.key }),
    }).catch(e => console.error('delete failed:', e))
    localStorage.removeItem(`octis-msgs-${session.key}`)
    localStorage.removeItem(`octis-draft-${session.key}`)
    const lbl = labels[session.key] || session.label || 'Session'
    setArchiveToast(`🗑️ Deleted: ${lbl}`)
    setTimeout(() => setArchiveToast(null), 3000)
  }

  const loadArchivedSessions = useCallback(async () => {
    setArchivedLoading(true)
    try {
      // Refresh from server; the reactive archivedSessions subscription picks up changes automatically
      await useSessionStore.getState().hydrateHiddenFromServer()
    } catch { /* best-effort */ } finally {
      setArchivedLoading(false)
    }
  }, [])

  const handleUnarchive = useCallback(async (session: Session) => {
    const { unhide } = useHiddenStore.getState()
    unhide(session.key)
    if (session.id) unhide(session.id)
    if (session.sessionId) unhide(session.sessionId)
    // Restore project tag from DB
    try {
      const r = await authFetch(`${API}/api/session-projects`)
      if (r.ok) {
        const rows: { session_key: string; project: string }[] = await r.json()
        const row = rows.find(r => r.session_key === session.key)
        if (row?.project) useProjectStore.getState().setTag(session.key, row.project)
      }
    } catch { /* best-effort */ }
    setArchiveToast(`↩ Unarchived: ${labels[session.key] || session.label || 'Session'}`)
    setTimeout(() => setArchiveToast(null), 3000)
  }, [labels])

  const handleNewSession = (projectSlug?: string) => {
    const key = `session-${Date.now()}`
    useAuthStore.getState().claimSession(key)  // claim before setSessions so ownership check passes
    const newSession: Session = { key, label: 'New session', sessionKey: key } as Session
    setSessions([newSession, ...useSessionStore.getState().sessions])
    pendingNewSessionRef.current = key
    if (projectSlug) {
      useProjectStore.getState().setTag(key, projectSlug)
      useSessionStore.getState().setPendingProjectInit(key, projectSlug)
    }
    setShowNewSessionSheet(false)
    openChat(newSession)
    setTab('sessions')
  }

  // Persist active tab in URL hash + sessionStorage (belt-and-suspenders — PWA strips hash on launch)
  useEffect(() => {
    sessionStorage.setItem('octis-active-tab', tab)
    if (isPopStateRef.current) { isPopStateRef.current = false; return }
    const hash = window.location.hash.replace('#', '')
    if (hash !== tab) {
      // If there's no existing hash, replace the current entry so back button
      // can't land on a hashless URL (which sends the user to the default page on refresh).
      if (!hash) {
        history.replaceState({ view: 'tab', tab }, '', '#' + tab)
      } else {
        history.pushState({ view: 'tab', tab }, '', '#' + tab)
      }
    }
  }, [tab])

  // Handle browser back/forward button
  useEffect(() => {
    const handlePop = (e: PopStateEvent) => {
      isPopStateRef.current = true
      const state = e.state as { view?: string; tab?: string; projectSlug?: string; sessionKey?: string } | null
      if (!state || state.view === 'tab') {
        setFullChatSession(null)
        setActiveProject(null)
        const t = state?.tab || window.location.hash.replace('#', '')
        if (VALID_TABS.includes(t)) setTab(t)
      } else if (state.view === 'chat') {
        setActiveProject(null)
        const s = sessions.find((x: Session) => x.key === state.sessionKey)
        if (s) setFullChatSession(s)
        else setFullChatSession(null)
      } else if (state.view === 'project') {
        setFullChatSession(null)
        const p = availableProjects.find(x => x.slug === state.projectSlug)
        if (p) setActiveProject(p as Project)
        else setActiveProject(null)
      }
    }
    window.addEventListener('popstate', handlePop)
    return () => window.removeEventListener('popstate', handlePop)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, availableProjects])

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
    // Use getLabel (same as desktop) so server-side labels are checked, not just s.label
    const lbl = getLabel(s.key, s.label || '')
    if (lbl.startsWith('Continue where you left off')) return true
    return false
  }
  const hideHeartbeat = localStorage.getItem('octis-show-heartbeat-sessions') !== 'true'
  const hideCron = localStorage.getItem('octis-show-cron-sessions') !== 'true'
  // Mirror desktop Sidebar.tsx isHeartbeatSession: check cron key AND label for 'heartbeat'
  const isHeartbeatOrCron = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    if (key.includes(':cron:')) return true
    const lbl = (getLabel(s.key, s.label || s.key) || '').toLowerCase()
    return lbl.includes('heartbeat') || lbl.startsWith('read heartbeat')
  }

  // Stable session fingerprint — only recompute visibleSessions when keys/statuses actually change
  const sessionFingerprint = sessions.map(s => `${s.key}:${getStatus(s)}`).join('|')
  const visibleSessions = useMemo(() => sessions.filter((s: Session) => {
    if (!s.key || isHidden(s.key) || isHidden(s.id || '') || isHidden(s.sessionId || '')) return false
    // Note: do NOT filter out session-\d+ keys — those are valid pending local sessions
    // created before the gateway assigns a full key. Filtering them breaks new session creation.
    if (hideAgentSessions && isAgentSession(s)) return false
    if ((hideHeartbeat || hideCron) && isHeartbeatOrCron(s)) return false
    // Hide sessions belonging to projects with hide_from_sessions=true
    // Check both: (a) tag-based (for sessions already tagged) and
    // (b) key-pattern-based (for new sessions not yet tagged by autoTagSlackSessions)
    const tag = getTag(s.key)
    if (tag.project && projectMeta[tag.project]?.hideFromSessions) return false
    // Direct key-pattern check — catches new Slack sessions before autoTagSlackSessions fires
    const hiddenSlugs = Object.entries(projectMeta)
      .filter(([, m]) => m.hideFromSessions)
      .map(([slug]) => slug.toLowerCase())
    if (hiddenSlugs.some(slug => slug === 'slack' && s.key.includes(':slack:'))) return false
    return true
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionFingerprint, hideAgentSessions, hideHeartbeat, hideCron, hidden, projectMeta])

  const filtered = useMemo(() => visibleSessions.filter((s: Session) => {
    const st = getStatus(s)
    // Always show working sessions regardless of filter — never lose a running session
    if (filter === 'active') return st === 'active' || st === 'working'
    if (filter === 'idle') return st === 'quiet' || st === 'working'
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
          <ProjectsGrid onOpenProject={(p) => openProject(p)} />
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
                {(() => {
                  // Group filtered sessions by project
                  const groups: Record<string, Session[]> = {}
                  const ungrouped: Session[] = []
                  for (const s of filtered) {
                    const p = useProjectStore.getState().getTag(s.key).project || ''
                    if (p) { if (!groups[p]) groups[p] = []; groups[p].push(s) }
                    else ungrouped.push(s)
                  }
                  const groupSlugs = Object.keys(groups).sort()
                  const allGroups: Array<{ slug: string; label: string; color: string; sessions: Session[] }> = [
                    ...groupSlugs.map(slug => {
                      const meta = useProjectStore.getState().projectMeta[slug]
                      return { slug, label: meta?.name || slug, color: meta?.color || '#6366f1', sessions: groups[slug] }
                    }),
                    ...(ungrouped.length > 0 ? [{ slug: '__untagged__', label: 'Untagged', color: '#6b7280', sessions: ungrouped }] : []),
                  ]

                  const renderSession = (s: Session) => {
                    const st = getStatus(s)
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
                      <div key={s.key} className="flex items-center border-b border-[#1e2330]">
                        <button
                          onClick={() => { if (longPressDetectedRef.current) { longPressDetectedRef.current = false; return } openChat(s) }}
                          onTouchStart={() => handleSessionLongPressStart(s)}
                          onTouchEnd={handleSessionLongPressEnd}
                          onTouchMove={handleSessionLongPressEnd}
                          className="flex-1 flex items-center gap-3 px-4 py-3 active:bg-[#1e2330] text-left min-w-0"
                        >
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                          <span className="flex-1 text-sm text-white truncate min-w-0">{lbl}</span>
                          <span className="text-xs shrink-0 font-medium" style={{ color: statusColor }}>{statusLabel}</span>
                          {ago && <span className="text-xs text-[#4b5563] shrink-0">{ago}</span>}
                          {(() => { const cost = useSessionStore.getState().sessionMeta[s.key]?.lastExchangeCost; return cost != null ? <span className="text-[10px] text-[#4b5563] shrink-0 font-mono">${(cost * 100).toFixed(1)}¢</span> : null })()}
                          <span className="text-[#4b5563] shrink-0">›</span>
                        </button>
                        <button
                          onClick={() => handleArchive(s)}
                          className="px-3 py-3 text-[#374151] hover:text-red-400 active:text-red-400 shrink-0 transition-colors"
                          title="Archive"
                        >
                          🗑
                        </button>
                      </div>
                    )
                  }

                  return allGroups.map(({ slug, label, color, sessions: groupSessions }) => {
                    const isCollapsed = collapsedGroups.has(slug)
                    const toggleCollapse = () => setCollapsedGroups(prev => {
                      const next = new Set(prev)
                      if (next.has(slug)) next.delete(slug); else next.add(slug)
                      localStorage.setItem('octis-mobile-collapsed-groups', JSON.stringify([...next]))
                      return next
                    })
                    return (
                      <div key={slug}>
                        <button
                          onClick={toggleCollapse}
                          className="w-full flex items-center gap-2 px-4 py-2 text-left active:bg-[#1e2330] border-b border-[#1a1d2a]"
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                          <span className="text-xs font-semibold flex-1 truncate" style={{ color }}>{label}</span>
                          <span className="text-[10px] text-[#4b5563] shrink-0">{groupSessions.length}</span>
                          <span className="text-[10px] text-[#4b5563] shrink-0">{isCollapsed ? '▼' : '▲'}</span>
                        </button>
                        {!isCollapsed && groupSessions.map(renderSession)}
                      </div>
                    )
                  })
                })()}

                {/* Archived sessions section */}
                <div className="border-t border-[#2a3142] mt-2">
                  <div className="flex items-center">
                    <button
                      onClick={() => {
                        if (!showArchivedSection) void loadArchivedSessions()
                        setShowArchivedSection(v => !v)
                        if (showArchivedSection) { setArchiveSelectMode(false); setSelectedArchived(new Set()) }
                      }}
                      className="flex-1 flex items-center gap-2 px-4 py-3 text-left active:bg-[#1e2330]"
                    >
                      <span className="text-xs text-[#6b7280] flex-1 font-medium uppercase tracking-wider">📦 Archived</span>
                      <span className="text-[10px] text-[#4b5563]">{showArchivedSection ? '▲' : '▼'}</span>
                    </button>
                    {showArchivedSection && (
                      <button
                        onClick={() => { setArchiveSelectMode(v => !v); setSelectedArchived(new Set()) }}
                        className={`px-4 py-3 text-xs shrink-0 font-medium transition-colors ${archiveSelectMode ? 'text-[#6366f1]' : 'text-[#4b5563] active:text-white'}`}
                      >
                        {archiveSelectMode ? 'Cancel' : 'Select'}
                      </button>
                    )}
                  </div>
                  {showArchivedSection && (
                    <div>
                      {archivedLoading && (
                        <div className="px-4 py-3 text-xs text-[#6b7280]">Loading…</div>
                      )}
                      {!archivedLoading && archivedSessions.length === 0 && (
                        <div className="px-4 py-3 text-xs text-[#6b7280]">No archived sessions.</div>
                      )}
                      {!archivedLoading && archiveSelectMode && selectedArchived.size > 0 && (
                        <div className="flex items-center gap-2 mx-3 mb-2 px-3 py-2 bg-[#1e2330] rounded-xl border border-[#2a3142]">
                          <span className="text-xs text-[#6b7280] flex-1">{selectedArchived.size} selected</span>
                          <button
                            onClick={handleBulkArchivedRestore}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600/20 border border-indigo-600/30 text-indigo-400 active:bg-indigo-600/30"
                          >
                            ↩ Restore
                          </button>
                          <button
                            onClick={handleBulkArchivedDelete}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-900/20 border border-red-800/30 text-red-400 active:bg-red-900/30"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      )}
                      {!archivedLoading && archivedSessions.map(s => {
                        // Try label store with multiple key formats before falling back
                        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.key)
                        const rawLbl = labels[s.key]
                          || (isUUID ? labels['agent:main:dashboard:' + s.key] : '')
                          || s.label
                          || ''
                        const lbl = rawLbl || (() => {
                          // agent:main:session-ts → show date
                          const tsMatch = s.key.match(/:session-(\d{13})/)
                          if (tsMatch) {
                            const d = new Date(parseInt(tsMatch[1]))
                            return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                          }
                          // Slack thread → readable timestamp
                          const slackTs = s.key.match(/:thread:([\d.]+)$/)
                          if (slackTs) {
                            const d = new Date(parseFloat(slackTs[1]) * 1000)
                            const ch = s.key.includes(':direct:') ? 'DM' : s.key.includes(':channel:') ? 'Slack' : 'Thread'
                            return `${ch} · ${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}`
                          }
                          // Bare UUID with no label — use archive date if available
                          if (isUUID) {
                            const hiddenAt = (s as any).hiddenAt
                            if (hiddenAt) {
                              const d = new Date(hiddenAt)
                              return `Archived ${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`
                            }
                            return 'Unnamed session'
                          }
                          return s.key.split(':').pop() || s.key
                        })()
                        const projEmoji = useProjectStore.getState().getProjectEmoji(useProjectStore.getState().getTag(s.key).project || '')
                        return (
                          <div
                            key={s.key}
                            className={`flex items-center border-b border-[#1e2330] ${archiveSelectMode && selectedArchived.has(s.key) ? 'bg-[#1e2330]' : ''}`}
                          >
                            <button
                              onClick={() => archiveSelectMode ? handleArchivedToggle(s.key) : openChat(s)}
                              className="flex-1 flex items-center gap-3 px-4 py-3.5 active:bg-[#1e2330] text-left min-w-0"
                            >
                              {archiveSelectMode ? (
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${selectedArchived.has(s.key) ? 'bg-[#6366f1] border-[#6366f1]' : 'border-[#3a4152]'}`}>
                                  {selectedArchived.has(s.key) && <span className="text-white text-[9px] font-bold">✓</span>}
                                </div>
                              ) : (
                                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-[#374151]" />
                              )}
                              {projEmoji && <span className="text-sm shrink-0">{projEmoji}</span>}
                              <span className="flex-1 text-sm text-[#9ca3af] truncate min-w-0">{lbl}</span>
                              {!archiveSelectMode && <span className="text-[#4b5563] shrink-0">›</span>}
                            </button>
                            {!archiveSelectMode && (
                              <>
                                <button
                                  onClick={() => handleUnarchive(s)}
                                  className="px-3 py-3.5 text-indigo-400 active:text-indigo-300 shrink-0 transition-colors"
                                  title="Unarchive"
                                >
                                  ↩
                                </button>
                                <button
                                  onClick={() => handleDeleteRequest(s)}
                                  className="px-3 py-3.5 text-red-500/60 active:text-red-400 shrink-0 transition-colors"
                                  title="Delete permanently"
                                >
                                  🗑️
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
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
          <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0 flex items-center">
            <h1 className="text-white font-semibold text-sm flex-1">🧠 Memory</h1>
            <button
              onClick={() => setShowSettings(true)}
              className="text-[#6b7280] hover:text-white transition-colors p-1 rounded-lg"
              title="Settings"
            >
              ⚙️
            </button>
          </div>
          <MemoryPanel />
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

      {/* Settings overlay */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#0f1117]" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <button onClick={() => setShowSettings(false)} className="text-[#6b7280] hover:text-white text-sm transition-colors">← Back</button>
            <span className="text-white font-semibold text-sm flex-1">⚙️ Settings</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <SettingsPanel onClose={() => setShowSettings(false)} />
          </div>
        </div>
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
            <div className="border-t border-[#2a3142] mt-3 pt-2 space-y-1">
              <button
                onClick={() => {
                  const s = sessions.find(s => s.key === longPressSessionKey)
                  if (s) handleArchive(s)
                  setShowMoveSheet(false)
                  setLongPressSessionKey(null)
                }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left active:bg-[#2a3142]"
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-yellow-900/20 border border-yellow-700/30">
                  📦
                </div>
                <span className="text-sm font-medium text-yellow-400">Archive session</span>
              </button>
              <button
                onClick={() => {
                  const s = sessions.find(s => s.key === longPressSessionKey)
                  if (s) handleDeleteRequest(s)
                  setShowMoveSheet(false)
                  setLongPressSessionKey(null)
                }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left active:bg-[#2a3142]"
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-red-900/20 border border-red-700/30">
                  🗑️
                </div>
                <span className="text-sm font-medium text-red-400">Delete permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteConfirmSession && (
        <DeleteConfirmModal
          sessionLabel={labels[deleteConfirmSession.key] || deleteConfirmSession.label || deleteConfirmSession.key}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteConfirmSession(null)}
        />
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
          onBack={() => { isPopStateRef.current = true; setActiveProject(null); history.back() }}
          onSwitchProject={(p) => openProject(p)}
        />
      </div>
    )}

    {/* Full chat from sessions list — overlay so ProjectsGrid/Costs/Memory stay mounted */}
    {fullChatSession && (
      <div className="fixed inset-0 z-20 bg-[#0f1117]">
        <MobileFullChat
          session={fullChatSession}
          onBack={() => { isPopStateRef.current = true; setFullChatSession(null); history.back() }}
          recentSessions={recentSessions}
          onSwitch={(s) => switchChat(s)}
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
