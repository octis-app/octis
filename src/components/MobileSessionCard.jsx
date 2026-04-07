import { useState, useRef, useEffect } from 'react'
import { useGatewayStore, useSessionStore } from '../store/gatewayStore'

const statusColors = { active: '#22c55e', idle: '#f59e0b', dead: '#6b7280' }

export default function MobileSessionCard({ session, isActive }) {
  const { send, ws } = useGatewayStore()
  const { getStatus } = useSessionStore()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const bottomRef = useRef(null)
  const status = getStatus(session)

  useEffect(() => {
    if (!session?.key || !ws) return
    send({ type: 'req', id: `h-${session.key}`, method: 'chat.history', params: { sessionKey: session.key, limit: 50 } })

    const handleMsg = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'res' && msg.payload?.messages && msg.payload?.sessionKey === session.key) {
          setMessages(msg.payload.messages)
        }
        if (msg.type === 'chat' && msg.sessionKey === session.key) {
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === msg.id)
            if (idx >= 0) { const n = [...prev]; n[idx] = { ...n[idx], content: msg.content }; return n }
            return [...prev, msg]
          })
        }
      } catch {}
    }
    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [session?.key, ws])

  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, expanded])

  const handleSend = () => {
    if (!input.trim()) return
    send({ type: 'req', id: `send-${Date.now()}`, method: 'chat.send', params: { sessionKey: session.key, message: input } })
    setMessages(prev => [...prev, { role: 'user', content: input, id: Date.now() }])
    setInput('')
  }

  const lastMsg = messages[messages.length - 1]
  const resolveContent = (c) => Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : x?.text ?? '').join('') : typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)
  const preview = lastMsg ? resolveContent(lastMsg.content).slice(0, 120) : 'No messages yet'

  return (
    <div className={`flex flex-col bg-[#181c24] rounded-2xl border transition-all duration-200 ${
      isActive ? 'border-[#6366f1] shadow-lg shadow-[#6366f1]/20' : 'border-[#2a3142]'
    } ${expanded ? 'h-[calc(100vh-180px)]' : 'min-h-[160px]'}`}>

      {/* Card header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: statusColors[status] }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white truncate">
            {session.displayName || session.key}
          </div>
          {!expanded && (
            <div className="text-xs text-[#6b7280] mt-1 line-clamp-2 leading-relaxed">
              {preview}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-xs" style={{ color: statusColors[status] }}>{status}</span>
          {session.estimatedCostUsd != null && (
            <span className="text-xs text-[#4b5563]">${(session.estimatedCostUsd || 0).toFixed(3)}</span>
          )}
          <span className="text-xs text-[#4b5563]">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded: full chat */}
      {expanded && (
        <>
          <div className="flex-1 overflow-y-auto px-4 pb-2 space-y-2">
            {messages.map((msg, i) => (
              <div key={msg.id || i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-[#6366f1] text-white rounded-br-sm'
                    : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                }`}>
                  {resolveContent(msg.content)}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 pb-3 pt-2 border-t border-[#2a3142]">
            <div className="flex gap-2">
              <input
                className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
                placeholder="Reply…"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
              />
              <button
                onClick={handleSend}
                className="bg-[#6366f1] hover:bg-[#818cf8] active:bg-[#4f46e5] text-white rounded-xl px-4 text-lg transition-colors"
              >↑</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
