import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { useLabelStore, useSessionStore } from '../store/gatewayStore'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { useAuthStore } from '../store/authStore'
import { authFetch } from '../lib/authFetch'

const API = import.meta.env.VITE_API_URL || ''

// Quick Commands config — ADD NEW COMMANDS HERE ONLY.
// key: unique id used in DB + localStorage. label: shown in Settings. note: hint below textarea.
// To add a new command: append one entry to this array. No other code changes needed.
const QUICK_COMMANDS_CONFIG = [
  {
    key: 'brief',
    label: '📝 Dev Log',
    note: '',
    default: "If you're a session that modified Octis app code, keep OCTIS_CHANGES.md updated with only relevant development work since the last log update. Record every code modification, bug fix, config/schema/API change, dependency change, important decision, known issue, and testing/verification result.",
  },
  {
    key: 'away',
    label: '🚪 Stepping Away',
    note: '',
    default: "I'm stepping away for a while. Please do the following:\n1. Summarize what you're currently working on (1-2 sentences).\n2. List anything you're blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\n3. List everything you CAN do autonomously while I'm gone, in order.\n4. Estimate how long you can run without me.\nBe concise. I'll read this on my phone.",
  },
  {
    key: 'save',
    label: '💾 Save',
    note: '',
    default: "💾 checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.",
  },
  {
    key: 'archive_msg',
    label: '📦 Archive msg',
    note: ' (also hides session from sidebar)',
    default: "💾 Final save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.",
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; note: string; default: string }>

// Derived defaults object — used as fallback in getQuickCommands()
const QUICK_COMMAND_DEFAULTS: Record<string, string> = Object.fromEntries(
  QUICK_COMMANDS_CONFIG.map(c => [c.key, c.default])
)

function getQuickCommands(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('octis-quick-commands') || '{}')
  } catch { return {} }
}

function saveQuickCommand(key: string, value: string) {
  const current = getQuickCommands()
  current[key] = value
  localStorage.setItem('octis-quick-commands', JSON.stringify(current))
}

interface AutoResizeTextareaProps {
  value: string
  onChange: (v: string) => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
}
function AutoResizeTextarea({ value, onChange, onUndo, onRedo, canUndo, canRedo }: AutoResizeTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = ref.current.scrollHeight + 'px'
    }
  }, [value])
  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
            e.preventDefault(); onUndo?.()
          } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
            e.preventDefault(); onRedo?.()
          }
        }}
        className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-xs text-[#a5b4fc] font-mono focus:outline-none focus:border-[#6366f1] resize-y min-h-[60px] overflow-hidden"
        rows={3}
      />
      {/* Undo/redo buttons */}
      <div className="absolute top-1.5 right-1.5 flex gap-0.5">
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Ctrl+Z)"
          className={`w-5 h-5 flex items-center justify-center rounded text-[10px] transition-colors ${canUndo ? 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]' : 'text-[#2a3142] cursor-not-allowed'}`}
        >↩</button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          className={`w-5 h-5 flex items-center justify-center rounded text-[10px] transition-colors ${canRedo ? 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]' : 'text-[#2a3142] cursor-not-allowed'}`}
        >↪</button>
      </div>
    </div>
  )
}

function Toggle({ value, onChange, label, description }: { value: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[#2a3142]">
      <div>
        <div className="text-sm text-white font-medium">{label}</div>
        {description && <div className="text-xs text-[#6b7280] mt-0.5">{description}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        type="button"
        className={`relative inline-flex shrink-0 ml-4 h-5 w-10 items-center rounded-full transition-colors focus:outline-none ${value ? 'bg-[#6366f1]' : 'bg-[#2a3142]'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${value ? 'translate-x-5' : 'translate-x-1'}`}
        />
      </button>
    </div>
  )
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { getToken } = useAuth()
  const { labels, setLabel } = useLabelStore()
  const { sessions } = useSessionStore()
  const { status: pushStatus, subscribe: pushSubscribe, unsubscribe: pushUnsubscribe } = usePushNotifications(getToken)

  // Load settings from localStorage
  const [autoRename, setAutoRename] = useState(() =>
    localStorage.getItem('octis-auto-rename') !== 'false'
  )
  const [renameModel, setRenameModel] = useState(() =>
    localStorage.getItem('octis-rename-model') || ''
  )
  const [noiseHidden, setNoiseHidden] = useState(() =>
    localStorage.getItem('octis-noise-hidden') !== 'false'
  )
  const [showHeartbeatSessions, setShowHeartbeatSessions] = useState(() =>
    localStorage.getItem('octis-show-heartbeat-sessions') === 'true'
  )
  const [showCronSessions, setShowCronSessions] = useState(() =>
    localStorage.getItem('octis-show-cron-sessions') === 'true'
  )

  const [renaming, setRenaming] = useState(false)
  const [renameStatus, setRenameStatus] = useState('')

  // Quick command state - localStorage is primary (instant, no flash)
  // Server DB is the authoritative source; synced on every mount and saved on every change
  const [qcValues, setQcValues] = useState<Record<string, string>>(() => getQuickCommands())
  const [qcSaveStatus, setQcSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // isDirtyRef: true once user has made any edit this mount - prevents server sync from stomping in-progress work
  const isDirtyRef = useRef(false)
  // pendingFlushRef: latest values waiting to be flushed to server (used on unmount)
  const pendingFlushRef = useRef<Record<string, string> | null>(null)

  // Ref-based undo map — works for ANY string key, no per-key hooks needed.
  // Adding a new command to QUICK_COMMANDS_CONFIG automatically gets undo/redo here.
  type QcUndoState = { undo: string[]; redo: string[]; inBurst: boolean; lastMs: number; timer: ReturnType<typeof setTimeout> | null }
  const qcUndoMapRef = useRef<Map<string, QcUndoState>>(new Map())
  const getQcUndoState = useCallback((key: string): QcUndoState => {
    if (!qcUndoMapRef.current.has(key)) {
      qcUndoMapRef.current.set(key, { undo: [], redo: [], inBurst: false, lastMs: 0, timer: null })
    }
    return qcUndoMapRef.current.get(key)!
  }, [])
  const canQcUndo = (key: string) => (qcUndoMapRef.current.get(key)?.undo.length ?? 0) > 0
  const canQcRedo = (key: string) => (qcUndoMapRef.current.get(key)?.redo.length ?? 0) > 0

  // On mount: ALWAYS fetch from server - server is the authoritative source.
  // localStorage is shown instantly (no flash), but server wins once response arrives.
  // If user has already started editing (isDirtyRef), server response is discarded.
  useEffect(() => {
    isDirtyRef.current = false
    pendingFlushRef.current = null
    authFetch(`${API}/api/settings`)
      .then(r => r.json())
      .then(d => {
        if (isDirtyRef.current) return // user already edited - don't stomp their work
        if (d.ok && d.settings?.quick_commands) {
          const serverVals = d.settings.quick_commands as Record<string, string>
          // localStorage is primary — user's saved text always wins.
          // Server fills in keys that don't exist locally yet.
          // NO DEFAULTS - only use what's explicitly saved (localStorage > server).
          let localVals: Record<string, string> = {}
          try { localVals = JSON.parse(localStorage.getItem('octis-quick-commands') || '{}') } catch {}
          const merged = { ...serverVals, ...localVals }
          setQcValues(merged)
          localStorage.setItem('octis-quick-commands', JSON.stringify(merged))
        }
      })
      .catch(() => {})
    // On unmount: flush any pending save immediately so closing the modal never drops changes
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (pendingFlushRef.current) {
        const vals = pendingFlushRef.current
        pendingFlushRef.current = null
        authFetch(`${API}/api/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quick_commands: vals }),
        }).catch(() => {})
      }
    }
  }, [])

  const persistQcToServer = useCallback((values: Record<string, string>) => {
    pendingFlushRef.current = values // always track latest for unmount flush
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    setQcSaveStatus('saving')
    saveTimerRef.current = setTimeout(() => {
      pendingFlushRef.current = null // debounce fired - no need for unmount flush
      authFetch(`${API}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quick_commands: values }),
      })
        .then(r => r.json())
        .then(d => {
          setQcSaveStatus(d.ok ? 'saved' : 'error')
          statusTimerRef.current = setTimeout(() => setQcSaveStatus('idle'), 2000)
        })
        .catch(() => {
          setQcSaveStatus('error')
          statusTimerRef.current = setTimeout(() => setQcSaveStatus('idle'), 2000)
        })
    }, 400)
  }, [])

  const updateQc = useCallback((key: string, value: string) => {
    isDirtyRef.current = true
    // Burst-coalescing undo push (Word-style) — works for any key
    const s = getQcUndoState(key)
    const current = getQuickCommands()[key] ?? ''
    const now = Date.now(); const gap = now - s.lastMs; s.lastMs = now
    if (!s.inBurst || gap > 1500) { s.undo = [...s.undo.slice(-99), current]; s.redo = []; s.inBurst = true }
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => { s.inBurst = false; s.timer = null }, 1500)
    saveQuickCommand(key, value)
    setQcValues(prev => { const next = { ...prev, [key]: value }; persistQcToServer(next); return next })
  }, [persistQcToServer, getQcUndoState])

  const resetQc = useCallback((key: string) => {
    isDirtyRef.current = true
    // Delete the command entirely (no defaults)
    const current = getQuickCommands()
    delete current[key]
    localStorage.setItem('octis-quick-commands', JSON.stringify(current))
    setQcValues(prev => { const next = { ...prev }; delete next[key]; persistQcToServer(next); return next })
  }, [persistQcToServer])

  const doQcUndo = useCallback((key: string) => {
    const s = getQcUndoState(key)
    if (s.undo.length === 0) return
    const current = getQuickCommands()[key] ?? ''
    const prev = s.undo.pop()!
    s.redo = [current, ...s.redo.slice(0, 99)]
    s.inBurst = false; if (s.timer) { clearTimeout(s.timer); s.timer = null }
    isDirtyRef.current = true
    saveQuickCommand(key, prev)
    setQcValues(v => { const next = { ...v, [key]: prev }; persistQcToServer(next); return next })
  }, [persistQcToServer, getQcUndoState])

  const doQcRedo = useCallback((key: string) => {
    const s = getQcUndoState(key)
    if (s.redo.length === 0) return
    const current = getQuickCommands()[key] ?? ''
    const nextVal = s.redo.shift()!
    s.undo = [...s.undo.slice(-99), current]; s.inBurst = false
    isDirtyRef.current = true
    saveQuickCommand(key, nextVal)
    setQcValues(v => { const nextVals = { ...v, [key]: nextVal }; persistQcToServer(nextVals); return nextVals })
  }, [persistQcToServer, getQcUndoState])

  const save = (key: string, val: boolean) => localStorage.setItem(key, String(val))

  // User management (owner only)
  const { role: authRole } = useAuthStore()
  const isOwner = authRole === 'owner' || authRole === 'admin'
  type OctisUser = { id: number; email: string; role: string; agent_id: string; created_at: number }
  const [users, setUsers] = useState<OctisUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState('viewer')
  const [addingUser, setAddingUser] = useState(false)
  const [userMsg, setUserMsg] = useState('')

  useEffect(() => {
    if (!isOwner) return
    setUsersLoading(true)
    authFetch(`${API}/api/users`)
      .then(r => r.json())
      .then(d => { if (d.ok) setUsers(d.users) })
      .catch(() => {})
      .finally(() => setUsersLoading(false))
  }, [isOwner])

  const handleAddUser = async () => {
    if (!newEmail || !newPassword) { setUserMsg('Email and password required'); return }
    setAddingUser(true); setUserMsg('')
    try {
      const res = await authFetch(`${API}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, password: newPassword, role: newRole, agentId: 'main' }),
      })
      const d = await res.json()
      if (!res.ok) { setUserMsg(`❌ ${d.error}`); return }
      setUsers(prev => [...prev, d.user])
      setNewEmail(''); setNewPassword(''); setNewRole('viewer')
      setUserMsg(`✅ Added ${d.user.email}`)
    } catch { setUserMsg('❌ Network error') }
    finally { setAddingUser(false) }
  }

  const handleDeleteUser = async (u: OctisUser) => {
    if (!confirm(`Remove ${u.email}? They will lose access immediately.`)) return
    try {
      const res = await authFetch(`${API}/api/users/${u.id}`, { method: 'DELETE' })
      const d = await res.json()
      if (!res.ok) { setUserMsg(`❌ ${d.error}`); return }
      setUsers(prev => prev.filter(x => x.id !== u.id))
      setUserMsg(`Removed ${u.email}`)
    } catch { setUserMsg('❌ Network error') }
  }

  const handleRenameAll = async () => {
    setRenaming(true)
    setRenameStatus('Fetching labels from DB...')
    try {
      const res = await fetch(`${API}/api/session-labels`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      // Match against loaded sessions
      let count = 0
      const dataMap = data as Record<string, string>
      sessions.forEach(s => {
        const uuid = s.id || s.sessionId
        const gKey = s.key
        if (uuid && dataMap[uuid]) {
          setLabel(gKey, dataMap[uuid])
          setLabel(uuid, dataMap[uuid])
          count++
        }
      })
      // Also store all by UUID for future matching
      Object.entries(data as Record<string, string>).forEach(([uuid, label]) => {
        if (!labels[uuid]) setLabel(uuid, label)
      })
      setRenameStatus(`✅ Applied ${count} labels (${Object.keys(data).length} total in DB)`)
    } catch (e) {
      setRenameStatus(`❌ Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRenaming(false)
    }
  }

  const handleClearLabels = () => {
    if (confirm('Clear all saved labels? Sessions will show their gateway keys until re-renamed.')) {
      localStorage.removeItem('octis-labels')
      window.location.reload()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3142]">
          <div className="flex items-center gap-2">
            <span className="text-xl">🐙</span>
            <span className="text-base font-semibold text-white">Octis Settings</span>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white text-sm px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto max-h-[70vh]">

          {/* Display */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-1">Display</div>
          <Toggle
            value={noiseHidden}
            onChange={v => { setNoiseHidden(v); save('octis-noise-hidden', v) }}
            label="Hide tool calls & system messages"
            description="Show only chat messages in panes (chat only mode)"
          />
          <Toggle
            value={!showHeartbeatSessions}
            onChange={v => { setShowHeartbeatSessions(!v); save('octis-show-heartbeat-sessions', !v) }}
            label="Hide heartbeat sessions in sidebar"
            description="Filter out periodic health-check sessions"
          />
          <Toggle
            value={!showCronSessions}
            onChange={v => { setShowCronSessions(!v); save('octis-show-cron-sessions', !v) }}
            label="Hide cron/scheduled sessions in sidebar"
            description="Filter out automated scheduled tasks"
          />

          {/* Sessions */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Session Names</div>
          <Toggle
            value={autoRename}
            onChange={v => { setAutoRename(v); save('octis-auto-rename', v) }}
            label="Auto-rename sessions"
            description="Automatically use first message as session name"
          />
          {autoRename && (
            <div className="mt-3">
              <div className="text-xs text-[#6b7280] mb-1">Rename model <span className="text-[#4b5563]">(blank = server default)</span></div>
              <input
                type="text"
                value={renameModel}
                onChange={e => { setRenameModel(e.target.value); localStorage.setItem('octis-rename-model', e.target.value) }}
                placeholder="e.g. anthropic/claude-haiku-4-5"
                className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-[#6366f1]"
              />
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleRenameAll}
              disabled={renaming}
              className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 text-white text-sm rounded-lg py-2 font-medium transition-colors"
            >
              {renaming ? 'Renaming...' : '🏷️ Rename all sessions from DB'}
            </button>
            <button
              onClick={handleClearLabels}
              className="px-3 bg-[#2a3142] hover:bg-[#3a4152] text-[#6b7280] text-sm rounded-lg py-2 transition-colors"
              title="Clear saved labels"
            >
              🗑️
            </button>
          </div>
          {renameStatus && (
            <div className="mt-2 text-xs text-[#6b7280] bg-[#0f1117] rounded-lg px-3 py-2">{renameStatus}</div>
          )}

          {/* Quick Commands */}
          <div className="flex items-center gap-2 mb-3 mt-5">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider flex-1">Quick Commands</div>
            {qcSaveStatus === 'saving' && <span className="text-[10px] text-[#6b7280]">saving...</span>}
            {qcSaveStatus === 'saved'  && <span className="text-[10px] text-[#22c55e]">✓ saved</span>}
            {qcSaveStatus === 'error'  && <span className="text-[10px] text-[#ef4444]">save failed</span>}
          </div>
          {QUICK_COMMANDS_CONFIG.map(({ key, label, note }) => (
            <div key={key} className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm text-white font-medium">{label}</div>
                <button
                  onClick={() => resetQc(key)}
                  className="text-[10px] text-[#6b7280] hover:text-white transition-colors"
                >
                  Reset
                </button>
              </div>
              <AutoResizeTextarea
                value={qcValues[key] ?? ''}
                onChange={(v) => updateQc(key, v)}
                onUndo={() => doQcUndo(key)}
                onRedo={() => doQcRedo(key)}
                canUndo={canQcUndo(key)}
                canRedo={canQcRedo(key)}
              />
              {note && <div className="text-[10px] text-[#4b5563] mt-1">{note}</div>}
            </div>
          ))}

          {/* Notifications */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Notifications</div>
          <div className="flex items-center justify-between py-3 border-b border-[#2a3142]">
            <div>
              <div className="text-sm text-white font-medium">Push notifications</div>
              <div className="text-xs text-[#6b7280] mt-0.5">
                {pushStatus === 'subscribed' && 'Active - Byte will ping you when input is needed'}
                {pushStatus === 'unsubscribed' && 'Off - enable to get pinged on mobile'}
                {pushStatus === 'denied' && 'Blocked in browser - update site permissions to enable'}
                {pushStatus === 'unsupported' && 'Not supported in this browser'}
                {pushStatus === 'loading' && 'Checking...'}
              </div>
            </div>
            {(pushStatus === 'subscribed' || pushStatus === 'unsubscribed') && (
              <button
                onClick={pushStatus === 'subscribed' ? pushUnsubscribe : pushSubscribe}
                className={`ml-4 shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  pushStatus === 'subscribed'
                    ? 'bg-[#2a3142] text-[#6b7280] hover:bg-[#3a4152]'
                    : 'bg-[#6366f1] text-white hover:bg-[#818cf8]'
                }`}
              >
                {pushStatus === 'subscribed' ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>

          {/* Gateway */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Gateway</div>
          <div className="bg-[#0f1117] rounded-lg px-3 py-2 text-xs text-[#6b7280] font-mono">
            {localStorage.getItem('octis-gateway') ? JSON.parse(localStorage.getItem('octis-gateway') || '{}').gatewayUrl : 'Not configured'}
          </div>

          {/* Users - owner only */}
          {isOwner && (
            <>
              <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Users</div>

              {/* Existing users list */}
              {usersLoading ? (
                <div className="text-xs text-[#6b7280] py-2">Loading...</div>
              ) : (
                <div className="space-y-1.5 mb-4">
                  {users.map(u => (
                    <div key={u.id} className="flex items-center justify-between bg-[#0f1117] rounded-lg px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-white truncate">{u.email}</div>
                        <div className="text-[10px] text-[#6b7280] mt-0.5">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mr-1.5 ${
                            u.role === 'owner' || u.role === 'admin' ? 'bg-[#312e81] text-[#a5b4fc]' : 'bg-[#1f2937] text-[#9ca3af]'
                          }`}>{u.role}</span>
                          agent: {u.agent_id || 'main'}
                        </div>
                      </div>
                      {(u.role !== 'owner' && u.role !== 'admin') && (
                        <button
                          onClick={() => handleDeleteUser(u)}
                          className="ml-3 shrink-0 text-[#6b7280] hover:text-red-400 transition-colors text-sm px-1.5"
                          title="Remove user"
                        >✕</button>
                      )}
                    </div>
                  ))}
                  {users.length === 0 && <div className="text-xs text-[#4b5563]">No other users yet.</div>}
                </div>
              )}

              {/* Add user form */}
              <div className="bg-[#0f1117] rounded-lg px-3 py-3 space-y-2">
                <div className="text-xs text-[#6b7280] font-medium mb-2">Add user</div>
                <input
                  type="email"
                  placeholder="Email address"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  className="w-full bg-[#181c24] border border-[#2a3142] rounded-lg px-3 py-1.5 text-sm text-white placeholder-[#4b5563] focus:outline-none focus:border-[#6366f1]"
                />
                <input
                  type="password"
                  placeholder="Password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddUser()}
                  className="w-full bg-[#181c24] border border-[#2a3142] rounded-lg px-3 py-1.5 text-sm text-white placeholder-[#4b5563] focus:outline-none focus:border-[#6366f1]"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={newRole}
                    onChange={e => setNewRole(e.target.value)}
                    className="flex-1 bg-[#181c24] border border-[#2a3142] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#6366f1]"
                  >
                    <option value="viewer">Viewer (read + reply)</option>
                    <option value="admin">Admin (full access)</option>
                  </select>
                  <button
                    onClick={handleAddUser}
                    disabled={addingUser}
                    className="shrink-0 px-3 py-1.5 bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {addingUser ? '...' : 'Add'}
                  </button>
                </div>
                {userMsg && <div className="text-xs text-[#6b7280] pt-1">{userMsg}</div>}
              </div>
            </>
          )}

          {/* About */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">About</div>
          <div className="text-xs text-[#4b5563]">
            Octis - AI command center<br />
            Built for OpenClaw · <a href="https://github.com/octis-app/octis" className="text-[#6366f1] hover:underline" target="_blank" rel="noopener noreferrer">github.com/octis-app/octis</a>
          </div>
        </div>
      </div>
    </div>
  )
}
