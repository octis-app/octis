import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore } from '../store/gatewayStore'

function resolveContent(c) {
  if (!c) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : x?.text ?? '').join('')
  return c?.text ?? JSON.stringify(c)
}

// Detect if a message is "noise" — tool calls, system, heartbeats, etc.
function isNoise(msg) {
  if (msg.role === 'tool') return true
  if (msg.role === 'system') return true
  const text = resolveContent(msg.content)
  if (!text) return true
  if (/^HEARTBEAT_OK$/m.test(text.trim())) return true
  if (/^NO_REPLY$/m.test(text.trim())) return true
  return false
}

// Split text into segments: normal text vs code blocks
function parseSegments(text) {
  const segments = []
  const re = /```([\w]*)\n?([\s\S]*?)```/g
  let last = 0
  let match
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', content: text.slice(last, match.index) })
    segments.push({ type: 'code', lang: match[1] || '', content: match[2] })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) })
  return segments
}

function CodeBlock({ lang, content }) {
  const lines = content.split('\n').length
  const [open, setOpen] = useState(lines <= 10)

  return (
    <div className="my-1.5 rounded-lg overflow-hidden border border-[#2a3142]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-[#0f1117] text-left hover:bg-[#1a1f2e] transition-colors"
      >
        <span className="text-[10px] text-[#6366f1] font-mono">{lang || 'code'}</span>
        <span className="text-[10px] text-[#4b5563]">{lines} lines</span>
        <span className="ml-auto text-[10px] text-[#6b7280]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {open && (
        <pre className="px-3 py-2 text-xs text-[#e8eaf0] bg-[#0f1117] overflow-x-auto whitespace-pre leading-relaxed max-h-[400px] overflow-y-auto">
          <code>{content}</code>
        </pre>
      )}
    </div>
  )
}

function MessageContent({ text }) {
  const segments = parseSegments(text)
  return (
    <div>
      {segments.map((seg, i) =>
        seg.type === 'code'
          ? <CodeBlock key={i} lang={seg.lang} content={seg.content} />
          : <span key={i} className="whitespace-pre-wrap break-words">{seg.content}</span>
      )}
    </div>
  )
}

export default function ChatPane({ sessionKey, paneIndex, onClose }) {
  const { send, ws, apiUrl } = useGatewayStore()
  const { sessions, getDisplayName, setDisplayNameOverride, setMessageCount, setSessionCard: storeSessionCard } = useSessionStore()
  const sessionMeta = sessions.find(x => x.key === sessionKey)
  const sessionLabel = getDisplayName(sessionMeta || { key: sessionKey })

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionCard, setSessionCard] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sending, setSending] = useState(false)
  const [hideNoise, setHideNoise] = useState(true)
  const [sessionCost, setSessionCost] = useState(null) // { total, lastMsg }
  const bottomRef = useRef(null)

  // Extract a good display name from chat history
  const extractNameFromHistory = (msgs) => {
    // Try to find a session card with a topic
    const card = msgs.find(m => m.role === 'assistant' && resolveContent(m.content)?.includes('📋'))
    if (card) {
      const cardText = resolveContent(card.content)
      const topicMatch = cardText.match(/📋\s+\*?\*?(.+?)\*?\*?[\n\r]/)
      if (topicMatch) return topicMatch[1].replace(/[*[\]]/g, '').trim()
    }
    // Try the first user message
    const firstUser = msgs.find(m => m.role === 'user')
    if (firstUser) {
      const text = resolveContent(firstUser.content)
      if (text && text.length < 80) return text.slice(0, 60)
      if (text) return text.slice(0, 60) + '…'
    }
    return null
  }

  useEffect(() => {
    if (!sessionKey || !ws) return
    setMessages([])

    send({
      type: 'req',
      id: `history-${sessionKey}`,
      method: 'chat.history',
      params: { sessionKey, limit: 100 }
    })

    const handleMsg = (event) => {
      try {
        const msg = JSON.parse(event.data)

        // History response
        if (msg.type === 'res' && msg.id === `history-${sessionKey}` && msg.ok) {
          const msgs = msg.payload?.messages ?? []
          setMessages(msgs)

          // Extract and persist display name if not already set
          const currentName = getDisplayName(sessionMeta || { key: sessionKey })
          const isDefaultName = !currentName || currentName === sessionKey
          if (isDefaultName && msgs.length > 0) {
            const extracted = extractNameFromHistory(msgs)
            if (extracted) setDisplayNameOverride(sessionKey, extracted)
          }

          // Track message count (user + assistant only)
          const realMsgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant')
          setMessageCount(sessionKey, realMsgs.length)

          // Extract session card
          const card = msgs.find(m => m.role === 'assistant' && resolveContent(m.content)?.includes('📋'))
          if (card) {
            const cardText = resolveContent(card.content).split('\n').slice(0, 8).join('\n')
            setSessionCard(cardText)
            storeSessionCard(sessionKey, cardText) // persist to store for sidebar
          }
        }

        // Streaming: session.message events
        if (msg.type === 'event' && msg.event === 'session.message') {
          const pl = msg.payload
          if (pl?.sessionKey !== sessionKey) return
          const chatMsg = pl.message
          if (!chatMsg) return
          if (chatMsg.role === 'assistant') setSending(false)
          setMessages(prev => {
            const id = chatMsg.__openclaw?.id || chatMsg.id
            const idx = prev.findIndex(m => (m.__openclaw?.id || m.id) === id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], ...chatMsg }
              return next
            }
            return [...prev, chatMsg]
          })
        }

        // Streaming: chat events (legacy / partial)
        if (msg.type === 'event' && msg.event?.startsWith('chat.')) {
          const pl = msg.payload
          const msgSessionKey = pl?.sessionKey || msg.sessionKey
          if (msgSessionKey !== sessionKey) return
          const chatMsg = pl?.message || pl
          if (!chatMsg || !chatMsg.role) return
          if (chatMsg.role === 'assistant') setSending(false)
          setMessages(prev => {
            const id = chatMsg.__openclaw?.id || chatMsg.id
            const idx = prev.findIndex(m => (m.__openclaw?.id || m.id) === id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], ...chatMsg }
              return next
            }
            return [...prev, chatMsg]
          })
        }

      } catch {}
    }

    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [sessionKey, ws])

  // Load session cost from API
  useEffect(() => {
    if (!sessionKey || !apiUrl) return
    fetch(`${apiUrl}/api/costs/session/${encodeURIComponent(sessionKey)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setSessionCost(d) })
      .catch(() => {})
  }, [sessionKey, apiUrl])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!input.trim() || sending) return
    const ikey = `octis-${Date.now()}-${Math.random().toString(36).slice(2)}`
    send({
      type: 'req',
      id: ikey,
      method: 'chat.send',
      params: { sessionKey, message: input, idempotencyKey: ikey }
    })
    setMessages(prev => [...prev, { role: 'user', content: input, id: ikey }])
    setInput('')
    setSending(true)
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

  const visibleMessages = hideNoise ? messages.filter(m => !isNoise(m)) : messages
  const noiseCount = messages.length - messages.filter(m => !isNoise(m)).length

  return (
    <div className="flex flex-1 min-w-0 border-r border-[#2a3142]">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <span className="text-sm font-medium text-white truncate flex-1">{sessionLabel}</span>
          {sending && <span className="text-xs text-[#6366f1] animate-pulse">thinking…</span>}

          {/* Noise toggle */}
          <button
            onClick={() => setHideNoise(h => !h)}
            title={hideNoise ? `Show ${noiseCount} hidden messages` : 'Hide system/tool noise'}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              hideNoise
                ? 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
                : 'bg-[#2a3142] text-white'
            }`}
          >
            {hideNoise ? `🔇 +${noiseCount}` : '🔊'}
          </button>

          <button onClick={() => setSidebarOpen(s => !s)} className="text-xs text-[#6b7280] hover:text-white px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">
            {sidebarOpen ? '→' : '←'}
          </button>
          <button onClick={onClose} className="text-xs text-[#6b7280] hover:text-red-400 px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {visibleMessages.map((msg, i) => {
            const text = resolveContent(msg.content)
            if (!text && msg.role !== 'user') return null
            return (
              <div key={msg.__openclaw?.id || msg.id || i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm break-words ${
                  msg.role === 'user'
                    ? 'bg-[#6366f1] text-white rounded-br-sm'
                    : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                }`}>
                  <MessageContent text={text} />
                </div>
              </div>
            )
          })}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-[#1e2330] text-[#6b7280] px-3 py-2 rounded-xl text-sm rounded-bl-sm">●●●</div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-3 py-3 border-t border-[#2a3142] bg-[#181c24] shrink-0">
          <div className="flex gap-2">
            <input
              className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563]"
              placeholder="Message…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-40 text-white rounded-lg px-4 text-sm font-medium transition-colors"
            >↑</button>
          </div>
        </div>
      </div>

      {/* Session sidebar */}
      {sidebarOpen && (
        <div className="w-52 shrink-0 bg-[#181c24] border-l border-[#2a3142] flex flex-col overflow-y-auto">
          <div className="px-3 py-3 border-b border-[#2a3142]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">Session Brief</div>
            {sessionCard
              ? <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed">{sessionCard}</pre>
              : <div className="text-xs text-[#4b5563]">No session card yet.</div>
            }
          </div>
          {sessionCost && (
            <div className="px-3 py-3 border-t border-[#2a3142]">
              <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">Cost</div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-[#6b7280]">Total</span>
                  <span className="text-white font-medium">${sessionCost.total?.toFixed(4)}</span>
                </div>
                {sessionCost.lastMsg != null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-[#6b7280]">Last msg</span>
                    <span className="text-[#9ca3af]">${sessionCost.lastMsg?.toFixed(4)}</span>
                  </div>
                )}
                {sessionCost.msgCount != null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-[#6b7280]">Messages</span>
                    <span className="text-[#9ca3af]">{sessionCost.msgCount}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="px-3 py-3 border-t border-[#2a3142]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Key</div>
            <div className="text-[10px] text-[#4b5563] font-mono break-all">{sessionKey}</div>
          </div>
        </div>
      )}
    </div>
  )
}
