import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useGatewayStore, useSessionStore, useHiddenStore, useProjectStore, useLabelStore, Session } from '../store/gatewayStore'
import MobileSessionCard from './MobileSessionCard'
import MobileFullChat from './MobileFullChat'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'
import ConnectModal from './ConnectModal'
import ProjectsGrid, { type Project } from './ProjectsGrid'
import MobileProjectView from './MobileProjectView'

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
  const { sessions, getStatus } = useSessionStore()
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
  const [tab, setTab] = useState('projects')
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [fullChatSession, setFullChatSession] = useState<Session | null>(null)
  const [showConnect, setShowConnect] = useState(!gatewayUrl)
  const [filter, setFilter] = useState<FilterType>('all')

  const handleArchive = (session: Session) => {
    if (!confirm(`Archive "${session.label || session.key}"?`)) return
    hideSession(session.key)
    if (session.id) hideSession(session.id)
    if (session.sessionId) hideSession(session.sessionId)
  }

  const handleNewSession = () => {
    const key = `session-${Date.now()}`
    setSessions([{ key, label: 'New session', sessionKey: key } as Session, ...sessions])
  }

  const visibleSessions = sessions.filter((s: Session) =>
    !isHidden(s.key) && !isHidden(s.id || '') && !isHidden(s.sessionId || '')
  )

  const filtered = visibleSessions.filter((s: Session) => {
    const st = getStatus(s)
    if (filter === 'active') return st === 'active'
    if (filter === 'idle') return st === 'quiet'
    return true
  })

  const counts = {
    active: visibleSessions.filter((s: Session) => getStatus(s) === 'active').length,
    idle: visibleSessions.filter((s: Session) => getStatus(s) === 'quiet').length,
  }

  if (fullChatSession) {
    return <MobileFullChat session={fullChatSession} onBack={() => setFullChatSession(null)} />
  }

  if (activeProject) {
    return <MobileProjectView project={activeProject} onBack={() => setActiveProject(null)} />
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
                onClick={handleNewSession}
                className="ml-auto px-3 py-1 rounded-full text-xs font-medium bg-[#6366f1] text-white active:bg-[#818cf8] shrink-0"
              >
                + New
              </button>
            </div>

            {/* Swipeable card carousel */}
            {filtered.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center px-8">
                  <div className="text-4xl mb-3">🐙</div>
                  <div className="text-[#6b7280] text-sm">
                    {sessions.length === 0
                      ? 'No sessions yet. Connect to your gateway to get started.'
                      : 'No sessions match this filter. Sessions may be archived on desktop.'}
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
              <div
                className="flex-1 overflow-x-auto overflow-y-hidden"
                style={{
                  scrollSnapType: 'x mandatory',
                  WebkitOverflowScrolling: 'touch',
                  scrollbarWidth: 'none',
                }}
              >
                <div
                  className="flex gap-4 px-4 h-full items-start pt-1 pb-3"
                  style={{ width: `calc(${filtered.length} * (100vw - 1rem))` }}
                >
                  {filtered.map((session: Session) => (
                    <MobileSessionCard
                      key={session.key}
                      session={session}
                      onOpenFull={setFullChatSession}
                      onArchive={handleArchive}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Swipe hint */}
            {filtered.length > 1 && (
              <div className="text-center py-1 shrink-0">
                <div className="flex justify-center gap-1.5">
                  {filtered.map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#2a3142]" />
                  ))}
                </div>
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

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}
