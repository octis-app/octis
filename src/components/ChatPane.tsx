import { useState, useEffect, useRef, useCallback } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore, Session } from '../store/gatewayStore'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id?: string | number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'toolResult' | 'toolCall'
  content: MessageContent
  ts?: string
  created_at?: string
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; [key: string]: unknown }
  | { type: 'tool_result'; [key: string]: unknown }
  | { type: 'toolCall'; [key: string]: unknown }
  | { type: 'toolResult'; [key: string]: unknown }

type MessageContent = string | ContentBlock[] | unknown

interface ChatPaneProps {
  sessionKey: string | null
  paneIndex: number
  onClose: () => void
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function CollapsibleCode({ lang, code }: { lang: string; code: string }) {
  const [open, setOpen] = useState(false)
  const lines = code.split('\n')
  const preview = lines.slice(0, 2).join('\n')
  return (
    <div className="my-1.5 rounded-lg overflow-hidden border border-[#2a3142]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-[#0f1117] hover:bg-[#181c24] transition-colors text-left"
      >
        <span className="text-[10px] text-[#6b7280] font-mono">
          {lang || 'code'} · {lines.length} lines
        </span>
        <span className="text-[10px] text-[#6366f1]">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {!open && (
        <div className="px-3 py-1.5 bg-[#0a0d14] text-[11px] font-mono text-[#6b7280] truncate">
          {preview}…
        </div>
      )}
      {open && (
        <pre className="px-3 py-2 bg-[#0a0d14] text-[11px] font-mono text-[#a5b4fc] overflow-x-auto leading-relaxed">
          {code}
        </pre>
      )}
    </div>
  )
}

function ChatMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0

  const renderInline = (str: string): React.ReactNode[] => {
    const parts = str.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)
    return parts.map((p, j) => {
      if (p.startsWith('**') && p.endsWith('**'))
        return (
          <strong key={j} className="font-semibold text-white">
            {p.slice(2, -2)}
          </strong>
        )
      if (p.startsWith('`') && p.endsWith('`') && p.length > 2)
        return (
          <code key={j} className="bg-[#0f1117] text-[#a5b4fc] px-1 rounded text-[11px] font-mono">
            {p.slice(1, -1)}
          </code>
        )
      if (p.startsWith('*') && p.endsWith('*') && p.length > 2)
        return (
          <em key={j} className="italic opacity-80">
            {p.slice(1, -1)}
          </em>
        )
      return <span key={j}>{p}</span>
    })
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++
      elements.push(<CollapsibleCode key={`code-${i}`} lang={lang} code={codeLines.join('\n')} />)
      continue
    }

    if (line.startsWith('### ')) {
      elements.push(
        <div key={i} className="text-xs font-semibold text-[#818cf8] mt-2 mb-0.5">
          {renderInline(line.slice(4))}
        </div>
      )
      i++
      continue
    }
    if (line.startsWith('## ')) {
      elements.push(
        <div key={i} className="text-sm font-semibold text-[#a5b4fc] mt-2 mb-1">
          {renderInline(line.slice(3))}
        </div>
      )
      i++
      continue
    }
    if (line.startsWith('# ')) {
      elements.push(
        <div
          key={i}
          className="text-sm font-bold text-white mt-2 mb-1 border-b border-[#2a3142] pb-1"
        >
          {renderInline(line.slice(2))}
        </div>
      )
      i++
      continue
    }

    const taskMatch = line.match(/^(\s*)- \[([ xX])\] (.*)/)
    if (taskMatch) {
      const done = taskMatch[2].toLowerCase() === 'x'
      elements.push(
        <div key={i} className="flex items-start gap-1.5 py-0.5">
          <span className={`mt-0.5 text-[11px] ${done ? 'text-emerald-400' : 'text-[#3a4152]'}`}>
            {done ? '✓' : '○'}
          </span>
          <span className={`text-sm leading-relaxed ${done ? 'line-through text-[#4b5563]' : ''}`}>
            {renderInline(taskMatch[3])}
          </span>
        </div>
      )
      i++
      continue
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
      i++
      continue
    }

    if (line.trim() === '---') {
      elements.push(<hr key={i} className="border-[#2a3142] my-2" />)
      i++
      continue
    }

    if (line.trim() === '') {
      elements.push(<div key={i} className="h-1" />)
      i++
      continue
    }

    elements.push(
      <div key={i} className="text-sm leading-relaxed py-0.5">
        {renderInline(line)}
      </div>
    )
    i++
  }

  return <div className="space-y-0">{elements}</div>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(content: MessageContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return (content as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
  return String(content)
}

function isHeartbeatTrigger(content: MessageContent): boolean {
  const text = extractText(content)
  return text.includes('Read HEARTBEAT.md') || text.trim().toLowerCase() === 'heartbeat'
}

function isHeartbeatResponse(content: MessageContent): boolean {
  const text = extractText(content)
  return text.trim() === 'HEARTBEAT_OK' || text.trim().startsWith('HEARTBEAT_OK\n')
}

function isHeartbeatMsg(msg: ChatMessage): boolean {
  return (
    (msg.role === 'user' && isHeartbeatTrigger(msg.content)) ||
    (msg.role === 'assistant' && isHeartbeatResponse(msg.content))
  )
}

function isNoiseMsg(msg: ChatMessage): boolean {
  if (!msg) return false
  if (msg.role === 'system') return true
  if (msg.role === 'tool' || msg.role === 'toolResult' || msg.role === 'toolCall') return true
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as ContentBlock[]
    const hasText = blocks.some((b) => b.type === 'text' && (b as { type: 'text'; text: string }).text?.trim())
    const hasToolBlock = blocks.some(
      (b) =>
        b.type === 'tool_use' ||
        b.type === 'tool_result' ||
        b.type === 'toolCall' ||
        b.type === 'toolResult'
    )
    if (hasToolBlock && !hasText) return true
  }
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const blocks = msg.content as ContentBlock[]
    const textBlocks = blocks.filter((b) => b.type === 'text')
    const toolBlocks = blocks.filter((b) => b.type === 'tool_use' || b.type === 'toolCall')
    if (
      toolBlocks.length > 0 &&
      textBlocks.every((b) => !(b as { type: 'text'; text: string }).text?.trim())
    )
      return true
  }
  return false
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatPane({ sessionKey, paneIndex: _paneIndex, onClose }: ChatPaneProps) {
  const { send, ws, connected } = useGatewayStore()
  const { setSessions, sessions, setLastRole } = useSessionStore()
  const { setCard } = useProjectStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sessionCard, setSessionCard] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [autoRenamed, setAutoRenamed] = useState(false)
  const [lastHeartbeat, setLastHeartbeat] = useState<{ ts: Date; ok: boolean } | null>(null)
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try {
      return localStorage.getItem('octis-noise-hidden') !== 'false'
    } catch {
      return true
    }
  })
  const bottomRef = useRef<HTMLDivElement>(null)

  const toggleNoise = () =>
    setNoiseHidden((v) => {
      const next = !v
      try {
        localStorage.setItem('octis-noise-hidden', String(next))
      } catch {}
      return next
    })

  // Load chat history when session or ws changes
  useEffect(() => {
    if (!sessionKey || !ws) return
    setMessages([])
    setSessionCard(null)
    setAutoRenamed(false)
    const reqId = `chat-history-${sessionKey}-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey, limit: 100 } })

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
          content?: MessageContent
          id_msg?: string | number
        }

        // Poll response
        const isPoll =
          msg.type === 'res' &&
          msg.ok &&
          msg.id?.startsWith(`chat-poll-${sessionKey}`)
        if (isPoll) {
          const msgs = msg.payload?.messages || []
          setMessages((prev) => {
            if (msgs.length <= prev.length) return prev
            const lastNew = msgs[msgs.length - 1]
            const lastPrev = prev[prev.length - 1]
            if (
              lastNew?.id === lastPrev?.id &&
              lastNew?.content === lastPrev?.content
            )
              return prev
            return msgs
          })
          return
        }

        // History response
        if (msg.type === 'res' && msg.id === reqId && msg.ok) {
          const msgs = msg.payload?.messages || []
          const lastHB = [...msgs]
            .reverse()
            .find((m) => m.role === 'assistant' && isHeartbeatResponse(m.content))
          if (lastHB)
            setLastHeartbeat({
              ts: new Date((lastHB.ts || lastHB.created_at || Date.now()) as string | number),
              ok: true,
            })
          setMessages(msgs)
          const card = msgs.find((m) => m.role === 'assistant')
          if (card) setSessionCard(extractText(card.content).slice(0, 300))
          const cardMsg = [...msgs]
            .reverse()
            .find((m) => m.role === 'assistant' && extractText(m.content).includes('📋'))
          if (cardMsg) setCard(sessionKey, extractText(cardMsg.content).slice(0, 500))
        }

        // Streaming chat event
        if (
          msg.type === 'event' &&
          msg.event === 'chat' &&
          (msg.payload as { sessionKey?: string })?.sessionKey === sessionKey
        ) {
          const chatMsg = msg.payload as unknown as ChatMessage & { sessionKey: string }
          if (chatMsg.role === 'assistant' && isHeartbeatResponse(chatMsg.content)) {
            setLastHeartbeat({ ts: new Date(), ok: true })
          }
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === chatMsg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: chatMsg.content }
              return next
            }
            return [...prev, chatMsg]
          })
          if (chatMsg.role === 'assistant') {
            const text = extractText(chatMsg.content)
            if (text.includes('📋')) setCard(sessionKey, text.slice(0, 500))
          }
        }

        // Flat chat event (older gateway versions)
        if (msg.type === 'chat' && msg.sessionKey === sessionKey) {
          const flatMsg: ChatMessage = {
            role: (msg.role as ChatMessage['role']) || 'assistant',
            content: msg.content,
            id: msg.id_msg,
          }
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
  }, [sessionKey, ws, send, setCard])

  // Polling fallback
  useEffect(() => {
    if (!sessionKey || !ws || !connected) return
    const interval = setInterval(() => {
      const pollId = `chat-poll-${sessionKey}-${Date.now()}`
      send({
        type: 'req',
        id: pollId,
        method: 'chat.history',
        params: { sessionKey, limit: 100 },
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [sessionKey, ws, connected, send])

  // Auto-rename: derive name from first user message
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const autoRename = useCallback(() => {
    if (autoRenamed || !sessionKey || messages.length === 0) return
    const firstUser = messages.find((m) => m.role === 'user')
    const firstAssistant = messages.find((m) => m.role === 'assistant')
    if (!firstUser || !firstAssistant) return
    const session = sessionsRef.current.find((s: Session) => s.key === sessionKey)
    const currentLabel = session?.label || ''
    if (currentLabel && !currentLabel.startsWith('session-') && currentLabel !== sessionKey)
      return
    const rawLabel = extractText(firstUser.content)
      .trim()
      .replace(/\n/g, ' ')
      .slice(0, 50)
    if (rawLabel.length > 5) {
      send({
        type: 'req',
        id: `sessions-patch-${Date.now()}`,
        method: 'sessions.patch',
        params: { sessionKey, patch: { label: rawLabel } },
      })
      setSessions(
        sessionsRef.current.map((s: Session) =>
          s.key === sessionKey ? { ...s, label: rawLabel } : s
        )
      )
      setAutoRenamed(true)
    }
  }, [autoRenamed, sessionKey, messages, send, setSessions])

  useEffect(() => {
    autoRename()
  }, [autoRename])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function renderContent(content: MessageContent) {
    const text = extractText(content)
    if (!text) return null
    return <ChatMarkdown text={text} />
  }

  const handleSend = () => {
    if (!input.trim() || !sessionKey) return
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
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: '⚠️ Not connected to gateway. Check your connection.',
          id: `err-${Date.now()}`,
        },
      ])
      return
    }
    setMessages((prev) => [...prev, { role: 'user', content: msg, id: Date.now() }])
    setLastRole(sessionKey, 'user')
    setInput('')

    const errorHandler = (event: MessageEvent) => {
      try {
        const m = JSON.parse(event.data as string) as {
          type: string
          id?: string
          ok?: boolean
          error?: { message?: string }
        }
        if (m.type === 'res' && m.id === reqId) {
          if (!m.ok) {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `⚠️ Gateway error: ${m.error?.message || JSON.stringify(m.error)}`,
                id: `err-${Date.now()}`,
              },
            ])
          }
          ws?.removeEventListener('message', errorHandler)
        }
      } catch {}
    }
    if (ws) ws.addEventListener('message', errorHandler)
    setTimeout(() => {
      if (ws) ws.removeEventListener('message', errorHandler)
    }, 10000)
  }

  const handleSave = () => {
    if (!sessionKey) return
    const msg =
      '💾 checkpoint — save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.'
    const idempotencyKey = `octis-save-${Date.now()}-${Math.random().toString(36).slice(2)}`
    send({
      type: 'req',
      id: `chat-send-${Date.now()}`,
      method: 'chat.send',
      params: { sessionKey, message: msg, deliver: false, idempotencyKey },
    })
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: '💾 Save checkpoint', id: Date.now() },
    ])
  }

  const handleArchive = () => {
    if (!sessionKey) return
    if (confirm('Save and archive this session?')) {
      const msg =
        '💾 Final save — write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. One-line ack only.'
      const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
      send({
        type: 'req',
        id: `chat-send-${Date.now()}`,
        method: 'chat.send',
        params: { sessionKey, message: msg, deliver: false, idempotencyKey },
      })
      setTimeout(() => {
        send({
          type: 'req',
          id: `sessions-delete-${Date.now()}`,
          method: 'sessions.delete',
          params: { sessionKey },
        })
        setSessions(sessions.filter((s: Session) => s.key !== sessionKey))
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
    const s = sessions.find((s: Session) => s.key === sessionKey)
    const label = s?.label || sessionKey
    return label.length > 40 ? label.slice(0, 40) + '…' : label
  })()

  return (
    <div className="flex flex-1 min-w-0 border-r border-[#2a3142]">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-1 px-3 py-2.5 border-b border-[#2a3142] bg-[#181c24] shrink-0">
          <span
            className="text-sm font-medium text-white truncate flex-1"
            title={sessionKey}
          >
            {displayName}
          </span>
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
            title={
              noiseHidden
                ? 'Show tool calls & system msgs'
                : 'Hide tool calls & system msgs'
            }
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors shrink-0 ${
              noiseHidden
                ? 'bg-[#1e2330] border-[#2a3142] text-[#4b5563]'
                : 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'
            }`}
          >
            {noiseHidden ? 'chat only' : '+ tools'}
          </button>
          <button
            onClick={handleSave}
            title="Save checkpoint to memory"
            className="text-xs text-[#6b7280] hover:text-green-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors"
          >
            💾
          </button>
          <button
            onClick={handleArchive}
            title="Save & archive session"
            className="text-xs text-[#6b7280] hover:text-yellow-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors"
          >
            📦
          </button>
          <button
            onClick={() => setSidebarOpen((s) => !s)}
            className="text-xs text-[#6b7280] hover:text-white px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors"
          >
            {sidebarOpen ? '→' : '←'}
          </button>
          <button
            onClick={onClose}
            className="text-xs text-[#6b7280] hover:text-red-400 px-1.5 py-1 rounded hover:bg-[#2a3142] transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages
            .filter(
              (msg) => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg))
            )
            .map((msg, i) => (
              <div
                key={msg.id !== undefined ? String(msg.id) : i}
                className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl ${
                    msg.role === 'user'
                      ? 'bg-[#6366f1] text-white rounded-br-sm text-sm whitespace-pre-wrap'
                      : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                  }`}
                >
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            />
            <button
              onClick={handleSend}
              className="bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg px-4 text-sm font-medium transition-colors"
            >
              ↑
            </button>
          </div>
        </div>
      </div>

      {/* Session sidebar */}
      {sidebarOpen && (
        <div className="w-52 shrink-0 bg-[#181c24] border-l border-[#2a3142] flex flex-col overflow-y-auto">
          <div className="px-3 py-3 border-b border-[#2a3142]">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-2">
              Session Brief
            </div>
            {sessionCard ? (
              <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed">
                {sessionCard}
              </pre>
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
