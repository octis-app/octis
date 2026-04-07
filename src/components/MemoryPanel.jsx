import { useEffect, useState, useMemo } from 'react'

const API = import.meta.env.VITE_API_URL || ''

// ─── Markdown renderer ────────────────────────────────────────────────────────
// Renders headings, bold/italic, code, lists, and task checkboxes.
// Handles [YOU] / [ME] / [BOTH] / [WAIT] / [UNLOCK→ME] badges with colors.
function renderMarkdown(text) {
  if (!text) return null
  const lines = text.split('\n')
  const elements = []
  let i = 0

  const badge = (content, color, bg) => (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${bg} ${color} mr-1.5 shrink-0`}>
      {content}
    </span>
  )

  const renderInline = (str) => {
    // Replace [YOU], [ME], [BOTH], [WAIT], [UNLOCK→ME] with colored badges
    const parts = str.split(/(\[YOU\]|\[ME\]|\[BOTH\]|\[WAIT\]|\[UNLOCK→ME\]|\[UNLOCK->ME\])/g)
    return parts.map((p, i) => {
      if (p === '[YOU]') return <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/20 text-indigo-300 mr-1.5">🤖 You</span>
      if (p === '[ME]') return <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 mr-1.5">👤 Me</span>
      if (p === '[BOTH]') return <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 mr-1.5">🤝 Both</span>
      if (p === '[WAIT]') return <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-zinc-500/20 text-zinc-400 mr-1.5">⏳ Wait</span>
      if (p === '[UNLOCK→ME]' || p === '[UNLOCK->ME]') return <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-orange-500/20 text-orange-300 mr-1.5">🔓 Unlock→Me</span>
      // Bold
      const boldParts = p.split(/(\*\*[^*]+\*\*)/g)
      return boldParts.map((bp, j) => {
        if (bp.startsWith('**') && bp.endsWith('**')) {
          return <strong key={j} className="text-white font-semibold">{bp.slice(2, -2)}</strong>
        }
        // Italic
        const italicParts = bp.split(/(\*[^*]+\*)/g)
        return italicParts.map((ip, k) => {
          if (ip.startsWith('*') && ip.endsWith('*') && ip.length > 2) {
            return <em key={k} className="text-[#c4cce0] italic">{ip.slice(1, -1)}</em>
          }
          // Inline code
          const codeParts = ip.split(/(`[^`]+`)/g)
          return codeParts.map((cp, l) => {
            if (cp.startsWith('`') && cp.endsWith('`') && cp.length > 2) {
              return <code key={l} className="bg-[#0f1117] text-[#a5b4fc] px-1 py-0.5 rounded text-[11px] font-mono">{cp.slice(1, -1)}</code>
            }
            return <span key={l}>{cp}</span>
          })
        })
      })
    })
  }

  while (i < lines.length) {
    const line = lines[i]

    // Skip blank lines between items (just add spacing)
    if (line.trim() === '') {
      elements.push(<div key={`gap-${i}`} className="h-1" />)
      i++
      continue
    }

    // H1
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={i} className="text-base font-bold text-white mt-4 mb-2 pb-1 border-b border-[#2a3142]">
          {renderInline(line.slice(2))}
        </h1>
      )
      i++; continue
    }
    // H2
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-sm font-semibold text-[#a5b4fc] mt-3 mb-1.5">
          {renderInline(line.slice(3))}
        </h2>
      )
      i++; continue
    }
    // H3
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-xs font-semibold text-[#818cf8] mt-2 mb-1">
          {renderInline(line.slice(4))}
        </h3>
      )
      i++; continue
    }

    // Task checkbox: - [ ] or - [x]
    const taskMatch = line.match(/^(\s*)- \[([ xX])\] (.*)/)
    if (taskMatch) {
      const indent = taskMatch[1].length
      const done = taskMatch[2].toLowerCase() === 'x'
      const content = taskMatch[3]
      elements.push(
        <div key={i} className={`flex items-start gap-2 py-0.5 ${indent > 0 ? 'ml-4' : ''}`}>
          <span className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded flex items-center justify-center border ${done ? 'bg-emerald-500/30 border-emerald-500/50 text-emerald-400' : 'border-[#3a4152] text-transparent'}`} style={{fontSize: '9px'}}>
            {done ? '✓' : ''}
          </span>
          <span className={`text-xs leading-relaxed ${done ? 'line-through text-[#4b5563]' : 'text-[#e8eaf0]'}`}>
            {renderInline(content)}
          </span>
        </div>
      )
      i++; continue
    }

    // Bullet list: - item
    const bulletMatch = line.match(/^(\s*)[-*] (.*)/)
    if (bulletMatch) {
      const indent = bulletMatch[1].length
      elements.push(
        <div key={i} className={`flex items-start gap-2 py-0.5 ${indent > 0 ? 'ml-4' : ''}`}>
          <span className="text-[#6366f1] mt-1 shrink-0 text-[10px]">•</span>
          <span className="text-xs text-[#d0d5e8] leading-relaxed">{renderInline(bulletMatch[2])}</span>
        </div>
      )
      i++; continue
    }

    // Code block
    if (line.startsWith('```')) {
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      elements.push(
        <pre key={`code-${i}`} className="bg-[#0f1117] border border-[#2a3142] rounded-lg p-3 text-[11px] text-[#a5b4fc] font-mono overflow-x-auto my-2 leading-relaxed">
          {codeLines.join('\n')}
        </pre>
      )
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      elements.push(
        <div key={i} className="border-l-2 border-[#6366f1] pl-3 py-0.5 my-1">
          <span className="text-xs text-[#9ca3af] italic">{renderInline(line.slice(2))}</span>
        </div>
      )
      i++; continue
    }

    // Section divider
    if (line.trim() === '---') {
      elements.push(<hr key={i} className="border-[#2a3142] my-3" />)
      i++; continue
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="text-xs text-[#d0d5e8] leading-relaxed py-0.5">
        {renderInline(line)}
      </p>
    )
    i++
  }

  return elements
}

// ─── Collapsible section ──────────────────────────────────────────────────────
function Section({ title, children, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-[#181c24] border border-[#2a3142] rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[#1e2330] transition-colors"
      >
        <span className="text-xs font-semibold text-[#a5b4fc] uppercase tracking-wider">{title}</span>
        <div className="flex items-center gap-2">
          {badge && <span className="text-[10px] text-[#6b7280]">{badge}</span>}
          <span className="text-[#6b7280] text-xs">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  )
}

// ─── Project card ─────────────────────────────────────────────────────────────
function ProjectCard({ project }) {
  const [expanded, setExpanded] = useState(false)
  const content = project.content || ''
  const lineCount = content.split('\n').length

  // Extract first heading as title fallback
  const firstH1 = content.match(/^# (.+)/m)?.[1]
  const displayName = firstH1 || project.name

  // Extract status line if present
  const statusLine = content.match(/\*?Status[:\s]+([^\n]+)/i)?.[1]?.replace(/\*/g, '').trim()

  return (
    <div className="bg-[#181c24] border border-[#2a3142] rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-start justify-between px-4 py-3 text-left hover:bg-[#1e2330] transition-colors gap-3"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{displayName}</div>
          {statusLine && !expanded && (
            <div className="text-[11px] text-[#6b7280] mt-0.5 truncate">{statusLine}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-[#4b5563]">{lineCount} lines</span>
          <span className="text-[#6b7280] text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-[#2a3142] pt-3">
          {renderMarkdown(content)}
        </div>
      )}
    </div>
  )
}

// ─── Projects sort options ────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { id: 'recency', label: '🕐 Recent' },
  { id: 'size', label: '📏 Size' },
  { id: 'urgency', label: '🔥 Urgency' },
  { id: 'alpha', label: '🔤 A–Z' },
]

const URGENCY_KEYWORDS = ['blocked', 'urgent', 'pending', 'asap', 'critical', 'in progress', 'todo', 'action']
function urgencyScore(content) {
  const lower = (content || '').toLowerCase()
  return URGENCY_KEYWORDS.reduce((n, kw) => n + (lower.includes(kw) ? 1 : 0), 0)
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export default function MemoryPanel() {
  const [memData, setMemData] = useState(null)
  const [projData, setProjData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [projectSearch, setProjectSearch] = useState('')
  const [projectSort, setProjectSort] = useState('recency')

  const load = () => {
    setLoading(true)
    Promise.all([
      fetch(`${API}/api/memory`).then(r => r.json()),
      fetch(`${API}/api/projects`).then(r => r.json()),
    ])
      .then(([mem, proj]) => {
        setMemData(mem)
        setProjData(proj)
        setLoading(false)
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const sortedProjects = useMemo(() => {
    const projects = projData?.projects || []
    const filtered = projectSearch
      ? projects.filter(p => p.name.toLowerCase().includes(projectSearch.toLowerCase()) || (p.content || '').toLowerCase().includes(projectSearch.toLowerCase()))
      : projects
    return [...filtered].sort((a, b) => {
      if (projectSort === 'recency') return new Date(b.mtime || 0) - new Date(a.mtime || 0)
      if (projectSort === 'size') return (b.size || 0) - (a.size || 0)
      if (projectSort === 'urgency') return urgencyScore(b.content) - urgencyScore(a.content)
      if (projectSort === 'alpha') return a.name.localeCompare(b.name)
      return 0
    })
  }, [projData, projectSearch, projectSort])

  const tabs = [
    { id: 'overview', label: '📋 TODOs' },
    { id: 'logs', label: '📅 Logs' },
    { id: 'projects', label: '📁 Projects' },
    { id: 'memory', label: '🧠 Memory' },
  ]

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading memory…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error}</div>

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tabs + refresh */}
      <div className="flex items-center gap-1 px-6 pt-4 border-b border-[#2a3142] shrink-0">
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
        <button
          onClick={load}
          className="text-xs text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#2a3142] transition-colors mb-1"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">

        {/* TODOs ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="bg-[#181c24] border border-[#2a3142] rounded-xl px-4 py-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-white">✅ TODOs</h2>
                <span className="text-[10px] text-[#4b5563]">TODOS.md</span>
              </div>
              <div className="space-y-0.5">
                {renderMarkdown(memData?.todos || '(empty)')}
              </div>
            </div>
          </div>
        )}

        {/* LOGS ──────────────────────────────────────────────────── */}
        {activeTab === 'logs' && (
          <>
            {(memData?.recentLogs || []).length === 0 && (
              <div className="text-[#6b7280] text-sm">No recent daily logs.</div>
            )}
            {(memData?.recentLogs || []).map(log => (
              <Section key={log.date} title={`📅 ${log.date}`} defaultOpen={true}>
                <div className="space-y-0.5">
                  {renderMarkdown(log.content || '(empty)')}
                </div>
              </Section>
            ))}
          </>
        )}

        {/* PROJECTS ──────────────────────────────────────────────── */}
        {activeTab === 'projects' && (
          <>
            <div className="flex gap-2 flex-wrap">
              <input
                className="flex-1 min-w-0 bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
                placeholder="Search projects…"
                value={projectSearch}
                onChange={e => setProjectSearch(e.target.value)}
              />
              <div className="flex gap-1">
                {SORT_OPTIONS.map(o => (
                  <button
                    key={o.id}
                    onClick={() => setProjectSort(o.id)}
                    className={`px-2.5 py-1.5 text-[11px] rounded-lg border transition-colors ${
                      projectSort === o.id
                        ? 'bg-[#6366f1] border-[#6366f1] text-white font-medium'
                        : 'border-[#2a3142] text-[#6b7280] hover:text-white hover:border-[#3a4152]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-[10px] text-[#4b5563]">{sortedProjects.length} project{sortedProjects.length !== 1 ? 's' : ''}</div>
            {sortedProjects.length === 0 && (
              <div className="text-[#6b7280] text-sm">No projects found.</div>
            )}
            <div className="space-y-3">
              {sortedProjects.map(p => (
                <ProjectCard key={p.name} project={p} />
              ))}
            </div>
          </>
        )}

        {/* MEMORY.md ─────────────────────────────────────────────── */}
        {activeTab === 'memory' && (
          <div className="bg-[#181c24] border border-[#2a3142] rounded-xl px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-white">🧠 MEMORY.md</h2>
              <span className="text-[10px] text-[#4b5563]">Long-term context</span>
            </div>
            <div className="space-y-0.5">
              {renderMarkdown(memData?.memory || '(empty)')}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
