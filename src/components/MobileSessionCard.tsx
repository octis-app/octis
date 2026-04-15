import { useState, useEffect, useRef, useCallback } from 'react'
import { useGatewayStore, useSessionStore, useLabelStore, Session } from '../store/gatewayStore'

function formatAgo(ms: number | null): string {
  if (!ms) return ''
  const mins = Math.floor((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

interface MobileSessionCardProps {
  session: Session
  onOpenFull?: (session: Session) => void
  onArchive?: (session: Session) => void
}

interface ChatMessage {
  id?: string | number
  role: string
  content: string | unknown
}

// Gateway can return content as string or array of content blocks [{type:'text',text:'...'}]
function normalizeContent(content: string | unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && 'text' in b) return String((b as {text: unknown}).text)
        return ''
      })
      .join('')
  }
  return String(content ?? '')
}

const statusColors: Record<string, string> = {
  working: '#a855f7',
  'needs-you': '#3b82f6',
  stuck: '#f59e0b',
  active: '#22c55e',
  quiet: '#6b7280',
}

const statusLabels: Record<string, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  stuck: 'Stuck?',
  active: 'Active',
  quiet: 'Quiet',
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function MobileSessionCard({ session, onOpenFull, onArchive }: MobileSessionCardProps) {
  const { send, ws } = useGatewayStore()
  const { getStatus, getLastActivityMs } = useSessionStore()
  const { getLabel, setLabel } = useLabelStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [autoRenamed, setAutoRenamed] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const status = getStatus(session)

  useEffect(() => {
    if (!session?.key || !ws) return

    // Use proper req/method format
    const reqId = `chat-history-${session.key}-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session.key, limit: 30 } })

    const handleMsg = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string
          id?: string
          ok?: boolean
          payload?: { messages?: ChatMessage[] }
          event?: string
          sessionKey?: string
          role?: string
          content?: string
          id_msg?: string | number
        }

        // History response
        if (msg.type === 'res' && msg.id === reqId && msg.ok) {
          setMessages(msg.payload?.messages || [])
        }

        // Streaming event
        if (msg.type === 'event' && msg.event === 'chat') {
          const payload = msg.payload as { sessionKey?: string; role?: string; content?: string; id?: string | number }
          if (payload?.sessionKey === session.key) {
            setSending(false)
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === payload.id)
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = { ...next[idx], content: payload.content || '' }
                return next
              }
              return [...prev, { role: payload.role || 'assistant', content: payload.content || '', id: payload.id }]
            })
          }
        }

        // Flat chat event (older gateway)
        if (msg.type === 'chat' && msg.sessionKey === session.key) {
          setSending(false)
          const flatMsg: ChatMessage = { role: msg.role || 'assistant', content: msg.content || '', id: msg.id_msg }
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === flatMsg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: flatMsg.content }
              return next
            }
            return [...prev, flatMsg]
          })
        }
      } catch {}
    }

    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [session?.key, ws, send])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim() || sending) return
    const msg = input.trim()
    const idempotencyKey = `octis-card-${Date.now()}-${Math.random().toString(36).slice(2)}`
    send({
      type: 'req',
      id: `chat-send-${Date.now()}`,
      method: 'chat.send',
      params: { sessionKey: session.key, message: msg, deliver: false, idempotencyKey },
    })
    setMessages((prev) => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setInput('')
    setSending(true)
  }

  // Auto-rename: fires once after first user+assistant exchange
  const autoRename = useCallback(() => {
    if (autoRenamed) return
    const hasUser = messages.some(m => m.role === 'user')
    const hasAssistant = messages.some(m => m.role === 'assistant')
    if (!hasUser || !hasAssistant) return
    const persisted = getLabel(session.key)
    if (persisted) return
    const currentLabel = session.label || ''
    if (currentLabel && !currentLabel.startsWith('session-') && currentLabel !== session.key) return
    setAutoRenamed(true)
    const slim = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, 6)
      .map(m => ({ role: m.role, content: normalizeContent(m.content).slice(0, 300) }))
    void fetch(`${API}/api/session-autoname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: slim }),
    }).then(r => r.json()).then((data: { label?: string }) => {
      const lbl = data.label
      if (!lbl) return
      send({
        type: 'req',
        id: `sessions-patch-${Date.now()}`,
        method: 'sessions.patch',
        params: { sessionKey: session.key, patch: { label: lbl } },
      })
      setLabel(session.key, lbl)
      void fetch(`${API}/api/session-rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: session.key, label: lbl }),
      })
    }).catch(() => {})
  }, [autoRenamed, messages, session, getLabel, setLabel, send])

  useEffect(() => { autoRename() }, [autoRename])

  const handleRename = () => {
    const trimmed = renameValue.trim()
    if (!trimmed) { setEditing(false); return }
    setLabel(session.key, trimmed)
    send({
      type: 'req',
      id: `sessions-patch-${Date.now()}`,
      method: 'sessions.patch',
      params: { sessionKey: session.key, patch: { label: trimmed } },
    })
    void fetch(`${API}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: session.key, label: trimmed }),
    })
    setEditing(false)
  }

  const startEditing = () => {
    setRenameValue(getLabel(session.key) || session.label || session.key)
    setEditing(true)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const displayLabel = getLabel(session.key) || session.label || session.key
  const lastMs = getLastActivityMs(session)
  const recentMsgs = messages.slice(-6)

  return (
    <div
      className="snap-center shrink-0 w-[calc(100vw-2rem)] flex flex-col bg-[#181c24] rounded-2xl border border-[#2a3142] overflow-hidden"
      style={{ height: 'calc(100vh - 13rem)' }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3142] shrink-0">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: statusColors[status] || statusColors.quiet }}
        />
        {editing ? (
          <input
            ref={renameInputRef}
            className="flex-1 bg-[#0f1117] border border-[#6366f1] rounded-lg px-2 py-0.5 text-sm text-white outline-none"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={handleRename}
            autoFocus
          />
        ) : (
          <span className="text-sm font-semibold text-white truncate flex-1">{displayLabel}</span>
        )}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{
              color: statusColors[status] || statusColors.quiet,
              background: (statusColors[status] || statusColors.quiet) + '22',
            }}
          >
            {statusLabels[status] || 'Quiet'}
          </span>
          {lastMs && (
            <span className="text-[10px] text-[#4b5563] px-1">{formatAgo(lastMs)}</span>
          )}
        </div>
        <button
          onClick={startEditing}
          className="text-xs text-[#4b5563] hover:text-[#a5b4fc] transition-colors shrink-0 px-1"
          title="Rename"
        >
          ✏️
        </button>
        {onOpenFull && (
          <button
            onClick={() => onOpenFull(session)}
            className="text-xs text-[#6366f1] hover:text-[#818cf8] ml-1 transition-colors shrink-0"
          >
            Open ↗
          </button>
        )}
        {onArchive && (
          <button
            onClick={() => onArchive(session)}
            className="text-xs text-[#4b5563] hover:text-red-400 ml-1 transition-colors shrink-0 px-1"
            title="Archive session"
          >
            🗑
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {recentMsgs.length === 0 && (
          <div className="text-xs text-[#4b5563] text-center py-4">No messages yet</div>
        )}
        {messages.length > 6 && onOpenFull && (
          <div
            className="text-xs text-[#6366f1] text-center py-1 cursor-pointer"
            onClick={() => onOpenFull(session)}
          >
            ↑ {messages.length - 6} earlier messages — tap to see all
          </div>
        )}
        {recentMsgs.map((msg, i) => (
          <div
            key={msg.id !== undefined ? String(msg.id) : i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-[#6366f1] text-white rounded-br-sm'
                  : 'bg-[#0f1117] text-[#e8eaf0] rounded-bl-sm'
              }`}
            >
              {normalizeContent(msg.content)}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#0f1117] text-[#6b7280] px-3 py-2 rounded-xl rounded-bl-sm text-sm">
              <span className="animate-pulse">···</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Inline reply */}
      <div className="px-3 py-3 border-t border-[#2a3142] bg-[#0f1117] shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 bg-[#181c24] border border-[#2a3142] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] resize-none leading-snug"
            placeholder="Reply…"
            value={input}
            rows={1}
            style={{ maxHeight: '96px', overflowY: 'auto' }}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="bg-[#6366f1] disabled:opacity-40 text-white rounded-xl w-10 h-10 flex items-center justify-center shrink-0 transition-colors active:bg-[#818cf8]"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
