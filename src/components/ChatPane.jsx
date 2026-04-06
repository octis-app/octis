import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore } from '../store/gatewayStore'

export default function ChatPane({ sessionKey, paneIndex, onClose }) {
  const { send, ws } = useGatewayStore()
  const { setSessions, sessions, setLastRole, markStreaming } = useSessionStore()
  const { setCard } = useProjectStore()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionCard, setSessionCard] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [autoRenamed, setAutoRenamed] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (!sessionKey || !ws) return
    setMessages([])
    setSessionCard(null)
    setAutoRenamed(false)
    const reqId = `chat-history-${sessionKey}-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey, limit: 100 } })

    const handleMsg = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // Gateway response: {type:'res', id:reqId, ok:true, payload:{messages:[...]}}
        if (msg.type === 'res' && msg.id === reqId && msg.ok) {
          const msgs = msg.payload?.messages || []
          setMessages(msgs)
          const card = msgs.find(m => m.role === 'assistant')
          if (card) setSessionCard(extractText(card.content).slice(0, 300))
          // Set initial status based on last message role
          if (msgs.length > 0) {
            const lastMsg = msgs[msgs.length - 1]
            if (lastMsg.role) setLastRole(sessionKey, lastMsg.role)
          }
          // Auto-extract session card (last 📋 assistant message)
          const cardMsg = [...msgs].reverse().find(m => m.role === 'assistant' && extractText(m.content).includes('📋'))
          if (cardMsg) {
            const cardText = extractText(cardMsg.content).slice(0, 500)
            setCard(sessionKey, cardText)
          }
        }

        // Streaming chat events for this session
        if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.sessionKey === sessionKey) {
          const chatMsg = msg.payload
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === chatMsg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: chatMsg.content }
              return next
            }
            return [...prev, chatMsg]
          })
          // Auto-save session card if this is a 📋 message
          if (chatMsg.role === 'assistant') {
            const text = extractText(chatMsg.content)
            if (text.includes('📋')) setCard(sessionKey, text.slice(0, 500))
          }
        }

        // Also handle flat chat event (older gateway versions)
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

  // Auto-rename: once the first assistant reply arrives, derive a name from it
  useEffect(() => {
    if (autoRenamed || messages.length === 0) return
    const firstUser = messages.find(m => m.role === 'user')
    const firstAssistant = messages.find(m => m.role === 'assistant')
    if (!firstUser || !firstAssistant) return
    // Only auto-rename sessions that still have the default generated key as label
    const session = sessions.find(s => s.key === sessionKey)
    const currentLabel = session?.label || ''
    if (currentLabel && !currentLabel.startsWith('session-') && currentLabel !== sessionKey) return
    // Derive label from first user message (first 50 chars)
    const rawLabel = extractText(firstUser.content).trim().replace(/\n/g, ' ').slice(0, 50)
    if (rawLabel.length > 5) {
      send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { sessionKey, patch: { label: rawLabel } } })
      setSessions(sessions.map(s => s.key === sessionKey ? { ...s, label: rawLabel } : s))
      setAutoRenamed(true)
    }
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Extract plain text from content (handles string or array of blocks)
  function extractText(content) {
    if (!content) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.filter(b => b.type === 'text').map(b => b.text).join('')
    }
    return String(content)
  }

  function renderContent(content) {
    if (!content) return null
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map((block, i) => {
        if (block.type === 'text') return <span key={i}>{block.text}</span>
        return null
      })
    }
    return String(content)
  }

  const handleSend = () => {
    if (!input.trim()) return
    const msg = input
    send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey, message: msg } })
    setMessages(prev => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setLastRole(sessionKey, 'user')
    setInput('')
  }

  const handleSave = () => {
    const msg = '💾 checkpoint — save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.'
    send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey, message: msg } })
    setMessages(prev => [...prev, { role: 'user', content: '💾 Save checkpoint', id: Date.now() }])
  }

  const handleArchive = () => {
    if (confirm('Save and archive this session?')) {
      const msg = '💾 Final save — write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. One-line ack only.'
      send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey, message: msg } })
      setTimeout(() => {
        send({ type: 'req', id: `sessions-delete-${Date.now()}`, method: 'sessions.delete', params: { sessionKey } })
        setSessions(sessions.filter(s => s.key !== sessionKey))
        onClose()
      }, 3000)
    }
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

  const displayName = (() => {
    const s = sessions.find(s => s.key === sessionKey)
    const label = s?.label || sessionKey
    return label.length > 40 ? label.slice(0, 40) + '…' : label
  })()

  return (
    <div className="flex flex-1 min-w-0 border-r border-[#2a3142]">
      {/* Chat area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Pane header */}
        <div className="flex items-center gap-1 px-3 py-2.5 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <span className="text-sm font-medium text-white truncate flex-1" title={sessionKey}>{displayName}</span>
          <button onClick={handleSave} title="Save checkpoint to memory" className="text-xs text-[#6b7280] hover:text-green-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">💾</button>
          <button onClick={handleArchive} title="Save & archive session" className="text-xs text-[#6b7280] hover:text-yellow-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">📦</button>
          <button onClick={() => setSidebarOpen(s => !s)} className="text-xs text-[#6b7280] hover:text-white px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">
            {sidebarOpen ? '→' : '←'}
          </button>
          <button onClick={onClose} className="text-xs text-[#6b7280] hover:text-red-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
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
                {renderContent(msg.content)}
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
        <div className="w-52 shrink-0 bg-[#181c24] border-l border-[#2a3142] flex flex-col overflow-y-auto">
          <div className="px-3 py-3 border-b border-[#2a3142]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">Session Brief</div>
            {sessionCard ? (
              <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed">{sessionCard}</pre>
            ) : (
              <div className="text-xs text-[#4b5563]">No messages yet.</div>
            )}
          </div>
          <div className="px-3 py-3">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Key</div>
            <div className="text-xs text-[#4b5563] font-mono break-all">{sessionKey}</div>
          </div>
        </div>
      )}
    </div>
  )
}
