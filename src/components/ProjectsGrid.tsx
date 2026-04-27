import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { useSessionStore, useProjectStore, useHiddenStore, Session } from '../store/gatewayStore'

interface Project {
  id: string
  name: string
  slug: string
  emoji: string
  color: string
  description: string
  memory_file: string
  position: number
  hide_from_sessions?: number
}

interface ProjectsGridProps {
  onOpenProject: (project: Project) => void
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function ProjectsGrid({ onOpenProject }: ProjectsGridProps) {
  const { getToken } = useAuth()
  const { sessions, hiddenSessions, getStatus } = useSessionStore()
  const { getTag, setProjectMeta } = useProjectStore()
  const { isHidden } = useHiddenStore()

  // Must match MobileProjectView's filters exactly so counts are accurate
  const isAgentSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    if (key.includes(':subagent:')) return true
    const lbl = (s.label || '').toLowerCase()
    return lbl.startsWith('continue where you left off')
  }
  const isVisibleSession = (s: Session) =>
    !isHidden(s.key) && !isHidden((s as Session & {id?: string}).id || '') && !isAgentSession(s) && !/^session-\d+$/.test(s.key)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmoji, setNewEmoji] = useState('📁')

  // Emoji editing state
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null)
  const [editEmojiValue, setEditEmojiValue] = useState('')
  const emojiInputRef = useRef<HTMLInputElement>(null)

  // Drag-and-drop reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const QUICK_EMOJIS = ['📁', '📂', '🏢', '🏠', '💼', '🚀', '⚙️', '💡', '🔬', '🎯', '📊', '🐙']

  const startEmojiEdit = useCallback((e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setEditingEmojiId(project.id)
    setEditEmojiValue(project.emoji || '📁')
    setTimeout(() => emojiInputRef.current?.focus(), 50)
  }, [])

  const saveEmojiEdit = useCallback(async (project: Project, overrideEmoji?: string) => {
    const newVal = (overrideEmoji ?? editEmojiValue).trim() || '📁'
    setEditingEmojiId(null)
    if (newVal === project.emoji) return
    await fetch(`${API}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ emoji: newVal }),
    })
    setProjects(prev => prev.map(p => p.id === project.id ? { ...p, emoji: newVal } : p))
  }, [editEmojiValue])

  const cancelEmojiEdit = useCallback(() => {
    setEditingEmojiId(null)
    setEditEmojiValue('')
  }, [])

  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then(d => {
        const list = d.projects || []
        setProjects(list)
        setLoading(false)
        // Publish emoji/name/color/hideFromSessions to global store so Sidebar + pills can prefix sessions
        const meta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }> = {}
        for (const p of list) meta[p.slug] = { emoji: p.emoji || '📁', name: p.name, color: p.color || '#6366f1', hideFromSessions: !!p.hide_from_sessions }
        setProjectMeta(meta)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleReorder = useCallback(async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    const newOrder = [...projects]
    const [moved] = newOrder.splice(fromIndex, 1)
    newOrder.splice(toIndex, 0, moved)
    // Update positions in local state
    const withPositions = newOrder.map((p, i) => ({ ...p, position: i }))
    setProjects(withPositions)
    // PATCH only items whose position changed
    const patches = withPositions.filter((p, i) => projects.findIndex(op => op.id === p.id) !== i)
    await Promise.all(
      patches.map(p =>
        fetch(`${API}/api/projects/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ position: p.position }),
        })
      )
    )
  }, [projects])

  const handleCreate = async () => {
    if (!newName.trim()) return
    const token = await getToken()
    const r = await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      body: JSON.stringify({ name: newName.trim(), emoji: newEmoji }),
    })
    const d = await r.json()
    if (d.project) {
      setProjects(prev => [...prev, d.project])
      setNewName('')
      setNewEmoji('📁')
      setCreating(false)
    }
  }

  // Count sessions per project — must apply same visibility filters as MobileProjectView
  const sessionCountForProject = (slug: string) =>
    sessions.filter((s: Session) => isVisibleSession(s) && getTag(s.key).project === slug).length

  const activeCountForProject = (slug: string) =>
    sessions.filter((s: Session) => isVisibleSession(s) && getTag(s.key).project === slug && getStatus(s) === 'active').length

  const lastActivityForProject = (slug: string): Date | null => {
    const tagged = sessions.filter((s: Session) =>
      slug === 'others' ? !getTag(s.key).project : getTag(s.key).project === slug
    )
    if (!tagged.length) return null
    const ts = tagged
      .map((s: Session) => s.lastActivity ? new Date(s.lastActivity as string).getTime() : 0)
      .filter(t => t > 0)
    return ts.length ? new Date(Math.max(...ts)) : null
  }

  const formatAgo = (d: Date | null): string => {
    if (!d) return ''
    const mins = Math.floor((Date.now() - d.getTime()) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0f1117]">
        <span className="text-[#4b5563] text-sm">Loading projects…</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#0f1117]">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-white text-2xl font-bold tracking-tight">Projects</h1>
            <p className="text-[#6b7280] text-sm mt-1">Your AI command center</p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 bg-[#6366f1] hover:bg-[#818cf8] text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <span className="text-base leading-none">+</span>
            New Project
          </button>
        </div>

        {/* Create project form */}
        {creating && (
          <div className="mb-6 bg-[#181c24] border border-[#6366f1]/40 rounded-2xl p-4">
            <div className="flex gap-3 items-center">
              <input
                className="w-12 bg-[#0f1117] border border-[#2a3142] rounded-lg px-2 py-2 text-center text-xl outline-none focus:border-[#6366f1]"
                value={newEmoji}
                onChange={e => setNewEmoji(e.target.value)}
                maxLength={2}
                placeholder="📁"
              />
              <input
                autoFocus
                className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
                placeholder="Project name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="bg-[#6366f1] disabled:opacity-40 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Create
              </button>
              <button
                onClick={() => { setCreating(false); setNewName('') }}
                className="text-[#4b5563] hover:text-white px-3 py-2 text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Project grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project, i) => {
            const count = sessionCountForProject(project.slug)
            const active = activeCountForProject(project.slug)
            const lastActivity = lastActivityForProject(project.slug)
            const isEditingEmoji = editingEmojiId === project.id
            const isDragging = dragIndex === i
            const isDragOver = dragOverIndex === i && dragOverIndex !== dragIndex

            return (
              <div
                key={project.id}
                role="button"
                tabIndex={0}
                draggable={!isEditingEmoji}
                onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move' }}
                onDragOver={(e) => { e.preventDefault(); setDragOverIndex(i) }}
                onDragLeave={() => setDragOverIndex(null)}
                onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
                onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) handleReorder(dragIndex, i); setDragIndex(null); setDragOverIndex(null) }}
                onClick={() => !isEditingEmoji && onOpenProject(project)}
                onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !isEditingEmoji) onOpenProject(project) }}
                className={`relative text-left bg-[#181c24] hover:bg-[#1e2330] border rounded-2xl p-5 transition-all group select-none ${
                  isDragOver ? 'border-[#6366f1] bg-[#1e2330]' : 'border-[#2a3142] hover:border-[#3a4152]'
                } ${
                  isDragging ? 'opacity-40 cursor-grabbing' : 'cursor-grab'
                }`}
              >
                {/* Drag handle — subtle, appears on hover */}
                <div className="absolute top-3 left-3 opacity-0 group-hover:opacity-30 text-[#9ca3af] text-xs pointer-events-none select-none" aria-hidden="true">⠿</div>

                {/* Emoji + status dot */}
                <div className="flex items-start justify-between mb-3">
                  <div className="relative">
                    {/* Emoji icon — not directly clickable; use edit button instead */}
                    <div
                      className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0 relative"
                      style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
                    >
                      {project.emoji}
                    </div>
                    {/* Dedicated edit button — only appears on card hover, positioned outside emoji hit zone */}
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#2a3142] hover:bg-[#6366f1] text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-md"
                      onClick={(e) => { e.stopPropagation(); startEmojiEdit(e, project) }}
                      title="Change icon"
                    >✏️</button>

                    {/* Emoji picker popover */}
                    {isEditingEmoji && (
                      <div
                        className="absolute top-14 left-0 z-50 bg-[#0f1117] border border-[#6366f1]/60 rounded-2xl p-4 shadow-2xl"
                        style={{ width: 260 }}
                        onClick={e => e.stopPropagation()}
                      >
                        {/* Header */}
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs text-[#9ca3af] font-medium">Change icon</span>
                          <button
                            type="button"
                            className="text-[#4b5563] hover:text-white text-sm leading-none px-1"
                            onClick={e => { e.stopPropagation(); cancelEmojiEdit() }}
                          >✕</button>
                        </div>

                        {/* Quick picks */}
                        <p className="text-[10px] text-[#4b5563] mb-1.5">Quick pick</p>
                        <div className="flex flex-wrap gap-1 mb-3">
                          {QUICK_EMOJIS.map(em => (
                            <button
                              key={em}
                              type="button"
                              className="w-9 h-9 rounded-xl bg-[#181c24] hover:bg-[#6366f1]/30 hover:ring-1 hover:ring-[#6366f1] text-xl transition-all flex items-center justify-center"
                              onClick={e => { e.stopPropagation(); saveEmojiEdit(project, em) }}
                            >{em}</button>
                          ))}
                        </div>

                        {/* Custom input */}
                        <p className="text-[10px] text-[#4b5563] mb-1.5">Or type any emoji</p>
                        <div className="flex gap-2">
                          <input
                            ref={emojiInputRef}
                            type="text"
                            className="w-14 bg-[#181c24] border border-[#2a3142] focus:border-[#6366f1] rounded-lg px-2 py-1.5 text-center text-xl outline-none"
                            value={editEmojiValue}
                            onChange={e => setEditEmojiValue(e.target.value)}
                            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') saveEmojiEdit(project); if (e.key === 'Escape') cancelEmojiEdit() }}
                            maxLength={2}
                            placeholder="📁"
                            onClick={e => e.stopPropagation()}
                          />
                          <button
                            type="button"
                            className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg text-xs font-medium transition-colors"
                            onClick={e => { e.stopPropagation(); saveEmojiEdit(project) }}
                          >Save</button>
                        </div>
                      </div>
                    )}
                  </div>
                  {active > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-xs text-green-400">{active} active</span>
                    </div>
                  )}
                </div>

                {/* Name */}
                <div className="text-white font-semibold text-base mb-1 group-hover:text-[#a5b4fc] transition-colors">
                  {project.name}
                </div>

                {/* Description */}
                {project.description && (
                  <div className="text-[#6b7280] text-xs mb-3 line-clamp-2">{project.description}</div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2a3142]">
                  <span className="text-[#4b5563] text-xs">
                    {count === 0 ? 'No sessions' : `${count} session${count !== 1 ? 's' : ''}`}
                  </span>
                  <div className="flex items-center gap-2">
                    {lastActivity && (
                      <span className="text-[#4b5563] text-xs">{formatAgo(lastActivity)}</span>
                    )}
                    {/* Hide from Sessions toggle */}
                    <button
                      type="button"
                      title={project.hide_from_sessions ? 'Shown only in Projects tab (click to show in Sessions)' : 'Click to hide from Sessions tab'}
                      onClick={async (e) => {
                        e.stopPropagation()
                        const newVal = project.hide_from_sessions ? 0 : 1
                        await fetch(`${API}/api/projects/${project.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({ hide_from_sessions: newVal }),
                        })
                        setProjects(prev => prev.map(p => p.id === project.id ? { ...p, hide_from_sessions: newVal } : p))
                        // Refresh projectMeta in global store
                        const updatedList = projects.map(p => p.id === project.id ? { ...p, hide_from_sessions: newVal } : p)
                        const meta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }> = {}
                        for (const p of updatedList) meta[p.slug] = { emoji: p.emoji || '📁', name: p.name, color: p.color || '#6366f1', hideFromSessions: !!p.hide_from_sessions }
                        setProjectMeta(meta)
                      }}
                      className={`opacity-0 group-hover:opacity-100 transition-all text-[10px] px-1.5 py-0.5 rounded ${
                        project.hide_from_sessions
                          ? 'bg-[#6366f1]/20 text-[#818cf8]'
                          : 'bg-[#2a3142] text-[#4b5563] hover:text-[#6b7280]'
                      }`}
                    >
                      {project.hide_from_sessions ? '📂 hidden' : '💬'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}

          {/* Untagged Active Sessions — catch-all for untagged sessions */}
          {(() => {
            const othersCount = sessions.filter((s: Session) => isVisibleSession(s) && !getTag(s.key).project).length
            const othersActive = sessions.filter((s: Session) => isVisibleSession(s) && !getTag(s.key).project && getStatus(s) === 'active').length
            const othersActivity = lastActivityForProject('others')
            const othersProject = { id: 'others', name: 'Untagged Active Sessions', slug: 'others', emoji: '📂', color: '#6b7280', description: 'Active sessions not assigned to any project', memory_file: '', position: 9999 }
            return (
              <button
                key="others"
                onClick={() => onOpenProject(othersProject)}
                className="text-left bg-[#181c24] hover:bg-[#1e2330] border border-[#2a3142] hover:border-[#3a4152] rounded-2xl p-5 transition-all group"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0 bg-[#6b728022] border border-[#6b728044]">
                    📂
                  </div>
                  {othersActive > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-xs text-green-400">{othersActive} active</span>
                    </div>
                  )}
                </div>
                <div className="text-white font-semibold text-base mb-1 group-hover:text-[#a5b4fc] transition-colors">Untagged Active Sessions</div>
                <div className="text-[#6b7280] text-xs mb-3 line-clamp-2">Active sessions not assigned to any project</div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2a3142]">
                  <span className="text-[#4b5563] text-xs">
                    {othersCount === 0 ? 'No sessions' : `${othersCount} session${othersCount !== 1 ? 's' : ''}`}
                  </span>
                  {othersActivity && <span className="text-[#4b5563] text-xs">{formatAgo(othersActivity)}</span>}
                </div>
              </button>
            )
          })()}

          {/* Archived chats — hidden sessions ordered by last activity */}
          {(() => {
            const archivedCount = hiddenSessions.length
            const archivedTs = hiddenSessions
              .map((s: Session) => s.lastActivity ? new Date(s.lastActivity as string).getTime() : 0)
              .filter(t => t > 0)
            const archivedActivity = archivedTs.length ? new Date(Math.max(...archivedTs)) : null
            const archivedProject = { id: 'archived', name: 'Archived', slug: 'archived', emoji: '🗂️', color: '#6b7280', description: 'Previously archived sessions', memory_file: '', position: 10000 }
            return (
              <button
                key="archived"
                onClick={() => onOpenProject(archivedProject)}
                className="text-left bg-[#181c24]/70 hover:bg-[#1e2330] border border-[#2a3142]/70 hover:border-[#3a4152] rounded-2xl p-5 transition-all group opacity-80 hover:opacity-100"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0 bg-[#6b728018] border border-[#6b728033]">
                    🗂️
                  </div>
                </div>
                <div className="text-[#9ca3af] font-semibold text-base mb-1 group-hover:text-[#a5b4fc] transition-colors">Archived</div>
                <div className="text-[#6b7280] text-xs mb-3 line-clamp-2">Previously archived sessions</div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#2a3142]/70">
                  <span className="text-[#4b5563] text-xs">
                    {archivedCount === 0 ? 'No archived sessions' : `${archivedCount} session${archivedCount !== 1 ? 's' : ''}`}
                  </span>
                  {archivedActivity && <span className="text-[#4b5563] text-xs">{formatAgo(archivedActivity)}</span>}
                </div>
              </button>
            )
          })()}

          {/* Empty state */}
          {projects.length === 0 && (
            <div className="col-span-3 text-center py-16 text-[#4b5563]">
              <div className="text-5xl mb-4">🐙</div>
              <div className="text-base font-medium text-[#6b7280]">No projects yet</div>
              <div className="text-sm mt-1">Create your first project to get started</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export type { Project }
