import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, Session } from '../store/gatewayStore'

interface MobileFullChatProps {
  session: Session
  onBack: () => void
}

interface ChatMessage {
  id?: string | number
  role: string
  content: string
}

export default function MobileFullChat({ session, onBack }: MobileFullChatProps) {
  const { send, ws } = useGatewayStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!session?.key || !ws) return

    // Use proper req/method format (not old type-based format)
    const reqId = `chat-history-${session.key}-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session.key, limit: 100 } })

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
    const idempotencyKey = `octis-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
    send({
      type: 'req',
      id: `chat-send-${Date.now()}`,
      method: 'chat.send',
      params: { sessionKey: session.key, message: msg, deliver: false, idempotencyKey },
    })
    setMessages((prev) => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setInput('')
    setSending(true)
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }

  const label = session?.label || session?.key || 'Chat'

  return (
    <div className="fixed inset-0 bg-[#0f1117] flex flex-col z-50">
      <div
        className="flex items-center gap-3 px-4 py-3 bg-[#181c24] border-b border-[#2a3142] shrink-0"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <button
          onClick={onBack}
          className="text-[#6366f1] text-lg font-semibold w-8 flex items-center justify-center"
        >
          ←
        </button>
        <span className="text-sm font-semibold text-white truncate flex-1">{label}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg, i) => (
          <div
            key={msg.id !== undefined ? String(msg.id) : i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] px-3 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-[#6366f1] text-white rounded-br-sm'
                  : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#1e2330] text-[#6b7280] px-4 py-2.5 rounded-2xl rounded-bl-sm text-sm">
              <span className="animate-pulse">···</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div
        className="px-3 py-3 bg-[#181c24] border-t border-[#2a3142] shrink-0"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-2xl px-4 py-3 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] resize-none leading-snug"
            placeholder="Message…"
            value={input}
            rows={1}
            style={{ maxHeight: '120px', overflowY: 'auto' }}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
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
            className="bg-[#6366f1] disabled:opacity-40 text-white rounded-2xl w-11 h-11 flex items-center justify-center shrink-0 transition-colors active:scale-95"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
