import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSessionStore, useProjectStore, useLabelStore, useHiddenStore, Session } from '../store/gatewayStore'
import MobileFullChat from './MobileFullChat'
import type { Project } from './ProjectsGrid'

interface MobileProjectViewProps {
  project: Project
  onBack: () => void
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function MobileProjectView({ project, onBack }: MobileProjectViewProps) {
  const { getToken } = useAuth()
  const { sessions, getStatus } = useSessionStore()
  const { getTag, setTag } = useProjectStore()
  const { getLabel } = useLabelStore()
  const { isHidden } = useHiddenStore()
  const [openSession, setOpenSession] = useState<Session | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  const projectSessions = sessions.filter((s: Session) =>
    getTag(s.key).project === project.slug && !isHidden(s.key) && !isHidden(s.id || '')
  )

  const untaggedSessions = sessions.filter((s: Session) =>
    !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '')
  )

  const handleTag = async (sessionKey: string) => {
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey, projectTag: project.slug }),
    })
    setTag(sessionKey, project.slug)
    setShowPicker(false)
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
    return <MobileFullChat session={openSession} onBack={() => setOpenSession(null)} />
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
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center text-lg shrink-0"
            style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
          >
            {project.emoji}
          </div>
          <span className="text-white font-semibold text-sm flex-1 truncate">{project.name}</span>
          <button
            onClick={() => setShowPicker(true)}
            className="text-xs text-[#6366f1] hover:text-[#818cf8] transition-colors px-2 py-1"
          >
            + Add
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {projectSessions.length === 0 && !showPicker ? (
          <div className="flex flex-col items-center justify-center h-full pb-12 text-center">
            <div
              className="w-16 h-16 rounded-3xl flex items-center justify-center text-4xl mb-4"
              style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
            >
              {project.emoji}
            </div>
            <div className="text-[#6b7280] text-sm mb-4">No sessions in {project.name} yet.</div>
            <button
              onClick={() => setShowPicker(true)}
              className="bg-[#6366f1] text-white px-5 py-2.5 rounded-xl text-sm font-medium"
            >
              + Add existing session
            </button>
          </div>
        ) : (
          projectSessions.map((s: Session) => {
            const status = getStatus(s)
            const label = getLabel(s.key) || s.label || s.key
            return (
              <button
                key={s.key}
                onClick={() => setOpenSession(s)}
                className="w-full text-left bg-[#181c24] hover:bg-[#1e2330] border border-[#2a3142] rounded-2xl px-4 py-3.5 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: statusColors[status] || statusColors.quiet }}
                  />
                  <span className="text-white text-sm font-medium flex-1 truncate">{label}</span>
                  <span
                    className="text-xs shrink-0"
                    style={{ color: statusColors[status] || statusColors.quiet }}
                  >
                    {(statusLabels[status] || '🔵 Quiet').split(' ').slice(1).join(' ')}
                  </span>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* Session picker overlay */}
      {showPicker && (
        <div className="absolute inset-0 bg-[#0f1117]/90 backdrop-blur-sm z-50 flex flex-col"
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="bg-[#181c24] border-b border-[#2a3142] px-4 py-3 flex items-center gap-3">
            <button onClick={() => setShowPicker(false)} className="text-[#6366f1] font-semibold text-base w-8">←</button>
            <span className="text-white font-semibold text-sm">Add to {project.name}</span>
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
    </div>
  )
}
