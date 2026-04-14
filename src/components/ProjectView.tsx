import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSessionStore, useProjectStore, useLabelStore, useHiddenStore, Session } from '../store/gatewayStore'
import ChatPane from './ChatPane'
import type { Project } from './ProjectsGrid'

interface ProjectViewProps {
  project: Project
  onBack: () => void
  paneCount: number
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function ProjectView({ project, onBack, paneCount }: ProjectViewProps) {
  const { getToken } = useAuth()
  const { sessions, getStatus, activePanes, pinToPane } = useSessionStore()
  const { getTag, setTag } = useProjectStore()
  const { getLabel } = useLabelStore()
  const { isHidden } = useHiddenStore()
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [tagging, setTagging] = useState<string | null>(null) // session key being tagged

  // Sessions belonging to this project (not hidden)
  const projectSessions = sessions.filter((s: Session) =>
    getTag(s.key).project === project.slug && !isHidden(s.key) && !isHidden(s.id || '') && !isHidden(s.sessionId || '')
  )

  // Default to most recent active session
  useEffect(() => {
    if (!activeSession && projectSessions.length > 0) {
      // prefer active/needs-you, fallback to first
      const active = projectSessions.find(s => {
        const st = getStatus(s)
        return st === 'active' || st === 'needs-you' || st === 'working'
      })
      const target = active || projectSessions[0]
      setActiveSession(target.key)
      pinToPane(0, target.key)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSessions.length])

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
    setActiveSession(sessionKey)
    pinToPane(0, sessionKey)
  }

  const handleSelectSession = (s: Session) => {
    setActiveSession(s.key)
    pinToPane(0, s.key)
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
    <div className="flex h-full bg-[#0f1117]">
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
            <div>
              <div className="text-white font-semibold text-sm">{project.name}</div>
              <div className="text-[#4b5563] text-[10px]">{projectSessions.length} session{projectSessions.length !== 1 ? 's' : ''}</div>
            </div>
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
                const isActive = s.key === activeSession
                return (
                  <button
                    key={s.key}
                    onClick={() => handleSelectSession(s)}
                    className={`w-full text-left px-3 py-2.5 mx-1 rounded-lg transition-colors ${
                      isActive ? 'bg-[#1e2330]' : 'hover:bg-[#111520]'
                    }`}
                    style={{ width: 'calc(100% - 8px)' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: statusColors[status] || statusColors.quiet }}
                      />
                      <span className={`text-xs truncate ${isActive ? 'text-white font-medium' : 'text-[#9ca3af]'}`}>
                        {label}
                      </span>
                    </div>
                    <div className="text-[10px] text-[#4b5563] pl-3.5 mt-0.5">{statusLabels[status] || 'Quiet'}</div>
                  </button>
                )
              })}
              <div className="px-4 pt-2 pb-1">
                <button
                  onClick={() => setTagging('picker')}
                  className="text-[10px] text-[#4b5563] hover:text-[#6366f1] transition-colors"
                >
                  + Add existing session
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
            {Array.from({ length: paneCount }).map((_, i) => {
              const paneSession = activePanes[i] || (i === 0 ? activeSession : null)
              return paneSession ? (
                <ChatPane
                  key={paneSession}
                  sessionKey={paneSession}
                  paneIndex={i}
                  onClose={() => {
                    pinToPane(i, null)
                    if (i === 0) setActiveSession(null)
                  }}
                />
              ) : (
                <div key={i} className="flex-1 flex items-center justify-center bg-[#0f1117] border-l border-[#1e2330]">
                  <div className="text-center">
                    <div className="text-[#4b5563] text-sm mb-2">Empty pane</div>
                    <div className="text-[#3a4152] text-xs">Select a session from the left</div>
                  </div>
                </div>
              )
            })}
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
