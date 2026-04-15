import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSessionStore, useProjectStore, useLabelStore, useHiddenStore, Session } from '../store/gatewayStore'
import { useGatewayStore, useHiddenStore } from '../store/gatewayStore'
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
  const { sessions, getStatus, setSessions } = useSessionStore()
  const { getTag, setTag } = useProjectStore()
  const { getLabel } = useLabelStore()
  const { isHidden, hide: hideSession } = useHiddenStore()
  const { send } = useGatewayStore()
  const [openSession, setOpenSession] = useState<Session | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [allProjects, setAllProjects] = useState<Project[]>([])
  const [todos, setTodos] = useState<Array<{ id: number; text: string; owner: string | null }>>([]) 
  const [todosOpen, setTodosOpen] = useState(false)

  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then(d => setAllProjects(d.projects || []))
      .catch(() => {})
  }, [])

  const refreshTodos = async () => {
    try {
      const token = await getToken()
      const r = await fetch(`${API}/api/todos`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      const data: Record<string, { items: Array<{ id: number; text: string; owner: string | null }> }> = await r.json()
      setTodos(data[project.slug]?.items || data[project.name]?.items || [])
    } catch {}
  }
  useEffect(() => { refreshTodos() }, [project.slug])

  const handleTodoComplete = async (id: number) => {
    await fetch(`${API}/api/todos/${id}/complete`, { method: 'PATCH' }).catch(() => {})
    refreshTodos()
  }

  const handleTodoNewSession = async (text: string) => {
    const key = `session-${Date.now()}`
    const newSession: Session = { key, label: text.slice(0, 40), sessionKey: key } as Session
    setSessions([newSession, ...sessions])
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey: key, projectTag: project.slug }),
    })
    setTag(key, project.slug)
    setTimeout(() => {
      send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: key, message: text } })
    }, 300)
    setOpenSession(newSession)
  }

  const projectSessions = sessions.filter((s: Session) =>
    getTag(s.key).project === project.slug && !isHidden(s.key) && !isHidden(s.id || '')
  )

  const untaggedSessions = sessions.filter((s: Session) =>
    !getTag(s.key).project && !isHidden(s.key) && !isHidden(s.id || '')
  )

  const handleNewSession = async () => {
    // Create session immediately and auto-inject project context
    const key = `session-${Date.now()}`
    const label = `New ${project.name} session`
    const newSession: Session = { key, label, sessionKey: key } as Session
    setSessions([newSession, ...sessions])
    const token = await getToken()
    await fetch(`${API}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ sessionKey: key, projectTag: project.slug }),
    })
    setTag(key, project.slug)
    setShowPicker(false)
    setOpenSession(newSession)
    // Auto-fetch project memory and inject as first message (non-blocking)
    fetch(`${API}/api/project-memory/${project.slug}`)
      .then(r => r.json())
      .then((d: { content?: string }) => {
        const memoryContext = d.content || ''
        const parts: string[] = [`Project: ${project.name}`]
        if (memoryContext.trim()) parts.push(`Context:\n${memoryContext.trim()}`)
        setTimeout(() => {
          send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: key, message: parts.join('\n\n') } })
        }, 300)
      })
      .catch(() => {})
  }

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
    return <MobileFullChat
      session={openSession}
      onBack={() => setOpenSession(null)}
      recentSessions={sessions.filter((s: Session) => !isHidden(s.key)).slice(0, 10)}
      onSwitch={(s) => setOpenSession(s)}
      onArchive={() => {
        hideSession(openSession.key)
        if (openSession.id) hideSession(openSession.id)
        setOpenSession(null)
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
          <button
            onClick={handleNewSession}
            className="text-xs text-[#6366f1] hover:text-[#818cf8] transition-colors px-2 py-1 font-medium"
            title="New session in this project"
          >
            ✶ New
          </button>
          <button
            onClick={() => setShowPicker(true)}
            className="text-xs text-[#6b7280] hover:text-white transition-colors px-1 py-1"
            title="Add existing session to this project"
          >
            + Add
          </button>
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
            <div className="text-[#6b7280] text-sm mb-4">No sessions in {project.name} yet.</div>
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
              >
                <button
                  onClick={() => setOpenSession(s)}
                  className="flex-1 text-left px-4 py-3.5 hover:bg-[#1e2330] transition-colors"
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
                <button
                  onClick={() => {
                    if (window.confirm('Archive this session?')) {
                      hideSession(s.key)
                      if (s.id) hideSession(s.id)
                    }
                  }}
                  className="px-3 py-3.5 text-[#4b5563] hover:text-red-400 transition-colors border-l border-[#2a3142]"
                  title="Archive"
                >
                  🗑
                </button>
              </div>
            )
          })}

          {/* Todos section */}
          {todos.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setTodosOpen(o => !o)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-xl hover:bg-[#1e2330] transition-colors"
              >
                <span className="text-sm font-medium text-[#6b7280] flex-1 text-left">Todos</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/40 text-yellow-300 font-mono">{todos.length}</span>
                <span className="text-xs text-[#4b5563]">{todosOpen ? '▲' : '▼'}</span>
              </button>
              {todosOpen && (
                <div className="mt-1 space-y-1">
                  {todos.map(todo => {
                    let pressTimer: ReturnType<typeof setTimeout> | null = null
                    return (
                      <div
                        key={todo.id}
                        className="flex items-start gap-3 bg-[#181c24] border border-[#2a3142] rounded-xl px-4 py-3"
                        onClick={() => handleTodoNewSession(todo.text)}
                        onTouchStart={() => { pressTimer = setTimeout(() => {
                          if (confirm(`Mark as done?\n\n"${todo.text}"`))
                            handleTodoComplete(todo.id)
                        }, 600) }}
                        onTouchEnd={() => { if (pressTimer) clearTimeout(pressTimer) }}
                        onTouchMove={() => { if (pressTimer) clearTimeout(pressTimer) }}
                      >
                        {todo.owner && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0 mt-0.5 ${
                            todo.owner === 'ME' ? 'bg-blue-900/50 text-blue-300' :
                            todo.owner === 'YOU' ? 'bg-amber-900/50 text-amber-300' :
                            todo.owner === 'BOTH' ? 'bg-green-900/50 text-green-300' :
                            'bg-gray-800 text-gray-400'
                          }`}>{todo.owner}</span>
                        )}
                        <span className="text-sm text-[#9ca3af] leading-snug flex-1">{todo.text}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
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
              {allProjects.map(p => (
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
