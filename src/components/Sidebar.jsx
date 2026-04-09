import { useState } from 'react'
import { useSessionStore, useGatewayStore, useProjectStore, useLabelStore } from '../store/gatewayStore'

const STATUS = {
  working:     { color: '#a855f7', label: 'Working',   dot: 'animate-pulse' },
  'needs-you': { color: '#3b82f6', label: 'Needs you', dot: '' },
  active:      { color: '#22c55e', label: 'Active',    dot: '' },
  quiet:       { color: '#6b7280', label: 'Quiet',     dot: '' },
}

// ─── Project tag picker popup ─────────────────────────────────────────────────
const PRESET_PROJECTS = ['Quantum', 'Portal', 'Billing', 'Sage', 'Octis', 'Centurion', 'Infra', 'Personal']

function ProjectPicker({ sessionKey, current, onClose }) {
  const { setTag } = useProjectStore()
  const [custom, setCustom] = useState('')

  const pick = (p) => { setTag(sessionKey, p); onClose() }
  const clear = () => { setTag(sessionKey, ''); onClose() }

  return (
    <div className="absolute right-0 top-8 bg-[#1e2330] border border-[#2a3142] rounded-xl shadow-2xl z-50 py-2 min-w-[180px]">
      <div className="px-3 pb-1 text-[10px] text-[#6b7280] uppercase tracking-wider">Assign project</div>
      {PRESET_PROJECTS.map(p => (
        <button
          key={p}
          onClick={() => pick(p)}
          className={`w-full px-3 py-1.5 text-xs text-left transition-colors hover:bg-[#2a3142] ${current === p ? 'text-[#a5b4fc] font-medium' : 'text-[#e8eaf0]'}`}
        >
          {current === p ? '✓ ' : '  '}{p}
        </button>
      ))}
      <div className="border-t border-[#2a3142] my-1 mx-2" />
      <div className="px-2 pb-1 flex gap-1">
        <input
          className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded px-2 py-1 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
          placeholder="Custom…"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && custom.trim()) pick(custom.trim()) }}
        />
        <button onClick={() => custom.trim() && pick(custom.trim())} className="text-xs bg-[#6366f1] text-white px-2 py-1 rounded hover:bg-[#818cf8]">+</button>
      </div>
      {current && (
        <button onClick={clear} className="w-full px-3 py-1.5 text-xs text-left text-red-400 hover:bg-[#2a3142]">✕ Remove tag</button>
      )}
    </div>
  )
}

// ─── Single session row ───────────────────────────────────────────────────────
function SessionItem({ session, isPinned, onPin, onRename, onArchive, onContinue }) {
  const { getStatus } = useSessionStore()
  const { getTag } = useProjectStore()
  const { getLabel, setLabel: saveLabel } = useLabelStore()
  const status = getStatus(session)
  const tag = getTag(session.key)
  const [showMenu, setShowMenu] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [editing, setEditing] = useState(false)
  // Use local override first, then gateway label, then key
  const displayLabel = getLabel(session.key, session.label || session.key)
  const [label, setLabel] = useState(displayLabel)

  const handleRename = () => {
    if (label.trim()) {
      saveLabel(session.key, label.trim()) // persist locally
      onRename(session.key, label.trim())   // also push to gateway
    }
    setEditing(false)
  }

  const st = STATUS[status] || STATUS.quiet

  return (
    <div
      className={`mx-2 px-3 py-2.5 rounded-lg mb-0.5 group transition-colors relative ${
        isPinned ? 'bg-[#1e2330] border border-[#2a3142]' : 'hover:bg-[#1e2330]'
      }`}
    >
      <div className="flex items-center gap-2">
        <div
          className={`w-1.5 h-1.5 rounded-full shrink-0 mt-0.5 ${st.dot}`}
          style={{ background: st.color }}
        />

        {editing ? (
          <input
            autoFocus
            className="flex-1 bg-[#0f1117] border border-[#6366f1] rounded px-1.5 py-0.5 text-sm text-white outline-none"
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={handleRename}
          />
        ) : (
          <span
            className="text-[13px] text-white truncate flex-1 cursor-pointer leading-snug"
            onClick={onPin}
            onDoubleClick={() => setEditing(true)}
            title={displayLabel}
          >
            {displayLabel}
          </span>
        )}

        <button
          onClick={e => { e.stopPropagation(); setShowMenu(s => !s); setShowProjectPicker(false) }}
          className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white px-1 text-xs transition-opacity"
        >
          ⋯
        </button>
      </div>

      <div className="flex items-center gap-2 mt-0.5 ml-3.5">
        <span className="text-xs" style={{ color: st.color }}>{st.label}</span>
        {tag.project && (
          <span className="text-[10px] bg-[#2a3142] text-[#a5b4fc] px-1.5 py-0.5 rounded font-medium">
            {tag.project}
          </span>
        )}
        {session.cost != null && (
          <span className="text-xs text-[#6b7280] ml-auto">${typeof session.cost === 'number' ? session.cost.toFixed(2) : session.cost}</span>
        )}
      </div>

      {/* Session card preview (if available) */}
      {tag.card && !isPinned && (
        <div className="ml-3.5 mt-1 text-[10px] text-[#6b7280] leading-relaxed line-clamp-2 border-l border-[#2a3142] pl-2">
          {tag.card}
        </div>
      )}

      {/* Context menu */}
      {showMenu && !showProjectPicker && (
        <div className="absolute right-2 top-8 bg-[#1e2330] border border-[#2a3142] rounded-xl shadow-xl z-50 py-1 min-w-[160px]">
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]" onClick={() => { setEditing(true); setShowMenu(false) }}>✏️ Rename</button>
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]" onClick={() => { onPin(); setShowMenu(false) }}>📌 Open in pane</button>
          <button
            className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
            onClick={() => { setShowProjectPicker(true); setShowMenu(false) }}
          >
            🗂 Assign project
          </button>
          {tag.card && (
            <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]" onClick={() => { onContinue(session); setShowMenu(false) }}>▶ Continue</button>
          )}
          <div className="border-t border-[#2a3142] my-1" />
          <button className="w-full px-3 py-1.5 text-xs text-left text-red-400 hover:bg-[#2a3142]" onClick={() => { onArchive(session.key); setShowMenu(false) }}>🗑 Archive</button>
        </div>
      )}

      {/* Project picker */}
      {showProjectPicker && (
        <ProjectPicker
          sessionKey={session.key}
          current={tag.project}
          onClose={() => setShowProjectPicker(false)}
        />
      )}

      {/* Click-outside to close menus */}
      {(showMenu || showProjectPicker) && (
        <div className="fixed inset-0 z-40" onClick={() => { setShowMenu(false); setShowProjectPicker(false) }} />
      )}
    </div>
  )
}

// ─── Project group ────────────────────────────────────────────────────────────
function ProjectGroup({ name, sessions, activePanes, paneCount, onPin, onRename, onArchive, onContinue }) {
  const { getStatus } = useSessionStore()
  const { getTag } = useProjectStore()
  const [open, setOpen] = useState(true)

  // Bubble up highest-urgency status
  const topStatus = sessions.reduce((best, s) => {
    const order = ['working', 'needs-you', 'active', 'quiet']
    const rank = i => order.indexOf(i)
    const st = getStatus(s)
    return rank(st) < rank(best) ? st : best
  }, 'quiet')

  const st = STATUS[topStatus] || STATUS.quiet

  return (
    <div className="mx-2 mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1e2330] transition-colors text-left"
      >
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
        <span className="text-xs font-semibold text-[#a5b4fc] flex-1">{name}</span>
        <span className="text-[10px] text-[#4b5563]">{sessions.length}</span>
        <span className="text-[#4b5563] text-[10px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-0.5">
          {sessions.map(session => (
            <SessionItem
              key={session.key}
              session={session}
              isPinned={activePanes.includes(session.key)}
              onPin={() => onPin(session.key)}
              onRename={onRename}
              onArchive={onArchive}
              onContinue={onContinue}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
export default function Sidebar({ onSettingsClick }) {
  const { sessions, getStatus, pinToPane, activePanes, paneCount, setSessions } = useSessionStore()
  const { connected, send } = useGatewayStore()
  const { getTag, setCard, getProjects } = useProjectStore()
  const { getLabel } = useLabelStore()
  const [sidebarView, setSidebarView] = useState('sessions') // 'sessions' | 'projects'
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const handlePin = (sessionKey) => {
    const alreadyAt = activePanes.indexOf(sessionKey)
    if (alreadyAt >= 0 && alreadyAt < paneCount) return
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : paneCount - 1, sessionKey)
  }

  const handleRename = (sessionKey, newLabel) => {
    send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { sessionKey, patch: { label: newLabel } } })
    setSessions(sessions.map(s => s.key === sessionKey ? { ...s, label: newLabel } : s))
  }

  const handleArchive = (sessionKey) => {
    if (confirm(`Archive this session?`)) {
      send({ type: 'req', id: `sessions-delete-${Date.now()}`, method: 'sessions.delete', params: { sessionKey } })
      setSessions(sessions.filter(s => s.key !== sessionKey))
      activePanes.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
    }
  }

  // Continue: create new session pre-seeded with last thread's card
  const handleContinue = (session) => {
    const tag = getTag(session.key)
    const prevLabel = session.label || session.key
    const card = tag.card || ''
    const project = tag.project || ''
    const newKey = `session-${Date.now()}`

    // Seed message for the new session
    const seedMsg = `Continuing from "${prevLabel}".${project ? ` Project: ${project}.` : ''}\n\n${card}\n\nPick up from here — no need to re-explain context.`

    send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: newKey, message: seedMsg } })

    // Add to sessions list locally
    setSessions([{ key: newKey, label: `↪ ${prevLabel}`, sessionKey: newKey }, ...sessions])

    // Assign same project tag
    if (project) {
      useProjectStore.getState().setTag(newKey, project)
    }

    // Open in pane
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : paneCount - 1, newKey)
  }

  const hideHeartbeat = localStorage.getItem('octis-show-heartbeat-sessions') !== 'true'
  const hideCron = localStorage.getItem('octis-show-cron-sessions') !== 'true'

  const isHeartbeatSession = (s) => {
    const lbl = (getLabel(s.key, s.label || s.key) || '').toLowerCase()
    const key = (s.key || '').toLowerCase()
    return key.includes(':cron:') || lbl.includes('heartbeat') || lbl.startsWith('read heartbeat')
  }
  const isCronSession = (s) => {
    const key = (s.key || '').toLowerCase()
    return key.includes(':cron:') || key.includes('subagent')
  }

  const filtered = sessions.filter(s => {
    if (hideHeartbeat && isHeartbeatSession(s)) return false
    if (hideCron && isCronSession(s)) return false
    const status = getStatus(s)
    if (filter !== 'all' && status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      const tag = getTag(s.key)
      const lbl = getLabel(s.key, s.label || s.key)
      return lbl.toLowerCase().includes(q) || (tag.project || '').toLowerCase().includes(q)
    }
    return true
  })

  const counts = {
    working:     sessions.filter(s => getStatus(s) === 'working').length,
    'needs-you': sessions.filter(s => getStatus(s) === 'needs-you').length,
    active:      sessions.filter(s => getStatus(s) === 'active').length,
    quiet:       sessions.filter(s => getStatus(s) === 'quiet').length,
  }

  // Projects view data
  const projectMap = getProjects()
  const projectNames = Object.keys(projectMap).sort()
  const taggedKeys = new Set(Object.values(projectMap).flat())
  const untaggedSessions = sessions.filter(s => !taggedKeys.has(s.key))

  return (
    <aside className="w-72 shrink-0 bg-[#181c24] border-r border-[#2a3142] flex flex-col h-screen">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a3142]">
        <div className="flex items-center gap-2 mb-2">
          {/* View toggle */}
          <div className="flex rounded-lg overflow-hidden border border-[#2a3142] text-xs">
            <button
              onClick={() => setSidebarView('sessions')}
              className={`px-2.5 py-1 transition-colors ${sidebarView === 'sessions' ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              💬
            </button>
            <button
              onClick={() => setSidebarView('projects')}
              className={`px-2.5 py-1 transition-colors ${sidebarView === 'projects' ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              🗂
            </button>
          </div>
          <span className="font-semibold text-white tracking-tight text-sm flex-1">
            {sidebarView === 'sessions' ? 'Sessions' : 'Projects'}
          </span>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-[#6b7280]">{connected ? 'live' : 'off'}</span>
          </div>
        </div>

        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
          placeholder={sidebarView === 'sessions' ? 'Search sessions…' : 'Search projects…'}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {/* Status filters (sessions view only) */}
        {sidebarView === 'sessions' && (
          <div className="flex flex-wrap gap-1 mt-2">
            {[
              { id: 'all',       label: 'All',       count: sessions.length,     color: '' },
              { id: 'working',   label: 'Working',   count: counts.working,      color: '#a855f7' },
              { id: 'needs-you', label: 'Needs you', count: counts['needs-you'], color: '#3b82f6' },
              { id: 'active',    label: 'Active',    count: counts.active,       color: '#22c55e' },
              { id: 'quiet',     label: 'Quiet',     count: counts.quiet,        color: '#6b7280' },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                  filter === f.id ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
                }`}
              >
                {f.color && filter !== f.id && (
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: f.color }} />
                )}
                {f.label}
                <span className={filter === f.id ? 'text-white/70' : 'text-[#4b5563]'}>{f.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2">

        {/* ── SESSIONS VIEW ── */}
        {sidebarView === 'sessions' && (
          <>
            {filtered.length === 0 && (
              <div className="px-4 py-3 text-xs text-[#6b7280]">No sessions found.</div>
            )}
            {filtered.map(session => (
              <SessionItem
                key={session.key}
                session={session}
                isPinned={activePanes.includes(session.key)}
                onPin={() => handlePin(session.key)}
                onRename={handleRename}
                onArchive={handleArchive}
                onContinue={handleContinue}
              />
            ))}
          </>
        )}

        {/* ── PROJECTS VIEW ── */}
        {sidebarView === 'projects' && (
          <>
            {projectNames.length === 0 && untaggedSessions.length === 0 && (
              <div className="px-4 py-3 text-xs text-[#6b7280]">No projects yet. Tag sessions with 🗂 from the ⋯ menu.</div>
            )}

            {projectNames.map(name => {
              const keys = projectMap[name]
              const projectSessions = sessions.filter(s => keys.includes(s.key))
              if (search && !name.toLowerCase().includes(search.toLowerCase()) && !projectSessions.some(s => (s.label || '').toLowerCase().includes(search.toLowerCase()))) return null
              return (
                <ProjectGroup
                  key={name}
                  name={name}
                  sessions={projectSessions}
                  activePanes={activePanes}
                  paneCount={paneCount}
                  onPin={handlePin}
                  onRename={handleRename}
                  onArchive={handleArchive}
                  onContinue={handleContinue}
                />
              )
            })}

            {untaggedSessions.length > 0 && (
              <div className="mx-2 mt-2">
                <div className="px-2 py-1 text-[10px] text-[#4b5563] uppercase tracking-wider">Untagged ({untaggedSessions.length})</div>
                {untaggedSessions.map(session => (
                  <SessionItem
                    key={session.key}
                    session={session}
                    isPinned={activePanes.includes(session.key)}
                    onPin={() => handlePin(session.key)}
                    onRename={handleRename}
                    onArchive={handleArchive}
                    onContinue={handleContinue}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a3142] px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => {
            const key = `session-${Date.now()}`
            send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: key, message: '/new' } })
            setSessions([{ key, label: 'New session', sessionKey: key }, ...sessions])
            const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
            pinToPane(emptyPane >= 0 ? emptyPane : paneCount - 1, key)
          }}
          className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] text-white text-xs py-1.5 rounded-lg transition-colors font-medium"
        >
          + New Session
        </button>
        <button
          onClick={onSettingsClick}
          className="text-xs text-[#6b7280] hover:text-white transition-colors px-2 py-1.5 rounded hover:bg-[#2a3142]"
          title="Gateway settings"
        >
          ⚙
        </button>
      </div>
    </aside>
  )
}
