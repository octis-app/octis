import { useState } from 'react'
import { useSessionStore, useGatewayStore } from '../store/gatewayStore'

const statusColors = {
  active: '#22c55e',
  idle: '#f59e0b',
  dead: '#6b7280',
  blocked: '#ef4444',
}

const statusLabels = {
  active: 'Active',
  idle: 'Idle',
  dead: 'Dead',
  blocked: 'Blocked',
}

function SessionItem({ session, isPinned, onPin, onRename, onArchive }) {
  const { getStatus } = useSessionStore()
  const status = getStatus(session)
  const [showMenu, setShowMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(session.label || session.key)

  const handleRename = () => {
    if (label.trim()) onRename(session.key, label.trim())
    setEditing(false)
  }

  return (
    <div
      className={`mx-2 px-3 py-2.5 rounded-lg mb-0.5 group transition-colors relative ${
        isPinned ? 'bg-[#1e2330] border border-[#2a3142]' : 'hover:bg-[#1e2330]'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full shrink-0 mt-0.5" style={{ background: statusColors[status] }} />

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
            className="text-sm text-white truncate flex-1 cursor-pointer"
            onClick={onPin}
            onDoubleClick={() => setEditing(true)}
            title="Click to open · Double-click to rename"
          >
            {session.label || session.key}
          </span>
        )}

        {/* Context menu trigger */}
        <button
          onClick={e => { e.stopPropagation(); setShowMenu(s => !s) }}
          className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white px-1 text-xs transition-opacity"
        >
          ⋯
        </button>
      </div>

      <div className="flex items-center gap-2 mt-0.5 ml-3.5">
        <span className="text-xs" style={{ color: statusColors[status] }}>{statusLabels[status]}</span>
        {session.cost != null && (
          <span className="text-xs text-[#6b7280]">· ${typeof session.cost === 'number' ? session.cost.toFixed(3) : session.cost}</span>
        )}
      </div>

      {/* Dropdown menu */}
      {showMenu && (
        <div
          className="absolute right-2 top-8 bg-[#1e2330] border border-[#2a3142] rounded-lg shadow-xl z-50 py-1 min-w-[140px]"
          onBlur={() => setShowMenu(false)}
        >
          <button
            className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142] transition-colors"
            onClick={() => { setEditing(true); setShowMenu(false) }}
          >
            ✏️ Rename
          </button>
          <button
            className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142] transition-colors"
            onClick={() => { onPin(); setShowMenu(false) }}
          >
            📌 Open in pane
          </button>
          <div className="border-t border-[#2a3142] my-1" />
          <button
            className="w-full px-3 py-1.5 text-xs text-left text-red-400 hover:bg-[#2a3142] transition-colors"
            onClick={() => { onArchive(session.key); setShowMenu(false) }}
          >
            🗑 Archive
          </button>
        </div>
      )}
    </div>
  )
}

export default function Sidebar({ onSettingsClick }) {
  const { sessions, getStatus, pinToPane, activePanes, paneCount, setSessions } = useSessionStore()
  const { connected, send } = useGatewayStore()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const handlePin = (sessionKey) => {
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : 0, sessionKey)
  }

  const handleRename = (sessionKey, newLabel) => {
    send({ type: 'sessions.patch', sessionKey, patch: { label: newLabel } })
    setSessions(sessions.map(s => s.key === sessionKey ? { ...s, label: newLabel } : s))
  }

  const handleArchive = (sessionKey) => {
    if (confirm(`Archive session "${sessionKey}"? It can be recovered from the gateway for 30 days.`)) {
      send({ type: 'sessions.delete', sessionKey })
      setSessions(sessions.filter(s => s.key !== sessionKey))
      // Clear from panes
      activePanes.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
    }
  }

  const handleNewSession = () => {
    const key = `session-${Date.now()}`
    send({ type: 'chat.send', sessionKey: key, message: '/new' })
    pinToPane(activePanes.findIndex((p, i) => i < paneCount && !p) ?? 0, key)
  }

  const filtered = sessions.filter(s => {
    const status = getStatus(s)
    if (filter === 'active' && status !== 'active') return false
    if (filter === 'idle' && status !== 'idle') return false
    if (filter === 'dead' && status !== 'dead') return false
    if (search) {
      const q = search.toLowerCase()
      return (s.label || s.key).toLowerCase().includes(q)
    }
    return true
  })

  const counts = {
    active: sessions.filter(s => getStatus(s) === 'active').length,
    idle: sessions.filter(s => getStatus(s) === 'idle').length,
    dead: sessions.filter(s => getStatus(s) === 'dead').length,
  }

  return (
    <aside className="w-60 shrink-0 bg-[#181c24] border-r border-[#2a3142] flex flex-col h-screen">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a3142]">
        <div className="flex items-center gap-2 mb-2">
          <span className="font-semibold text-white tracking-tight text-sm">Sessions</span>
          <div className="ml-auto flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-[#6b7280]">{connected ? 'live' : 'off'}</span>
          </div>
        </div>

        {/* Search */}
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
          placeholder="Search sessions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {/* Filter tabs */}
        <div className="flex gap-1 mt-2">
          {[
            { id: 'all', label: `All ${sessions.length}` },
            { id: 'active', label: `🟢 ${counts.active}` },
            { id: 'idle', label: `🟡 ${counts.idle}` },
            { id: 'dead', label: `⚫ ${counts.dead}` },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex-1 text-xs py-1 rounded transition-colors ${
                filter === f.id ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-2">
        {filtered.length === 0 && (
          <div className="px-4 py-3 text-xs text-[#6b7280]">No sessions found.</div>
        )}
        {filtered.map((session) => (
          <SessionItem
            key={session.key}
            session={session}
            isPinned={activePanes.includes(session.key)}
            onPin={() => handlePin(session.key)}
            onRename={handleRename}
            onArchive={handleArchive}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a3142] px-3 py-2 flex items-center gap-2">
        <button
          onClick={handleNewSession}
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
