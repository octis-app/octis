import { useEffect, useState } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3747'

function MarkdownBlock({ content, maxLines = 20 }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const truncated = lines.length > maxLines && !expanded
  const display = truncated ? lines.slice(0, maxLines).join('\n') + '\n…' : content

  return (
    <div>
      <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed font-sans">{display}</pre>
      {lines.length > maxLines && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-xs text-[#6366f1] hover:text-[#818cf8] mt-1 transition-colors"
        >
          {expanded ? 'Show less' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

export default function MemoryPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('todos')

  useEffect(() => {
    fetch(`${API}/api/memory`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading memory…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error}</div>

  const tabs = [
    { id: 'todos', label: 'TODOs' },
    { id: 'memory', label: 'MEMORY.md' },
    { id: 'logs', label: 'Recent Logs' },
    { id: 'projects', label: 'Projects' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 border-b border-[#2a3142]">
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
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'todos' && (
          <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">TODOS.md</div>
            <MarkdownBlock content={data.todos || '(empty)'} maxLines={100} />
          </div>
        )}

        {activeTab === 'memory' && (
          <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">MEMORY.md</div>
            <MarkdownBlock content={data.memory || '(empty)'} maxLines={50} />
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="space-y-4">
            {data.recentLogs?.length === 0 && (
              <div className="text-[#6b7280] text-sm">No recent daily logs.</div>
            )}
            {data.recentLogs?.map(log => (
              <div key={log.date} className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
                <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">📅 {log.date}</div>
                <MarkdownBlock content={log.content || '(empty)'} maxLines={30} />
              </div>
            ))}
          </div>
        )}

        {activeTab === 'projects' && (
          <div className="space-y-4">
            {data.projects?.length === 0 && (
              <div className="text-[#6b7280] text-sm">No project files found.</div>
            )}
            {data.projects?.map(p => (
              <div key={p.name} className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
                <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">📁 {p.name}</div>
                <MarkdownBlock content={p.preview || '(empty)'} maxLines={15} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
