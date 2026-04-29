import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { useSessionStore, useProjectStore, useLabelStore, useHiddenStore, useGatewayStore, Session } from '../store/gatewayStore'
import { useAuthStore } from '../store/authStore'
import { authFetch } from '../lib/authFetch'
import MobileFullChat from './MobileFullChat'
import type { Project } from './ProjectsGrid'

interface MobileProjectViewProps {
  project: Project
  onBack: () => void
  onSwitchProject?: (project: Project) => void
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function MobileProjectView({ project, onBack, onSwitchProject }: MobileProjectViewProps) {
  const { getToken } = useAuth()
  // Selective subscriptions: sessions and hiddenSessions only re-render this component
  // when the session list itself changes, not on every streaming token or chat event.
  const sessions = useSessionStore(s => s.sessions)
  const hiddenSessions = useSessionStore(s => s.hiddenSessions)
  const getStatus = useSessionStore(s => s.getStatus)
  const setSessions = useSessionStore(s => s.setSessions)
  const setPendingProjectPrefix = useSessionStore(s => s.setPendingProjectPrefix)
  const setPendingProjectInit = useSessionStore(s => s.setPendingProjectInit)
  // Helper to read live sessions from store (avoids stale closure in async handlers)
  const getLiveSessions = () => useSessionStore.getState().sessions
  const { getTag, setTag, getProjectEmoji } = useProjectStore()
  const { getLabel } = useLabelStore()
  const { isHidden, hide: hideSession, unhide: unhideSession } = useHiddenStore()
  const { send, agentId } = useGatewayStore()
  const { mainAgentId } = useAuthStore()

  const getAgentBadge = (sessionKey: string): { emoji: string; label: string } | null => {
    const m = (sessionKey || '').match(/^agent:([^:]+):/)
    const aid = m?.[1]
    if (!aid || aid === (mainAgentId || 'main')) return null
    const BADGES: Record<string, { emoji: string; label: string }> = {
      haiku: { emoji: '⚡', label: 'Haiku' },
      minimax: { emoji: '🔧', label: 'MiniMax' },
      gemini: { emoji: '✨', label: 'Gemini' },
      opus: { emoji: '🔮', label: 'Opus' },
    }
    return BADGES[aid] || { emoji: '🤖', label: aid }
  }

  // Track session keys that existed before we created a new session,
  // so we can detect the real gateway-assigned key when sessions.list fires.
  const pendingTagRef = useRef<{ pendingKey: string; slug: string } | null>(null)

  // When a new session appears in the store (sessions.list fired), apply the pending project tag.
  // Match by timestamp suffix only — `session-<ts>` -> `agent:<id>:session-<ts>`.
  // This prevents accidentally tagging concurrent subagent/Slack sessions with the wrong project.
  useEffect(() => {
    if (!pendingTagRef.current) return
    const { pendingKey, slug } = pendingTagRef.current
    const tsMatch = pendingKey.match(/^session-(\d+)$/)
    if (!tsMatch) return
    const ts = tsMatch[1]
    const matched = sessions.find((s: Session) => s.key.endsWith(`:session-${ts}`))
    if (!matched) return
    pendingTagRef.current = null
    setTag(matched.key, slug)
    authFetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: matched.key, projectTag: slug }),
    }).catch(() => {})
    // Update pendingNewSession to the real key so pill strip stays accurate
    setPendingNewSession(matched)
    // Only force-navigate to the new session if the user is still on the temp session
    // or on the project list. If they've already switched to a different real session,
    // don't interrupt — they can find the new session in the pill strip or project list.
    setOpenSession(prev => (prev === null || prev.key === pendingKey) ? matched : prev)
  }, [sessions])
  const [openSession, setOpenSession] = useState<Session | null>(null)
  // Track the most-recently created (pending) session so it stays pinned in the pill strip
  // even after the user swipes to another session. Cleared when the real key arrives.
  const [pendingNewSession, setPendingNewSession] = useState<Session | null>(null)
  // Track keys just archived so they're excluded from the strip immediately (before isHidden propagates)
  const [justArchivedKeys, setJustArchivedKeys] = useState<Set<string>>(new Set())
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const { setLabel: saveLabelLocal } = useLabelStore()
  const { send: wsSend } = useGatewayStore()

  const startRename = (s: Session, currentLabel: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenamingKey(s.key)
    setRenameValue(currentLabel)
  }

  const commitRename = async (s: Session) => {
    const trimmed = renameValue.trim()
    setRenamingKey(null)
    if (!trimmed || trimmed === (getLabel(s.key) || s.label || s.key)) return
    saveLabelLocal(s.key, trimmed)
    wsSend({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { key: s.key, label: trimmed } })
    authFetch(`${API}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: s.key, label: trimmed }),
    }).catch(() => {})
  }

  const [longPressSession, setLongPressSession] = useState<Session | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressDetectedRef = useRef(false)
  const [showPicker, setShowPicker] = useState(false)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [restoringSession, setRestoringSession] = useState<Session | null>(null)
  const [allProjects, setAllProjects] = useState<Project[]>([])
  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then(d => setAllProjects(d.projects || []))
      .catch(() => {})
  }, [])

  // Re-hydrate project tags whenever this view mounts (catches timing issues
  // where the user opens a project before initial hydrateAll completes)
  useEffect(() => {
    const { hydrateFromServer } = useProjectStore.getState()
    getToken().then(token => hydrateFromServer(token || undefined)).catch(() => {})
  }, [])

  const handleTodoNewSession = async (text: string) => {
    const key = `session-${Date.now()}`
    const newSession: Session = { key, label: text.slice(0, 40), sessionKey: key } as Session
    // Snapshot keys before creation so we can detect the real gateway-assigned key
    pendingTagRef.current = { pendingKey: key, slug: project.slug }
    setSessions([newSession, ...getLiveSessions()])
    setTag(key, project.slug)
    setOpenSession(newSession)
    // Send first message immediately (no delay) — gateway creates real session with its own key
    send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: key, message: text, idempotencyKey: `octis-proj-${Date.now()}-${Math.random().toString(36).slice(2)}` } })
    // Trigger sessions.list refresh after send so the real session key is detected
    setTimeout(() => {
      send({ type: 'req', id: `sessions-list-${Date.now()}`, method: 'sessions.list', params: {} })
    }, 800)
    // Also persist the tag to server async
    authFetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: key, projectTag: project.slug }),
    }).catch(() => {})
  }

  const isAgentSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    // Only hide background subagents — ACP sessions are user-spawned, keep them visible
    if (key.includes(':subagent:')) return true
    const lbl = (s.label || '').toLowerCase()
    return lbl.startsWith('continue where you left off')
  }

  const isOthers = project.slug === 'others'
  const isArchived = project.slug === 'archived'

  const projectSessions = (isArchived ? hiddenSessions : sessions)
    .filter((s: Session) => {
      if (isArchived) return true
      if (isOthers) return !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '') && !isAgentSession(s)
      return getTag(s.key).project === project.slug && !isHidden(s.key) && !isHidden(s.id || '') && !isAgentSession(s)
    })
    .sort((a, b) => {
      if (!isArchived) return 0
      const ta = a.lastActivity ? new Date(a.lastActivity as string).getTime() : 0
      const tb = b.lastActivity ? new Date(b.lastActivity as string).getTime() : 0
      return tb - ta
    })

  const untaggedSessions = sessions.filter((s: Session) =>
    !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '') && !isAgentSession(s)
  )

  const handleNewSession = async () => {
    // Create a real gateway session key via the API (same as Sidebar.tsx for main agent).
    // Using a temp key `session-<ts>` is unreliable because setSessions now filters it out
    // via the mainAgentId isolation guard (ef7582e regression — owners lost the bypass).
    // A real `agent:main:session-<ts>` key passes the isolation filter automatically.
    const placeholderLabel = `New ${project.name} session`
    const placeholderKey = `session-${Date.now()}`
    const placeholder: Session = { key: placeholderKey, label: placeholderLabel, sessionKey: placeholderKey } as Session

    // Show the chat immediately with a placeholder so the tap feels instant
    useAuthStore.getState().claimSession(placeholderKey)
    pendingTagRef.current = { pendingKey: placeholderKey, slug: project.slug }
    setSessions([placeholder, ...getLiveSessions()])
    setTag(placeholderKey, project.slug)
    setShowPicker(false)
    setPendingNewSession(placeholder)
    setOpenSession(placeholder)
    setPendingProjectInit(placeholderKey, project.slug)

    // Fire real session creation in background; swap key when it resolves
    authFetch(`${API}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'main' }),
    }).then(async r => {
      if (!r.ok) return
      const data = await r.json() as { ok: boolean; sessionKey?: string }
      const realKey = data.sessionKey
      if (!realKey) return
      // Claim real key and tag it
      useAuthStore.getState().claimSession(realKey)
      setTag(realKey, project.slug)
      // Persist tag + pending init under real key
      authFetch(`${API}/api/session-projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: realKey, projectTag: project.slug, skipInject: true }),
      }).catch(() => {})
      // Transfer pending project init from placeholder to real key
      setPendingProjectInit(realKey, project.slug)
      // Replace open session with real key so chat sends go to the right place
      const realSession: Session = { key: realKey, label: placeholderLabel, sessionKey: realKey } as Session
      setSessions([realSession, ...getLiveSessions().filter(s => s.key !== placeholderKey)])
      setPendingNewSession(realSession)
      setOpenSession(realSession)
    }).catch(() => {
      // Keep placeholder open — first send will still create the gateway session
    })
  }

  const handleLongPressStart = (s: Session) => {
    longPressDetectedRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressDetectedRef.current = true
      setLongPressSession(s)
    }, 500)
  }

  const handleLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const handleMoveTo = async (sessionKey: string, newSlug: string) => {
    setTag(sessionKey, newSlug)
    setLongPressSession(null)
    // Close the open pane if the reassigned session was in it
    if (openSession?.key === sessionKey) setOpenSession(null)
    authFetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, projectTag: newSlug }),
    }).catch(() => {})
  }

  const handleTag = async (sessionKey: string, targetSlug?: string) => {
    const slug = targetSlug ?? project.slug
    // Optimistic: update UI immediately
    setTag(sessionKey, slug)
    setShowPicker(false)
    setRestoringSession(null)
    // Persist async
    authFetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, projectTag: slug }),
    }).catch(() => {})
  }

  const statusColors: Record<string, string> = {
    working: '#a855f7',
    'needs-you': '#3b82f6',
    stuck: '#f59e0b',
    active: '#22c55e',
    quiet: '#6b7280',
  }
  const statusLabels: Record<string, string> = {
    working: '⚙️ Working',
    'needs-you': '💬 Needs you',
    stuck: '⚠️ Stuck?',
    active: '🟢 Active',
    quiet: '🔵 Quiet',
  }

  if (openSession) {
    // Build recent sessions list: always include the current open session even if it
    // still has a temp key (session-<ts>) — that regex filter would otherwise hide it
    // until the gateway fires sessions.list after the first message.
    const recentSessionsForChat = (() => {
      const filtered = sessions.filter((s: Session) =>
        !isHidden(s.key) && !justArchivedKeys.has(s.key) && !isAgentSession(s) && !/^session-\d+$/.test(s.key)
      ).slice(0, 10)
      const result: Session[] = [...filtered]
      // Include current openSession only if not archived
      const currentArchived = justArchivedKeys.has(openSession.key) || isHidden(openSession.key)
      if (!currentArchived && !result.find(s => s.key === openSession.key)) result.unshift(openSession)
      // Pin pending new session in strip so temp key stays visible until real key arrives
      if (pendingNewSession && !result.find(s => s.key === pendingNewSession.key)) {
        result.unshift(pendingNewSession)
      }
      return result.slice(0, 10)
    })()
    return <MobileFullChat
      key={openSession.key}
      session={openSession}
      onBack={() => setOpenSession(null)}
      recentSessions={recentSessionsForChat}
      onSwitch={(s) => setOpenSession(s)}
      onArchive={() => {
        const keyToHide = openSession.key
        const idToHide = openSession.id
        // Mark as archived immediately so strip removes it this render
        setJustArchivedKeys(prev => { const s = new Set(prev); s.add(keyToHide); if (idToHide) s.add(idToHide); return s })
        hideSession(keyToHide)
        if (idToHide) hideSession(idToHide)
        if (pendingNewSession?.key === keyToHide) setPendingNewSession(null)
        // Jump to next session in project, or go to list if none left
        const remaining = projectSessions.filter((s: Session) => s.key !== keyToHide)
        setOpenSession(remaining.length > 0 ? remaining[0] : null)
      }}
    />
  }

  return (
    <div className="flex flex-col bg-[#0f1117] overflow-hidden" style={{ height: '100dvh' }}>
      {/* Header */}
      <div
        className="bg-[#181c24] border-b border-[#2a3142] shrink-0"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={onBack}
            className="text-[#6366f1] text-base font-semibold w-8 flex items-center justify-center"
          >
            ←
          </button>
          <button
            onClick={() => onSwitchProject && setShowProjectSwitcher(true)}
            className="flex items-center gap-2 flex-1 min-w-0 text-left"
            disabled={!onSwitchProject}
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center text-lg shrink-0"
              style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
            >
              {project.emoji}
            </div>
            <span className="text-white font-semibold text-sm truncate">{project.name}</span>
            {onSwitchProject && <span className="text-[#4b5563] text-xs shrink-0">⌄</span>}
          </button>
          {!isOthers && !isArchived && (
            <button
              onClick={() => setShowPicker(true)}
              className="text-xs text-[#6b7280] hover:text-white transition-colors px-1 py-1"
              title="Assign existing session to this project"
            >
              Assign
            </button>
          )}
          {!isOthers && !isArchived && (
            <button
              onClick={handleNewSession}
              className="w-7 h-7 rounded-full bg-[#6366f1] text-white flex items-center justify-center text-lg font-light leading-none active:bg-[#818cf8] shrink-0"
              title="New session in this project"
            >
              +
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        {projectSessions.length === 0 && !showPicker ? (
          <div className="flex flex-col items-center justify-center h-full pb-12 text-center">
            <div
              className="w-16 h-16 rounded-3xl flex items-center justify-center text-4xl mb-4"
              style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
            >
              {project.emoji}
            </div>
            <div className="text-[#6b7280] text-sm mb-4">
              {isOthers ? 'All your sessions are assigned to projects.' : `No sessions in ${project.name} yet.`}
            </div>
            {!isOthers && (
              <>
                <button
                  onClick={handleNewSession}
                  className="bg-[#6366f1] text-white px-5 py-2.5 rounded-xl text-sm font-medium"
                >
                  ✶ New session
                </button>
                <button
                  onClick={() => setShowPicker(true)}
                  className="mt-2 text-[#6b7280] text-sm hover:text-white transition-colors"
                >
                  or add existing
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
          {projectSessions.map((s: Session) => {
            const status = getStatus(s)
            const label = getLabel(s.key) || s.label || s.key
            return (
              <div
                key={s.key}
                className="flex items-center bg-[#181c24] border border-[#2a3142] rounded-2xl overflow-hidden"
                style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
              >
                {renamingKey === s.key ? (
                  <input
                    autoFocus
                    className="flex-1 min-w-0 bg-[#0f1117] border border-[#6366f1] rounded-xl px-4 py-3 text-sm text-white outline-none"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitRename(s); if (e.key === 'Escape') setRenamingKey(null) }}
                    onBlur={() => commitRename(s)}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                <button
                  onClick={() => { if (longPressDetectedRef.current) { longPressDetectedRef.current = false; return } setOpenSession(s) }}
                  onTouchStart={(e) => { e.currentTarget.style.webkitTapHighlightColor = 'transparent'; handleLongPressStart(s) }}
                  onTouchEnd={handleLongPressEnd}
                  onTouchMove={handleLongPressEnd}
                  className="flex-1 min-w-0 text-left px-4 py-3.5 hover:bg-[#1e2330] transition-colors overflow-hidden"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: statusColors[status] || statusColors.quiet }}
                    />
                    <span className="text-white text-sm font-medium flex-1 min-w-0 truncate flex items-center gap-1">
                      {label}
                      {(() => {
                        const badge = getAgentBadge(s.key)
                        return badge ? <span className="text-[10px] text-[#6b7280] bg-[#1a1d2e] px-1 rounded flex-shrink-0" title={badge.label}>{badge.emoji}</span> : null
                      })()}
                    </span>
                    <span
                      className="text-xs shrink-0"
                      style={{ color: statusColors[status] || statusColors.quiet }}
                    >
                      {(statusLabels[status] || '🔵 Quiet').split(' ').slice(1).join(' ')}
                    </span>
                  </div>
                </button>
                )}
                <button
                  onClick={(e) => startRename(s, label, e)}
                  className="px-3 py-3.5 text-[#4b5563] hover:text-[#a5b4fc] transition-colors border-l border-[#2a3142] shrink-0"
                  title="Rename"
                >
                  ✏️
                </button>
                {!isArchived ? (
                  <button
                    onClick={() => {
                      hideSession(s.key)
                      if (s.id) hideSession(s.id)
                    }}
                    className="px-3 py-3.5 text-[#4b5563] hover:text-red-400 transition-colors border-l border-[#2a3142] shrink-0"
                    title="Archive"
                  >
                    🗑
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      unhideSession(s.key)
                      if (s.id) unhideSession(s.id)
                      setRestoringSession(s)
                    }}
                    className="px-3 py-3.5 text-[#4b5563] hover:text-[#6366f1] transition-colors border-l border-[#2a3142] shrink-0"
                    title="Restore"
                  >
                    ↩
                  </button>
                )}
              </div>
            )
          })}

          </div>
        )}
      </div>

      {/* Project switcher sheet */}
      {showProjectSwitcher && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowProjectSwitcher(false)} />
          <div className="relative bg-[#181c24] rounded-t-3xl border-t border-[#2a3142] px-4 pt-4 pb-6">
            <div className="w-10 h-1 bg-[#2a3142] rounded-full mx-auto mb-4" />
            <div className="text-[#6b7280] text-xs font-medium mb-3 px-1">Switch project</div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {allProjects.filter(p => p.slug !== '__archived').map(p => (
                <button
                  key={p.id}
                  onClick={() => { setShowProjectSwitcher(false); onSwitchProject?.(p) }}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors ${
                    p.slug === project.slug
                      ? 'bg-[#6366f1]/20 border border-[#6366f1]/40'
                      : 'hover:bg-[#2a3142]'
                  }`}
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
                    style={{ background: p.color + '22', border: `1px solid ${p.color}44` }}
                  >
                    {p.emoji}
                  </div>
                  <span className={`text-sm font-medium ${ p.slug === project.slug ? 'text-[#a5b4fc]' : 'text-white' }`}>
                    {p.name}
                  </span>
                  {p.slug === project.slug && <span className="ml-auto text-[#6366f1] text-xs">current</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Move to project bottom sheet */}
      {longPressSession && (
        <div
          className="absolute inset-0 z-50 flex flex-col justify-end"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="absolute inset-0 bg-black/60" onClick={() => setLongPressSession(null)} />
          <div className="relative bg-[#181c24] rounded-t-3xl border-t border-[#2a3142] px-4 pt-4 pb-6">
            <div className="w-10 h-1 bg-[#2a3142] rounded-full mx-auto mb-4" />
            <div className="text-[#6b7280] text-xs font-medium mb-1 px-1">Move to project</div>
            <div className="text-white text-sm font-medium mb-3 px-1 truncate">
              {getLabel(longPressSession.key) || longPressSession.label || longPressSession.key}
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {allProjects
                .filter(p => p.slug !== getTag(longPressSession.key).project && p.slug !== '__archived')
                .map(p => (
                  <button
                    key={p.id}
                    onClick={() => handleMoveTo(longPressSession.key, p.slug)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[#2a3142] transition-colors"
                  >
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
                      style={{ background: p.color + '22', border: `1px solid ${p.color}44` }}
                    >
                      {p.emoji}
                    </div>
                    <span className="text-sm font-medium text-white">{p.name}</span>
                  </button>
                ))
              }
              {getTag(longPressSession.key).project && getTag(longPressSession.key).project !== 'others' && (
                <button
                  onClick={() => handleMoveTo(longPressSession.key, '')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[#2a3142] transition-colors"
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

      {/* Session picker overlay */}
      {showPicker && (
        <div className="absolute inset-0 bg-[#0f1117]/90 backdrop-blur-sm z-50 flex flex-col"
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="bg-[#181c24] border-b border-[#2a3142] px-4 py-3 flex items-center gap-3">
            <button onClick={() => setShowPicker(false)} className="text-[#6366f1] font-semibold text-base w-8">←</button>
            <span className="text-white font-semibold text-sm">Assign to {project.name}</span>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {untaggedSessions.length === 0 ? (
              <div className="text-[#6b7280] text-sm text-center py-8">All sessions are already tagged to a project.</div>
            ) : (
              untaggedSessions.map((s: Session) => {
                const label = getLabel(s.key) || s.label || s.key
                return (
                  <button
                    key={s.key}
                    onClick={() => handleTag(s.key)}
                    className="w-full text-left bg-[#1e2330] hover:bg-[#2a3142] rounded-xl px-4 py-3 text-sm text-white transition-colors"
                  >
                    {label}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* Restore session — project picker */}
      {restoringSession && (
        <div className="absolute inset-0 bg-[#0f1117]/90 backdrop-blur-sm z-50 flex flex-col"
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="bg-[#181c24] border-b border-[#2a3142] px-4 py-3 flex items-center gap-3">
            <button onClick={() => setRestoringSession(null)} className="text-[#6366f1] font-semibold text-base w-8">←</button>
            <span className="text-white font-semibold text-sm">Move to project</span>
          </div>
          <div className="px-4 pt-2 pb-1">
            <p className="text-[#6b7280] text-xs py-2">
              “{getLabel(restoringSession.key) || restoringSession.label || restoringSession.key}” was restored.
              Choose a project, or skip to leave it untagged.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
            {allProjects.filter(p => p.slug !== 'others' && p.slug !== 'archived').map(p => (
              <button
                key={p.slug}
                onClick={() => handleTag(restoringSession.key, p.slug)}
                className="w-full text-left bg-[#1e2330] hover:bg-[#2a3142] rounded-xl px-4 py-3 text-sm text-white transition-colors flex items-center gap-3"
              >
                <span className="text-lg">{p.emoji || '📁'}</span>
                <span>{p.name}</span>
              </button>
            ))}
            <button
              onClick={() => setRestoringSession(null)}
              className="w-full text-center text-[#6b7280] py-3 text-sm"
            >
              Skip — leave untagged
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
