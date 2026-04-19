import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore, useLabelStore, useDraftStore, Session } from '../store/gatewayStore'

interface MobileFullChatProps {
  session: Session
  onBack: () => void
  recentSessions?: Session[]
  onSwitch?: (session: Session) => void
  onArchive?: () => void
  onNewSession?: () => void
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
  ts?: string | number;
  created_at?: string | number;
  timestamp?: string | number;
  // Gateway stores images as separate fields when sent via chat.send with attachments
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
}

function getMsgTs(msg: ChatMessage): number {
  const raw = msg.ts || msg.created_at || msg.timestamp
  if (!raw) return 0
  const ms = typeof raw === 'number' ? raw : new Date(raw as string).getTime()
  return isNaN(ms) ? 0 : ms
}

function fmtMsgTs(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  if (isYesterday) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
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
// Render text that may contain [media attached: /path (mime)] or [Saved to workspace: /path]
function renderTextWithMedia(text: string, key: number): React.ReactNode {
  // Handle [Saved to workspace: /path] — files uploaded via 💾 toggle
  const savedMatch = text.match(/\[Saved to workspace:\s*([^\]]+)\]/)
  if (savedMatch) {
    const filePath = savedMatch[1].trim()
    const filename = filePath.split('/').pop() || ''
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const isPdf = ext === 'pdf'
    const isImage = ['png','jpg','jpeg','gif','webp'].includes(ext)
    const mediaSrc = `${API}/api/uploads/${encodeURIComponent(filename)}`
    const afterMeta = text.replace(/\[Saved to workspace:[^\]]+\]/g, '').trim()
    return (
      <span key={key}>
        {isPdf
          ? <a href={mediaSrc} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
              <span className="text-2xl">📄</span>
              <span className="text-xs text-white truncate">{filename}</span>
            </a>
          : isImage
          ? <img src={mediaSrc} alt={filename} className="max-w-full rounded-lg my-1 max-h-64 object-contain"
              style={{ maxWidth: '100%', borderRadius: '8px' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          : <a href={mediaSrc} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
              <span className="text-2xl">📎</span>
              <span className="text-xs text-white truncate">{filename}</span>
            </a>
        }
        {afterMeta && <span style={{ whiteSpace: 'pre-wrap' }}>{afterMeta}</span>}
      </span>
    )
  }
  const mediaMatch = text.match(/\[media attached:\s*([^\s)]+)\s+\(([^)]+)\)/)
  if (mediaMatch) {
    const filePath = mediaMatch[1]
    const mimeType = mediaMatch[2] || ''
    const filename = filePath.split('/').pop() || ''
    const mediaSrc = `${API}/api/media/${encodeURIComponent(filename)}`
    const afterMeta = text
      .replace(/\[media attached:[^\]]+\]/g, '')
      .replace(/\nTo send an image back[^\n]*(\n|$)/g, '')
      .replace(/\nTo send a document back[^\n]*(\n|$)/g, '')
      .replace(/System: \[.*?\]/gs, '')
      .replace(/\nSender \(untrusted[\s\S]*?UTC\]/g, '')
      .trim()
    const isPdf = mimeType.includes('pdf') || filename.endsWith('.pdf')
    return (
      <span key={key}>
        {isPdf
          ? (
            <a href={mediaSrc} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
              <span className="text-2xl">📄</span>
              <span className="text-xs text-white truncate">{filename}</span>
            </a>
          )
          : (
            <img src={mediaSrc} alt="image" className="max-w-full rounded-lg my-1 max-h-64 object-contain"
              style={{ maxWidth: '100%', borderRadius: '8px' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )
        }
        {afterMeta && <span style={{ whiteSpace: 'pre-wrap' }}>{afterMeta}</span>}
      </span>
    )
  }
  return <span key={key} style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
}

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
            return renderTextWithMedia(String(b.text), i);
          }
          // Handle other block types if necessary, or just render text content
          return b.text ? renderTextWithMedia(String(b.text), i) : null;
        })}
      </>
    );
  }

  // If content is a string, strip envelope then try to parse as blocks
  if (typeof content === 'string') {
    // Strip OpenClaw message envelope (user messages from chat history)
    const inner = extractEnvelope(content)
    const processStr = inner ?? stripBootstrapNoise(content)
    const blocks = tryParseBlocks(processStr);
    if (blocks) {
      return renderMessageContent(blocks);
    }
    return renderTextWithMedia(processStr, 0);
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

// Strip OpenClaw message envelope from user messages stored in chat history.
// Format: "Sender (untrusted metadata):\n{...}\n\n[Day YYYY-MM-DD HH:MM UTC] <actual content>"
function stripBootstrapNoise(text: string): string {
  const idx = text.indexOf('[Bootstrap truncation warning]')
  return idx !== -1 ? text.slice(0, idx).trimEnd() : text
}

function extractEnvelope(text: string): string | null {
  if (!text.includes('Sender (untrusted metadata):')) return null
  const match = text.match(/\[\w+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\]\s*([\s\S]*)$/)
  if (!match) return null
  return stripBootstrapNoise(match[1].trim()) || null
}

// Compress image to ≤1280px longest side, JPEG 0.72 quality
// Reduces iPhone photos from ~5MB to <200KB before base64 encoding
async function compressImage(dataUrl: string, mimeType: string): Promise<{ dataUrl: string; mimeType: string }> {
  const MAX_PX = 1280
  const QUALITY = 0.72
  return new Promise((resolve) => {
    const img = new window.Image()
    img.onload = () => {
      const { width, height } = img
      const scale = Math.min(1, MAX_PX / Math.max(width, height))
      const w = Math.round(width * scale)
      const h = Math.round(height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      const outMime = 'image/jpeg'
      const compressed = canvas.toDataURL(outMime, QUALITY)
      resolve({ dataUrl: compressed, mimeType: outMime })
    }
    img.onerror = () => resolve({ dataUrl, mimeType }) // fallback: original
    img.src = dataUrl
  })
}

// Cache utilities
const CACHE_PREFIX = 'octis-msg-cache-'
const MAX_CACHED_SESSIONS = 20
const MAX_MESSAGES_PER_SESSION = 60

function getMsgCache(sessionKey: string): ChatMessage[] | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + sessionKey)
    return raw ? (JSON.parse(raw) as ChatMessage[]) : null
  } catch { return null }
}

function setMsgCache(sessionKey: string, msgs: ChatMessage[]): void {
  if (msgs.length === 0) return // Never cache empty
  try {
    localStorage.setItem(CACHE_PREFIX + sessionKey, JSON.stringify(msgs.slice(-MAX_MESSAGES_PER_SESSION)))
    // Evict oldest if over limit
    const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX))
    if (keys.length > MAX_CACHED_SESSIONS) {
      const toRemove = keys.find(k => k !== CACHE_PREFIX + sessionKey)
      if (toRemove) localStorage.removeItem(toRemove)
    }
  } catch {}
}

export default function MobileFullChat({ session, onBack, recentSessions, onSwitch, onArchive, onNewSession }: MobileFullChatProps) {
  const { send, ws, connect, connected } = useGatewayStore()
  const { consumePendingProjectInit, getStatus } = useSessionStore()
  const { getLabel, setLabel } = useLabelStore()
  // Initialize from cache if available
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const cached = session?.key ? getMsgCache(session.key) : null
    return (cached && cached.length > 0) ? cached : []
  })
  const [loadedKey, setLoadedKey] = useState<string | null>(session?.key && getMsgCache(session.key) ? session.key : null)
  const { getDraft, setDraft, clearDraft } = useDraftStore()
  const [input, setInput] = useState(() => getDraft(session?.key || ''))
  type PendingFile = { dataUrl: string; mimeType: string; name: string; kind: 'image' | 'document' | 'video'; saveToWorkspace: boolean; extractedText?: string; extracting?: boolean; pages?: number; videoObjectUrl?: string; _key?: number }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sending, _setSending] = useState(false)
  const sendingRef = useRef(false)
  const setSending = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(sendingRef.current) : v
    sendingRef.current = next
    _setSending(next)
  }
  // Message queue: holds a message to auto-send when model finishes current reply
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null)
  const queuedMessageRef = useRef<string | null>(null)
  // Sent queue: tracks recent sends for visual feedback (mirrors desktop behavior)
  type SentEntry = { id: number; text: string; status: 'sending' | 'queued' }
  const [sentQueue, setSentQueue] = useState<SentEntry[]>([])
  const confirmedSentRef = useRef<number | null>(null)
  // Track message count before send — used to unblock polls once server confirms receipt
  const preSendCountRef = useRef<number>(0)
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try { return localStorage.getItem('octis-noise-hidden') !== 'false' } catch { return true }
  })
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [autoRenaming, setAutoRenaming] = useState(false)
  const [showArchiveSheet, setShowArchiveSheet] = useState(false)
  const [copiedMsgId, setCopiedMsgId] = useState<string | number | null>(null)
  const [swipeHint, setSwipeHint] = useState<string | null>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const isDraggingRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const lastMsgCountRef = useRef(0)
  const programmaticScrollRef = useRef(false)
  // Preserve strip scroll position across re-renders (iOS Safari resets scrollLeft on re-render)
  const prevSessionKeyRef = useRef<string | undefined>(undefined)
  const stripRef = useRef<HTMLDivElement>(null)
  const pillRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const stripScrollLeft = useRef(0)
  // Preserve chat scroll position across re-renders (iOS resets scrollTop on re-render)

  // Track the latest history reqId so we can match responses from re-sent requests
  const currentHistoryReqIdRef = useRef<string>('')

  // Scroll to bottom without triggering userScrolledUp detection
  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0 // flex-col-reverse: 0 = bottom
  }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)

  // Reconnect + re-fetch when returning from background.
  // Always force reconnect — WS can show readyState=OPEN while actually dead (half-open).
  // Pin body background to chat color while mounted — prevents black flash on iOS keyboard dismiss
  useEffect(() => {
    const prev = document.body.style.backgroundColor
    document.body.style.backgroundColor = '#181c24'
    return () => { document.body.style.backgroundColor = prev }
  }, [])

  // Fix iOS keyboard jump: pin container to the visual viewport via DOM ref.
  // We set height + top directly on the DOM node so React re-renders (e.g. every
  // keystroke changing `input` state) can never override these values — React only
  // controls the `style` prop, not imperative style mutations made through refs.
  // Both 'resize' (height changes) and 'scroll' (offsetTop changes) are needed:
  // iOS scrolls the visual viewport when focusing an input, which changes offsetTop.
  useEffect(() => {
    const vv = window.visualViewport
    const el = outerRef.current
    if (!el) return
    if (!vv) {
      // Fallback for browsers without visualViewport support
      el.style.height = window.innerHeight + 'px'
      return
    }
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!outerRef.current) return
        outerRef.current.style.height = vv.height + 'px'
        outerRef.current.style.top = vv.offsetTop + 'px'
      })
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update() // apply immediately
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      cancelAnimationFrame(raf)
    }
  }, [])

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

    // Load draft for new session (no longer remounting on switch)
    setInput(getDraft(session.key))
    // Reset sending state on reconnect / session switch so polls aren't permanently blocked
    setSending(false)
    // Reset scroll state on session switch
    userScrolledUpRef.current = false
    // Reset message count so scroll-to-bottom fires on cache load (stale count from previous session
    // would suppress the scroll when switching to a session with fewer messages than the last one).
    lastMsgCountRef.current = 0
    // Reset scroll position to bottom (flex-col-reverse: scrollTop=0 = bottom).
    // Without this, returning to a session keeps the old scroll offset from a previous visit.
    if (scrollRef.current) scrollRef.current.scrollTop = 0

    // Populate from cache — never wipe to empty (causes blank flash on reconnect)
    const cached = getMsgCache(session.key)
    if (cached && cached.length > 0) {
      setMessages(cached)
      // Mark as loaded from cache immediately so messages render without waiting for WS
      setLoadedKey(session.key)
    }
    // Only clear loadedKey if we have no cache — triggers loading state
    if (!cached || cached.length === 0) {
      setMessages([])
      setLoadedKey(null)
    }

    // Use proper req/method format (not old type-based format)
    const reqId = `chat-history-${session.key}-${Date.now()}`
    currentHistoryReqIdRef.current = reqId
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
          if (msgs.length === 0) return
          // Gate: keep optimistic message visible until server confirms receipt
          // (server message count exceeds count at time of send).
          // Once server has it, ALWAYS apply — this is how replies become visible.
          if (sendingRef.current && msgs.length <= preSendCountRef.current) {
            // Server hasn't received our message yet — keep optimistic, don't overwrite
            return
          }
          // Server has our message (or we're not in a send). Apply update.
          // Clear pending localStorage entry if message is now confirmed
          localStorage.removeItem(`octis-pending-${session.key}`)
          setMessages(msgs)
          // Clear sending state: either assistant replied, OR user msg confirmed but no reply yet.
          // Always clear once server has the user's message (avoids stuck queue when reply is slow).
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.role === 'assistant') {
            const txt = typeof lastMsg.content === 'string' ? lastMsg.content.trim() : ''
            if (txt && txt !== 'HEARTBEAT_OK') setSending(false)
          } else {
            // User message confirmed server-side — clear sending so new sends aren't blocked
            setSending(false)
          }
          return
        }

        // History response (match current reqId — handles re-sent requests after reconnect)
        if (msg.type === 'res' && msg.id === currentHistoryReqIdRef.current && msg.ok) {
          const msgs = msg.payload?.messages || []
          // Refresh resilience: restore optimistic message if server hasn't committed it yet
          const pendingKey = `octis-pending-${session.key}`
          const pendingRaw = localStorage.getItem(pendingKey)
          let finalMsgs = msgs
          if (pendingRaw) {
            try {
              const { text, timestamp } = JSON.parse(pendingRaw) as { text: string; timestamp: number }
              const age = Date.now() - timestamp
              const inHistory = msgs.some(m => {
                if (m.role !== 'user') return false
                if (typeof m.content === 'string') return m.content.slice(0, 80) === text.slice(0, 80)
                if (Array.isArray(m.content)) {
                  const textBlock = (m.content as Array<{type: string; text?: string}>).find(b => b.type === 'text')
                  return (textBlock?.text || '').slice(0, 80) === text.slice(0, 80)
                }
                return false
              })
              if (!inHistory && age < 5 * 60 * 1000) {
                // Server hasn't committed it yet — show as optimistic
                finalMsgs = [...msgs, { role: 'user', content: text, id: Date.now() }]
                preSendCountRef.current = msgs.length
                setSending(true)
                // Safety: always schedule a timeout so sendingRef never stays stuck
                // (unlike handleSend which sets its own timeout, this path has no auto-clear)
                setTimeout(() => setSending(false), 15000)
              } else {
                // Confirmed in history or too old — clear
                localStorage.removeItem(pendingKey)
              }
            } catch {}
          }
          if (!pendingRaw) setSending(false)
          setMessages(finalMsgs)
          setLoadedKey(session.key)
          // Write to cache after receiving fresh history
          setMsgCache(session.key, finalMsgs)
        }

        // Streaming event
        if (msg.type === 'event' && msg.event === 'chat') {
          const payload = msg.payload as { sessionKey?: string; role?: string; content?: string; id?: string | number }
          if (payload?.sessionKey === session.key) {
            setSending(false)
            localStorage.removeItem(`octis-pending-${session.key}`)
            setSentQueue(prev => prev.filter(e => e.status === 'sending'))
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
          setSentQueue(prev => prev.filter(e => e.status === 'sending'))
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

  // Re-fetch history when connection is established (handles the common case where
  // the initial chat.history send was dropped because WS was still CONNECTING).
  // Without this, user sees stale cached messages for up to 3s after reconnect.
  useEffect(() => {
    if (!connected || !session?.key || !ws) return
    // Only re-fetch if we don't have fresh data for this session yet
    if (loadedKey === session.key) return
    const reqId = `chat-history-reconnect-${session.key}-${Date.now()}`
    currentHistoryReqIdRef.current = reqId
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session.key, limit: 100 } })
  }, [connected, session?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic poll so messages arrive even when streaming events are missed
  useEffect(() => {
    if (!session?.key || !ws || !connected) return
    const interval = setInterval(() => {
      send({ type: 'req', id: `chat-poll-mobile-${session.key}-${Date.now()}`, method: 'chat.history', params: { sessionKey: session.key, limit: 100 } })
    }, 3000)
    return () => clearInterval(interval)
  }, [session?.key, ws, connected, send])

  // Track message count for "new message arrived" detection (used for auto-scroll with col-reverse).
  // useLayoutEffect fires synchronously before paint — eliminates the visible scroll jerk
  // that occurs when useEffect fires after the browser has already painted the old position.
  useLayoutEffect(() => {
    const newCount = messages.length
    const hadNewMessage = newCount > lastMsgCountRef.current
    lastMsgCountRef.current = newCount
    if (!hadNewMessage) return
    // Always scroll when the newest message is from the assistant (reply just arrived).
    // Only respect userScrolledUpRef for user messages (mid-conversation scroll position).
    const newestIsAssistant = messages.length > 0 && messages[messages.length - 1]?.role === 'assistant'
    if (newestIsAssistant || !userScrolledUpRef.current) {
      const el = scrollRef.current
      if (el) {
        userScrolledUpRef.current = false
        el.scrollTop = 0
      }
    }
  }, [messages])

  // Mark sent entries as delivered when server confirms (messages count exceeds pre-send count)
  useEffect(() => {
    if (sentQueue.length === 0) return
    const pendingEntries = sentQueue.filter(e => e.status === 'sending')
    if (pendingEntries.length === 0) return
    // Server has our message when message count exceeds what we had at send time
    if (messages.length > preSendCountRef.current) {
      setSentQueue(prev => prev.map(e => e.status === 'sending' ? { ...e, status: 'queued' as const } : e))
      // Fallback: auto-remove after 8s if streaming never clears it
      setTimeout(() => setSentQueue(prev => prev.filter(e => e.status !== 'queued')), 8000)
    }
  }, [messages])

  const extractVideoFrame = (objectUrl: string): Promise<string> =>
    new Promise((resolve) => {
      const video = document.createElement('video')
      video.src = objectUrl
      video.muted = true
      video.playsInline = true
      video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(1.5, video.duration * 0.1) })
      video.addEventListener('seeked', () => {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, 1280 / (video.videoWidth || 1280))
        canvas.width = Math.round((video.videoWidth || 1280) * scale)
        canvas.height = Math.round((video.videoHeight || 720) * scale)
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }, { once: true })
      video.addEventListener('error', () => resolve(''))
      video.load()
    })

  const handleAttachFile = (file: File) => {
    const isImage = file.type.startsWith('image/')
    const isPdf = file.type === 'application/pdf'
    const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(file.name)
    if (!isImage && !isPdf && !isVideo) return
    const key = Date.now() + Math.random()
    const reader = new FileReader()
    reader.onload = async (e) => {
      const rawDataUrl = e.target?.result as string
      if (isVideo) {
        const objectUrl = URL.createObjectURL(file)
        const frameDataUrl = await extractVideoFrame(objectUrl)
        setPendingFiles(prev => [...prev, { dataUrl: frameDataUrl, mimeType: 'image/jpeg', name: file.name, kind: 'video', saveToWorkspace: false, videoObjectUrl: objectUrl, _key: key }])
        return
      }
      if (isImage) {
        // Compress before storing — iPhone photos are 5-8MB raw, need to be <200KB
        const { dataUrl, mimeType } = await compressImage(rawDataUrl, file.type)
        setPendingFiles(prev => [...prev, { dataUrl, mimeType, name: file.name, kind: 'image', saveToWorkspace: false, _key: key }])
      } else {
        // Show immediately, extract text in background
        setPendingFiles(prev => [...prev, { dataUrl: rawDataUrl, mimeType: file.type, name: file.name, kind: 'document', saveToWorkspace: false, extracting: true, _key: key }])
        try {
          const b64 = rawDataUrl.split(',')[1]
          const token = null
          const r = await fetch(`${API}/api/extract-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', credentials: 'include' },
            body: JSON.stringify({ data: b64 }),
          })
          const json = await r.json()
          setPendingFiles(prev => prev.map(f => f._key === key ? { ...f, extractedText: json.text || '', pages: json.pages, extracting: false } : f))
        } catch {
          setPendingFiles(prev => prev.map(f => f._key === key ? { ...f, extractedText: '', extracting: false } : f))
        }
      }
    }
    reader.readAsDataURL(file)
  }

  const handleSend = async (overrideMsg?: string) => {
    const effectiveInput = overrideMsg ?? input
    if (!effectiveInput.trim() && pendingFiles.length === 0) return
    if (pendingFiles.some(f => f.extracting)) return // wait for PDF extraction
    // If model is busy and this is a user-initiated send, queue it
    if (sendingRef.current && !overrideMsg) {
      setQueuedMessage(effectiveInput.trim())
      queuedMessageRef.current = effectiveInput.trim()
      setInput('')
      return
    }
    let msg = effectiveInput.trim()

    // Save to workspace if toggled for any file
    for (const pf of pendingFiles.filter(f => f.saveToWorkspace)) {
      try {
        const token = null
        const res = await fetch(`${API}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', credentials: 'include' },
          body: JSON.stringify({ filename: pf.name, data: pf.dataUrl.split(',')[1] }),
        })
        const json = await res.json()
        if (json.ok) msg = (msg ? msg + '\n\n' : '') + `[Saved to workspace: ${json.path}]`
      } catch (e) {
        console.error('[octis-mobile] upload failed:', e)
      }
    }

    // Fire project-context injection on first send (lazy)
    const pendingInit = consumePendingProjectInit(session.key)
    if (pendingInit) {
      Promise.resolve(null).then((token: string | null) => {
        fetch(`${API}/api/session-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', credentials: 'include' },
          body: JSON.stringify({ sessionKey: session.key, projectSlug: pendingInit }),
        }).catch(() => {})
      })
    }
    // PDFs: inject extracted text inline (gateway strips non-image attachments)
    for (const pf of pendingFiles.filter(f => f.kind === 'document' && f.extractedText !== undefined)) {
      const pdfBlock = `📄 **PDF: ${pf.name}**${pf.pages ? ` (${pf.pages} page${pf.pages > 1 ? 's' : ''})` : ''}\n\n${pf.extractedText}`
      msg = msg ? `${pdfBlock}\n\n${msg}` : pdfBlock
    }
    // Videos: prepend note
    for (const pf of pendingFiles.filter(f => f.kind === 'video')) {
      msg = msg ? `🎬 Video: ${pf.name}\n\n${msg}` : `🎬 Video: ${pf.name}`
    }

    const idempotencyKey = `octis-mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Images + videos (frame) go via attachments; PDFs are inlined above
    const imageFiles = pendingFiles.filter(f => f.kind === 'image' || f.kind === 'video')
    const attachments = imageFiles.length > 0
      ? imageFiles.map(f => ({ type: 'image', mimeType: f.mimeType, content: f.dataUrl.split(',')[1] }))
      : undefined
    const optimisticContent = pendingFiles.length > 0
      ? [
          ...pendingFiles.map(f =>
            (f.kind === 'image' || f.kind === 'video')
              ? { type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.dataUrl.split(',')[1] } }
              : { type: 'text', text: `📄 ${f.name}${f.extractedText !== undefined ? ` (✓ extracted)` : ''}` }
          ),
          ...(msg ? [{ type: 'text', text: msg }] : []),
        ]
      : msg
    send({
      type: 'req',
      id: `chat-send-${Date.now()}`,
      method: 'chat.send',
      params: { sessionKey: session.key, message: msg, attachments, deliver: false, idempotencyKey },
    })
    userScrolledUpRef.current = false
    setPendingFiles([])
    const optimisticId = Date.now()
    const optimisticText = typeof optimisticContent === 'string' ? optimisticContent : ''
    setMessages((prev) => {
      // Race guard: poll may have already committed this message to state before
      // the optimistic append runs (React batches functional updates — prev reflects
      // the poll-updated state). Skip if real or optimistic already present.
      // Must handle both string content and block-array content (server returns either).
      if (optimisticText && prev.some(m => {
        if (m.role !== 'user') return false
        if (typeof m.content === 'string') return m.content.slice(0, 80) === optimisticText.slice(0, 80)
        if (Array.isArray(m.content)) {
          const textBlock = (m.content as Array<{type: string; text?: string}>).find(b => b.type === 'text')
          return (textBlock?.text || '').slice(0, 80) === optimisticText.slice(0, 80)
        }
        return false
      })) return prev
      return [...prev, { role: 'user', content: optimisticContent as string, id: optimisticId }]
    })
    setInput('')
    clearDraft(session.key)
    // Reset textarea height to 1 line after send
    if (inputRef.current) { inputRef.current.style.height = 'auto' }
    preSendCountRef.current = messages.length  // capture count before optimistic is added
    setSending(true)
    // Persist to localStorage so message survives a page refresh while model is working
    if (pendingFiles.length === 0 && msg) {
      localStorage.setItem(`octis-pending-${session.key}`, JSON.stringify({ text: msg, timestamp: Date.now() }))
    }
    // Add to sent queue for visual feedback
    const firstFileName = pendingFiles.length > 0 ? pendingFiles[0].name : ''
    setSentQueue(prev => [...prev, { id: optimisticId, text: (msg || firstFileName).slice(0, 60) + ((msg.length > 60) ? '\u2026' : ''), status: 'sending' }])
    // Safety timeout: if streaming events are missed (reconnect, iOS bg, etc.),
    // force-clear sendingRef so polls resume and the reply becomes visible.
    setTimeout(() => setSending(false), 15000)
    setTimeout(() => scrollToBottom(true), 50)
  }

  // Auto-flush queued message when model finishes
  useEffect(() => {
    if (!sending && queuedMessageRef.current) {
      const queued = queuedMessageRef.current
      setQueuedMessage(null)
      queuedMessageRef.current = null
      setTimeout(() => handleSend(queued), 300)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending])


  // Preserve strip scroll position across re-renders (iOS Safari resets scrollLeft on re-render)
  useLayoutEffect(() => {
    if (!stripRef.current) return
    if (session?.key !== prevSessionKeyRef.current) {
      prevSessionKeyRef.current = session?.key
      return
    }
    if (stripScrollLeft.current > 0) {
      stripRef.current.scrollLeft = stripScrollLeft.current
    }
  })

  // Auto-scroll strip to keep active pill in view when session changes
  useEffect(() => {
    if (!session?.key || !stripRef.current) return
    const pill = pillRefs.current[session.key]
    const strip = stripRef.current
    if (!pill) return
    const pillLeft = pill.offsetLeft
    const pillRight = pillLeft + pill.offsetWidth
    const visible = pillLeft >= strip.scrollLeft && pillRight <= strip.scrollLeft + strip.clientWidth
    if (!visible) {
      const target = pillLeft - strip.clientWidth / 2 + pill.offsetWidth / 2
      strip.scrollLeft = Math.max(0, target)
      stripScrollLeft.current = strip.scrollLeft
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
      .map(m => ({ role: m.role, content: extractText(m.content).slice(0, 300) }))
      .filter(m => m.content.trim().length > 0)
      .slice(0, 6)
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
    <div ref={outerRef} className="bg-[#181c24] flex flex-col overflow-hidden" style={{ position: 'fixed', top: 0, left: 0, right: 0 }}>
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
          <>
            <span
              className="text-sm font-semibold text-white truncate flex-1 select-none"
              onDoubleClick={startEditing}
              title="Double-tap to rename"
            >
              {label}
            </span>

          </>
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
          onClick={() => setShowArchiveSheet(true)}
          className="text-[#4b5563] hover:text-white transition-colors shrink-0 px-1 text-base leading-none"
          title="More options"
        >
          ⋯
        </button>
        {onNewSession && (
          <button
            onClick={onNewSession}
            className="text-[#4b5563] hover:text-[#a5b4fc] transition-colors shrink-0 px-1 text-xl leading-none"
            title="New session"
          >
            ＋
          </button>
        )}
      </div>

      {/* Quick action buttons */}
      <div className="flex gap-1.5 px-4 py-1.5 bg-[#0f1117] border-b border-[#1e2330] shrink-0">
        {([
          { icon: '💬', label: 'Brief', msg: "Give me a 3-sentence status update: (1) what you last did, (2) what you're working on now, (3) what's next. No fluff." },
          { icon: '🚪', label: 'Away', msg: "I'm stepping away for a while. Please do the following:\n1. Summarize what you're currently working on (1-2 sentences).\n2. List anything you're blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\n3. List everything you CAN do autonomously while I'm gone, in order.\n4. Estimate how long you can run without me.\nBe concise. I'll read this on my phone." },
          { icon: '💾', label: 'Save', msg: '💾 checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.' },
        ] as { icon: string; label: string; msg: string }[]).map(({ icon, label, msg }) => (
          <button
            key={label}
            onClick={() => {
              const idempotencyKey = `octis-quick-${Date.now()}-${Math.random().toString(36).slice(2)}`
              send({ type: 'req', id: `quick-${label}-${Date.now()}`, method: 'chat.send', params: { sessionKey: session.key, message: msg, idempotencyKey } })
              // Add optimistic user message so it appears immediately
              const optimisticId = Date.now()
              setMessages(prev => {
                if (prev.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.slice(0, 80) === msg.slice(0, 80))) return prev
                return [...prev, { role: 'user', content: msg, id: optimisticId }]
              })
              preSendCountRef.current = messages.length
              setSending(true)
              // Safety timeout — quick actions have no handleSend wrapper to set this
              setTimeout(() => setSending(false), 15000)
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
          style={{ scrollbarWidth: 'none', touchAction: 'pan-x', WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' } as React.CSSProperties}
          onScroll={(e) => { stripScrollLeft.current = (e.target as HTMLDivElement).scrollLeft }}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
        >
          {recentSessions.map((s) => {
            const lbl = (getLabel(s.key) || s.label || s.key).slice(0, 14)
            const isCurrent = s.key === session.key
            const st = getStatus(s)
            const dotColor =
              st === 'working' ? '#a855f7'
              : st === 'needs-you' ? '#3b82f6'
              : st === 'stuck' ? '#f59e0b'
              : st === 'active' ? '#22c55e'
              : '#6b7280'
            return (
              <button
                key={s.key}
                ref={el => { pillRefs.current[s.key] = el }}
                onClick={() => !isCurrent && onSwitch?.(s)}
                className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap transition-colors shrink-0 ${
                  isCurrent
                    ? 'bg-[#6366f1] text-white'
                    : 'bg-[#1e2330] text-[#9ca3af] active:bg-[#2a3142]'
                }`}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: isCurrent ? 'rgba(255,255,255,0.7)' : dotColor }}
                />
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
        className="h-full overflow-y-auto px-4 py-3 space-y-3 space-y-reverse flex flex-col-reverse" style={{ overflowAnchor: 'none' } as React.CSSProperties}
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0].clientX
          touchStartY.current = e.touches[0].clientY
          isDraggingRef.current = false
          if (scrollRef.current) scrollRef.current.style.transition = ''
        }}
        onTouchMove={(e) => {
          if (!recentSessions || !onSwitch) return
          const dx = e.touches[0].clientX - touchStartX.current
          const dy = e.touches[0].clientY - touchStartY.current
          if (!isDraggingRef.current && Math.abs(dx) < 10) return
          if (!isDraggingRef.current && Math.abs(dx) <= Math.abs(dy)) return
          isDraggingRef.current = true
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
            if (el) {
              el.style.transition = 'transform 220ms ease-out'
              el.style.transform = 'translateX(0)'
              setTimeout(() => { if (el) el.style.transition = '' }, 230)
            }
            isDraggingRef.current = false
            return
          }
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
          if (programmaticScrollRef.current) return
          const el = scrollRef.current
          if (!el) return
          // With flex-col-reverse, scrollTop=0 is the bottom. User scrolled up = scrollTop > 80
          userScrolledUpRef.current = el.scrollTop > 80
        }}
      >
        {/* Loading indicator when no messages and history not yet loaded */}
        {loadedKey !== session?.key && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-[#4b5563]">
            <div className="w-6 h-6 border-2 border-[#4b5563] border-t-[#6366f1] rounded-full animate-spin" />
            {!connected && <span className="text-xs">Reconnecting…</span>}
          </div>
        )}
        {/* Show messages from cache while loading (when loadedKey doesn't match yet) */}
        {(() => {
          const showMessages = (loadedKey === session?.key || (loadedKey === null && messages.length > 0))
            ? messages
            : []
          // Reverse so newest is first in DOM — flex-col-reverse makes it appear at visual bottom
          const filtered = showMessages.filter((msg) => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg)) && !(msg.role === 'assistant' && extractText(msg.content).trimStart().startsWith('📁 **')))
          return [...filtered].reverse().map((msg, i) => (
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
                {msg.MediaPaths && msg.MediaPaths.length > 0
                  ? msg.MediaPaths.map((p: string, i: number) => {
                      const filename = p.split('/').pop() || ''
                      const mime = (msg.MediaTypes?.[i] || msg.MediaType || '')
                      const src = `${API}/api/media/${encodeURIComponent(filename)}`
                      return mime.includes('pdf')
                        ? <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-2 bg-[#4f51c0] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
                            <span className="text-2xl">📄</span>
                            <span className="text-xs text-white truncate">{filename}</span>
                          </a>
                        : <img key={i} src={src} alt="attachment"
                            className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                            style={{ maxWidth: '100%', borderRadius: '8px' }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    })
                  : msg.MediaPath
                    ? (() => {
                        const filename = (msg.MediaPath as string).split('/').pop() || ''
                        const src = `${API}/api/media/${encodeURIComponent(filename)}`
                        return (msg.MediaType || '').includes('pdf')
                          ? <a href={src} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-2 bg-[#4f51c0] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
                              <span className="text-2xl">📄</span>
                              <span className="text-xs text-white truncate">{filename}</span>
                            </a>
                          : <img src={src} alt="attachment"
                              className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                              style={{ maxWidth: '100%', borderRadius: '8px' }}
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      })()
                    : null
                }
                {renderMessageContent(msg.content)}
                {(() => {
                  const ts = getMsgTs(msg)
                  const isInFlight = msg.role === 'user' && sentQueue.some(e => e.id === msg.id)
                  const msgKey = msg.id !== undefined ? msg.id : i
                  const isCopied = copiedMsgId === msgKey
                  return (
                    <div className={`text-[10px] mt-1 flex items-center gap-1 ${msg.role === 'user' ? 'justify-end' : 'justify-between'}`}>
                      <div className="flex items-center gap-1">
                        {isInFlight && (
                          <span className="text-[#a5b4fc] opacity-70">sending…</span>
                        )}
                        {ts > 0 && !isInFlight && (
                          <span className={msg.role === 'user' ? 'text-[#a5b4fc]' : 'text-[#4b5563]'}>{fmtMsgTs(ts)}</span>
                        )}
                      </div>
                      {msg.role === 'assistant' && (
                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation()
                            const text = extractText(msg.content)
                            navigator.clipboard.writeText(text).then(() => {
                              setCopiedMsgId(msgKey)
                              setTimeout(() => setCopiedMsgId(null), 1800)
                            }).catch(() => {
                              // Fallback for iOS WebKit clipboard restrictions
                              const ta = document.createElement('textarea')
                              ta.value = text
                              ta.style.position = 'fixed'
                              ta.style.opacity = '0'
                              document.body.appendChild(ta)
                              ta.focus()
                              ta.select()
                              document.execCommand('copy')
                              document.body.removeChild(ta)
                              setCopiedMsgId(msgKey)
                              setTimeout(() => setCopiedMsgId(null), 1800)
                            })
                          }}
                          className="text-[#6b7280] hover:text-[#9ca3af] active:text-[#6366f1] transition-colors px-2 py-1 -mr-1 rounded text-base leading-none"
                          title="Copy message"
                        >
                          {isCopied ? <span className="text-[11px] text-[#6366f1] font-medium">✓ Copied</span> : <span className="text-[15px]">⎘</span>}
                        </button>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          ))
        })()}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#1e2330] px-4 py-3 rounded-2xl rounded-bl-sm flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '200ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '400ms' }} />
            </div>
          </div>
        )}

      </div>
      </div>
      <div
        className="px-3 pt-2 pb-2 bg-[#181c24] border-t border-[#2a3142] shrink-0"
      >
        {/* Queued message indicator */}
        {queuedMessage && (
          <div className="px-1 pb-2 flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" style={{ animation: 'typingBounce 1.2s infinite' }} />
            <span className="text-xs text-amber-400 flex-1 truncate">Queued: {queuedMessage.slice(0, 50)}{queuedMessage.length > 50 ? '…' : ''}</span>
            <button onClick={() => { setQueuedMessage(null); queuedMessageRef.current = null }} className="text-xs text-[#6b7280] hover:text-white shrink-0">✕</button>
          </div>
        )}
        {/* Sent queue strip removed — status shown inline on the message bubble */}
        {/* Pending file preview */}
        {pendingFiles.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1 mb-2 px-1">
            {pendingFiles.map((file, idx) => (
              <div key={file._key ?? idx} className="relative shrink-0">
                {file.kind === 'image'
                  ? <img src={file.dataUrl} alt="preview" className="h-14 w-14 rounded-xl object-cover border border-[#6366f1]" />
                  : file.kind === 'video'
                  ? (
                    <div className="flex flex-col gap-1 max-w-[180px]">
                      <video src={file.videoObjectUrl} controls muted playsInline className="rounded-xl max-h-24 max-w-full border border-[#6366f1]" />
                      <span className="text-[10px] text-[#9ca3af] truncate">🎬 {file.name}</span>
                    </div>
                  )
                  : (
                    <div className="flex flex-col gap-0.5 bg-[#1e2330] rounded-xl px-2 py-1.5 max-w-[160px]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-base">📄</span>
                        <span className="text-xs text-white truncate flex-1">{file.name}</span>
                      </div>
                      {file.extracting && (
                        <span className="text-[10px] text-[#6b7280] animate-pulse">Extracting…</span>
                      )}
                      {!file.extracting && file.extractedText !== undefined && (
                        <span className="text-[10px] text-[#22c55e]">✓ {file.pages ? `${file.pages}p · ` : ''}{Math.round((file.extractedText?.length || 0) / 4)} tokens</span>
                      )}
                    </div>
                  )
                }
                <button
                  onClick={() => { if (file.videoObjectUrl) URL.revokeObjectURL(file.videoObjectUrl); setPendingFiles(prev => prev.filter((_, i) => i !== idx)) }}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-[9px] flex items-center justify-center"
                >✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,video/mp4,video/quicktime,video/webm,video/*"
            className="hidden"
            onChange={(e) => { Array.from(e.target.files || []).forEach(f => handleAttachFile(f)); e.target.value = '' }}
            multiple
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
            className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-2xl px-4 py-2 text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] resize-none leading-snug"
            placeholder="Message…"
            value={input}
            rows={1}
            style={{ maxHeight: '120px', overflowY: 'auto', fontSize: '16px', height: 'auto' }}
            onChange={(e) => {
              setInput(e.target.value)
              setDraft(session.key, e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={(!input.trim() && pendingFiles.length === 0) || pendingFiles.some(f => f.extracting === true)}
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
            {/* Noise toggle */}
            <button
              onClick={() => setNoiseHidden((v) => { const next = !v; try { localStorage.setItem('octis-noise-hidden', String(next)) } catch {} return next })}
              className="w-full flex items-center justify-between px-4 py-3.5 rounded-xl hover:bg-[#2a3142] transition-colors"
            >
              <span className="text-sm text-white">{noiseHidden ? 'Show tool calls' : 'Hide tool calls'}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${noiseHidden ? 'bg-[#1e2330] border-[#2a3142] text-[#6b7280]' : 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'}`}>
                {noiseHidden ? 'chat only' : '+ tools'}
              </span>
            </button>
            <div className="border-t border-[#2a3142] my-1" />
            <button
              onClick={() => {
                setShowArchiveSheet(false)
                // Send final save instruction (fire-and-forget, NO_REPLY expected)
                const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
                send({
                  type: 'req',
                  id: `chat-send-${Date.now()}`,
                  method: 'chat.send',
                  params: {
                    sessionKey: session.key,
                    message: '💾 Final save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.',
                    deliver: false,
                    idempotencyKey,
                  },
                })
                // Hide only (no gateway delete — sessions needed for productivity audits)
                onArchive?.()
              }}
              className="w-full text-left px-4 py-3.5 rounded-xl text-red-400 font-medium text-sm hover:bg-[#2a3142] transition-colors"
            >
              Save &amp; Archive
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
