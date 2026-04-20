import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore, useLabelStore, useDraftStore, useHiddenStore, Session } from '../store/gatewayStore'
import { authFetch } from '../lib/authFetch'

// ─── Session cost/health badge (for panel header) ─────────────────────────────
function SessionCostBadge({ sessionKey }: { sessionKey: string }) {
  const { sessions, sessionMeta } = useSessionStore()
  const { send, sendChat } = useGatewayStore()
  const [expanded, setExpanded] = useState(false)

  const session = sessions.find((s: Session) => s.key === sessionKey)
  const cost = session?.estimatedCostUsd
  if (cost == null || cost < 0.01) return null

  const exchangeCost = sessionMeta[sessionKey]?.lastExchangeCost ?? null
  if (exchangeCost == null) return null

  // Per-exchange cost: signals context overhead for the most recent completed message
  let icon = '🟢'
  let level = 'Light'
  let pillClass = 'bg-emerald-900/40 text-emerald-400 border-emerald-700/40'
  if (exchangeCost > 0.15) {
    icon = '🔴'; level = 'Heavy'; pillClass = 'bg-red-900/40 text-red-400 border-red-700/40'
  } else if (exchangeCost > 0.05) {
    icon = '🟡'; level = 'Growing'; pillClass = 'bg-amber-900/40 text-amber-400 border-amber-700/40'
  }

  const sendCompact = (e: React.MouseEvent) => {
    e.stopPropagation()
    void sendChat({ sessionKey, message: '/compact' })
    setExpanded(false)
  }

  return (
    <div className="relative shrink-0" onMouseEnter={() => setExpanded(true)} onMouseLeave={() => setExpanded(false)}>
      <div
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-mono cursor-default select-none ${pillClass}`}
        title={`Session cost: $${cost.toFixed(2)}`}
      >
        <span className="leading-none" style={{ fontSize: '10px' }}>{icon}</span>
        <span>${cost.toFixed(2)}</span>
      </div>
      {expanded && (
        <div className="absolute right-0 top-7 z-50 bg-[#1a1f2e] border border-[#2a3142] rounded-xl shadow-2xl p-3 min-w-[180px] text-xs">
          <div className="text-white font-semibold mb-1">Context overhead</div>
          <div className="text-[#e8eaf0] mb-0.5">
            Per message: <span className="font-mono" style={{ color: level === 'Heavy' ? '#ef4444' : level === 'Growing' ? '#f59e0b' : '#22c55e' }}>${exchangeCost.toFixed(3)}</span>
          </div>
          <div className="text-[10px] text-[#6b7280] mb-2">{level === 'Heavy' ? '🔴 Heavy - compact or start a new session' : level === 'Growing' ? '🟡 Growing - consider compacting soon' : '🟢 Light - context is healthy'}</div>
          {level !== 'Light' && (
            <button
              onClick={sendCompact}
              className="w-full bg-[#6366f1] hover:bg-[#818cf8] text-white rounded px-2 py-1 text-[10px] font-medium transition-colors"
            >Compact context</button>
          )}
        </div>
      )}
    </div>
  )
}

const API = (import.meta.env.VITE_API_URL as string) || ''

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id?: string | number
  role: 'user' | 'assistant' | 'system' | 'tool' | 'toolResult' | 'toolCall'
  content: MessageContent
  ts?: string
  created_at?: string
  timestamp?: string | number
  // Gateway stores images as separate fields when sent via chat.send with attachments
  MediaPath?: string
  MediaPaths?: string[]
  MediaType?: string
  MediaTypes?: string[]
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
  onFocus?: () => void
  renameRequested?: number
  isFocused?: boolean
  onDragStart?: (e: React.PointerEvent, label: string) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: () => void
  onDragEnd?: () => void
  isDragOver?: boolean
}

// ─── Markdown renderer ────────────────────────────────────────────────────────


function renderBase64Image(base64String: string, key: number): React.ReactNode {
  // Basic check for common image types. More robust parsing could be added if needed.
  const mimeMatch = base64String.match(/^data:(image\/(png|jpeg|gif|webp));base64,/)
  if (mimeMatch) {
    return <img key={key} src={base64String} alt="image" className="max-w-full rounded-lg my-1 max-h-64 object-contain" />
  }
  return null
}

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
          {preview}...
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

    // Check for base64 image on its own line
    const base64Image = renderBase64Image(line, i)
    if (base64Image) {
      elements.push(base64Image)
      i++
      continue
    }



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
  if (text.includes('Read HEARTBEAT.md') || text.trim().toLowerCase() === 'heartbeat') return true
  // Async exec completion notifications injected by OpenClaw - always hide
  if (text.trimStart().startsWith('System (untrusted):') || text.trimStart().startsWith('System:') ||
      text.includes('An async command you ran earlier has completed')) return true
  return false
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

function getMsgTs(msg: ChatMessage): number {
  const raw = msg.ts || msg.created_at || msg.timestamp
  if (!raw) return 0
  const ms = typeof raw === 'number' ? raw : new Date(raw).getTime()
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

export default function ChatPane({ sessionKey, paneIndex: _paneIndex, onClose, onFocus, isFocused, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, renameRequested }: ChatPaneProps) {
  const { send, sendChat, ws, connected, agentId } = useGatewayStore()
  const { setSessions, sessions, setLastRole, markStreaming: markSessionStreaming, incrementUnread, clearUnread, sessionMeta, consumePendingProjectPrefix, consumePendingProjectInit, setLastExchangeCost } = useSessionStore()
  const { setCard } = useProjectStore()
  const { setLabel: saveLabelLocal, getLabel } = useLabelStore()
  const { setDraft, getDraft, clearDraft } = useDraftStore()
  // Per-session message cache - show instantly on switch, refresh silently behind the scenes
  const messageCacheRef = useRef<Map<string, ChatMessage[]>>(new Map())
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const setMessagesAndCache = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]), key?: string) => {
    setMessages(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (key && next.length > 0) messageCacheRef.current.set(key, next)
      return next
    })
  }
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [input, setInput] = useState(() => (sessionKey ? getDraft(sessionKey) : ''))
  const [sessionCard, setSessionCard] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const [autoRenamed, setAutoRenamed] = useState(false)
  const [lastHeartbeat, setLastHeartbeat] = useState<{ ts: Date; ok: boolean } | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const [workingTool, setWorkingTool] = useState<string | null>(null)
  // Sent queue: tracks recent sends with status for user feedback
  type SentEntry = { id: number; text: string; status: 'sending' | 'queued' }
  const [sentQueue, setSentQueue] = useState<SentEntry[]>([])
  const confirmedOptimisticRef = useRef<number | null>(null) // tracks just-confirmed optimistic ID
  const lastSentRef = useRef<number>(0) // timestamp of last sent message
  const preSendCountRef = useRef<number>(0) // server message count at time of send
  const preSendCostRef = useRef<number>(0) // session cost at time of last send
  const pendingOptimisticIdRef = useRef<number | null>(null) // id of current optimistic message
  const loadedSessionRef = useRef<string | null>(null) // session key for which history is currently loaded
  const workingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null) // fallback: clear working after 90s
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Show thinking indicator if: local state says working, OR the global session store says this
  // session is streaming (e.g. driven from another pane or another surface like Slack)
  const globalStreaming = sessionKey ? (sessionMeta[sessionKey]?.isStreaming ?? false) : false
  // Defensive fallback: if isWorking/globalStreaming both cleared but messages still show user as last
  // message (reply hasn't rendered yet), keep indicator active. Closes the Zustand/React batching race
  // where setLastRole() zeroes isStreaming before setMessages() fires with the assistant reply.
  const lastVisibleMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const awaitingRender = !isWorking && !globalStreaming &&
    lastVisibleMsg?.role === 'user' &&
    lastSentRef.current > 0 &&
    (Date.now() - lastSentRef.current) < 120000
  const showWorking = isWorking || globalStreaming || awaitingRender
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try {
      return localStorage.getItem('octis-noise-hidden') !== 'false'
    } catch {
      return true
    }
  })
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  const toggleNoise = () =>
    setNoiseHidden((v) => {
      const next = !v
      try {
        localStorage.setItem('octis-noise-hidden', String(next))
      } catch {}
      return next
    })

  // Load chat history when session or ws changes
  // Clear unread count when this pane is active on a session
  useEffect(() => {
    if (sessionKey) clearUnread(sessionKey)
  }, [sessionKey, clearUnread])

  // Trigger a sessions.list refresh on mount so the cost badge populates immediately
  // (Sidebar polls every 30s - without this, a newly-opened pane can wait up to 30s)
  useEffect(() => {
    if (!sessionKey || !connected) return
    send({ type: 'req', id: `sessions-list-pane-${Date.now()}`, method: 'sessions.list', params: agentId ? { agentId } : {} })
  }, [sessionKey, connected, send])

  // Handle sent queue delivery confirmation outside of setMessages callbacks
  useEffect(() => {
    const confirmed = confirmedOptimisticRef.current
    if (confirmed === null) return
    confirmedOptimisticRef.current = null
    setSentQueue(prev => prev.map(e => e.id === confirmed ? { ...e, status: 'queued' as const } : e))
    // Fallback: remove after 8s if streaming never clears it
    const timer = setTimeout(() => setSentQueue(prev => prev.filter(e => e.id !== confirmed)), 8000)
    return () => clearTimeout(timer)
  }, [messages]) // runs after messages state settles

  // Keep message cache fresh as messages update (so future visits to this session are instant)
  useEffect(() => {
    if (sessionKey && messages.length > 0 && loadedKey === sessionKey) {
      messageCacheRef.current.set(sessionKey, messages)
    }
  }, [messages, sessionKey, loadedKey])

  // Clear sent queue as soon as agent starts streaming (message is being processed)
  useEffect(() => {
    if (globalStreaming) {
      setSentQueue(prev => prev.filter(e => e.status === 'sending'))
    }
  }, [globalStreaming])

  useEffect(() => {
    if (!sessionKey || !ws) return
    const isSameSession = loadedSessionRef.current === sessionKey
    loadedSessionRef.current = sessionKey
    // Only wipe messages when switching to a different session.
    // On ws reconnect (same session), keep old messages visible while history reloads silently.
    if (!isSameSession) {
      // Reset scroll state so new session always starts at the bottom
      userScrolledUpRef.current = false
      // Show cached messages instantly while fresh history loads in background
      const cached = messageCacheRef.current.get(sessionKey)
      if (cached && cached.length > 0) {
        setMessages(cached)
      } else {
        setMessages([])
      }
    }
    setLoadedKey(null)
    setSessionCard(null)
    if (!isSameSession) setAutoRenamed(false)
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
          // Poll is NO LONGER the primary clear signal — lifecycle:end handles that.
          // Poll only handles: cost tracking + fallback clear when no lifecycle events arrive.
          const lastPollMsg = msgs[msgs.length - 1]
          if (lastPollMsg?.role === 'assistant' && extractText(lastPollMsg.content).trim()) {
            const rawTs = (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).ts ||
                          (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).created_at ||
                          (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).timestamp
            const msgTs = rawTs ? new Date(rawTs as string | number).getTime() : 0
            // Only update cost tracking here — isWorking cleared by lifecycle:end
            if (sessionKey) {
              setLastRole(sessionKey, 'assistant')
              const currentCost = useSessionStore.getState().sessions.find((s: Session) => s.key === sessionKey)?.estimatedCostUsd
              if (currentCost != null && preSendCostRef.current > 0) {
                const exchangeCost = currentCost - preSendCostRef.current
                if (exchangeCost > 0) setLastExchangeCost(sessionKey, exchangeCost)
              }
            }
            // Fallback: if we've been waiting >90s with no lifecycle:end, clear it
            const waitedTooLong = lastSentRef.current > 0 && (Date.now() - lastSentRef.current) > 90 * 1000
            if (waitedTooLong) {
              setIsWorking(false)
              setWorkingTool(null)
            }
            // Also clear if this is a session opened without a recent send (history load)
            if (lastSentRef.current === 0 && msgTs > 0) {
              setIsWorking(false)
              setWorkingTool(null)
            }
          }
          setMessages((prev) => {
            if (msgs.length === 0) return prev
            const oid = pendingOptimisticIdRef.current
            // Search ALL of prev for the tracked optimistic
            const optimisticIdx = oid !== null ? prev.findIndex((m) => m.id === oid) : -1
            const isOptimistic = optimisticIdx >= 0
            if (isOptimistic) {
              // Check if server already has our message via content match.
              // This handles sessions at the history limit (100 msgs): msgs.length stays
              // constant even after the server stores our message, breaking the count check.
              const optimistic = prev[optimisticIdx]
              const optimisticText = extractText(optimistic.content).substring(0, 80).trim()
              const serverAlreadyHasMsg = !!optimisticText && msgs.some(
                m => m.role === 'user' && typeof m.id !== 'number' &&
                     extractText(m.content).substring(0, 80).trim() === optimisticText
              )
              // Keep optimistic until server has our message (count increased OR content found)
              if (!serverAlreadyHasMsg && msgs.length <= preSendCountRef.current) {
                return [...msgs, prev[optimisticIdx]] // server hasn't received our msg yet
              }
              // Server has our message - drop optimistic, signal delivery
              confirmedOptimisticRef.current = oid
              pendingOptimisticIdRef.current = null
              return msgs
            }
            // Check for orphaned optimistic messages (number IDs) whose tracking ref was
            // cleared prematurely (e.g. by a flush streaming event). Preserve them until
            // the server confirms receipt — avoids the "disappeared then came back later" bug.
            const orphans = prev.filter((m) => typeof m.id === 'number')
            if (orphans.length > 0) {
              const serverHasOrphans = orphans.every((o) => {
                const oText = extractText(o.content).substring(0, 80).trim()
                return !!oText && msgs.some(
                  (m) => m.role === 'user' && typeof m.id !== 'number' &&
                         extractText(m.content).substring(0, 80).trim() === oText
                )
              })
              if (!serverHasOrphans) {
                return [...msgs, ...orphans] // keep orphans visible until server confirms
              }
              return msgs // server confirmed all orphans — drop them cleanly
            }
            // Always apply server list - this is the authoritative source.
            // Skip only if count AND last ID both match (prevents skipping when duplicates
            // inflated prev.length beyond what the server returned).
            const lastNew = msgs[msgs.length - 1]
            const lastInPrev = prev[prev.length - 1]
            if (msgs.length === prev.length && lastNew?.id !== undefined && lastNew?.id !== null && lastNew.id === lastInPrev?.id) {
              return prev // same count + same last ID = nothing new, safe to skip
            }
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
              ts: new Date((lastHB.ts || lastHB.created_at || (lastHB as {timestamp?: string | number}).timestamp || Date.now()) as string | number),
              ok: true,
            })
          // Set/clear working based on last message after history load
          const lastMsg = msgs[msgs.length - 1]
          const lastMsgText = lastMsg ? extractText(lastMsg.content).trim() : ''
          if (lastMsg?.role === 'assistant' && lastMsgText && !isHeartbeatResponse(lastMsg.content)) {
            // Last message is a real assistant reply - done
            setIsWorking(false)
            setWorkingTool(null)
          } else if (lastMsg && (
            lastMsg.role === 'user' ||
            lastMsg.role === 'toolCall' ||
            lastMsg.role === 'tool' ||
            (lastMsg.role === 'assistant' && !lastMsgText) // assistant with no text = tool-only turn
          )) {
            // Only show thinking if the last message is recent (< 5 min)
            // Prevents stale sessions (ended with user msg hours ago) from showing thinking forever
            const rawTs = (lastMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).ts ||
                          (lastMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).created_at ||
                          (lastMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).timestamp
            const msgAge = rawTs ? Date.now() - new Date(rawTs as string | number).getTime() : Infinity
            if (msgAge < 5 * 60 * 1000) {
              setIsWorking(true)
              setWorkingTool(null)
              lastSentRef.current = Date.now()
            }
          }
          // Cache so next visit to this session is instant
          if (msgs.length > 0) messageCacheRef.current.set(sessionKey, msgs)
          setMessages((prev) => {
            if (msgs.length === 0) return prev
            const pendingOid = pendingOptimisticIdRef.current
            if (pendingOid !== null) {
              const optimisticMsg = prev.find(m => m.id === pendingOid)
              if (optimisticMsg) {
                const optimisticText = extractText(optimisticMsg.content).substring(0, 80).trim()
                const serverHasIt = !!optimisticText && msgs.some(
                  m => m.role === 'user' && typeof m.id !== 'number' &&
                       extractText(m.content).substring(0, 80).trim() === optimisticText
                )
                if (!serverHasIt) {
                  return [...msgs, optimisticMsg]
                }
                confirmedOptimisticRef.current = pendingOid
                pendingOptimisticIdRef.current = null
              }
            }
            return msgs
          })
          setLoadedKey(sessionKey)
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
          const payload = msg.payload as Record<string, unknown>
          const stream = payload.stream as string | undefined
          const evtState = payload.state as string | undefined

          // -- Lifecycle events: authoritative run start/end --
          if (stream === 'lifecycle') {
            const phase = (payload.data as Record<string, unknown>)?.phase as string | undefined
            if (phase === 'start') {
              setIsWorking(true)
              if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
              workingTimeoutRef.current = setTimeout(() => { setIsWorking(false); setWorkingTool(null) }, 90_000)
            } else if (phase === 'end' || phase === 'error') {
              setIsWorking(false)
              setWorkingTool(null)
              if (workingTimeoutRef.current) { clearTimeout(workingTimeoutRef.current); workingTimeoutRef.current = null }
            }
            return
          }

          // -- Tool events: keep indicator alive + show tool name --
          if (stream === 'tool') {
            const phase = (payload.data as Record<string, unknown>)?.phase as string | undefined
            const toolName = (payload.data as Record<string, unknown>)?.name as string | undefined
            if (phase === 'start') {
              setIsWorking(true)
              if (toolName) setWorkingTool(toolName)
              if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
              workingTimeoutRef.current = setTimeout(() => { setIsWorking(false); setWorkingTool(null) }, 90_000)
            }
            return
          }

          // -- Delta: streaming tokens --
          if (evtState === 'delta') {
            setIsWorking(true)
            return
          }

          const chatMsg = payload as unknown as ChatMessage & { sessionKey: string }
          if (chatMsg.role === 'assistant' && isHeartbeatResponse(chatMsg.content)) {
            setLastHeartbeat({ ts: new Date(), ok: true })
          }
          // Track working state from tool calls / assistant replies
          if (chatMsg.role === 'toolCall' || chatMsg.role === 'tool') {
            setIsWorking(true)
            if (Array.isArray(chatMsg.content)) {
              const tb = (chatMsg.content as ContentBlock[]).find(
                (b) => b.type === 'tool_use' || b.type === 'toolCall'
              )
              if (tb) setWorkingTool((tb as { name?: string }).name || 'tool')
            } else {
              setWorkingTool('tool')
            }
          } else if (chatMsg.role === 'assistant') {
            if (Array.isArray(chatMsg.content)) {
              const blocks = chatMsg.content as ContentBlock[]
              const hasToolCall = blocks.some((b) => b.type === 'tool_use' || b.type === 'toolCall')
              if (hasToolCall) {
                setIsWorking(true)
                const tb = blocks.find((b) => b.type === 'tool_use' || b.type === 'toolCall')
                setWorkingTool((tb as { name?: string })?.name || 'tool')
              }
            }
          }
          // Increment unread for new assistant replies - but only when this pane is NOT
          // the one the user is currently focused on (i.e., it's a background pane).
          // We detect this by checking if another pane is pinned to a LOWER index.
          if (chatMsg.role === 'assistant' && !isHeartbeatResponse(chatMsg.content)) {
            const { activePanes, paneCount } = useSessionStore.getState()
            const myPaneIndex = activePanes.findIndex(k => k === sessionKey)
            const isBackgroundPane = myPaneIndex > 0 && activePanes.slice(0, myPaneIndex).some(k => k !== null)
            if (isBackgroundPane && extractText(chatMsg.content).trim()) {
              incrementUnread(sessionKey)
            }
          }

          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === chatMsg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: chatMsg.content }
              return next
            }
            if (chatMsg.role === 'user') {
              // Replace the specific pending optimistic if it exists.
              // Guard: only replace when the echo has real content — empty/flush echoes
              // would blank the optimistic and cause a visible "disappear then reappear" flicker.
              const hasContent = !!extractText(chatMsg.content).trim()
              if (hasContent) {
                const oid = pendingOptimisticIdRef.current
                if (oid !== null) {
                  const optimisticIdx = prev.findIndex((m) => m.id === oid)
                  if (optimisticIdx >= 0) {
                    const next = [...prev]
                    next[optimisticIdx] = chatMsg
                    pendingOptimisticIdRef.current = null
                    return next
                  }
                }
              }
              // No pending optimistic or empty echo - poll handles confirmation
              return prev
            }
            // New messages from streaming events are intentionally NOT appended here.
            // The poll (1s) is the single source of truth for new messages.
            // Appending from both streaming and poll creates duplicates when IDs differ
            // (e.g. one event has id='abc', another has id=undefined for the same message).
            return prev
          })
          if (chatMsg.role === 'assistant') {
            const text = extractText(chatMsg.content)
            if (text.includes('📋')) setCard(sessionKey, text.slice(0, 500))
          }
        }

        // Flat chat event (older gateway versions)
        // Only process if both id and role are explicitly present - avoids appending
        // user messages as 'assistant' when role is undefined
        if (msg.type === 'chat' && msg.sessionKey === sessionKey && msg.id_msg && msg.role) {
          const flatMsg: ChatMessage = {
            role: msg.role as ChatMessage['role'],
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
            // User messages: replace pending optimistic if exists, otherwise skip (poll handles it)
            if (flatMsg.role === 'user') {
              const oid = pendingOptimisticIdRef.current
              if (oid !== null) {
                const optimisticIdx = prev.findIndex((m) => m.id === oid)
                if (optimisticIdx >= 0) {
                  const next = [...prev]
                  next[optimisticIdx] = flatMsg
                  pendingOptimisticIdRef.current = null
                  return next
                }
              }
              return prev // no pending optimistic - poll handles it
            }
            // Non-user messages: poll is authoritative, don't append from flat events
            return prev
          })
        }
      } catch {}
    }

    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [sessionKey, ws, send, setCard])

  // Polling fallback — two-tier: fast only while waiting for reply, slow otherwise.
  // Was 2s unconditional per pane: 3 open panes = 90 WS requests/min.
  // Idle: 10s, small payload. Active (isWorking/awaitingRender): 2s, larger payload.
  useEffect(() => {
    if (!sessionKey || !ws || !connected) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (isWorking || awaitingRender) return // fast-poll handles this
      const pollId = `chat-poll-${sessionKey}-${Date.now()}`
      send({ type: 'req', id: pollId, method: 'chat.history', params: { sessionKey, limit: 30 } })
    }, 10000)
    return () => clearInterval(interval)
  }, [sessionKey, ws, connected, send, isWorking, awaitingRender])

  // Fast poll (2s) — only while actively waiting for a reply.
  useEffect(() => {
    if (!sessionKey || !ws || !connected) return
    if (!isWorking && !awaitingRender) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const pollId = `chat-poll-${sessionKey}-${Date.now()}`
      send({ type: 'req', id: pollId, method: 'chat.history', params: { sessionKey, limit: 100 } })
    }, 2000)
    return () => clearInterval(interval)
  }, [sessionKey, ws, connected, send, isWorking, awaitingRender])

  // Auto-rename: derive name from first user message
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const autoRename = useCallback(() => {
    if (autoRenamed || !sessionKey || messages.length === 0) return
    const firstUser = messages.find((m) => m.role === 'user')
    const firstAssistant = messages.find((m) => m.role === 'assistant')
    if (!firstUser || !firstAssistant) return
    // If a persisted label exists in the store, never auto-overwrite it
    const persistedLabel = getLabel(sessionKey)
    if (persistedLabel) return
    const session = sessionsRef.current.find((s: Session) => s.key === sessionKey)
    const currentLabel = session?.label || ''
    if (currentLabel && !currentLabel.startsWith('session-') && currentLabel !== sessionKey)
      return
    // Use AI autoname instead of raw-slice to get meaningful labels
    setAutoRenamed(true)
    const slim = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: extractText(m.content).slice(0, 300) }))
      .filter((m) => m.content.trim().length > 0)
      .slice(0, 6)
    void fetch(`${API}/api/session-autoname`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: slim }),
    }).then((r) => r.json()).then((data: { label?: string }) => {
      const label = data.label
      if (!label) return
      send({
        type: 'req',
        id: `sessions-patch-${Date.now()}`,
        method: 'sessions.patch',
        params: { key: sessionKey, label },
      })
      setSessions(
        sessionsRef.current.map((s: Session) =>
          s.key === sessionKey ? { ...s, label } : s
        )
      )
      saveLabelLocal(sessionKey, label)
      void authFetch(`${API}/api/session-rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey, label }),
      })
    }).catch(() => { /* silently fail - label stays as session key */ })
  }, [autoRenamed, sessionKey, messages, send, setSessions])

  useEffect(() => {
    autoRename()
  }, [autoRename])

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Extract actual message content from OpenClaw webchat metadata envelope
  function stripBootstrapNoise(text: string): string {
    // Strip OpenClaw bootstrap truncation warnings injected into user messages
    const idx = text.indexOf('[Bootstrap truncation warning]')
    if (idx !== -1) return text.slice(0, idx).trimEnd()
    return text
  }

  function extractEnvelopeContent(text: string): MessageContent | null {
    if (!text.includes('Sender (untrusted metadata):')) return null
    // Match content after the [Day YYYY-MM-DD HH:MM UTC] timestamp
    const match = text.match(/\[\w+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\]\s*([\s\S]*)$/)
    if (!match) return null
    const raw = stripBootstrapNoise(match[1].trim())
    if (!raw) return null
    // Try to parse as JSON array (image+text blocks)
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) return parsed as ContentBlock[]
      } catch {}
    }
    return raw
  }

  // Try to parse content that looks like a JSON content-block array (or single object).
  // Returns the parsed blocks, or null if it doesn't look like one / fails to parse.
  function tryParseBlocks(raw: string): ContentBlock[] | null {
    const trimmed = raw.trimStart()
    // Try as JSON array
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && 'type' in parsed[0]) {
          return parsed as ContentBlock[]
        }
      } catch {}
    }
    // Try as a single JSON object (server may return unwrapped object)
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          return [parsed] as ContentBlock[]
        }
      } catch {}
    }
    return null
  }

  // Render an image block - handles both Anthropic format and OpenClaw native format
  function renderImageBlock(b: ContentBlock | Record<string, unknown>, key: number): React.ReactNode {
    const block = b as Record<string, unknown>
    // Anthropic format: {type:'image', source:{type:'base64', media_type:..., data:...}}
    const src = block.source as { type?: string; data?: string; media_type?: string; url?: string } | undefined
    // OpenClaw native format: {type:'image', data:..., mimeType:...}
    const directData = block.data as string | undefined
    const directMime = (block.mimeType || block.media_type) as string | undefined
    let imgSrc = ''
    if (src?.type === 'base64' && src.data) {
      imgSrc = `data:${src.media_type || 'image/png'};base64,${src.data}`
    } else if (src?.url) {
      imgSrc = src.url
    } else if (directData) {
      imgSrc = `data:${directMime || 'image/png'};base64,${directData}`
    }
    return imgSrc
      ? <img key={key} src={imgSrc} alt="image" className="max-w-full rounded-lg my-1 max-h-64 object-contain" />
      : <span key={key} className="text-[#6b7280] text-xs italic">[Image]</span>
  }

  const API = (window as {VITE_API_URL?: string}).VITE_API_URL ||
    (import.meta as {env?: {VITE_API_URL?: string}}).env?.VITE_API_URL || ''

  // Render text block - detects [media attached: /path...] or [Saved to workspace: /path] and renders inline
  function renderTextWithMedia(text: string, key: number): React.ReactNode {
    // Match [Saved to workspace: /path] - files uploaded via the 💾 toggle
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
                className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs hover:bg-[#3a4152] transition-colors no-underline">
                <span className="text-2xl">📄</span>
                <span className="text-xs text-white truncate">{filename}</span>
                <span className="text-[10px] text-[#6b7280] ml-auto shrink-0">↗️</span>
              </a>
            : isImage
            ? <img src={mediaSrc} alt={filename} className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display='none' }} />
            : <a href={mediaSrc} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs hover:bg-[#3a4152] transition-colors no-underline">
                <span className="text-2xl">📎</span>
                <span className="text-xs text-white truncate">{filename}</span>
              </a>
          }
          {afterMeta && <ChatMarkdown text={afterMeta} />}
        </span>
      )
    }
    // Match: [media attached: /root/.openclaw/media/inbound/FILENAME.EXT (mime/type) | ...]
    const mediaMatch = text.match(/\[media attached:\s*([^\s)]+)\s+\(([^)]+)\)/)
    if (mediaMatch) {
      const filePath = mediaMatch[1]
      const mimeType = mediaMatch[2] || ''
      const filename = filePath.split('/').pop() || ''
      const mediaSrc = `${API}/api/media/${encodeURIComponent(filename)}`
      // Strip metadata lines so only actual user text remains
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
                className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs hover:bg-[#3a4152] transition-colors no-underline">
                <span className="text-2xl">📄</span>
                <span className="text-xs text-white truncate">{filename}</span>
                <span className="text-[10px] text-[#6b7280] ml-auto shrink-0">↗️</span>
              </a>
            )
            : (
              <img src={mediaSrc} alt="image" className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display='none' }} />
            )
          }
          {afterMeta && <ChatMarkdown text={afterMeta} />}
        </span>
      )
    }
    return <ChatMarkdown key={key} text={text} />
  }

  function renderContent(content: MessageContent) {
    // Parse JSON strings that may represent array content (e.g. image+text blocks sent via chat.send)
    if (typeof content === 'string') {
      const blocks = tryParseBlocks(content)
      if (blocks) content = blocks
    }
    // Extract from OpenClaw metadata envelope stored in text blocks
    if (Array.isArray(content) && content.length === 1) {
      const b = content[0] as ContentBlock
      if (b.type === 'text') {
        const extracted = extractEnvelopeContent((b as {type:'text';text:string}).text)
        if (extracted !== null) {
          if (typeof extracted === 'string') {
            // Could be a JSON content-block string embedded in envelope
            const blocks = tryParseBlocks(extracted)
            content = blocks ?? extracted
          } else {
            content = extracted
          }
        }
      }
    } else if (typeof content === 'string') {
      const extracted = extractEnvelopeContent(content)
      if (extracted !== null) {
        if (typeof extracted === 'string') {
          const blocks = tryParseBlocks(extracted)
          content = blocks ?? extracted
        } else {
          content = extracted
        }
      }
    }
    // Handle array content with possible image blocks
    if (Array.isArray(content)) {
      const blocks = content as ContentBlock[]
      return (
        <>
          {blocks.map((b, i) => {
            if (b.type === 'image') {
              return renderImageBlock(b, i)
            }
            if (b.type === 'document') {
              const block = b as Record<string, unknown>
              const name = (block.name as string) || 'document.pdf'
              return (
                <div key={i} className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs">
                  <span className="text-2xl">📄</span>
                  <span className="text-xs text-white truncate">{name}</span>
                </div>
              )
            }
            if (b.type === 'text') {
              const rawText = (b as { type: 'text'; text: string }).text
              return rawText?.trim() ? renderTextWithMedia(rawText, i) : null
            }
            return null
          })}
        </>
      )
    }
    // Last-chance: if content is a plain object with a 'type' field, treat as single block
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      const obj = content as Record<string, unknown>
      if (obj.type === 'image') return renderImageBlock(obj as ContentBlock, 0)
      if (obj.type === 'text' && typeof obj.text === 'string') return <ChatMarkdown text={obj.text} />
    }
    const text = extractText(content)
    if (!text) return null

    // If the text is a standalone base64 image string, render it
    const tryRenderBase64 = renderBase64Image(text.trim(), 0)
    if (tryRenderBase64) return tryRenderBase64

    // Never render raw JSON content-block arrays or metadata envelopes
    const trimmed = stripBootstrapNoise(text.trim())
    // Detect document/image blocks regardless of envelope wrapping
    const hasDocumentBlock = trimmed.includes('"type":"document"') || trimmed.includes('"type": "document"')
    const hasImageBlock = trimmed.includes('"type":"image"') || trimmed.includes('"type": "image"')
    const hasTimestampEnvelope = /^\[\w+\s+\d{4}-\d{2}-\d{2}/.test(trimmed)
    if (
      trimmed.startsWith('[{') ||                                // JSON array of objects
      trimmed.startsWith('{"type"') ||                          // bare JSON object with type
      trimmed.startsWith('{ "type"') ||
      (trimmed.startsWith('[') && trimmed.includes('"source"')) || // image/doc block in array
      hasImageBlock || hasDocumentBlock ||                       // any block type anywhere
      hasTimestampEnvelope ||                                    // timestamp envelope we couldn't strip
      trimmed.startsWith('Sender (untrusted metadata):')
    ) {
      // Try to show a meaningful label instead of raw JSON
      if (hasDocumentBlock) {
        return <div className="flex items-center gap-2 bg-[#2a3142] rounded-lg px-3 py-2 my-1 max-w-xs"><span className="text-2xl">📄</span><span className="text-xs text-[#6b7280]">PDF attachment</span></div>
      }
      if (hasImageBlock) {
        return <span className="text-[#6b7280] text-xs italic">[Image attachment]</span>
      }
      return <span className="text-[#6b7280] text-xs italic">[Attachment]</span>
    }
    return renderTextWithMedia(text, 0)
  }

  const handleSend = async () => {
    if ((!input.trim() && pendingFiles.length === 0) || !sessionKey) return
    if (pendingFiles.some(f => f.extracting)) return // wait for PDF extraction to finish
    // Fire project-context injection on first send (lazy - skips sessions that get archived without messaging)
    const pendingInit = consumePendingProjectInit(sessionKey)
    if (pendingInit) {
      Promise.resolve(null).then((token: string | null) => {
        authFetch(`${API}/api/session-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey, projectSlug: pendingInit }),
        }).catch(() => {})
      })
    }
    const pendingPrefix = consumePendingProjectPrefix(sessionKey)
    let msg = pendingPrefix && input.trim()
      ? `${pendingPrefix}\n\n${input.trim()}`
      : pendingPrefix || input.trim()

    // If saveToWorkspace is enabled for any file, upload and append paths
    for (const pf of pendingFiles.filter(f => f.saveToWorkspace)) {
      try {
        const token = null
        const res = await authFetch(`${API}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: pf.name, data: pf.dataUrl.split(',')[1] }),
        })
        const json = await res.json()
        if (json.ok) {
          msg = (msg ? msg + '\n\n' : '') + `[Saved to workspace: ${json.path}]`
        }
      } catch (e) {
        console.error('[octis] upload failed:', e)
      }
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
    const idempotencyKey = `octis-send-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reqId = `chat-send-${Date.now()}`
    // Images + video frames go via gateway attachments; PDFs are already inlined above
    const imageFiles = pendingFiles.filter(f => f.kind === 'image' || f.kind === 'video')
    const attachments = imageFiles.length > 0
      ? imageFiles.map(f => ({ type: 'image', mimeType: f.mimeType, content: f.dataUrl.split(',')[1] }))
      : undefined
    // sendChat: WS-first, HTTP fallback if WS is dead/zombie
    void sendChat({ sessionKey, message: msg, idempotencyKey, deliver: false })
    // Use structured content for optimistic message so files render immediately
    const optimisticContent: MessageContent = pendingFiles.length > 0
      ? [
          ...pendingFiles.map(f =>
            (f.kind === 'image' || f.kind === 'video')
              ? { type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.dataUrl.split(',')[1] } } as ContentBlock
              : { type: 'document', source: { type: 'base64', media_type: f.mimeType, data: f.dataUrl.split(',')[1] }, name: f.name } as ContentBlock
          ),
          ...(msg ? [{ type: 'text', text: msg }] : []),
        ]
      : msg
    const optimisticId = Date.now()
    pendingOptimisticIdRef.current = optimisticId
    setMessages((prev) => [...prev, { role: 'user', content: optimisticContent, id: optimisticId }])
    setLastRole(sessionKey, 'user')
    setIsWorking(true)
    setWorkingTool(null)
    lastSentRef.current = Date.now()
    preSendCountRef.current = messages.filter(m => typeof m.id !== 'number').length
    preSendCostRef.current = sessions.find((s: Session) => s.key === sessionKey)?.estimatedCostUsd || 0
    // Fallback: clear working indicator after 90s in case timestamps are missing
    if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
    workingTimeoutRef.current = setTimeout(() => { setIsWorking(false); setWorkingTool(null) }, 90000)
    // Add to sent queue for user feedback
    const queueEntry: SentEntry = { id: optimisticId, text: msg.slice(0, 60) + (msg.length > 60 ? '...' : ''), status: 'sending' }
    setSentQueue(prev => [...prev.slice(-4), queueEntry]) // keep last 5
    // Tell sidebar this session is now working
    if (sessionKey) markSessionStreaming(sessionKey)
    setInput('')
    if (sessionKey) clearDraft(sessionKey)
    setPendingFiles([])
    userScrolledUpRef.current = false // snap back to bottom on send
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

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

  const [autoNaming, setAutoNaming] = useState(false)
  const [labelEditing, setLabelEditing] = useState(false)
  const [labelValue, setLabelValue] = useState('')

  // Compute display name early (needed before early returns so hooks can reference it)
  const displayName = (() => {
    if (!sessionKey) return ''
    const stored = getLabel(sessionKey)
    const s = sessions.find((s: Session) => s.key === sessionKey)
    const label = stored || s?.label || sessionKey
    return label.length > 40 ? label.slice(0, 40) + '...' : label
  })()

  // Handle external rename request via R hotkey → triggers AI auto-rename
  useEffect(() => {
    if (!renameRequested) return
    void handleAutoRename()
  }, [renameRequested])
  type PendingFile = { dataUrl: string; mimeType: string; name: string; kind: 'image' | 'document' | 'video'; saveToWorkspace: boolean; extractedText?: string; extracting?: boolean; pages?: number; videoObjectUrl?: string; _key?: number }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    if (isVideo) {
      const objectUrl = URL.createObjectURL(file)
      extractVideoFrame(objectUrl).then(frameDataUrl => {
        setPendingFiles(prev => [...prev, { dataUrl: frameDataUrl, mimeType: 'image/jpeg', name: file.name, kind: 'video', saveToWorkspace: false, videoObjectUrl: objectUrl, _key: key }])
      })
      return
    }
    const reader = new FileReader()
    reader.onload = async (e) => {
      const dataUrl = e.target?.result as string
      if (isPdf) {
        // Show preview immediately, extract in background
        setPendingFiles(prev => [...prev, { dataUrl, mimeType: file.type, name: file.name, kind: 'document', saveToWorkspace: false, extracting: true, _key: key }])
        try {
          const b64 = dataUrl.split(',')[1]
          const r = await authFetch(`${API}/api/extract-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: b64 }),
          })
          const json = await r.json()
          setPendingFiles(prev => prev.map(f => f._key === key ? { ...f, extractedText: json.text || '', pages: json.pages, extracting: false } : f))
        } catch {
          setPendingFiles(prev => prev.map(f => f._key === key ? { ...f, extractedText: '', extracting: false } : f))
        }
      } else {
        setPendingFiles(prev => [...prev, { dataUrl, mimeType: file.type, name: file.name, kind: 'image', saveToWorkspace: false, _key: key }])
      }
    }
    reader.readAsDataURL(file)
  }

  // Helper to get auth header for API calls
  const getAuthHeader = async (): Promise<Record<string, string>> => {
    try {
      // @ts-ignore
      const token = null
      return {}
    } catch { return {} }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
    if (items.length > 0) {
      e.preventDefault()
      items.forEach(item => {
        const file = item.getAsFile()
        if (file) handleAttachFile(file)
      })
    }
  }

  const handleLabelRename = (value: string) => {
    const trimmed = value.trim()
    setLabelEditing(false)
    if (!trimmed || !sessionKey) return
    saveLabelLocal(sessionKey, trimmed)
    send({
      type: 'req',
      id: `sessions-patch-${Date.now()}`,
      method: 'sessions.patch',
      params: { key: sessionKey, label: trimmed },
    })
    void authFetch(`${API}/api/session-rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, label: trimmed }),
    })
  }

  const handleAutoRename = async () => {
    if (!sessionKey || messages.length === 0 || autoNaming) return
    setAutoNaming(true)
    try {
      // Send only first 8 messages, text-only, trimmed - avoid payload limit
      const slim = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: extractText(m.content).slice(0, 400) }))
        .filter((m) => m.content.trim().length > 0)
        .slice(0, 8)
      const res = await fetch(`${API}/api/session-autoname`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: slim }),
      })
      const data = await res.json() as { label?: string; error?: string }
      const label = data.label
      if (!label) return
      send({
        type: 'req',
        id: `sessions-patch-${Date.now()}`,
        method: 'sessions.patch',
        params: { key: sessionKey, label },
      })
      setSessions(sessions.map((s: Session) => s.key === sessionKey ? { ...s, label } : s))
      saveLabelLocal(sessionKey, label)
      void authFetch(`${API}/api/session-rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey, label }),
      })
    } catch (e) {
      console.error('[autoname]', e)
    } finally {
      setAutoNaming(false)
    }
  }

  // Helper: send a quick-action message without adding an optimistic to the local state.
  // The poll will surface the message naturally. The thinking indicator confirms it was sent.
  const sendQuickAction = (msg: string, prefix: string) => {
    if (!sessionKey) return
    sendChat({ sessionKey, message: msg, deliver: false, idempotencyKey: `octis-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    const ok = true // sendChat handles WS + HTTP fallback
    if (ok) {
      setIsWorking(true)
      setWorkingTool(null)
      setLastRole(sessionKey, 'user')
      lastSentRef.current = Date.now()
      preSendCountRef.current = messages.filter(m => typeof m.id !== 'number').length
      preSendCostRef.current = sessions.find((s: Session) => s.key === sessionKey)?.estimatedCostUsd || 0
      if (sessionKey) markSessionStreaming(sessionKey)
      if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
      workingTimeoutRef.current = setTimeout(() => { setIsWorking(false); setWorkingTool(null) }, 90000)
    }
  }

  const handleBriefMe    = () => sendQuickAction('Give me a 3-sentence status update: (1) what you last did, (2) what you\'re working on now, (3) what\'s next. No fluff.', 'brief')
  const handlePause      = () => sendQuickAction('Pause. Summarize the current state in 3-5 bullet points so we can resume cleanly later: what was decided, what\'s in progress, what\'s next, any blockers. Then stop and wait for me.', 'pause')
  const handleContinue   = () => sendQuickAction('Continue from where we left off. Review the last state summary and resume the next action.', 'continue')
  const handleSave       = () => sendQuickAction('💾 checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.', 'save')
  const handleSteppingAway = () => sendQuickAction(
    "I'm stepping away for a while. Please do the following:\n" +
    "1. Summarize what you're currently working on (1-2 sentences).\n" +
    "2. List anything you're blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\n" +
    "3. List everything you CAN do autonomously while I'm gone, in order.\n" +
    "4. Estimate how long you can run without me.\n" +
    "Be concise. I'll read this on my phone.", 'away'
  )

  const handleArchive = () => {
    if (!sessionKey) return
    if (confirm('Save and archive this session?')) {
      // Send save instruction to agent (fire-and-forget - NO_REPLY expected)
      const msg =
        '💾 Final save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.'
      const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
      sendChat({ sessionKey, message: msg, deliver: false, idempotencyKey })
      // Hide only — no gateway delete (sessions needed for productivity audits)
      // Permanently hide from sidebar so gateway sessions.list can't re-surface it
      useHiddenStore.getState().hide(sessionKey)
      setSessions(sessions.filter((s: Session) => s.key !== sessionKey))
      onClose()
    }
  }

  if (!sessionKey) {
    const handleNewSession = () => {
      const key = `session-${Date.now()}`
      setSessions([{ key, label: 'New session', sessionKey: key }, ...sessions])
      const emptyPane = useSessionStore.getState().activePanes.findIndex((p, i) => i < useSessionStore.getState().paneCount && !p)
      useSessionStore.getState().pinToPane(emptyPane >= 0 ? emptyPane : _paneIndex, key)
    }
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0f1117] border-r border-[#2a3142]">
        <div className="text-center">
          <div className="text-4xl mb-3">🐙</div>
          <div className="text-[#6b7280] text-sm mb-4">No session open</div>
          <button
            onClick={handleNewSession}
            className="bg-[#6366f1] hover:bg-[#818cf8] text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors"
          >
            + New Session
          </button>
        </div>
      </div>
    )
  }

  const lastMsgTime = (() => {
    const visible = messages.filter(m => m.role === 'user' || m.role === 'assistant')
    const last = visible[visible.length - 1]
    if (!last) return null
    const ts = (last as {ts?: string | number; created_at?: string | number}).ts ||
                (last as {ts?: string | number; created_at?: string | number}).created_at
    if (!ts) return null
    const ms = typeof ts === 'number' ? ts : new Date(ts).getTime()
    if (isNaN(ms)) return null
    const diff = Date.now() - ms
    const s = Math.floor(diff / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  })()

  return (
    <div
      data-pane-index={_paneIndex}
      className={`flex flex-1 min-w-0 border-r border-[#2a3142] transition-all relative ${isFocused ? 'shadow-[inset_3px_0_0_#818cf8,inset_20px_0_32px_rgba(129,140,248,0.08)]' : ''}`}
      onMouseDown={(e) => {
        onFocus?.()
        // If clicking a non-input area, blur any active input so bare-key hotkeys (E, R, N) fire
        const tag = (e.target as HTMLElement).tagName.toLowerCase()
        if (tag !== 'input' && tag !== 'textarea' && !(e.target as HTMLElement).isContentEditable) {
          ;(document.activeElement as HTMLElement | null)?.blur?.()
        }
      }}
    >
      {/* Drop target overlay - glowing left-border + translucent wash */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 border-l-2 border-[#6366f1] bg-[#6366f1]/[0.07] shadow-[inset_4px_0_20px_rgba(99,102,241,0.15)]" />
      )}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Status bar at top: animated purple when running, solid green when idle */}
        <div className="h-0.5 w-full shrink-0 overflow-hidden">
          {showWorking ? (
            <div
              className="h-full bg-gradient-to-r from-transparent via-[#a855f7] to-transparent"
              style={{ animation: 'slide 1.4s ease-in-out infinite', width: '60%' }}
            />
          ) : (
            <div className="h-full w-full bg-[#22c55e]" />
          )}
        </div>
        <style>{`@keyframes slide { 0% { transform: translateX(-100%) } 100% { transform: translateX(280%) } }`}</style>
        {/* Header */}
        <div
          className={`flex flex-col border-b border-[#2a3142] shrink-0 ${isFocused ? 'bg-[#1a1d2e]' : 'bg-[#181c24]'}`}
        >
          {/* Title row */}
          <div className="flex items-center gap-1 px-3 pt-2 pb-1">
            {/* Drag handle - pointer-event based for custom ghost */}
            <div
              onPointerDown={(e) => {
                e.stopPropagation()
                const label = getLabel(sessionKey) || session?.label || ''
                onDragStart?.(e, label)
              }}
              className="text-[#3a4152] hover:text-[#6366f1] cursor-grab active:cursor-grabbing shrink-0 pr-1 select-none text-[13px] leading-none transition-colors"
              title="Drag to reorder pane"
            >⠿</div>
            <div className="group flex items-center gap-1.5 flex-1 min-w-0">
              {showWorking && (
                <span className="w-2 h-2 rounded-full bg-[#a855f7] animate-pulse shrink-0" title={workingTool ? `Running: ${workingTool}` : 'Working...'} />
              )}
              {labelEditing ? (
                <input
                  autoFocus
                  className="flex-1 min-w-0 bg-[#0f1117] border border-[#6366f1] rounded px-1.5 py-0.5 text-sm text-white outline-none leading-none"
                  value={labelValue}
                  onChange={e => setLabelValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleLabelRename(labelValue)
                    if (e.key === 'Escape') setLabelEditing(false)
                  }}
                  onBlur={() => handleLabelRename(labelValue)}
                />
              ) : (
                <>
                  <span
                    className="text-sm font-medium text-white truncate leading-none"
                    title={sessionKey}
                  >
                    {displayName}
                  </span>
                  <button
                    className="opacity-40 hover:opacity-100 transition-opacity text-[11px] text-[#6b7280] hover:text-indigo-400 shrink-0 px-0.5"
                    title="AI auto-rename"
                    disabled={autoNaming}
                    onClick={() => { void handleAutoRename() }}
                  >
                    {autoNaming ? '...' : '✨'}
                  </button>
                </>
              )}
              {showWorking && workingTool && (
                <span className="text-[10px] text-[#a855f7] shrink-0 truncate max-w-[120px]">{workingTool}...</span>
              )}
            </div>
            {!showWorking && lastMsgTime && (
              <span className="text-[10px] text-[#4b5563] shrink-0" title="Last message">{lastMsgTime}</span>
            )}
            {lastHeartbeat && (
              <span
                title={`Last heartbeat: ${lastHeartbeat.ts.toLocaleTimeString()}`}
                className="text-xs px-1"
              >
                {lastHeartbeat.ok ? '❤️' : '🖤'}
              </span>
            )}
            <SessionCostBadge sessionKey={sessionKey} />
            <button
              onClick={onClose}
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-xs text-[#6b7280] hover:text-red-400 shrink-0"
            >
              ✕
            </button>
          </div>
          {/* Action row */}
          <div className="flex items-center gap-1 px-3 pb-1.5">
            <button
              onClick={toggleNoise}
              title={
                noiseHidden
                  ? 'Show tool calls & system msgs'
                  : 'Hide tool calls & system msgs'
              }
              className={`text-[10px] font-medium h-6 px-2 rounded-full border transition-colors shrink-0 flex items-center ${
                noiseHidden
                  ? 'bg-[#1e2330] border-[#2a3142] text-[#4b5563]'
                  : 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'
              }`}
            >
              {noiseHidden ? 'chat only' : '+ tools'}
            </button>
            <button
              onClick={handleBriefMe}
              title="Brief me - 3-sentence status"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-indigo-400"
            >
              💬
            </button>
            <button
              onClick={handleSteppingAway}
              title="Stepping away - ask agent for plan + blockers"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-blue-400"
            >
              🚪
            </button>
            <button
              onClick={handleSave}
              title="Save checkpoint to memory"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-green-400"
            >
              💾
            </button>
            <button
              onClick={handleArchive}
              title="Save & archive session"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-yellow-400"
            >
              📦
            </button>
            <button
              onClick={() => setCardOpen((s) => !s)}
              title="Session brief"
              className={`h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm ${sessionCard ? 'text-[#a5b4fc] hover:text-white' : 'text-[#3a4152]'}`}
            >
              📋
            </button>
          </div>
        </div>

        {/* Session card strip */}
        {cardOpen && (() => {
          const firstUser = messages.find((m) => m.role === 'user')
          const lastAssistant = [...messages].reverse().find(
            (m) => m.role === 'assistant' && extractText(m.content).trim() && !isHeartbeatMsg(m)
          )
          return (
            <div className="px-4 py-3 border-b border-[#2a3142] bg-[#0a0d14] shrink-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-[#6366f1] uppercase tracking-wider">Session</span>
                <span className="text-xs text-white font-medium truncate">{displayName}</span>
                <span className="text-[10px] text-[#4b5563] font-mono ml-auto truncate max-w-[120px]" title={sessionKey}>{sessionKey.slice(0, 20)}...</span>
              </div>
              {firstUser && (
                <div>
                  <div className="text-[10px] text-[#6b7280] uppercase tracking-wider mb-0.5">Started with</div>
                  <div className="text-xs text-[#e8eaf0] leading-relaxed line-clamp-2">
                    {extractText(firstUser.content).slice(0, 200)}
                  </div>
                </div>
              )}
              {lastAssistant && (
                <div>
                  <div className="text-[10px] text-[#6b7280] uppercase tracking-wider mb-0.5">Last reply</div>
                  <div className="text-xs text-[#a5b4fc] leading-relaxed line-clamp-2">
                    {extractText(lastAssistant.content).slice(0, 200)}
                  </div>
                </div>
              )}
              {!firstUser && (
                <div className="text-xs text-[#4b5563]">No messages yet.</div>
              )}
            </div>
          )
        })()}

        {/* Messages */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          onScroll={() => {
            const el = scrollContainerRef.current
            if (!el) return
            // Consider "at bottom" if within 80px of bottom
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            userScrolledUpRef.current = !atBottom
          }}
        >
          {(loadedKey === sessionKey || messages.length > 0 ? messages : [])
            .filter(
              (msg) => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg))
            )
            // Render-level dedup - two rules:
            // 1. Numeric-id user messages (optimistics) only render if they ARE the currently
            //    tracked pending optimistic. Any other numeric-id user message is an orphan
            //    that was never cleaned up from state - hide it.
            // 2. Duplicate string IDs: only the first occurrence renders.
            // Render-level dedup - two rules:
            // 1. Numeric-id user messages (optimistics) only render if they ARE the currently
            //    tracked pending optimistic. Any other numeric-id user message is an orphan
            //    that was never cleaned up from state - hide it.
            // 2. Duplicate string/undefined IDs: only the first occurrence renders. If ID is undefined,
            //    we use a content fingerprint to detect duplicates.
            .filter((msg, idx, arr) => {
              // Hide project context injection notes (visible to agent in transcript, not needed in UI)
              if (msg.role === 'assistant' && extractText(msg.content).trimStart().startsWith('📁 **')) return false
              if (msg.role === 'user' && typeof msg.id === 'number') {
                // Only show if this is the live optimistic
                return msg.id === pendingOptimisticIdRef.current
              }

              // For messages with defined IDs, filter traditional duplicates
              if (msg.id !== undefined && msg.id !== null) {
                return arr.findIndex((m) => m.id === msg.id) === idx
              }

              // For messages with UNDEFINED IDs, use a content fingerprint for deduplication
              const fingerprint = `${msg.role}-${extractText(msg.content).substring(0, 100)}`
              return arr.findIndex((m) => m.id === undefined && `${m.role}-${extractText(m.content).substring(0, 100)}` === fingerprint) === idx
            })
            .map((msg, i, arr) => {
              const msgTs = getMsgTs(msg)
              const showTs = msgTs > 0
              return (
              <>
              <div
                key={msg.id !== undefined ? String(msg.id) : i}
                className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl ${
                    msg.role === 'user'
                      ? 'bg-[#6366f1] text-white rounded-br-sm text-sm'
                      : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                  }`}
                >
                  {/* Render gateway-stored media attachments (MediaPath/MediaPaths from chat.send) */}
                  {msg.MediaPaths && msg.MediaPaths.length > 0
                    ? msg.MediaPaths.map((p, i) => {
                        const filename = p.split('/').pop() || ''
                        const mime = (msg.MediaTypes?.[i] || msg.MediaType || '')
                        const src = `${API}/api/media/${encodeURIComponent(filename)}`
                        return mime.includes('pdf')
                          ? <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-2 bg-[#4f51c0] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
                              <span className="text-2xl">📄</span>
                              <span className="text-xs text-white truncate">{filename}</span>
                            </a>
                          : <img key={i} src={src} alt="attachment" className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      })
                    : msg.MediaPath
                      ? (() => {
                          const filename = msg.MediaPath.split('/').pop() || ''
                          const src = `${API}/api/media/${encodeURIComponent(filename)}`
                          return (msg.MediaType || '').includes('pdf')
                            ? <a href={src} target="_blank" rel="noopener noreferrer"
                                className="flex items-center gap-2 bg-[#4f51c0] rounded-lg px-3 py-2 my-1 max-w-xs no-underline">
                                <span className="text-2xl">📄</span>
                                <span className="text-xs text-white truncate">{filename}</span>
                              </a>
                            : <img src={src} alt="attachment" className="max-w-full rounded-lg my-1 max-h-64 object-contain"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                        })()
                      : null
                  }
                  {/* user text-only content gets whitespace-pre-wrap; array (image+text) does not */}
                  {msg.role === 'user' && typeof msg.content === 'string'
                    ? <span className="whitespace-pre-wrap">{renderContent(msg.content)}</span>
                    : renderContent(msg.content)
                  }
                  {showTs && (
                    <div className={`text-[10px] mt-1 ${msg.role === 'user' ? 'text-[#a5b4fc] text-right' : 'text-[#4b5563]'}`}>
                      {fmtMsgTs(msgTs)}
                    </div>
                  )}
                </div>
              </div>
              </>
              )
            })}
          {showWorking && (
            <div className="flex gap-2 justify-start">
              <div className="bg-[#1e2330] text-[#6b7280] px-3 py-2 rounded-xl rounded-bl-sm text-xs flex items-center gap-2">
                <span className="inline-flex gap-0.5">
                  <span className="w-1.5 h-1.5 bg-[#6366f1] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-[#6366f1] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-[#6366f1] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
                <span>{workingTool ? `${workingTool}...` : 'thinking...'}</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Sent queue strip */}
        {sentQueue.length > 0 && (
          <div className="px-3 pt-1.5 pb-0.5 bg-[#181c24] border-t border-[#2a3142] flex flex-col gap-0.5">
            {sentQueue.map(e => (
              <div key={e.id} className="flex items-center gap-1.5 text-[10px]">
                {e.status === 'sending'
                  ? <span className="w-1.5 h-1.5 rounded-full bg-[#6366f1] animate-pulse shrink-0" />
                  : <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse shrink-0" />
                }
                <span className="text-[#6b7280]">
                  {e.text}
                </span>
                <span className="text-[#4b5563] shrink-0">{e.status === 'sending' ? 'sending...' : 'in queue'}</span>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="px-3 py-3 border-t border-[#2a3142] bg-[#181c24] shrink-0">
          {/* File preview */}
          {pendingFiles.length > 0 && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {pendingFiles.map((file, idx) => (
                <div key={file._key ?? idx} className="relative shrink-0 inline-block">
                  {file.kind === 'image'
                    ? <img src={file.dataUrl} alt="pending" className="max-h-20 max-w-[160px] rounded-lg border border-[#6366f1] object-cover" />
                    : file.kind === 'video'
                    ? (
                      <div className="flex flex-col gap-1 max-w-[200px]">
                        <video src={file.videoObjectUrl} controls muted playsInline className="rounded-lg border border-[#6366f1] max-h-20 max-w-full" />
                        <span className="text-[10px] text-[#9ca3af] truncate">🎬 {file.name}</span>
                      </div>
                    )
                    : (
                      <div className="flex flex-col gap-1 bg-[#2a3142] border border-[#6366f1] rounded-lg px-2 py-1.5 max-w-[180px]">
                        <div className="flex items-center gap-1.5">
                          <span className="text-base">📄</span>
                          <span className="text-xs text-white truncate flex-1">{file.name}</span>
                        </div>
                        {file.extracting && (
                          <span className="text-[10px] text-[#6b7280] animate-pulse">Extracting...</span>
                        )}
                        {!file.extracting && file.extractedText !== undefined && (
                          <span className="text-[10px] text-[#22c55e]">
                            ✓ {file.pages ? `${file.pages}p · ` : ''}{Math.round((file.extractedText?.length || 0) / 4)} tokens
                          </span>
                        )}
                        {!file.extracting && file.extractedText === undefined && (
                          <span className="text-[10px] text-red-400">Extraction failed</span>
                        )}
                      </div>
                    )
                  }
                  <button
                    onClick={() => { if (file.videoObjectUrl) URL.revokeObjectURL(file.videoObjectUrl); setPendingFiles(prev => prev.filter((_, i) => i !== idx)) }}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 text-white rounded-full text-[9px] flex items-center justify-center hover:bg-red-400"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 items-end">
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
              title="Attach image or PDF"
              className="text-[#6b7280] hover:text-[#a5b4fc] text-lg px-1 py-1 transition-colors shrink-0"
            >
              📎
            </button>
            <textarea
              ref={textareaRef}
              className="flex-1 bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#6366f1] placeholder-[#4b5563] resize-none overflow-y-auto leading-relaxed"
              style={{ minHeight: '38px', maxHeight: '150px' }}
              placeholder="Message... (Enter to send, Shift+Enter for new line, paste image or attach PDF)"
              value={input}
              rows={1}
              onChange={(e) => {
                const val = e.target.value
                setInput(val)
                // Debounce draft — avoids Zustand re-render on every keystroke
                if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
                draftTimerRef.current = setTimeout(() => { if (sessionKey) setDraft(sessionKey, val) }, 300)
                // Height via rAF — avoids forced layout reflow on every keystroke
                const ta = e.target
                requestAnimationFrame(() => {
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'
                })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              onPaste={handlePaste}
            />
            <button
              onClick={handleSend}
              className="bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg px-4 text-sm font-medium transition-colors self-end"
              style={{ height: '38px' }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>


    </div>
  )
}
