import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore, Session } from '../store/gatewayStore'

interface MobileSessionCardProps {
  session: Session
  onOpenFull?: (session: Session) => void
}

interface ChatMessage {
  id?: string | number
  role: string
  content: string
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

export default function MobileSessionCard({ session, onOpenFull }: MobileSessionCardProps) {
  const { send, ws } = useGatewayStore()
  const { getStatus } = useSessionStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
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

  const label = session.label || session.key
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
        <span className="text-sm font-semibold text-white truncate flex-1">{label}</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            color: statusColors[status] || statusColors.quiet,
            background: (statusColors[status] || statusColors.quiet) + '22',
          }}
        >
          {statusLabels[status] || 'Quiet'}
        </span>
        {onOpenFull && (
          <button
            onClick={() => onOpenFull(session)}
            className="text-xs text-[#6366f1] hover:text-[#818cf8] ml-1 transition-colors shrink-0"
          >
            Open ↗
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
              {msg.content}
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
