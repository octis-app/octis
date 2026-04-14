import { useState, useEffect } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useSessionStore, useProjectStore, Session } from '../store/gatewayStore'

interface Project {
  id: string
  name: string
  slug: string
  emoji: string
  color: string
  description: string
  memory_file: string
  position: number
}

interface ProjectsGridProps {
  onOpenProject: (project: Project) => void
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function ProjectsGrid({ onOpenProject }: ProjectsGridProps) {
  const { getToken } = useAuth()
  const { sessions, getStatus } = useSessionStore()
  const { getTag } = useProjectStore()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmoji, setNewEmoji] = useState('📁')

  useEffect(() => {
    fetch(`${API}/api/projects`)
      .then(r => r.json())
      .then(d => { setProjects(d.projects || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const handleCreate = async () => {
    if (!newName.trim()) return
    const token = await getToken()
    const r = await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

  // Count sessions per project (by project_tag matching slug)
  const sessionCountForProject = (slug: string) =>
    sessions.filter((s: Session) => getTag(s.key).project === slug).length

  const activeCountForProject = (slug: string) =>
    sessions.filter((s: Session) => getTag(s.key).project === slug && getStatus(s) === 'active').length

  const lastActivityForProject = (slug: string): Date | null => {
    const tagged = sessions.filter((s: Session) => getTag(s.key).project === slug)
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
          {projects.map(project => {
            const count = sessionCountForProject(project.slug)
            const active = activeCountForProject(project.slug)
            const lastActivity = lastActivityForProject(project.slug)

            return (
              <button
                key={project.id}
                onClick={() => onOpenProject(project)}
                className="text-left bg-[#181c24] hover:bg-[#1e2330] border border-[#2a3142] hover:border-[#3a4152] rounded-2xl p-5 transition-all group"
              >
                {/* Emoji + status dot */}
                <div className="flex items-start justify-between mb-3">
                  <div
                    className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl shrink-0"
                    style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}
                  >
                    {project.emoji}
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
                  {lastActivity && (
                    <span className="text-[#4b5563] text-xs">{formatAgo(lastActivity)}</span>
                  )}
                </div>
              </button>
            )
          })}

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
