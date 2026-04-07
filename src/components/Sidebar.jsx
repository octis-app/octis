import { useState, useEffect } from 'react'
import { useSessionStore, useGatewayStore, PROJECT_RULES, timeAgo, classifySession } from '../store/gatewayStore'

const statusColors = { active: '#22c55e', idle: '#f59e0b', dead: '#6b7280', blocked: '#ef4444' }

const ALL_PROJECTS = ['General', ...PROJECT_RULES.map(r => r.project)]

const TASK_STATUSES = [
  { id: 'todo',     label: 'To Do',    color: '#6366f1', emoji: '🔵' },
  { id: 'doing',    label: 'Doing',    color: '#22c55e', emoji: '🟢' },
  { id: 'backlog',  label: 'Backlog',  color: '#f59e0b', emoji: '🟡' },
  { id: 'done',     label: 'Done',     color: '#4b5563', emoji: '✅' },
  { id: 'archived', label: 'Archived', color: '#374151', emoji: '🗄' },
]

function urgencyLabel(session, status, msgCount) {
  if (status === 'active') return { label: 'urgent', color: '#ef4444' }
  if (status === 'idle' && msgCount > 0) return { label: 'reply?', color: '#f59e0b' }
  return null
}

function sizeLabel(msgCount) {
  if (msgCount === 0) return { label: 'empty', color: '#4b5563' }
  if (msgCount < 5) return { label: 'small', color: '#6b7280' }
  if (msgCount < 20) return { label: 'medium', color: '#9ca3af' }
  if (msgCount < 60) return { label: 'large', color: '#c4b5fd' }
  return { label: 'huge', color: '#f472b6' }
}

function SessionItem({ session, isPinned, onPin, onRename, onArchive, onMoveProject, onSetTaskStatus, onContinue }) {
  const { getStatus, getLastActive, getDisplayName, getSessionStatus, messageCounts } = useSessionStore()
  const liveStatus = getStatus(session)
  const lastActive = getLastActive(session)
  const taskStatus = getSessionStatus(session.key)
  const msgCount = messageCounts[session.key] ?? null

  const [showMenu, setShowMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const displayName = getDisplayName(session)
  const [label, setLabel] = useState(displayName)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [showStatusPicker, setShowStatusPicker] = useState(false)

  useEffect(() => { setLabel(getDisplayName(session)) }, [displayName])

  const handleRename = () => {
    if (label.trim()) onRename(session.key, label.trim())
    setEditing(false)
  }

  const urgency = urgencyLabel(session, liveStatus, msgCount ?? 0)
  const size = msgCount !== null ? sizeLabel(msgCount) : null

  return (
    <div
      className={`mx-2 px-3 py-2 rounded-lg mb-0.5 group transition-colors relative ${
        isPinned ? 'bg-[#1e2330] border border-[#2a3142]' : 'hover:bg-[#1e2330]'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full shrink-0 mt-0.5" style={{ background: statusColors[liveStatus] }} />

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
            className="text-xs text-white truncate flex-1 cursor-pointer leading-snug"
            onClick={onPin}
            onDoubleClick={() => setEditing(true)}
            title={displayName}
          >
            {displayName}
          </span>
        )}

        <button
          onClick={e => { e.stopPropagation(); setShowMenu(s => !s); setShowProjectPicker(false); setShowStatusPicker(false) }}
          className="opacity-0 group-hover:opacity-100 text-[#6b7280] hover:text-white px-1 text-xs transition-opacity shrink-0"
        >⋯</button>
      </div>

      {/* Stats row */}
      <div className="ml-3.5 mt-1 flex flex-wrap items-center gap-1.5">
        {lastActive && (
          <span className="text-[10px] text-[#4b5563]">{timeAgo(lastActive)}</span>
        )}
        {size && (
          <span className="text-[10px] px-1 py-0.5 rounded" style={{ color: size.color, background: '#1a1f2e' }}>
            {size.label}{msgCount !== null ? ` · ${msgCount}msg` : ''}
          </span>
        )}
        {urgency && (
          <span className="text-[10px] font-medium animate-pulse" style={{ color: urgency.color }}>
            {urgency.label}
          </span>
        )}
      </div>

      {/* Context menu */}
      {showMenu && (
        <div className="absolute right-2 top-8 bg-[#1e2330] border border-[#2a3142] rounded-lg shadow-xl z-50 py-1 min-w-[160px]">
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
            onClick={() => { setEditing(true); setShowMenu(false) }}>✏️ Rename</button>
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
            onClick={() => { onPin(); setShowMenu(false) }}>📌 Open in pane</button>
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#818cf8] hover:bg-[#2a3142] font-medium"
            onClick={() => { onContinue(session); setShowMenu(false) }}>↩ Continue from here</button>
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
            onClick={() => setShowStatusPicker(s => !s)}>
            🏷 Status: {TASK_STATUSES.find(s => s.id === taskStatus)?.label || taskStatus} ›
          </button>
          <button className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
            onClick={() => setShowProjectPicker(s => !s)}>📁 Move to project ›</button>
          <div className="border-t border-[#2a3142] my-1" />
          <button className="w-full px-3 py-1.5 text-xs text-left text-red-400 hover:bg-[#2a3142]"
            onClick={() => { onArchive(session.key); setShowMenu(false) }}>🗑 Archive</button>

          {/* Status picker */}
          {showStatusPicker && (
            <div className="border-t border-[#2a3142] pt-1">
              {TASK_STATUSES.map(ts => (
                <button key={ts.id} className="w-full px-3 py-1.5 text-xs text-left hover:bg-[#2a3142] flex items-center gap-2"
                  style={{ color: ts.id === taskStatus ? ts.color : '#e8eaf0' }}
                  onClick={() => { onSetTaskStatus(session.key, ts.id); setShowMenu(false); setShowStatusPicker(false) }}>
                  {ts.emoji} {ts.label} {ts.id === taskStatus && '✓'}
                </button>
              ))}
            </div>
          )}

          {/* Project picker */}
          {showProjectPicker && (
            <div className="border-t border-[#2a3142] pt-1">
              {ALL_PROJECTS.map(p => (
                <button key={p} className="w-full px-3 py-1.5 text-xs text-left text-[#e8eaf0] hover:bg-[#2a3142]"
                  onClick={() => { onMoveProject(session.key, p); setShowMenu(false); setShowProjectPicker(false) }}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TaskStatusGroup({ taskStatus, sessions, activePanes, onPin, onRename, onArchive, onMoveProject, onSetTaskStatus, onContinue, collapsed, onToggle }) {
  const { getStatus } = useSessionStore()
  const ts = TASK_STATUSES.find(s => s.id === taskStatus) || TASK_STATUSES[0]
  const activeCount = sessions.filter(s => getStatus(s) === 'active').length

  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[#1e2330] transition-colors"
      >
        <span className="text-[#6b7280] text-xs">{collapsed ? '▶' : '▼'}</span>
        <span className="text-xs font-semibold tracking-wide" style={{ color: ts.color }}>{ts.emoji} {ts.label}</span>
        {activeCount > 0 && <span className="text-[10px] ml-1" style={{ color: '#22c55e' }}>●{activeCount}</span>}
        <span className="text-[10px] text-[#4b5563] ml-auto">{sessions.length}</span>
      </button>
      {!collapsed && sessions.map(session => (
        <SessionItem
          key={session.key}
          session={session}
          isPinned={activePanes.includes(session.key)}
          onPin={() => onPin(session.key)}
          onRename={onRename}
          onArchive={onArchive}
          onMoveProject={onMoveProject}
          onSetTaskStatus={onSetTaskStatus}
          onContinue={onContinue}
        />
      ))}
    </div>
  )
}

export default function Sidebar({ onSettingsClick }) {
  const { sessions, getStatus, getProject, pinToPane, activePanes, paneCount, setSessions,
          setProjectOverride, collapsedProjects, toggleCollapsed,
          getSessionStatus, setSessionStatus, setDisplayNameOverride } = useSessionStore()
  const { connected, send } = useGatewayStore()
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [, tick] = useState(0)
  // Which task-status groups are collapsed
  const [collapsedTaskGroups, setCollapsedTaskGroups] = useState([])

  // Refresh time-ago labels every 30s
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const handlePin = (sessionKey) => {
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : 0, sessionKey)
  }

  const handleRename = (sessionKey, newLabel) => {
    send({ type: 'req', id: `rename-${Date.now()}`, method: 'sessions.patch', params: { sessionKey, patch: { label: newLabel } } })
    setSessions(sessions.map(s => s.key === sessionKey ? { ...s, label: newLabel } : s))
  }

  const handleArchive = (sessionKey) => {
    if (confirm(`Archive this session?`)) {
      send({ type: 'req', id: `del-${Date.now()}`, method: 'sessions.delete', params: { sessionKey } })
      setSessions(sessions.filter(s => s.key !== sessionKey))
      activePanes.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
    }
  }

  const handleMoveProject = (sessionKey, project) => {
    setProjectOverride(sessionKey, project)
  }

  const handleSetTaskStatus = (sessionKey, status) => {
    setSessionStatus(sessionKey, status)
  }

  const handleContinue = (fromSession) => {
    const { sessionCards, getDisplayName, sessions: allSessions } = useSessionStore.getState()
    const { ws } = useGatewayStore.getState()
    if (!ws) return

    const fromName = getDisplayName(fromSession)
    const cardText = sessionCards[fromSession.key]
    const project = getProject(fromSession)

    // Build handoff message
    let handoff = `↩ Continuing from: **${fromName}**`
    if (project && project !== 'General') handoff += ` (${project})`
    handoff += '\n\n'
    if (cardText) {
      handoff += cardText
    } else {
      handoff += `_(No session card found — pick up where we left off)_`
    }

    const reqId = `new-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'sessions.create', params: { agentId: 'main' } })

    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'res' && msg.id === reqId) {
          ws.removeEventListener('message', handler)
          if (msg.ok) {
            const newKey = msg.payload?.key || msg.payload?.sessionKey
            if (newKey) {
              // Add to session list with a meaningful name
              const existing = useSessionStore.getState().sessions
              if (!existing.find(s => s.key === newKey)) {
                useSessionStore.getState().setSessions([
                  { key: newKey, displayName: `↩ ${fromName}`, updatedAt: Date.now() },
                  ...existing
                ])
              }
              // Pre-name it
              useSessionStore.getState().setDisplayNameOverride(newKey, `↩ ${fromName}`)
              // Mark it as "doing"
              useSessionStore.getState().setSessionStatus(newKey, 'doing')
              // Pin to pane
              const emptyPane = useSessionStore.getState().activePanes.findIndex((p, i) => i < paneCount && !p)
              pinToPane(emptyPane >= 0 ? emptyPane : 0, newKey)
              // Send handoff message after short delay (let pane mount + connect)
              setTimeout(() => {
                send({
                  type: 'req',
                  id: `handoff-${Date.now()}`,
                  method: 'chat.send',
                  params: { sessionKey: newKey, message: handoff }
                })
              }, 800)
            }
            setTimeout(() => send({ type: 'req', id: `sl-${Date.now()}`, method: 'sessions.list', params: {} }), 600)
          }
        }
      } catch {}
    }
    ws.addEventListener('message', handler)
    setTimeout(() => ws.removeEventListener('message', handler), 8000)
  }

  const handleNewSession = () => {
    const reqId = `new-${Date.now()}`
    const { ws } = useGatewayStore.getState()
    if (!ws) return

    send({ type: 'req', id: reqId, method: 'sessions.create', params: { agentId: 'main' } })

    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'res' && msg.id === reqId) {
          ws.removeEventListener('message', handler)
          if (msg.ok) {
            const newKey = msg.payload?.key || msg.payload?.sessionKey
            if (newKey) {
              const existing = useSessionStore.getState().sessions
              if (!existing.find(s => s.key === newKey)) {
                useSessionStore.getState().setSessions([
                  { key: newKey, displayName: 'New Session', updatedAt: Date.now() },
                  ...existing
                ])
              }
              const emptyPane = useSessionStore.getState().activePanes.findIndex((p, i) => i < paneCount && !p)
              pinToPane(emptyPane >= 0 ? emptyPane : 0, newKey)
            }
            setTimeout(() => send({ type: 'req', id: `sl-${Date.now()}`, method: 'sessions.list', params: {} }), 500)
          }
        }
      } catch {}
    }
    ws.addEventListener('message', handler)
    setTimeout(() => ws.removeEventListener('message', handler), 5000)
  }

  const toggleTaskGroup = (id) => {
    setCollapsedTaskGroups(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  // Filter sessions
  const filtered = sessions.filter(s => {
    const status = getStatus(s)
    if (filter === 'active' && status !== 'active') return false
    if (filter === 'idle' && status !== 'idle') return false
    if (filter === 'dead' && status !== 'dead') return false
    if (search) {
      const q = search.toLowerCase()
      const { getDisplayName } = useSessionStore.getState()
      return getDisplayName(s).toLowerCase().includes(q)
    }
    return true
  })

  // Group by task status
  const byTaskStatus = {}
  filtered.forEach(s => {
    const ts = getSessionStatus(s.key)
    if (!byTaskStatus[ts]) byTaskStatus[ts] = []
    byTaskStatus[ts].push(s)
  })
  // Sort within each group: active first, then by last activity
  const { getLastActive } = useSessionStore.getState()
  const statusOrder = { active: 0, idle: 1, dead: 2 }
  Object.values(byTaskStatus).forEach(group => {
    group.sort((a, b) => {
      const sa = statusOrder[getStatus(a)] ?? 3
      const sb = statusOrder[getStatus(b)] ?? 3
      if (sa !== sb) return sa - sb
      const la = getLastActive(a) || 0
      const lb = getLastActive(b) || 0
      return (typeof lb === 'number' ? lb : new Date(lb).getTime()) -
             (typeof la === 'number' ? la : new Date(la).getTime())
    })
  })

  // Show task status groups in order: doing → todo → backlog → done → archived
  const taskGroupOrder = ['doing', 'todo', 'backlog', 'done', 'archived']
  const presentGroups = taskGroupOrder.filter(ts => byTaskStatus[ts]?.length > 0)

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
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
          placeholder="Search sessions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="flex gap-1 mt-2">
          {[
            { id: 'all', label: `All ${sessions.length}` },
            { id: 'active', label: `🟢 ${counts.active}` },
            { id: 'idle', label: `🟡 ${counts.idle}` },
            { id: 'dead', label: `⚫ ${counts.dead}` },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`flex-1 text-xs py-1 rounded transition-colors ${
                filter === f.id ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
              }`}>{f.label}</button>
          ))}
        </div>
      </div>

      {/* Task status groups */}
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-4 py-3 text-xs text-[#6b7280]">No sessions found.</div>
        )}
        {presentGroups.map(tsId => (
          <TaskStatusGroup
            key={tsId}
            taskStatus={tsId}
            sessions={byTaskStatus[tsId] || []}
            activePanes={activePanes}
            onPin={handlePin}
            onRename={handleRename}
            onArchive={handleArchive}
            onMoveProject={handleMoveProject}
            onSetTaskStatus={handleSetTaskStatus}
            onContinue={handleContinue}
            collapsed={collapsedTaskGroups.includes(tsId)}
            onToggle={() => toggleTaskGroup(tsId)}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a3142] px-3 py-2 flex items-center gap-2">
        <button onClick={handleNewSession}
          className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] text-white text-xs py-1.5 rounded-lg transition-colors font-medium">
          + New Session
        </button>
        <button onClick={onSettingsClick}
          className="text-xs text-[#6b7280] hover:text-white transition-colors px-2 py-1.5 rounded hover:bg-[#2a3142]"
          title="Gateway settings">⚙</button>
      </div>
    </aside>
  )
}
