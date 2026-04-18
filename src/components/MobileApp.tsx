import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useGatewayStore, useSessionStore, useHiddenStore, useProjectStore, useLabelStore, Session } from '../store/gatewayStore'

const API = ''  // same-origin
import MobileSessionCard from './MobileSessionCard'
import MobileFullChat from './MobileFullChat'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'
import ConnectModal from './ConnectModal'
import ProjectsGrid, { type Project } from './ProjectsGrid'
import MobileProjectView from './MobileProjectView'
import IssueReporter from './IssueReporter'

const TABS = [
  { id: 'projects', icon: '🐙', label: 'Projects' },
  { id: 'sessions', icon: '💬', label: 'Sessions' },
  { id: 'costs', icon: '💰', label: 'Costs' },
  { id: 'memory', icon: '🧠', label: 'Memory' },
]

type FilterType = 'all' | 'active' | 'idle'

export default function MobileApp() {
  const { getToken } = useAuth()
  const { connected, gatewayUrl } = useGatewayStore()
  const { sessions, getStatus, getLastActivityMs } = useSessionStore()
  const { isHidden, hide: hideSession, hydrateFromServer: hydrateHidden } = useHiddenStore()
  const { setSessions } = useSessionStore()
  const { hydrateFromServer: hydrateProjects } = useProjectStore()
  const { labels, setLabel } = useLabelStore()

  const hydrateAll = useCallback(async () => {
    const token = await getToken() || undefined
    await Promise.all([
      hydrateHidden(token),
      hydrateProjects(token),
    ])
    // Fetch server-side session labels
    const authHeader = token ? { Authorization: `Bearer ${token}` } : {}
    fetch('/api/session-labels', { headers: authHeader })
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

  // Fetch projects list for new-session picker
  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then((data: Array<{id: string; name: string; slug: string; emoji?: string; color?: string}>) => {
        if (Array.isArray(data)) setAvailableProjects(data.filter(p => p.slug !== 'others'))
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
  }), [sessionFingerprint, hideAgentSessions, hideHeartbeat, hideCron])

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

  if (fullChatSession) {
    return <MobileFullChat
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
    />
  }

  if (activeProject) {
    return <MobileProjectView project={activeProject} onBack={() => setActiveProject(null)} onSwitchProject={(p) => setActiveProject(p)} />
  }

  return (
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
            <span className="text-xl">🐙</span>
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
        {tab === 'projects' && (
          <ProjectsGrid onOpenProject={(p) => setActiveProject(p)} />
        )}

        {tab === 'sessions' && (
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
                  <div className="text-4xl mb-3">🐙</div>
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
                        onClick={() => setFullChatSession(s)}
                        className="flex-1 flex items-center gap-3 px-4 py-3.5 active:bg-[#1e2330] text-left min-w-0"
                      >
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
                        <span className="flex-1 text-sm text-white truncate min-w-0">{lbl}</span>
                        <span className="text-xs shrink-0 font-medium" style={{ color: statusColor }}>{statusLabel}</span>
                        {ago && <span className="text-xs text-[#4b5563] shrink-0 ml-1.5">{ago}</span>}
                        <span className="text-[#4b5563] shrink-0 ml-1">›</span>
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

        {tab === 'costs' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
              <h1 className="text-white font-semibold text-sm">💰 Costs</h1>
            </div>
            <CostsPanel />
          </div>
        )}

        {tab === 'memory' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
              <h1 className="text-white font-semibold text-sm">🧠 Memory</h1>
            </div>
            <MemoryPanel />
          </div>
        )}
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

      {/* Floating bug report button */}
      <button
        onClick={() => setShowIssueReporter(true)}
        className="fixed bottom-20 right-4 z-40 w-10 h-10 rounded-full bg-[#181c24] border border-[#2a3142] text-base shadow-lg flex items-center justify-center hover:bg-[#2a3142] transition-colors"
        style={{ bottom: 'calc(4rem + max(0.5rem, env(safe-area-inset-bottom)) + 0.5rem)' }}
        title="Report an issue"
      >
        🐛
      </button>

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

      {/* Archive toast */}
      {archiveToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-[#1e2330] border border-[#2a3142] text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-lg pointer-events-none whitespace-nowrap">
          {archiveToast}
        </div>
      )}
    </div>
  )
}
