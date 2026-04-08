import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore } from '../store/gatewayStore'

const statusColors = { active: '#22c55e', idle: '#f59e0b', dead: '#6b7280' }
const statusLabels = { active: 'Active', idle: 'Idle', dead: 'Dead' }

export default function MobileSessionCard({ session, onOpenFull }) {
  const { send, ws } = useGatewayStore()
  const { getStatus } = useSessionStore()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)
  const status = getStatus(session)

  useEffect(() => {
    if (!session?.key || !ws) return
    send({ type: 'chat.history', sessionKey: session.key, limit: 30 })

    const handleMsg = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'chat.history.result' && msg.sessionKey === session.key) {
          setMessages(msg.messages || [])
        }
        if (msg.type === 'chat' && msg.sessionKey === session.key) {
          setSending(false)
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === msg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: msg.content }
              return next
            }
            return [...prev, msg]
          })
        }
      } catch {}
    }

    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [session?.key, ws])

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
    setMessages(prev => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setInput('')
    setSending(true)
  }

  const label = session.label || session.key
  const recentMsgs = messages.slice(-6)

  return (
    <div className="snap-center shrink-0 w-[calc(100vw-2rem)] flex flex-col bg-[#181c24] rounded-2xl border border-[#2a3142] overflow-hidden"
      style={{ height: 'calc(100vh - 13rem)' }}>

      {/* Card header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3142] shrink-0">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColors[status] }} />
        <span className="text-sm font-semibold text-white truncate flex-1">{label}</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ color: statusColors[status], background: statusColors[status] + '22' }}>
          {statusLabels[status]}
        </span>
        <button
          onClick={() => onOpenFull(session)}
          className="text-xs text-[#6366f1] hover:text-[#818cf8] ml-1 transition-colors shrink-0"
        >
          Open ↗
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {recentMsgs.length === 0 && (
          <div className="text-xs text-[#4b5563] text-center py-4">No messages yet</div>
        )}
        {messages.length > 6 && (
          <div
            className="text-xs text-[#6366f1] text-center py-1 cursor-pointer"
            onClick={() => onOpenFull(session)}
          >
            ↑ {messages.length - 6} earlier messages — tap to see all
          </div>
        )}
        {recentMsgs.map((msg, i) => (
          <div key={msg.id || i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words ${
              msg.role === 'user'
                ? 'bg-[#6366f1] text-white rounded-br-sm'
                : 'bg-[#0f1117] text-[#e8eaf0] rounded-bl-sm'
            }`}>
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
            onChange={e => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 96) + 'px'
            }}
            onKeyDown={e => {
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
