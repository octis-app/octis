import { useState, useEffect, useRef } from 'react'
import { useGatewayStore, useLabelStore, Session } from '../store/gatewayStore'

interface MobileFullChatProps {
  session: Session
  onBack: () => void
  recentSessions?: Session[]
  onSwitch?: (session: Session) => void
  onArchive?: () => void
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

type MessageContent = string | ContentBlock[] | unknown;

interface ChatMessage {
  id?: string | number;
  role: string;
  content: MessageContent;
}

// ─── Content Rendering ────────────────────────────────────────────────────────

// Try to parse content that looks like a JSON content-block array (or single object).
// Returns the parsed blocks, or null if it doesn't look like one / fails to parse.
function tryParseBlocks(raw: string): ContentBlock[] | null {
  const trimmed = raw.trimStart();
  // Try as JSON array
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && 'type' in parsed[0]) {
        return parsed as ContentBlock[];
      }
    } catch {}
  }
  // Try as a single JSON object (server may return unwrapped object)
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        return [parsed] as ContentBlock[];
      }
    } catch {}
  }
  return null;
}

// Render an image block — handles both Anthropic format and OpenClaw native format
function renderImageBlock(b: ContentBlock | Record<string, unknown>, key: number): React.ReactNode {
  const block = b as Record<string, unknown>;
  // Anthropic format: {type:'image', source:{type:'base64', media_type:..., data:...}}
  const src = block.source as { type?: string; data?: string; media_type?: string; url?: string } | undefined;
  // OpenClaw native format: {type:'image', data:..., mimeType:...}
  const directData = block.data as string | undefined;
  const directMime = (block.mimeType || block.media_type) as string | undefined;
  let imgSrc = '';
  if (src?.type === 'base64' && src.data) {
    imgSrc = `data:${src.media_type || 'image/png'};base64,${src.data}`;
  } else if (src?.url) {
    imgSrc = src.url;
  } else if (directData) {
    imgSrc = `data:${directMime || 'image/png'};base64,${directData}`;
  }
  return imgSrc
    ? <img key={key} src={imgSrc} alt="attachment" className="max-w-full rounded-lg my-1 max-h-64 object-contain" style={{ maxWidth: '100%', borderRadius: '8px' }} />
    : <span key={key} className="text-[#6b7280] text-xs italic">[Image]</span>;
}

// Main content rendering function
function renderMessageContent(content: MessageContent): React.ReactNode {
  // If content is already an array of blocks, process it
  if (Array.isArray(content)) {
    const blocks = content as ContentBlock[];
    return (
      <>
        {blocks.map((b, i) => {
          if (b.type === 'image') {
            return renderImageBlock(b, i);
          }
          if (b.type === 'text') {
            if (!b.text) return null;
            // Text block may itself contain a JSON block array (e.g. image wrapped by gateway)
            const nested = tryParseBlocks(b.text);
            if (nested) return <span key={i}>{renderMessageContent(nested)}</span>;
            return <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{String(b.text)}</span>;
          }
          // Handle other block types if necessary, or just render text content
          return b.text ? <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{String(b.text)}</span> : null;
        })}
      </>
    );
  }

  // If content is a string, try to parse it as blocks first
  if (typeof content === 'string') {
    const blocks = tryParseBlocks(content);
    if (blocks) {
      return renderMessageContent(blocks); // Recurse with parsed blocks
    }
  }

  return String(content ?? '');
}

// ─── Noise filter (mirrors ChatPane logic) ───────────────────────────────────

type ContentBlock = { type: string; text?: string; [key: string]: unknown }

function extractText(content: string | unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return (content as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
  return String(content ?? '')
}

function isHeartbeatMsg(msg: ChatMessage): boolean {
  const text = extractText(msg.content).trim()
  if (msg.role === 'user') {
    if (text.includes('Read HEARTBEAT.md') || text.toLowerCase() === 'heartbeat') return true
    // Async exec completion notifications injected by OpenClaw — always hide
    if (text.startsWith('System (untrusted):') || text.startsWith('System:') ||
        text.includes('An async command you ran earlier has completed')) return true
  }
  if (msg.role === 'assistant') return text === 'HEARTBEAT_OK' || text.startsWith('HEARTBEAT_OK\n')
  return false
}

function isNoiseMsg(msg: ChatMessage): boolean {
  if (msg.role === 'system') return true
  if (msg.role === 'tool' || msg.role === 'toolResult' || msg.role === 'toolCall') return true
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as ContentBlock[]
    const hasText = blocks.some((b) => b.type === 'text' && b.text?.trim())
    const hasTool = blocks.some((b) => ['tool_use','tool_result','toolCall','toolResult'].includes(b.type))
    if (hasTool && !hasText) return true
  }
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const blocks = msg.content as ContentBlock[]
    const textBlocks = blocks.filter((b) => b.type === 'text')
    const toolBlocks = blocks.filter((b) => b.type === 'tool_use' || b.type === 'toolCall')
    if (toolBlocks.length > 0 && textBlocks.every((b) => !b.text?.trim())) return true
  }
  return false
}

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function MobileFullChat({ session, onBack, recentSessions, onSwitch, onArchive }: MobileFullChatProps) {
  const { send, ws, connect, connected } = useGatewayStore()
  const { getLabel, setLabel } = useLabelStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pendingFile, setPendingFile] = useState<{ dataUrl: string; mimeType: string; name: string; kind: 'image' | 'document' } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sending, _setSending] = useState(false)
  const sendingRef = useRef(false)
  const setSending = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(sendingRef.current) : v
    sendingRef.current = next
    _setSending(next)
  }
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try { return localStorage.getItem('octis-noise-hidden') !== 'false' } catch { return true }
  })
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [autoRenaming, setAutoRenaming] = useState(false)
  const [showArchiveSheet, setShowArchiveSheet] = useState(false)
  const [swipeHint, setSwipeHint] = useState<string | null>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const isDraggingRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const pillRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const userScrolledUpRef = useRef(false)
  const lastMsgCountRef = useRef(0)
  const programmaticScrollRef = useRef(false)

  // Scroll to bottom without triggering userScrolledUp detection
  const scrollToBottom = (smooth = false) => {
    programmaticScrollRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant' })
    setTimeout(() => { programmaticScrollRef.current = false }, smooth ? 450 : 60)
  }
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Reconnect + re-fetch when returning from background.
  // Always force reconnect — WS can show readyState=OPEN while actually dead (half-open).
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return
      // Force a fresh connection regardless of apparent WS state.
      // connect() closes the old socket and opens a new one; the ws-change
      // effect below will re-fetch history once the new connection is authed.
      connect()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [connect])

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

        // Poll response (periodic refresh)
        if (
          msg.type === 'res' &&
          msg.ok &&
          typeof msg.id === 'string' &&
          msg.id.startsWith(`chat-poll-mobile-${session.key}`)
        ) {
          const msgs = msg.payload?.messages || []
          if (msgs.length > 0 && !sendingRef.current) {
            // Skip poll updates while sending — poll can wipe the optimistic message
            // before the gateway has committed it. Wait for streaming/res to land first.
            setMessages(msgs)
          }
          return
        }

        // History response
        if (msg.type === 'res' && msg.id === reqId && msg.ok) {
          setSending(false)
          setMessages(msg.payload?.messages || [])
        }

        // Streaming event
        if (msg.type === 'event' && msg.event === 'chat') {
          const payload = msg.payload as { sessionKey?: string; role?: string; content?: string; id?: string | number }
          if (payload?.sessionKey === session.key) {
            setSending(false)
            // Only update if content is non-empty — empty payloads are flush events
            // and would blank out the message until the next poll
            if (payload.content) {
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

  // Periodic poll so messages arrive even when streaming events are missed
  useEffect(() => {
    if (!session?.key || !ws || !connected) return
    const interval = setInterval(() => {
      send({ type: 'req', id: `chat-poll-mobile-${session.key}-${Date.now()}`, method: 'chat.history', params: { sessionKey: session.key, limit: 100 } })
    }, 3000)
    return () => clearInterval(interval)
  }, [session?.key, ws, connected, send])

  useEffect(() => {
    const newCount = messages.length
    const hadNewMessage = newCount > lastMsgCountRef.current
    lastMsgCountRef.current = newCount
    // Only scroll if: user is near the bottom OR a genuinely new message arrived
    if (!userScrolledUpRef.current || hadNewMessage) {
      scrollToBottom(false)
    }
  }, [messages])

  const handleAttachFile = (file: File) => {
    const isImage = file.type.startsWith('image/')
    const isPdf = file.type === 'application/pdf'
    if (!isImage && !isPdf) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      setPendingFile({ dataUrl, mimeType: file.type, name: file.name, kind: isImage ? 'image' : 'document' })
    }
    reader.readAsDataURL(file)
  }

  const handleSend = () => {
    if (!input.trim() && !pendingFile) return
    if (sending) return
    const msg = input.trim()
    const idempotencyKey = `octis-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const messageContent = pendingFile
      ? JSON.stringify([
          pendingFile.kind === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: pendingFile.mimeType, data: pendingFile.dataUrl.split(',')[1] } }
            : { type: 'document', source: { type: 'base64', media_type: pendingFile.mimeType, data: pendingFile.dataUrl.split(',')[1] } },
          ...(msg ? [{ type: 'text', text: msg }] : []),
        ])
      : msg
    const optimisticContent = pendingFile
      ? [pendingFile.kind === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: pendingFile.mimeType, data: pendingFile.dataUrl.split(',')[1] } }
          : { type: 'text', text: `📄 ${pendingFile.name}` },
         ...(msg ? [{ type: 'text', text: msg }] : [])]
      : msg
    send({
      type: 'req',
      id: `chat-send-${Date.now()}`,
      method: 'chat.send',
      params: { sessionKey: session.key, message: messageContent, deliver: false, idempotencyKey },
    })
    userScrolledUpRef.current = false
    setPendingFile(null)
    setMessages((prev) => [...prev, { role: 'user', content: optimisticContent as string, id: Date.now() }])
    setInput('')
    setSending(true)
    setTimeout(() => scrollToBottom(true), 50)
  }

  // Auto-scroll the sessions pill strip to keep active pill in view when session changes
  useEffect(() => {
    if (!session?.key) return
    const pill = pillRefs.current[session.key]
    if (pill) {
      pill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }
  }, [session?.key])

  const label = getLabel(session?.key || '') || session?.label || session?.key || 'Chat'

  const startEditing = () => {
    setRenameValue(label)
    setEditing(true)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleRename = () => {
    const trimmed = renameValue.trim()
    if (!trimmed) { setEditing(false); return }
    setLabel(session.key, trimmed)
    send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { sessionKey: session.key, patch: { label: trimmed } } })
    void fetch(`${API}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: session.key, label: trimmed }),
    })
    setEditing(false)
  }

  const handleAutoRename = async () => {
    if (autoRenaming || messages.length === 0) return
    setAutoRenaming(true)
    const slim = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, 6)
      .map(m => ({ role: m.role, content: extractText(m.content).slice(0, 300) }))
    try {
      const res = await fetch(`${API}/api/session-autoname`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: slim }),
      })
      const data = await res.json() as { label?: string }
      if (data.label) {
        setLabel(session.key, data.label)
        send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { sessionKey: session.key, patch: { label: data.label } } })
        void fetch(`${API}/api/session-rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey: session.key, label: data.label }),
        })
      }
    } catch {}
    setAutoRenaming(false)
  }

  return (
    <div className="fixed inset-0 bg-[#181c24] flex flex-col z-50" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div
        className="flex items-center gap-3 px-4 py-3 bg-[#181c24] border-b border-[#2a3142] shrink-0"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <button
          onClick={onBack}
          className="text-[#6366f1] text-lg font-semibold w-8 flex items-center justify-center shrink-0"
        >
          ←
        </button>
        {editing ? (
          <input
            ref={renameInputRef}
            className="flex-1 bg-[#0f1117] border border-[#6366f1] rounded-lg px-2 py-0.5 text-sm text-white outline-none"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }}
            onBlur={handleRename}
            autoFocus
          />
        ) : (
          <span
            className="text-sm font-semibold text-white truncate flex-1 select-none"
            onDoubleClick={startEditing}
            title="Double-tap to rename"
          >
            {label}
          </span>
        )}
        {!editing && (
          <button
            onClick={handleAutoRename}
            disabled={autoRenaming}
            className="text-[#4b5563] hover:text-[#a5b4fc] disabled:opacity-40 transition-colors shrink-0 px-1 text-base"
            title="Auto-rename from conversation"
          >
            {autoRenaming ? '…' : '✨'}
          </button>
        )}
        <button
          onClick={() => setNoiseHidden((v) => { const next = !v; try { localStorage.setItem('octis-noise-hidden', String(next)) } catch {} return next })}
          title={noiseHidden ? 'Show tool calls & system msgs' : 'Hide tool calls & system msgs'}
          className={`text-[10px] font-medium h-6 px-2 rounded-full border transition-colors shrink-0 ${
            noiseHidden
              ? 'bg-[#1e2330] border-[#2a3142] text-[#4b5563]'
              : 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'
          }`}
        >
          {noiseHidden ? 'chat only' : '+ tools'}
        </button>
        {onArchive && (
          <button
            onClick={() => setShowArchiveSheet(true)}
            className="text-[#4b5563] hover:text-white transition-colors shrink-0 px-1 text-base leading-none"
            title="More options"
          >
            ⋯
          </button>
        )}
      </div>

      {/* Quick action buttons */}
      <div className="flex gap-1.5 px-4 py-1.5 bg-[#0f1117] border-b border-[#1e2330] shrink-0">
        {([
          { icon: '💬', label: 'Brief', msg: "Give me a 3-sentence status update: (1) what you last did, (2) what you're working on now, (3) what's next. No fluff." },
          { icon: '💾', label: 'Save', msg: '💾 checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.' },
        ] as { icon: string; label: string; msg: string }[]).map(({ icon, label, msg }) => (
          <button
            key={label}
            onClick={() => {
              send({ type: 'req', id: `quick-${label}-${Date.now()}`, method: 'chat.send', params: { sessionKey: session.key, message: msg } })
              setSending(true)
              userScrolledUpRef.current = false
              setTimeout(() => scrollToBottom(false), 50)
            }}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap bg-[#1e2330] text-[#9ca3af] active:bg-[#6366f1] active:text-white transition-colors shrink-0 border border-[#2a3142]"
          >
            <span>{icon}</span><span>{label}</span>
          </button>
        ))}
        <button
          onClick={() => onArchive?.()}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap bg-[#1e2330] text-[#9ca3af] active:bg-[#6366f1] active:text-white transition-colors shrink-0 border border-[#2a3142]"
        >
          <span>📦</span><span>Archive</span>
        </button>
      </div>

      {/* Recent sessions strip */}
      {recentSessions && recentSessions.length > 0 && (
        <div
          ref={stripRef}
          className="overflow-x-auto flex gap-1.5 px-4 py-1.5 bg-[#0f1117] border-b border-[#1e2330] shrink-0"
          style={{ scrollbarWidth: 'none' }}
        >
          {recentSessions.map((s) => {
            const lbl = (getLabel(s.key) || s.label || s.key).slice(0, 14)
            const isCurrent = s.key === session.key
            return (
              <button
                key={s.key}
                ref={el => { pillRefs.current[s.key] = el }}
                onClick={() => !isCurrent && onSwitch?.(s)}
                className={`text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap transition-colors shrink-0 ${
                  isCurrent
                    ? 'bg-[#6366f1] text-white'
                    : 'bg-[#1e2330] text-[#9ca3af] active:bg-[#2a3142]'
                }`}
              >
                {lbl}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex-1 relative overflow-hidden bg-[#0f1117]">
      {swipeHint && (
        <div className="absolute inset-x-0 top-1/2 flex justify-center pointer-events-none z-10">
          <span className="bg-black/70 text-white text-xs px-3 py-1.5 rounded-full">{swipeHint}</span>
        </div>
      )}
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto px-4 py-3 space-y-3"
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0].clientX
          touchStartY.current = e.touches[0].clientY
          isDraggingRef.current = false
          // Remove any transition so dragging is instant
          if (scrollRef.current) scrollRef.current.style.transition = ''
        }}
        onTouchMove={(e) => {
          if (!recentSessions || !onSwitch) return
          const dx = e.touches[0].clientX - touchStartX.current
          const dy = e.touches[0].clientY - touchStartY.current
          // Only hijack if clearly horizontal
          if (!isDraggingRef.current && Math.abs(dx) < 10) return
          if (!isDraggingRef.current && Math.abs(dx) <= Math.abs(dy)) return
          isDraggingRef.current = true
          // Check a valid next session exists; dampen if at edge
          const idx = recentSessions.findIndex(s => s.key === session.key)
          const wouldGoTo = dx < 0 ? idx + 1 : idx - 1
          const atEdge = wouldGoTo < 0 || wouldGoTo >= recentSessions.length
          const effectiveDx = atEdge ? dx * 0.2 : dx
          if (scrollRef.current) scrollRef.current.style.transform = `translateX(${effectiveDx}px)`
        }}
        onTouchEnd={(e) => {
          if (!recentSessions || !onSwitch) return
          const deltaX = e.changedTouches[0].clientX - touchStartX.current
          const deltaY = e.changedTouches[0].clientY - touchStartY.current
          const el = scrollRef.current

          if (!isDraggingRef.current || Math.abs(deltaX) < 60 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) {
            // Snap back
            if (el) {
              el.style.transition = 'transform 220ms ease-out'
              el.style.transform = 'translateX(0)'
              setTimeout(() => { if (el) el.style.transition = '' }, 230)
            }
            isDraggingRef.current = false
            return
          }

          const idx = recentSessions.findIndex(s => s.key === session.key)
          const newIdx = deltaX < 0 ? idx + 1 : idx - 1
          if (newIdx < 0 || newIdx >= recentSessions.length) {
            // Edge — snap back
            if (el) {
              el.style.transition = 'transform 220ms ease-out'
              el.style.transform = 'translateX(0)'
              setTimeout(() => { if (el) el.style.transition = '' }, 230)
            }
            isDraggingRef.current = false
            return
          }

          // Slide out fully, then switch
          const target = deltaX < 0 ? '-100vw' : '100vw'
          setSwipeHint(deltaX < 0 ? 'Next →' : '← Previous')
          setTimeout(() => setSwipeHint(null), 600)
          if (el) {
            el.style.transition = 'transform 220ms ease-out'
            el.style.transform = `translateX(${target})`
            setTimeout(() => {
              if (el) { el.style.transition = ''; el.style.transform = '' }
              onSwitch(recentSessions[newIdx])
            }, 225)
          } else {
            onSwitch(recentSessions[newIdx])
          }
          isDraggingRef.current = false
        }}
        onScroll={() => {
          if (programmaticScrollRef.current) return // ignore scroll events we triggered
          const el = scrollRef.current
          if (!el) return
          const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
          userScrolledUpRef.current = distFromBottom > 80
        }}
      >
        {messages.filter((msg) => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg))).map((msg, i) => (
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
              {renderMessageContent(msg.content)}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#1e2330] px-4 py-3 rounded-2xl rounded-bl-sm flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '200ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '400ms' }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      </div>

      <div
        className="px-3 py-3 bg-[#181c24] border-t border-[#2a3142] shrink-0"
      >
        {/* Pending file preview */}
        {pendingFile && (
          <div className="flex items-center gap-2 mb-2 px-1">
            {pendingFile.kind === 'image'
              ? <img src={pendingFile.dataUrl} alt="preview" className="h-14 w-14 rounded-xl object-cover border border-[#6366f1]" />
              : <div className="flex items-center gap-2 bg-[#1e2330] rounded-xl px-3 py-2"><span className="text-xl">📄</span><span className="text-xs text-white truncate max-w-[160px]">{pendingFile.name}</span></div>
            }
            <button onClick={() => setPendingFile(null)} className="text-[#6b7280] hover:text-red-400 text-lg ml-auto">✕</button>
          </div>
        )}
        <div className="flex gap-2 items-end">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAttachFile(f); e.target.value = '' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-[#4b5563] hover:text-[#6366f1] transition-colors w-9 h-9 flex items-center justify-center shrink-0 rounded-xl hover:bg-[#1e2330]"
            title="Attach image or PDF"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-2xl px-4 py-3 text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] resize-none leading-snug"
            placeholder="Message…"
            value={input}
            rows={1}
            style={{ maxHeight: '120px', overflowY: 'auto', fontSize: '16px' }}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && !pendingFile) || sending}
            className="bg-[#6366f1] disabled:opacity-40 text-white rounded-2xl w-11 h-11 flex items-center justify-center shrink-0 transition-colors active:scale-95"
          >
            ↑
          </button>
        </div>
      </div>

      {/* Archive action sheet */}
      {showArchiveSheet && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60"
          onClick={() => setShowArchiveSheet(false)}
        >
          <div
            className="bg-[#181c24] rounded-t-3xl border-t border-[#2a3142] px-4 pt-4 pb-8 space-y-2"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-[#2a3142] rounded-full mx-auto mb-4" />
            <button
              onClick={() => {
                setShowArchiveSheet(false)
                onArchive?.()
                // After archiving, switch to the next available session instead of going back
                const next = (recentSessions || []).find(s => s.key !== session.key)
                if (next && onSwitch) onSwitch(next)
                else onBack()
              }}
              className="w-full text-left px-4 py-3.5 rounded-xl text-red-400 font-medium text-sm hover:bg-[#2a3142] transition-colors"
            >
              Archive session
            </button>
            <button
              onClick={() => setShowArchiveSheet(false)}
              className="w-full text-left px-4 py-3.5 rounded-xl text-[#6b7280] text-sm hover:bg-[#2a3142] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
