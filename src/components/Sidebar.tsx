import { useState, useEffect, useRef, useCallback } from 'react'
import { useSessionStore, useGatewayStore, useProjectStore, useLabelStore, useHiddenStore, Session, SessionStatus } from '../store/gatewayStore'

// ─── Health Circle ─────────────────────────────────────────────────────────────
function HealthCircle({ session }: { session: Session }) {
  const { getCostDelta } = useSessionStore()
  const { send } = useGatewayStore()
  const [show, setShow] = useState(false)

  const cost = session.estimatedCostUsd
  if (cost == null || cost < 0.01) return null

  const delta = getCostDelta(session.key)

  // Color: based on growth rate (delta per poll) + absolute floor
  let color = '#22c55e' // green
  let label = 'Low'
  if (cost > 60 || (delta != null && delta > 0.20)) {
    color = '#ef4444'; label = 'Hot'
  } else if (cost > 15 || (delta != null && delta > 0.05)) {
    color = '#f59e0b'; label = 'Warm'
  }

  const sendCompact = (e: React.MouseEvent) => {
    e.stopPropagation()
    const sk = session.key || session.sessionKey
    send({ type: 'req', id: `compact-${Date.now()}`, method: 'chat.send', params: { sessionKey: sk, message: '/compact' } })
    setShow(false)
  }

  const sendNew = (e: React.MouseEvent) => {
    e.stopPropagation()
    const sk = session.key || session.sessionKey
    send({ type: 'req', id: `new-${Date.now()}`, method: 'chat.send', params: { sessionKey: sk, message: '/new' } })
    setShow(false)
  }

  return (
    <div className="relative shrink-0" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div
        className="w-2 h-2 rounded-full cursor-pointer"
        style={{ background: color, boxShadow: color !== '#22c55e' ? `0 0 4px ${color}88` : 'none' }}
      />
      {show && (
        <div className="absolute left-4 top-0 z-50 bg-[#1a1f2e] border border-[#2a3142] rounded-xl shadow-2xl p-3 min-w-[180px] text-xs">
          <div className="text-white font-semibold mb-1">Session cost</div>
          <div className="text-[#e8eaf0] mb-0.5">
            Total: <span className="font-mono text-amber-400">${cost.toFixed(2)}</span>
          </div>
          {delta != null && (
            <div className="text-[#e8eaf0] mb-2">
              +<span className="font-mono" style={{ color }}>${delta.toFixed(3)}</span> last 30s
            </div>
          )}
          <div className="text-[10px] mb-2" style={{ color }}>{label} — {label === 'Hot' ? 'compact now' : label === 'Warm' ? 'consider compacting' : 'healthy'}</div>
          <div className="flex gap-1.5">
            <button
              onClick={sendCompact}
              className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] text-white rounded px-2 py-1 text-[10px] font-medium transition-colors"
            >Compact</button>
            <button
              onClick={sendNew}
              className="flex-1 bg-[#2a3142] hover:bg-[#3a4152] text-[#e8eaf0] rounded px-2 py-1 text-[10px] font-medium transition-colors"
            >New session</button>
          </div>
        </div>
      )}
    </div>
  )
}

const API = (import.meta.env.VITE_API_URL as string) || ''

interface ArchiveRow {
  session_key: string
  label: string
  sender_name: string
  cost: number
  first_date: string
  last_activity: string
  turn_count: number
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

const STATUS = {
  working: { color: '#a855f7', label: 'Thinking', dot: 'animate-pulse' },
  stuck:   { color: '#f59e0b', label: 'Stuck',    dot: '' },
  active:  { color: '#22c55e', label: 'Active',   dot: '' },
  quiet:   { color: '#6b7280', label: 'Quiet',    dot: '' },
}

// ─── Project tag picker popup ─────────────────────────────────────────────────
const PRESET_PROJECTS = ['Quantum', 'Portal', 'Billing', 'Sage', 'Octis', 'Centurion', 'Infra', 'Personal']

function ProjectPicker({ sessionKey, current, onClose }: { sessionKey: string; current: string; onClose: () => void }) {
  const { setTag } = useProjectStore()
  const [custom, setCustom] = useState('')

  const pick = (p: string) => { setTag(sessionKey, p); onClose() }
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
function SessionItem({ session, isPinned, onPin, onRename, onArchive, onContinue, selected, onSelect, onDragStart, onDragOver, onDrop, isDragOver }: {
  session: Session; isPinned: boolean; onPin: () => void
  onRename: (key: string, label: string) => void
  onArchive: (key: string) => void
  onContinue: (session: Session) => void
  selected: boolean
  onSelect: (key: string, e: React.MouseEvent) => void
  onDragStart?: (key: string) => void
  onDragOver?: (key: string) => void
  onDrop?: (key: string) => void
  isDragOver?: boolean
}) {
  const { getStatus, getLastActivityMs, getUnreadCount } = useSessionStore()
  const { getTag } = useProjectStore()
  const { getLabel, setLabel: saveLabel } = useLabelStore()
  const lastMs = getLastActivityMs(session)
  const lastSeen = lastMs ? timeAgo(lastMs) : null
  const status = getStatus(session)
  const tag = getTag(session.key)
  const [showMenu, setShowMenu] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [editing, setEditing] = useState(false)
  // Use local override first, then gateway label, then a readable fallback from the key
  function formatFallbackLabel(key: string): string {
    // agent:main:slack:direct:u08ml4w30jw:1776060160.265889 → "Slack · Apr 13 6:02am"
    const parts = key.split(':')
    const channel = parts[2] || ''
    const threadTs = parts[parts.length - 1] || ''
    const tsNum = parseFloat(threadTs)
    if (!isNaN(tsNum) && tsNum > 0) {
      const d = new Date(tsNum * 1000)
      const mon = d.toLocaleString('en', { month: 'short' })
      const day = d.getDate()
      const h = d.getHours(), m = d.getMinutes()
      const time = `${h % 12 || 12}:${String(m).padStart(2,'0')}${h < 12 ? 'am' : 'pm'}`
      const ch = channel ? channel.charAt(0).toUpperCase() + channel.slice(1) : 'Session'
      return `${ch} · ${mon} ${day} ${time}`
    }
    return key.slice(0, 40)
  }
  const displayLabel = getLabel(session.key, session.label || formatFallbackLabel(session.key))
  const [label, setLabel] = useState(displayLabel)

  const handleRename = () => {
    if (label.trim()) {
      saveLabel(session.key, label.trim()) // persist locally
      onRename(session.key, label.trim())   // also push to gateway
    }
    setEditing(false)
  }

  const unread = getUnreadCount(session.key)
  const st = STATUS[status as keyof typeof STATUS] || STATUS.quiet

  return (
    <div
      draggable
      onDragStart={() => onDragStart?.(session.key)}
      onDragOver={(e) => { e.preventDefault(); onDragOver?.(session.key) }}
      onDrop={(e) => { e.preventDefault(); onDrop?.(session.key) }}
      className={`mx-2 px-3 py-2.5 rounded-lg mb-0.5 group transition-colors relative cursor-grab active:cursor-grabbing ${
        isDragOver ? 'border-t-2 border-t-[#6366f1]' :
        selected ? 'bg-[#2a1f5e] border border-[#6366f1]' : isPinned ? 'bg-[#1e2330] border border-[#2a3142]' : 'hover:bg-[#1e2330]'
      }`}
      onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); onSelect(session.key, e) } }}
    >
      <div className="flex items-center gap-2">
        {/* Selection checkbox - always visible when selected, hover otherwise */}
        <div
          onClick={(e) => { e.stopPropagation(); onSelect(session.key, e) }}
          className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 cursor-pointer transition-all ${
            selected ? 'bg-[#6366f1] border-[#6366f1]' : 'border-[#3a4152] opacity-0 group-hover:opacity-100 hover:border-[#6366f1]'
          }`}
        >
          {selected && <span className="text-white text-[8px] font-bold">✓</span>}
        </div>
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
            onClick={(e) => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey) onPin() }}
            onDoubleClick={() => setEditing(true)}
            title={displayLabel}
          >
            {displayLabel}
          </span>
        )}

        {unread > 0 && (
          <span className="shrink-0 bg-[#6366f1] text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
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
        {status === 'stuck' && (
          <span className="text-[10px] text-amber-400">⚠️ no activity 5min+</span>
        )}
        {unread > 0 && (
          <span className="text-[10px] text-[#6366f1]">{unread} new</span>
        )}
        {tag.project && (
          <span className="text-[10px] bg-[#2a3142] text-[#a5b4fc] px-1.5 py-0.5 rounded font-medium">
            {tag.project}
          </span>
        )}
        {lastSeen && (
          <span className="text-[10px] text-[#4b5563] ml-auto" title="Last activity">{lastSeen}</span>
        )}
        {session.cost != null && (
          <span className="text-xs text-[#6b7280]">${typeof session.cost === 'number' ? session.cost.toFixed(2) : session.cost}</span>
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
          current={tag.project ?? ''}
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
interface TodoItem { id: number; project: string; text: string; owner: string | null; status: string }

function OwnerBadge({ owner }: { owner: string | null }) {
  if (!owner) return null
  const styles: Record<string, string> = {
    ME: 'bg-blue-900/50 text-blue-300',
    YOU: 'bg-amber-900/50 text-amber-300',
    BOTH: 'bg-green-900/50 text-green-300',
    WAIT: 'bg-gray-800 text-gray-400',
    UNLOCK: 'bg-purple-900/50 text-purple-300',
  }
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono shrink-0 ${styles[owner] || 'bg-gray-800 text-gray-400'}`}>
      {owner}
    </span>
  )
}

function ProjectGroup({ name, sessions, activePanes, paneCount, onPin, onRename, onArchive, onContinue, selected, onSelect, todoCount, todos, onTodoComplete, onTodoNewSession }: {
  name: string; sessions: Session[]; activePanes: (string | null)[]; paneCount: number
  onPin: (key: string) => void
  onRename: (key: string, label: string) => void
  onArchive: (key: string) => void
  onContinue: (session: Session) => void
  selected: Set<string>
  onSelect: (key: string, e: React.MouseEvent) => void
  todoCount?: number
  todos?: TodoItem[]
  onTodoComplete?: (id: number) => void
  onTodoNewSession?: (text: string, project: string) => void
}) {
  const { getStatus } = useSessionStore()
  const [open, setOpen] = useState(true)
  const [todosOpen, setTodosOpen] = useState(false)

  // Bubble up highest-urgency status
  const order: SessionStatus[] = ['working', 'stuck', 'active', 'quiet']
  const topStatus = sessions.reduce((best, s) => {
    const rank = (i: SessionStatus) => order.indexOf(i)
    const st = getStatus(s)
    return rank(st) < rank(best) ? st : best
  }, 'quiet' as SessionStatus)

  const st = STATUS[topStatus] ?? STATUS.quiet

  return (
    <div className="mx-2 mb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1e2330] transition-colors text-left"
      >
        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
        <span className="text-xs font-semibold text-[#a5b4fc] flex-1">{name}</span>
        {todoCount ? (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-yellow-900/40 text-yellow-300 font-mono">{todoCount}</span>
        ) : null}
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
              selected={selected.has(session.key)}
              onSelect={(k, e) => onSelect(k, e)}
            />
          ))}
          {/* Todos section */}
          {todos && todos.length > 0 && (
            <div className="mt-1 mx-1">
              <button
                onClick={() => setTodosOpen(o => !o)}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#1e2330] transition-colors text-left"
              >
                <span className="text-[10px] text-[#6b7280] flex-1">Todos ({todos.length})</span>
                <span className="text-[9px] text-[#4b5563]">{todosOpen ? '▲' : '▼'}</span>
              </button>
              {todosOpen && (
                <div className="mt-0.5 space-y-0.5">
                  {todos.map(todo => {
                    let pressTimer: ReturnType<typeof setTimeout> | null = null
                    return (
                      <div
                        key={todo.id}
                        className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1e2330] cursor-pointer group"
                        onClick={() => onTodoNewSession?.(todo.text, name)}
                        onMouseDown={() => { pressTimer = setTimeout(() => {
                          if (confirm(`Mark as done?\n\n"${todo.text}"`))
                            onTodoComplete?.(todo.id)
                        }, 600) }}
                        onMouseUp={() => { if (pressTimer) clearTimeout(pressTimer) }}
                        onMouseLeave={() => { if (pressTimer) clearTimeout(pressTimer) }}
                      >
                        <OwnerBadge owner={todo.owner} />
                        <span className="text-[11px] text-[#9ca3af] leading-snug flex-1">{todo.text}</span>
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
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
export default function Sidebar({ onSettingsClick }: { onSettingsClick: () => void }) {
  const { sessions, getStatus, getSortedSessions, pinToPane, activePanes, paneCount, setSessions, setManualOrder } = useSessionStore()
  // Re-render every 60s so stuck detection updates live
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  const { connected, send } = useGatewayStore()
  const { getTag, getProjects } = useProjectStore()
  const { getLabel } = useLabelStore()
  const { hide: hideSession } = useHiddenStore()
  const [sidebarView, setSidebarView] = useState('sessions') // 'sessions' | 'projects' | 'archives'
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastSelectedRef = useRef<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [todoCounts, setTodoCounts] = useState<Record<string, number>>({})
  const [todoItems, setTodoItems] = useState<Record<string, TodoItem[]>>({})

  // Fetch todo counts + items for project badges
  const refreshTodos = () => {
    fetch(`${API}/api/todos/count`).then(r => r.json()).then(setTodoCounts).catch(() => {})
    fetch(`${API}/api/todos`).then(r => r.json()).then((data: Record<string, { count: number; items: TodoItem[] }>) => {
      const items: Record<string, TodoItem[]> = {}
      for (const [proj, val] of Object.entries(data)) items[proj] = val.items
      setTodoItems(items)
    }).catch(() => {})
  }
  useEffect(() => {
    refreshTodos()
    const t = setInterval(refreshTodos, 60_000)
    return () => clearInterval(t)
  }, [])
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [archiveRows, setArchiveRows] = useState<ArchiveRow[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveDays, setArchiveDays] = useState(30)

  const loadArchives = useCallback(async () => {
    setArchiveLoading(true)
    try {
      const r = await fetch(`${API}/api/sessions/history?days=${archiveDays}`)
      if (r.ok) setArchiveRows(await r.json() as ArchiveRow[])
    } catch {}
    setArchiveLoading(false)
  }, [archiveDays])

  useEffect(() => {
    if (sidebarView === 'archives') void loadArchives()
  }, [sidebarView, loadArchives])

  // Poll sessions.list every 30s to refresh live cost data
  useEffect(() => {
    if (!connected) return
    const poll = () => {
      send({ type: 'req', id: `sessions-list-${Date.now()}`, method: 'sessions.list', params: {} })
    }
    const t = setInterval(poll, 30_000)
    return () => clearInterval(t)
  }, [connected, send])

  const handleDragStart = (key: string) => setDragKey(key)
  const handleDragOver = (key: string) => setDragOverKey(key)
  const handleDrop = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); setDragOverKey(null); return }
    const sorted = getSortedSessions()
    const from = sorted.findIndex(s => s.key === dragKey)
    const to = sorted.findIndex(s => s.key === targetKey)
    if (from < 0 || to < 0) { setDragKey(null); setDragOverKey(null); return }
    const reordered = [...sorted]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    setManualOrder(reordered.map(s => s.key))
    setDragKey(null)
    setDragOverKey(null)
  }

  const handleSelect = (key: string, e: React.MouseEvent, visibleList: Session[]) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (e.shiftKey && lastSelectedRef.current) {
        const keys = visibleList.map(s => s.key)
        const a = keys.indexOf(lastSelectedRef.current)
        const b = keys.indexOf(key)
        const [from, to] = a < b ? [a, b] : [b, a]
        keys.slice(from, to + 1).forEach(k => next.add(k))
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(key)) next.delete(key)
        else next.add(key)
      } else {
        if (next.has(key) && next.size === 1) next.delete(key)
        else { next.clear(); next.add(key) }
      }
      lastSelectedRef.current = key
      return next
    })
  }

  const handleBulkArchive = () => {
    if (!confirm(`Archive ${selected.size} session(s)?`)) return
    selected.forEach(key => {
      send({ type: 'req', id: `sessions-delete-${Date.now()}-${key}`, method: 'sessions.delete', params: { sessionKey: key } })
      hideSession(key)  // persist by gateway key
      const s = sessions.find(s => s.key === key)
      if (s?.id) hideSession(s.id)  // also persist by UUID
      if (s?.sessionId) hideSession(s.sessionId)
      activePanes.forEach((p, i) => { if (p === key) pinToPane(i, null) })
    })
    setSessions(sessions.filter(s => !selected.has(s.key)))
    setSelected(new Set())
  }

  const handlePin = (sessionKey: string) => {
    const alreadyAt = activePanes.indexOf(sessionKey)
    if (alreadyAt >= 0 && alreadyAt < paneCount) return
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : paneCount - 1, sessionKey)
  }

  const handleRename = (sessionKey: string, newLabel: string) => {
    send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { sessionKey, patch: { label: newLabel } } })
    setSessions(sessions.map(s => s.key === sessionKey ? { ...s, label: newLabel } : s))
    // Persist to server so renames survive page refresh
    void fetch(`${API}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, label: newLabel }),
    })
  }

  const handleArchive = (sessionKey: string) => {
    if (confirm(`Archive this session?`)) {
      send({ type: 'req', id: `sessions-delete-${Date.now()}`, method: 'sessions.delete', params: { sessionKey } })
      hideSession(sessionKey)  // persist by gateway key
      const s = sessions.find(s => s.key === sessionKey)
      if (s?.id) hideSession(s.id)  // also persist by UUID
      if (s?.sessionId) hideSession(s.sessionId)
      setSessions(sessions.filter(s => s.key !== sessionKey))
      activePanes.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
    }
  }

  // Continue: create new session pre-seeded with last thread's card
  const handleContinue = (session: Session) => {
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

  const handleTodoComplete = async (id: number) => {
    await fetch(`${API}/api/todos/${id}/complete`, { method: 'PATCH' }).catch(() => {})
    refreshTodos()
  }

  const handleTodoNewSession = (text: string, project: string) => {
    const newKey = `session-${Date.now()}`
    setSessions([{ key: newKey, label: text.slice(0, 40), sessionKey: newKey }, ...sessions])
    useProjectStore.getState().setTag(newKey, project)
    setTimeout(() => {
      send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey: newKey, message: text } })
    }, 300)
    const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
    pinToPane(emptyPane >= 0 ? emptyPane : paneCount - 1, newKey)
  }

  const hideHeartbeat = localStorage.getItem('octis-show-heartbeat-sessions') !== 'true'
  const hideCron = localStorage.getItem('octis-show-cron-sessions') !== 'true'
  const hideAgentSessions = localStorage.getItem('octis-show-agent-sessions') !== 'true'

  const isHeartbeatSession = (s: Session) => {
    const lbl = (getLabel(s.key, s.label || s.key) || '').toLowerCase()
    const key = (s.key || '').toLowerCase()
    return key.includes(':cron:') || lbl.includes('heartbeat') || lbl.startsWith('read heartbeat')
  }
  const isCronSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    return key.includes(':cron:')
  }
  // Inter-agent sessions: spawned subagents (runtime=subagent) and ACP harness sessions (runtime=acp)
  const isAgentSession = (s: Session) => {
    const key = (s.key || '').toLowerCase()
    return key.includes(':subagent:') || key.includes(':acp:')
  }

  const sorted = getSortedSessions()
  const filtered = sorted.filter((s: Session) => {
    if (hideHeartbeat && isHeartbeatSession(s)) return false
    if (hideCron && isCronSession(s)) return false
    if (hideAgentSessions && isAgentSession(s)) return false
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

  // Only count sessions that pass the heartbeat/cron/agent filter (i.e. are actually visible)
  const visibleSessions = sorted.filter((s: Session) => {
    if (hideHeartbeat && isHeartbeatSession(s)) return false
    if (hideCron && isCronSession(s)) return false
    if (hideAgentSessions && isAgentSession(s)) return false
    return true
  })

  const counts = {
    working:     visibleSessions.filter((s: Session) => getStatus(s) === 'working').length,

    stuck:       visibleSessions.filter((s: Session) => getStatus(s) === 'stuck').length,
    active:      visibleSessions.filter((s: Session) => getStatus(s) === 'active').length,
    quiet:       visibleSessions.filter((s: Session) => getStatus(s) === 'quiet').length,
  }

  // Projects view data
  const projectMap = getProjects()
  const projectNames = Object.keys(projectMap).sort()
  const taggedKeys = new Set(Object.values(projectMap).flat())
  const untaggedSessions = sessions.filter(s => !taggedKeys.has(s.key))

  return (
    <aside className="w-80 shrink-0 bg-[#181c24] border-r border-[#2a3142] flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#2a3142]">
        <div className="flex items-center gap-2 mb-2">
          {/* View toggle */}
          <div className="flex rounded-lg overflow-hidden border border-[#2a3142] text-xs">
            <button
              onClick={() => setSidebarView('sessions')}
              title="Sessions"
              className={`px-2.5 py-1 transition-colors ${sidebarView === 'sessions' ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              💬
            </button>
            <button
              onClick={() => setSidebarView('projects')}
              title="Projects"
              className={`px-2.5 py-1 transition-colors ${sidebarView === 'projects' ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              🗂
            </button>
            <button
              onClick={() => setSidebarView('archives')}
              title="Archives"
              className={`px-2.5 py-1 transition-colors ${sidebarView === 'archives' ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white'}`}
            >
              📁
            </button>
          </div>
          <span className="font-semibold text-white tracking-tight text-sm flex-1">
            {sidebarView === 'sessions' ? 'Sessions' : sidebarView === 'projects' ? 'Projects' : 'Archives'}
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
      </div>

      {/* Status filter pills (sessions view only) */}
      {sidebarView === 'sessions' && (
        <div className="flex flex-wrap gap-1 px-4 py-2 border-b border-[#2a3142]">
          {[
            { id: 'all',       label: 'All',      count: visibleSessions.length, color: '' },
            { id: 'working',   label: 'Running',  count: counts.working,      color: '#a855f7' },

            { id: 'active',    label: 'Recent',   count: counts.active,       color: '#22c55e' },
            { id: 'quiet',     label: 'Idle',     count: counts.quiet,        color: '#6b7280' },
          ].filter((f) => f.count > 0 || f.id === 'all').map((f) => (
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

      {/* Heartbeat/cron indicator */}
      {sidebarView === 'sessions' && ((hideHeartbeat || hideCron) && (() => {
        const hb = hideHeartbeat ? sorted.filter((s: Session) => isHeartbeatSession(s)).length : 0
        const cr = hideCron ? sorted.filter((s: Session) => isCronSession(s) && !isHeartbeatSession(s)).length : 0
        return hb + cr
      })() > 0) && (
        <div className="px-4 py-1.5 border-b border-[#2a3142]">
          <span className="text-xs text-[#4b5563]">
            ❤️ {(() => {
              const hb = hideHeartbeat ? sorted.filter((s: Session) => isHeartbeatSession(s)).length : 0
              const cr = hideCron ? sorted.filter((s: Session) => isCronSession(s) && !isHeartbeatSession(s)).length : 0
              return hb + cr
            })()} running
          </span>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mx-2 mb-1 px-3 py-2 bg-[#2a1f5e] border border-[#6366f1] rounded-lg flex items-center gap-2">
          <span className="text-xs text-[#a5b4fc] flex-1">{selected.size} selected</span>
          <button
            onClick={handleBulkArchive}
            className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-[#3a2a2a] transition-colors"
          >
            🗑 Archive
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-[#6b7280] hover:text-white px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors"
          >
            ✕
          </button>
        </div>
      )}

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
                selected={selected.has(session.key)}
                onSelect={(k, e) => handleSelect(k, e, filtered)}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                isDragOver={dragOverKey === session.key && dragKey !== session.key}
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
                  selected={selected}
                  onSelect={(k, e) => handleSelect(k, e, projectSessions)}
                  todoCount={todoCounts[name]}
                  todos={todoItems[name]}
                  onTodoComplete={handleTodoComplete}
                  onTodoNewSession={handleTodoNewSession}
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
                    selected={selected.has(session.key)}
                    onSelect={(k, e) => handleSelect(k, e, untaggedSessions)}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {/* ── ARCHIVES VIEW ── */}
        {sidebarView === 'archives' && (
          <div className="px-2 py-2">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] text-[#6b7280] uppercase tracking-wider flex-1">History</span>
              <select
                value={archiveDays}
                onChange={e => setArchiveDays(Number(e.target.value))}
                className="bg-[#0f1117] border border-[#2a3142] text-xs text-[#e8eaf0] rounded px-1.5 py-0.5 outline-none"
              >
                <option value={7}>7d</option>
                <option value={30}>30d</option>
                <option value={90}>90d</option>
              </select>
              <button
                onClick={() => void loadArchives()}
                className="text-xs text-[#6b7280] hover:text-white px-1.5 py-0.5 rounded hover:bg-[#2a3142] transition-colors"
                title="Refresh"
              >↻</button>
            </div>

            {archiveLoading && <div className="text-xs text-[#6b7280] py-2">Loading…</div>}

            {!archiveLoading && archiveRows.length === 0 && (
              <div className="text-xs text-[#6b7280] py-2">No archived sessions found.</div>
            )}

            {!archiveLoading && archiveRows
              .filter(r => !search || r.label.toLowerCase().includes(search.toLowerCase()))
              .map(r => {
                const lastMs = r.last_activity ? new Date(r.last_activity).getTime() : null
                const ago = lastMs ? timeAgo(lastMs) : null
                const isActive = sessions.some(s => s.key === r.session_key)
                return (
                  <div
                    key={r.session_key}
                    className="px-3 py-2 rounded-lg mb-0.5 hover:bg-[#1e2330] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#6b7280] shrink-0">
                        {isActive ? '🟢' : '📁'}
                      </span>
                      <span
                        className="text-xs text-white truncate flex-1 leading-snug"
                        title={r.session_key}
                      >
                        {r.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 pl-5">
                      <span className="text-[10px] text-[#4b5563]">{r.sender_name}</span>
                      {ago && <span className="text-[10px] text-[#4b5563]">{ago}</span>}
                      <span className="text-[10px] text-[#4b5563] ml-auto">${r.cost.toFixed(3)}</span>
                    </div>
                  </div>
                )
              })
            }
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a3142] px-3 py-2 flex items-center gap-2">
        <button
          onClick={() => {
            const key = `session-${Date.now()}`
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
