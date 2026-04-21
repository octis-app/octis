import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSessionStore, useProjectStore, useLabelStore, useHiddenStore, useGatewayStore, Session } from '../store/gatewayStore'
import ChatPane from './ChatPane'
import type { Project } from './ProjectsGrid'

interface ProjectViewProps {
  project: Project
  onBack: () => void
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function ProjectView({ project, onBack }: ProjectViewProps) {
  const { getToken } = useAuth()
  const { sessions, getStatus, setSessions, setPendingProjectPrefix, setPendingProjectInit } = useSessionStore()
  const { getTag, setTag } = useProjectStore()
  const { getLabel, setLabel } = useLabelStore()
  const { isHidden } = useHiddenStore()
  const { send } = useGatewayStore()
  // Local pane state — independent of the shared activePanes (Sessions view)
  const [localPanes, setLocalPanes] = useState<(string | null)[]>([null, null, null, null, null, null, null, null])
  const [activeSession, setActiveSession] = useState<string | null>(null)

  // Reset panes when switching projects (avoids stale panes from previous visit)
  useEffect(() => {
    setLocalPanes([null, null, null, null, null, null, null, null])
    setActiveSession(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.slug])
  const [tagging, setTagging] = useState<string | null>(null) // session key being tagged
  const [editingSessionKey, setEditingSessionKey] = useState<string | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const _editInputRef = useRef<HTMLInputElement | null>(null)
  const handleTodoNewSession = async (text: string) => {
    const key = `session-${Date.now()}`
    const newSession: Session = { key, label: text.slice(0, 40), sessionKey: key } as Session
    setSessions([newSession, ...sessions])
    const freshPanes: (string | null)[] = [null, null, null, null, null, null, null, null]
    freshPanes[0] = key
    setLocalPanes(freshPanes)
    setActiveSession(key)
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey: key, projectTag: project.slug }),
    })
    setTag(key, project.slug)
    setPendingProjectPrefix(key, text)
  }

  // Never show subagent/ACP sessions
  const isAgentSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    if (key.includes(':subagent:') || key.includes(':acp:')) return true
    const lbl = (s.label || '').toLowerCase()
    return lbl.startsWith('continue where you left off')
  }

  // Sessions belonging to this project (not hidden, not subagent)
  const isOthers = project.slug === 'others'

  const projectSessions = sessions.filter((s: Session) => {
    if (isOthers) return !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '') && !isAgentSession(s)
    return getTag(s.key).project === project.slug && !isHidden(s.key) && !isHidden(s.id || '') && !isHidden(s.sessionId || '') && !isAgentSession(s)
  })

  // Default to most recent active session on mount / when project sessions first load
  useEffect(() => {
    if (!activeSession && projectSessions.length > 0) {
      const active = projectSessions.find(s => {
        const st = getStatus(s)
        return st === 'active' || st === 'needs-you' || st === 'working'
      })
      const target = active || projectSessions[0]
      setActiveSession(target.key)
      setLocalPanes(prev => { const next = [...prev]; next[0] = target.key; return next })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSessions.length])

  // Open a session in the next available local pane slot — no duplicates
  const openInNextPane = useCallback((key: string) => {
    setLocalPanes(prev => {
      if (prev.some(p => p === key)) {
        setActiveSession(key)
        return prev
      }
      const next = [...prev]
      const empty = next.findIndex(p => !p)
      const target = empty === -1 ? 0 : empty
      next[target] = key
      setActiveSession(key)
      return next
    })
  }, [])

  // Close a pane and compact remaining (no gaps)
  const handleClosePane = useCallback((i: number) => {
    setLocalPanes(prev => {
      // Find the actual index in the full array by counting non-null entries
      const filled = prev.map((v, idx) => ({ v, idx })).filter(x => x.v)
      const target = filled[i]
      if (!target) return prev
      const next = [...prev]
      next[target.idx] = null
      const remaining = next.filter(Boolean)
      setActiveSession((remaining[0] as string | null) ?? null)
      return next
    })
  }, [])

  // Create a brand-new session in this project
  const handleNewSession = async () => {
    const key = `session-${Date.now()}`
    const label = `New ${project.name} session`
    const newSession: Session = { key, label, sessionKey: key } as Session
    // Set state synchronously before await to prevent useEffect race
    setSessions([newSession, ...sessions])
    // Open in a fresh single pane (clears stale panes from previous visit)
    const freshPanes: (string | null)[] = [null, null, null, null, null, null, null, null]
    freshPanes[0] = key
    setLocalPanes(freshPanes)
    setActiveSession(key)
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey: key, projectTag: project.slug }),
    })
    setTag(key, project.slug)
    // Defer context injection until user actually sends a message
    setPendingProjectInit(key, project.slug)
  }

  // Tag a session to this project
  const handleTagSession = async (sessionKey: string) => {
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey, projectTag: project.slug }),
    })
    setTag(sessionKey, project.slug)
    setTagging(null)
    openInNextPane(sessionKey)
  }

  const handleSessionRename = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) {
      setLabel(key, trimmed)
      send({
        type: 'req',
        id: `sessions-patch-${Date.now()}`,
        method: 'sessions.patch',
        params: { sessionKey: key, patch: { label: trimmed } },
      })
      void fetch(`${API}/api/session-rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: key, label: trimmed }),
      })
    }
    setEditingSessionKey(null)
  }

  const handleSelectSession = (s: Session) => {
    openInNextPane(s.key)
    setTagging(null)
  }

  const statusColors: Record<string, string> = {
    working: '#a855f7',
    'needs-you': '#3b82f6',
    stuck: '#f59e0b',
    active: '#22c55e',
    quiet: '#6b7280',
  }
  const statusLabels: Record<string, string> = {
    working: 'Working',
    'needs-you': 'Needs you',
    stuck: 'Stuck?',
    active: 'Active',
    quiet: 'Quiet',
  }

  // Untagged sessions (for the "Add existing session" panel)
  const untaggedSessions = sessions.filter((s: Session) =>
    !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '')
  )

  return (
    <div className="flex flex-1 h-full min-w-0 bg-[#0f1117]">
      {/* Left sidebar: project sessions */}
      <div className="w-64 shrink-0 flex flex-col bg-[#0a0d14] border-r border-[#1e2330]">
        {/* Header */}
        <div className="px-4 py-4 border-b border-[#1e2330]">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[#6b7280] hover:text-white text-xs mb-3 transition-colors"
          >
            ← Projects
          </button>
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-xl shrink-0"
              style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
            >
              {project.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white font-semibold text-sm">{project.name}</div>
              <div className="text-[#4b5563] text-[10px]">{projectSessions.length} session{projectSessions.length !== 1 ? 's' : ''}</div>
            </div>
            <button
              onClick={handleNewSession}
              title="New session in this project"
              className="w-7 h-7 rounded-lg bg-[#6366f1] hover:bg-[#818cf8] text-white flex items-center justify-center text-sm transition-colors shrink-0"
            >
              ✦
            </button>
          </div>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto py-2">
          {projectSessions.length === 0 ? (
            <div className="px-4 py-4 text-center">
              <div className="text-[#4b5563] text-xs mb-3">No sessions in this project yet.</div>
              <button
                onClick={() => setTagging('picker')}
                className="text-xs text-[#6366f1] hover:text-[#818cf8] transition-colors"
              >
                + Add existing session
              </button>
            </div>
          ) : (
            <>
              {projectSessions.map((s: Session) => {
                const status = getStatus(s)
                const label = getLabel(s.key) || s.label || s.key
                const isOpen = localPanes.some(p => p === s.key)
                const isActive = isOpen || s.key === activeSession
                return (
                  <div
                    key={s.key}
                    className={`group relative w-full text-left px-3 py-2.5 mx-1 rounded-lg transition-colors ${
                      isOpen ? 'bg-[#1e2330] cursor-default' : 'hover:bg-[#111520] cursor-pointer'
                    }`}
                    style={{ width: 'calc(100% - 8px)' }}
                    onClick={() => { if (editingSessionKey !== s.key && !isOpen) handleSelectSession(s) }}
                  >
                    {editingSessionKey === s.key ? (
                      <input
                        autoFocus
                        className="w-full bg-[#0f1117] border border-[#6366f1] rounded px-1.5 py-0.5 text-xs text-white outline-none"
                        value={editingLabelValue}
                        onChange={e => setEditingLabelValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSessionRename(s.key, editingLabelValue)
                          if (e.key === 'Escape') setEditingSessionKey(null)
                        }}
                        onBlur={() => handleSessionRename(s.key, editingLabelValue)}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: statusColors[status] || statusColors.quiet }}
                        />
                        <span className={`text-xs truncate flex-1 ${isActive ? 'text-white font-medium' : 'text-[#9ca3af]'}`}>
                          {label}
                        </span>
                        {isOpen && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-[#6366f1]/20 text-[#818cf8] shrink-0 font-medium">open</span>
                        )}

                      </div>
                    )}
                    {editingSessionKey !== s.key && (
                      <div className="text-[10px] text-[#4b5563] pl-3.5 mt-0.5">{statusLabels[status] || 'Quiet'}</div>
                    )}
                  </div>
                )
              })}
              <div className="px-4 pt-2 pb-1 flex items-center gap-3">
                <button
                  onClick={handleNewSession}
                  className="text-[10px] text-[#6366f1] hover:text-[#818cf8] transition-colors"
                >
                  + New session
                </button>
                <button
                  onClick={() => setTagging('picker')}
                  className="text-[10px] text-[#4b5563] hover:text-[#6366f1] transition-colors"
                >
                  + Add existing
                </button>
              </div>
            </>
          )}
        </div>

        {/* Session picker (tag existing session to project) */}
        {tagging === 'picker' && (
          <div className="border-t border-[#1e2330] px-3 py-3 bg-[#0f1117]">
            <div className="text-[10px] text-[#6b7280] mb-2 font-medium uppercase tracking-wider">Tag session to {project.name}</div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {untaggedSessions.length === 0 ? (
                <div className="text-[11px] text-[#4b5563]">All sessions are already tagged.</div>
              ) : (
                untaggedSessions.slice(0, 20).map((s: Session) => {
                  const label = getLabel(s.key) || s.label || s.key
                  return (
                    <button
                      key={s.key}
                      onClick={() => handleTagSession(s.key)}
                      className="w-full text-left text-xs text-[#9ca3af] hover:text-white hover:bg-[#1e2330] px-2 py-1.5 rounded-lg transition-colors truncate"
                    >
                      {label}
                    </button>
                  )
                })
              )}
            </div>
            <button
              onClick={() => setTagging(null)}
              className="text-[10px] text-[#4b5563] hover:text-white mt-2 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}


      </div>

      {/* Main: chat pane(s) */}
      <div className="flex-1 flex min-w-0">
        {activeSession ? (
          <>
            {localPanes.filter(Boolean).map((paneSession, i) =>
              paneSession ? (
                <ChatPane
                  key={paneSession}
                  sessionKey={paneSession}
                  paneIndex={i}
                  onClose={() => handleClosePane(i)}
                />
              ) : null
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#0f1117]">
            <div className="text-center max-w-sm">
              <div
                className="w-16 h-16 rounded-3xl flex items-center justify-center text-4xl mx-auto mb-4"
                style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
              >
                {project.emoji}
              </div>
              <div className="text-white font-semibold text-lg mb-2">{project.name}</div>
              {project.description && (
                <div className="text-[#6b7280] text-sm mb-4">{project.description}</div>
              )}
              <div className="text-[#4b5563] text-sm mb-4">
                No sessions yet. Tag an existing session to this project to get started.
              </div>
              <button
                onClick={() => setTagging('picker')}
                className="bg-[#6366f1] hover:bg-[#818cf8] text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                + Add session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
