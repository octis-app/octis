import { useState, useEffect, useRef } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

const statusColors = { active: '#22c55e', idle: '#f59e0b', dead: '#6b7280', blocked: '#ef4444' }

export default function ChatPane({ sessionKey, paneIndex, onClose }) {
  const { send, ws } = useGatewayStore()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionCard, setSessionCard] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (!sessionKey || !ws) return

    // Request history
    send({ type: 'chat.history', sessionKey, limit: 100 })

    const handleMsg = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'chat.history.result' && msg.sessionKey === sessionKey) {
          const msgs = msg.messages || []
          setMessages(msgs)
          // Extract session card from first assistant message
          const card = msgs.find(m => m.role === 'assistant' && m.content?.includes('📋'))
          if (card) {
            setSessionCard(card.content.split('\n').slice(0, 6).join('\n'))
          }
        }
        if (msg.type === 'chat' && msg.sessionKey === sessionKey) {
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
  }, [sessionKey, ws])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim()) return
    send({ type: 'chat.send', sessionKey, message: input })
    setMessages(prev => [...prev, { role: 'user', content: input, id: Date.now() }])
    setInput('')
  }

  if (!sessionKey) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0f1117] border-r border-[#2a3142]">
        <div className="text-center">
          <div className="text-4xl mb-3">🐙</div>
          <div className="text-[#6b7280] text-sm">Click a session to open it here</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-w-0 border-r border-[#2a3142]">
      {/* Chat area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Pane header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <span className="text-sm font-medium text-white truncate flex-1">{sessionKey}</span>
          <button onClick={() => setSidebarOpen(s => !s)} className="text-xs text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">
            {sidebarOpen ? '→ hide' : '← brief'}
          </button>
          <button onClick={onClose} className="text-xs text-[#6b7280] hover:text-red-400 px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.map((msg, i) => (
            <div key={msg.id || i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-[#6366f1] text-white rounded-br-sm'
                  : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-3 py-3 border-t border-[#2a3142] bg-[#181c24] shrink-0">
          <div className="flex gap-2">
            <input
              className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
              placeholder="Message..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            />
            <button
              onClick={handleSend}
              className="bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg px-4 text-sm font-medium transition-colors"
            >↑</button>
          </div>
        </div>
      </div>

      {/* Session sidebar */}
      {sidebarOpen && (
        <div className="w-56 shrink-0 bg-[#181c24] border-l border-[#2a3142] flex flex-col overflow-y-auto">
          <div className="px-3 py-3 border-b border-[#2a3142]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">Session Brief</div>
            {sessionCard ? (
              <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed">{sessionCard}</pre>
            ) : (
              <div className="text-xs text-[#4b5563]">No session card yet. Claw posts one at the start of each session.</div>
            )}
          </div>
          <div className="px-3 py-3">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">Session</div>
            <div className="text-xs text-[#e8eaf0] font-mono break-all">{sessionKey}</div>
          </div>
        </div>
      )}
    </div>
  )
}
