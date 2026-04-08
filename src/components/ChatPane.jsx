import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore } from '../store/gatewayStore'

// ─── Chat message markdown renderer ──────────────────────────────────────────
function CollapsibleCode({ lang, code }) {
  const [open, setOpen] = useState(false)
  const lines = code.split('\n')
  const preview = lines.slice(0, 2).join('\n')
  return (
    <div className="my-1.5 rounded-lg overflow-hidden border border-[#2a3142]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-[#0f1117] hover:bg-[#181c24] transition-colors text-left"
      >
        <span className="text-[10px] text-[#6b7280] font-mono">{lang || 'code'} · {lines.length} lines</span>
        <span className="text-[10px] text-[#6366f1]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {!open && (
        <div className="px-3 py-1.5 bg-[#0a0d14] text-[11px] font-mono text-[#6b7280] truncate">{preview}…</div>
      )}
      {open && (
        <pre className="px-3 py-2 bg-[#0a0d14] text-[11px] font-mono text-[#a5b4fc] overflow-x-auto leading-relaxed">{code}</pre>
      )}
    </div>
  )
}

function ChatMarkdown({ text }) {
  const lines = text.split('\n')
  const elements = []
  let i = 0

  const renderInline = (str) => {
    // bold, italic, inline code
    const parts = str.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)
    return parts.map((p, j) => {
      if (p.startsWith('**') && p.endsWith('**')) return <strong key={j} className="font-semibold text-white">{p.slice(2,-2)}</strong>
      if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return <code key={j} className="bg-[#0f1117] text-[#a5b4fc] px-1 rounded text-[11px] font-mono">{p.slice(1,-1)}</code>
      if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={j} className="italic opacity-80">{p.slice(1,-1)}</em>
      return <span key={j}>{p}</span>
    })
  }

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++ }
      i++
      elements.push(<CollapsibleCode key={`code-${i}`} lang={lang} code={codeLines.join('\n')} />)
      continue
    }

    // H1/H2/H3
    if (line.startsWith('### ')) { elements.push(<div key={i} className="text-xs font-semibold text-[#818cf8] mt-2 mb-0.5">{renderInline(line.slice(4))}</div>); i++; continue }
    if (line.startsWith('## ')) { elements.push(<div key={i} className="text-sm font-semibold text-[#a5b4fc] mt-2 mb-1">{renderInline(line.slice(3))}</div>); i++; continue }
    if (line.startsWith('# ')) { elements.push(<div key={i} className="text-sm font-bold text-white mt-2 mb-1 border-b border-[#2a3142] pb-1">{renderInline(line.slice(2))}</div>); i++; continue }

    // Bullet / task
    const taskMatch = line.match(/^(\s*)- \[([ xX])\] (.*)/)
    if (taskMatch) {
      const done = taskMatch[2].toLowerCase() === 'x'
      elements.push(
        <div key={i} className="flex items-start gap-1.5 py-0.5">
          <span className={`mt-0.5 text-[11px] ${done ? 'text-emerald-400' : 'text-[#3a4152]'}`}>{done ? '✓' : '○'}</span>
          <span className={`text-sm leading-relaxed ${done ? 'line-through text-[#4b5563]' : ''}`}>{renderInline(taskMatch[3])}</span>
        </div>
      )
      i++; continue
    }
    const bulletMatch = line.match(/^(\s*)[-*] (.*)/)
    if (bulletMatch) {
      const indent = bulletMatch[1].length
      elements.push(
        <div key={i} className={`flex items-start gap-1.5 py-0.5 ${indent > 0 ? 'ml-4' : ''}`}>
          <span className="text-[#6366f1] mt-1 text-[10px] shrink-0">•</span>
          <span className="text-sm leading-relaxed">{renderInline(bulletMatch[2])}</span>
        </div>
      )
      i++; continue
    }

    // Divider
    if (line.trim() === '---') { elements.push(<hr key={i} className="border-[#2a3142] my-2" />); i++; continue }

    // Blank line
    if (line.trim() === '') { elements.push(<div key={i} className="h-1" />); i++; continue }

    // Regular text
    elements.push(<div key={i} className="text-sm leading-relaxed py-0.5">{renderInline(line)}</div>)
    i++
  }

  return <div className="space-y-0">{elements}</div>
}

// Heartbeat detection helpers
function extractText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('')
  return String(content)
}

function isHeartbeatTrigger(content) {
  const text = extractText(content)
  return text.includes('Read HEARTBEAT.md') || text.trim().toLowerCase() === 'heartbeat'
}
function isHeartbeatResponse(content) {
  const text = extractText(content)
  return text.trim() === 'HEARTBEAT_OK' || text.trim().startsWith('HEARTBEAT_OK\n')
}
function isHeartbeatMsg(msg) {
  return (msg.role === 'user' && isHeartbeatTrigger(msg.content)) ||
         (msg.role === 'assistant' && isHeartbeatResponse(msg.content))
}

// Noise detection — tool calls, tool results, system messages, exec output
function isNoiseMsg(msg) {
  if (!msg) return false
  // System-role messages
  if (msg.role === 'system') return true
  // Tool call or tool result roles
  if (msg.role === 'tool' || msg.role === 'toolResult' || msg.role === 'toolCall') return true
  // Content array containing only tool_use / tool_result blocks (no text)
  if (Array.isArray(msg.content)) {
    const hasText = msg.content.some(b => b.type === 'text' && b.text?.trim())
    const hasToolBlock = msg.content.some(b => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'toolCall' || b.type === 'toolResult')
    if (hasToolBlock && !hasText) return true
  }
  // Assistant messages that contain ONLY tool calls (no visible text)
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const textBlocks = msg.content.filter(b => b.type === 'text')
    const toolBlocks = msg.content.filter(b => b.type === 'tool_use' || b.type === 'toolCall')
    if (toolBlocks.length > 0 && textBlocks.every(b => !b.text?.trim())) return true
  }
  return false
}

export default function ChatPane({ sessionKey, paneIndex, onClose }) {
  const { send, ws } = useGatewayStore()
  const { setSessions, sessions, setLastRole, markStreaming } = useSessionStore()
  const { setCard } = useProjectStore()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionCard, setSessionCard] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [autoRenamed, setAutoRenamed] = useState(false)
  const [lastHeartbeat, setLastHeartbeat] = useState(null) // { ts: Date, ok: bool }
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try { return localStorage.getItem('octis-noise-hidden') !== 'false' } catch { return true }
  })
  const bottomRef = useRef(null)

  const toggleNoise = () => setNoiseHidden(v => {
    const next = !v
    try { localStorage.setItem('octis-noise-hidden', String(next)) } catch {}
    return next
  })

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
          // Find last HEARTBEAT_OK in history
          const lastHB = [...msgs].reverse().find(m => m.role === 'assistant' && isHeartbeatResponse(m.content))
          if (lastHB) setLastHeartbeat({ ts: new Date(lastHB.ts || lastHB.created_at || Date.now()), ok: true })
          setMessages(msgs)
          const card = msgs.find(m => m.role === 'assistant')
          if (card) setSessionCard(extractText(card.content).slice(0, 300))
          // Set initial status based on last message role
          // Don't set lastRole from history — only set from live events
          // (avoids all sessions flipping to 'needs-you' on first open)
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
          // Track heartbeat state from live events
          if (chatMsg.role === 'assistant' && isHeartbeatResponse(chatMsg.content)) {
            setLastHeartbeat({ ts: new Date(), ok: true })
          }
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

  function renderContent(content) {
    const text = extractText(content)
    if (!text) return null
    return <ChatMarkdown text={text} />
  }

  const handleSend = () => {
    if (!input.trim()) return
    const msg = input
    const idempotencyKey = `octis-send-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reqId = `chat-send-${Date.now()}`
    const ok = send({
      type: 'req',
      id: reqId,
      method: 'chat.send',
      params: { sessionKey, message: msg, deliver: false, idempotencyKey },
    })
    if (!ok) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '⚠️ Not connected to gateway. Check your connection.',
        id: `err-${Date.now()}`,
      }])
      return
    }
    setMessages(prev => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setLastRole(sessionKey, 'user')
    setInput('')

    // Listen for gateway ack/error on this request
    const errorHandler = (event) => {
      try {
        const m = JSON.parse(event.data)
        if (m.type === 'res' && m.id === reqId) {
          if (!m.ok) {
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `⚠️ Gateway error: ${m.error?.message || JSON.stringify(m.error)}`,
              id: `err-${Date.now()}`,
            }])
          }
          ws.removeEventListener('message', errorHandler)
        }
      } catch {}
    }
    if (ws) ws.addEventListener('message', errorHandler)
    // Clean up after 10s regardless
    setTimeout(() => { if (ws) ws.removeEventListener('message', errorHandler) }, 10000)
  }

  const handleSave = () => {
    const msg = '💾 checkpoint — save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.'
    const idempotencyKey = `octis-save-${Date.now()}-${Math.random().toString(36).slice(2)}`
    send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey, message: msg, deliver: false, idempotencyKey } })
    setMessages(prev => [...prev, { role: 'user', content: '💾 Save checkpoint', id: Date.now() }])
  }

  const handleArchive = () => {
    if (confirm('Save and archive this session?')) {
      const msg = '💾 Final save — write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. One-line ack only.'
      const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
      send({ type: 'req', id: `chat-send-${Date.now()}`, method: 'chat.send', params: { sessionKey, message: msg, deliver: false, idempotencyKey } })
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
          {lastHeartbeat && (
            <span
              title={`Last heartbeat: ${lastHeartbeat.ts.toLocaleTimeString()}`}
              className="text-xs px-1"
            >
              {lastHeartbeat.ok ? '❤️' : '🖤'}
            </span>
          )}
          <button
            onClick={toggleNoise}
            title={noiseHidden ? 'Show tool calls & system msgs' : 'Hide tool calls & system msgs'}
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors shrink-0 ${
              noiseHidden
                ? 'bg-[#1e2330] border-[#2a3142] text-[#4b5563]'
                : 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'
            }`}
          >{noiseHidden ? 'chat only' : '+ tools'}</button>
          <button onClick={handleSave} title="Save checkpoint to memory" className="text-xs text-[#6b7280] hover:text-green-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">💾</button>
          <button onClick={handleArchive} title="Save & archive session" className="text-xs text-[#6b7280] hover:text-yellow-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">📦</button>
          <button onClick={() => setSidebarOpen(s => !s)} className="text-xs text-[#6b7280] hover:text-white px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">
            {sidebarOpen ? '→' : '←'}
          </button>
          <button onClick={onClose} className="text-xs text-[#6b7280] hover:text-red-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.filter(msg => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg))).map((msg, i) => (
            <div key={msg.id || i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] px-3 py-2 rounded-xl ${
                msg.role === 'user'
                  ? 'bg-[#6366f1] text-white rounded-br-sm text-sm whitespace-pre-wrap'
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
