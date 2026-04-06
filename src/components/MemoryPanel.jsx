import { useEffect, useState } from 'react'

const API = import.meta.env.VITE_API_URL || ''

function MarkdownBlock({ content, maxLines = 30 }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const truncated = lines.length > maxLines && !expanded
  const display = truncated ? lines.slice(0, maxLines).join('\n') + '\n…' : content
  return (
    <div>
      <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed font-sans">{display}</pre>
      {lines.length > maxLines && (
        <button onClick={() => setExpanded(e => !e)} className="text-xs text-[#6366f1] hover:text-[#818cf8] mt-1 transition-colors">
          {expanded ? 'Show less' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-[#181c24] border border-[#2a3142] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#1e2330] transition-colors"
      >
        <span className="text-xs text-[#6b7280] uppercase tracking-wider font-medium">{title}</span>
        <span className="text-[#6b7280] text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

export default function MemoryPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [projectSearch, setProjectSearch] = useState('')

  const load = () => {
    setLoading(true)
    fetch(`${API}/api/memory`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading memory…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error}</div>

  const tabs = [
    { id: 'overview', label: '📋 Overview' },
    { id: 'logs', label: '📅 Logs' },
    { id: 'projects', label: '📁 Projects' },
  ]

  const filteredProjects = (data.projects || []).filter(p =>
    !projectSearch || p.name.toLowerCase().includes(projectSearch.toLowerCase())
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs + refresh */}
      <div className="flex items-center gap-1 px-6 pt-4 border-b border-[#2a3142]">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === t.id
                ? 'bg-[#181c24] text-white border border-b-0 border-[#2a3142]'
                : 'text-[#6b7280] hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={load} className="text-xs text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#2a3142] transition-colors mb-1" title="Refresh">↻ Refresh</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">

        {/* OVERVIEW: TODOs + MEMORY.md */}
        {activeTab === 'overview' && (
          <>
            <Section title="✅ TODOs" defaultOpen={true}>
              <MarkdownBlock content={data.todos || '(empty)'} maxLines={60} />
            </Section>
            <Section title="🧠 MEMORY.md" defaultOpen={false}>
              <MarkdownBlock content={data.memory || '(empty)'} maxLines={40} />
            </Section>
          </>
        )}

        {/* LOGS: recent daily session logs */}
        {activeTab === 'logs' && (
          <>
            {(data.recentLogs || []).length === 0 && (
              <div className="text-[#6b7280] text-sm">No recent daily logs.</div>
            )}
            {(data.recentLogs || []).map(log => (
              <Section key={log.date} title={`📅 ${log.date}`} defaultOpen={true}>
                <MarkdownBlock content={log.content || '(empty)'} maxLines={30} />
              </Section>
            ))}
          </>
        )}

        {/* PROJECTS: memory/*.md project files */}
        {activeTab === 'projects' && (
          <>
            <input
              className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] mb-2"
              placeholder="Search projects…"
              value={projectSearch}
              onChange={e => setProjectSearch(e.target.value)}
            />
            {filteredProjects.length === 0 && (
              <div className="text-[#6b7280] text-sm">No project files found.</div>
            )}
            {filteredProjects.map(p => (
              <Section key={p.name} title={`📁 ${p.name}`} defaultOpen={false}>
                <MarkdownBlock content={p.preview || '(empty)'} maxLines={15} />
              </Section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
