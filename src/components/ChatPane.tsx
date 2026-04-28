import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore, useLabelStore, useDraftStore, useHiddenStore, Session, DraftData } from '../store/gatewayStore'
import { authFetch } from '../lib/authFetch'
import { useAuthStore } from '../store/authStore'
import DecisionButtons from './DecisionButtons'
import { DeleteConfirmModal } from './DeleteConfirmModal'

// Quick Commands helpers
const QUICK_COMMAND_DEFAULTS = {
  brief: "If you're a session that modified Octis app code, keep OCTIS_CHANGES.md updated with only relevant development work since the last log update. Record every code modification, bug fix, config/schema/API change, dependency change, important decision, known issue, and testing/verification result.",
  away: "I'm stepping away for a while. Please do the following:\n1. Summarize what you're currently working on (1-2 sentences).\n2. List anything you're blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\n3. List everything you CAN do autonomously while I'm gone, in order.\n4. Estimate how long you can run without me.\nBe concise. I'll read this on my phone.",
  save: "💾 checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.",
  archive_msg: "💾 Final save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.",
}

function getQuickCommands() {
  try {
    return { ...QUICK_COMMAND_DEFAULTS, ...JSON.parse(localStorage.getItem('octis-quick-commands') || '{}') }
  } catch { return { ...QUICK_COMMAND_DEFAULTS } }
}

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

  // Per-message cost overhead - color tells you when to start a new session
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
  isFeatured?: boolean
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
    // Split on URLs first, then handle markdown formatting within non-URL segments
    const urlSegments = str.split(/(https?:\/\/[^\s<>"{}|\\^`\[\]*]+)/g)
    return urlSegments.flatMap((seg, j) => {
      if (/^https?:\/\//.test(seg)) {
        return [<a key={`u${j}`} href={seg} target="_blank" rel="noopener noreferrer"
          className="text-[#6366f1] underline break-all hover:text-[#818cf8]">{seg}</a>]
      }
      const parts = seg.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)
      return parts.map((p, k) => {
        if (p.startsWith('**') && p.endsWith('**'))
          return <strong key={`${j}-${k}`} className="font-semibold text-white">{p.slice(2, -2)}</strong>
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2)
          return <code key={`${j}-${k}`} className="bg-[#0f1117] text-[#a5b4fc] px-1 rounded text-[11px] font-mono">{p.slice(1, -1)}</code>
        if (p.startsWith('*') && p.endsWith('*') && p.length > 2)
          return <em key={`${j}-${k}`} className="italic opacity-80">{p.slice(1, -1)}</em>
        return <span key={`${j}-${k}`}>{p}</span>
      })
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

    // Markdown image: ![alt](url)
    const mdImgMatch = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/)
    if (mdImgMatch) {
      elements.push(<img key={i} src={mdImgMatch[2]} alt={mdImgMatch[1]}
        className="max-w-full rounded-lg my-1 max-h-64 object-contain"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />)
      i++
      continue
    }

    // MEDIA:<url> directive
    const mediaLineMatch = line.match(/^MEDIA:(https?:\/\/\S+)$/)
    if (mediaLineMatch) {
      const mUrl = mediaLineMatch[1]
      const isImg = /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(mUrl)
      elements.push(isImg
        ? <img key={i} src={mUrl} alt="image" className="max-w-full rounded-lg my-1 max-h-64 object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        : <a key={i} href={mUrl} target="_blank" rel="noopener noreferrer"
            className="text-[#6366f1] underline break-all">{mUrl}</a>
      )
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
  // System-injected lifecycle messages (memory flush, compaction, etc.) — hide from chat
  if (text.startsWith('Pre-compaction memory flush') || text.startsWith('Pre-compaction context flush')) return true
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

// ─── Reply helpers ────────────────────────────────────────────────────────────

function getReplyCtx(content: MessageContent): { role: string; preview: string; msgId?: string } | null {
  const text = extractText(content)
  // Handles both formats: "[Replying to AI: \"...\"]" and "[Replying to AI (42): \"...\"]"
  const m = text.match(/^\[Replying to ([^(:]+?)(?:\s*\(([^)]+)\))?:\s*"([^"]{0,150})"\]\n\n/)
  if (!m) return null
  return { role: m[1].trim(), preview: m[3], msgId: m[2] || undefined }
}

function stripReplyCtxText(text: string): string {
  return text.replace(/^\[Replying to [^:]+: "[^"]{0,150}"\]\n\n/, '')
}

function stripReplyCtx(content: MessageContent): MessageContent {
  if (typeof content === 'string') return stripReplyCtxText(content)
  if (Array.isArray(content)) {
    const arr = content as ContentBlock[]
    const firstTextIdx = arr.findIndex(b => b.type === 'text')
    if (firstTextIdx === -1) return content
    const ft = arr[firstTextIdx] as { type: 'text'; text: string }
    const stripped = stripReplyCtxText(ft.text)
    if (stripped === ft.text) return content
    const updated = [...arr]
    updated[firstTextIdx] = { ...ft, text: stripped }
    return updated
  }
  return content
}

function ReplyQuoteBubble({ role, preview, isUserMsg, onJump }: { role: string; preview: string; isUserMsg: boolean; onJump?: () => void }) {
  return (
    <div
      className={`mb-1.5 px-2 py-1 rounded-lg border-l-2 text-xs max-w-full transition-opacity ${
        isUserMsg ? 'bg-[#4f51c0]/30 border-[#a5b4fc]/70' : 'bg-[#0f1117]/60 border-[#4b5563]'
      } ${onJump ? 'cursor-pointer hover:opacity-100' : ''}`}
      style={{ opacity: onJump ? 0.9 : undefined }}
      onClick={onJump}
      title={onJump ? 'Jump to message' : undefined}
    >
      <div className={`text-[10px] font-semibold mb-0.5 flex items-center gap-1 ${
        isUserMsg ? 'text-[#c7d2fe]' : 'text-[#6b7280]'
      }`}>
        {role === 'AI' ? '🤖 AI' : '👤 You'}
        {onJump && <span className="opacity-50 text-[9px]">↗</span>}
      </div>
      <div className={`line-clamp-2 leading-tight opacity-80 ${
        isUserMsg ? 'text-[#e0e7ff]' : 'text-[#9ca3af]'
      }`}>
        {preview}
      </div>
    </div>
  )
}

// ─── Message cache (localStorage - survives pane unmount) ──────────────────────
import { loadMsgCache, saveMsgCache } from '../lib/msgCache'
import { useTextareaUndo } from '../hooks/useTextareaUndo'

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatPane({ sessionKey, paneIndex: _paneIndex, onClose, onFocus, isFocused, isFeatured, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, renameRequested }: ChatPaneProps) {
  const { send, sendChat, ws, connected, agentId } = useGatewayStore()
  const { setSessions, sessions, setLastRole, markStreaming: markSessionStreaming, incrementUnread, clearUnread, sessionMeta, consumePendingProjectPrefix, consumePendingProjectInit, setLastExchangeCost } = useSessionStore()
  const { setCard, getTag, getProjectEmoji } = useProjectStore()
  const { setLabel: saveLabelLocal, getLabel } = useLabelStore()
  const { setDraft, getDraft, getDraftData, clearDraft, isDraftCleared, hydrateFromServer: hydrateDraftsFromServer } = useDraftStore()
  // Per-session message cache - show instantly on switch, refresh silently behind the scenes
  // Uses localStorage so cache survives pane unmount/remount (useRef would die on close)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const setMessagesAndCache = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]), key?: string) => {
    setMessages(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      if (key && next.length > 0) saveMsgCache(key, next)
      return next
    })
  }
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(200)
  const historyLimitRef = useRef(200) // ref so WS closure always sees latest without re-running effect
  const [hasMore, setHasMore] = useState(false)
  const [input, setInput] = useState(() => (sessionKey ? getDraft(sessionKey) : ''))
  // Resize textarea to fit content — called after any programmatic setInput()
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    // rAF ensures the DOM has painted the new value before we read scrollHeight
    requestAnimationFrame(() => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'
    })
  }, [])
  // On mount: size textarea to fit initial draft
  useEffect(() => {
    if (input) resizeTextarea()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver: re-compute textarea height whenever the container width changes.
  // This fixes the "1 line draft when pane splits" bug — narrower pane = more wrapped lines.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const ro = new ResizeObserver(() => {
      if (!ta.value) return // empty — let CSS handle it
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, []) // stable — runs once, ResizeObserver watches the element
  // When sessionKey changes (pane reuses same component), reset input to that session's draft
  const prevSessionKeyRef = useRef<string | null>(sessionKey)
  useEffect(() => {
    if (prevSessionKeyRef.current === sessionKey) return
    prevSessionKeyRef.current = sessionKey
    const draftData = sessionKey ? getDraftData(sessionKey) : { text: '' }
    setInput(draftData.text)
    if (draftData.files && draftData.files.length > 0) {
      // Restore image/doc attachments from draft (assign fresh _keys)
      setPendingFiles(draftData.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[])
    } else {
      setPendingFiles([])
    }
    inputUndo.reset() // new session = fresh undo history
    // Resize after React re-renders with the new value
    if (draftData.text) setTimeout(resizeTextarea, 0)
  }, [sessionKey, getDraftData, resizeTextarea])
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
  const workingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null) // fallback: clear working after 5 min max
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputUndo = useTextareaUndo()
  const runActiveRef = useRef(false)           // lifecycle:start→true, lifecycle:end→false
  const lastEventTsRef = useRef(0)             // updated on every WS event
  const [runQuiet, setRunQuiet] = useState(false) // run is active but no events for >60s
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
    (Date.now() - lastSentRef.current) < 300000
  const showWorking = isWorking || globalStreaming || awaitingRender || runActiveRef.current
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try {
      return localStorage.getItem('octis-noise-hidden') !== 'false'
    } catch {
      return true
    }
  })
  // Reply state
  const [hoveredMsgKey, setHoveredMsgKey] = useState<string | null>(null)
  const [replyingTo, setReplyingTo] = useState<{ id: string | number | undefined; role: 'user' | 'assistant'; preview: string } | null>(null)
  const [highlightedMsgKey, setHighlightedMsgKey] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const isInitialScrollRef = useRef(true) // true until first scroll after session load
  const savedScrollHeightRef = useRef<number>(0) // for scroll preservation when loading older
  const isLoadingOlderRef = useRef(false) // true while an older-messages fetch is in flight
  const wasLoadingOlderRef = useRef(false) // set in useLayoutEffect, consumed in useEffect to block scroll-to-bottom

  const toggleNoise = () =>
    setNoiseHidden((v) => {
      const next = !v
      try {
        localStorage.setItem('octis-noise-hidden', String(next))
      } catch {}
      return next
    })

  // "Quiet run" detector: runActive but no events for >60s → amber indicator
  useEffect(() => {
    const interval = setInterval(() => {
      const quiet = runActiveRef.current && !isWorking && !globalStreaming &&
        lastEventTsRef.current > 0 && (Date.now() - lastEventTsRef.current > 60_000)
      setRunQuiet(quiet)
    }, 5000)
    return () => clearInterval(interval)
  }, [isWorking, globalStreaming])

  // Load chat history when session or ws changes
  // Clear unread count when this pane is active on a session
  useEffect(() => {
    if (sessionKey) clearUnread(sessionKey)
  }, [sessionKey, clearUnread])

  // Claim session ownership when a session is opened
  const { claimSession } = useAuthStore()
  useEffect(() => {
    if (sessionKey) claimSession(sessionKey)
  }, [sessionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync draft from server when switching to a session (cross-device persistence)
  useEffect(() => {
    if (!sessionKey) return
    // Check if we already have a local draft (text OR files — don't trigger server fetch if files saved)
    const localData = getDraftData(sessionKey)
    const hasLocal = !!localData.text || (localData.files?.length ?? 0) > 0
    if (hasLocal) return // local draft already loaded on mount — skip server fetch
    // If draft was intentionally cleared (tombstone in localStorage), don't restore from server
    if (isDraftCleared(sessionKey)) return
    // No local draft at all — check server for a draft from another device
    void (async () => {
      try {
        const resp = await authFetch(`${API}/api/drafts/${encodeURIComponent(sessionKey)}`)
        if (!resp.ok) return
        const data = await resp.json()
        if (!data.text) return
        // Verify still no local draft (avoid race condition)
        const currentData = getDraftData(sessionKey)
        if (currentData.text || (currentData.files?.length ?? 0) > 0) return
        // Deserialize server response (data.text is the serialized DraftData JSON)
        const parsed = (() => {
          try { const p = JSON.parse(data.text); if (p && typeof p === 'object' && 'text' in p) return p as { text: string; files?: typeof localData.files } }
          catch {} return { text: data.text as string, files: undefined }
        })()
        setDraft(sessionKey, parsed.text, parsed.files)
        setInput(parsed.text)
        if (parsed.files && parsed.files.length > 0) {
          setPendingFiles(parsed.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[])
        }
        if (parsed.text) setTimeout(resizeTextarea, 0)
      } catch {}
    })()
  }, [sessionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger a sessions.list refresh on mount so the cost badge populates immediately
  // (Sidebar polls every 30s - without this, a newly-opened pane can wait up to 30s)
  useEffect(() => {
    if (!sessionKey || !connected) return
    send({ type: 'req', id: `sessions-list-pane-${Date.now()}`, method: 'sessions.list', params: {} })
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

  // Keep historyLimitRef in sync with historyLimit state
  useEffect(() => { historyLimitRef.current = historyLimit }, [historyLimit])

  // Keep message cache fresh as messages update (so future visits to this session are instant)
  useEffect(() => {
    if (sessionKey && messages.length > 0 && loadedKey === sessionKey) {
      saveMsgCache(sessionKey, messages)
    }
  }, [messages, sessionKey, loadedKey])


  // When hasMore becomes true and we're already near the top (e.g. after initial load of a
  // short session, or after load-more that left us < 150px from top), auto-trigger immediately
  // without waiting for another onScroll event.
  useEffect(() => {
    if (!hasMore || isLoadingOlderRef.current) return
    const el = scrollContainerRef.current
    if (el && el.scrollTop < 150) {
      isLoadingOlderRef.current = true
      savedScrollHeightRef.current = el.scrollHeight
      setHistoryLimit(prev => prev + 100)
    }
  }, [hasMore])

  // Restore scroll position after loading older messages so the view doesn't jump
  // useLayoutEffect fires synchronously after DOM update — before browser paint
  const { useLayoutEffect } = React
  useLayoutEffect(() => {
    if (isLoadingOlderRef.current) {
      // Load-more: preserve scroll position so content doesn't jump
      const el = scrollContainerRef.current
      const savedHeight = savedScrollHeightRef.current
      if (!el || savedHeight === 0) return
      wasLoadingOlderRef.current = true
      isLoadingOlderRef.current = false
      savedScrollHeightRef.current = 0
      const delta = el.scrollHeight - savedHeight
      if (delta > 0) el.scrollTop = delta
      return
    }
    // Initial load: scroll to bottom BEFORE browser paints (no visible top-flash)
    if (isInitialScrollRef.current && messages.length > 0) {
      const el = scrollContainerRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
        isInitialScrollRef.current = false
      }
    }
  }, [messages])

  // Clear sent queue as soon as agent starts streaming (message is being processed)
  useEffect(() => {
    if (globalStreaming) {
      setSentQueue(prev => prev.filter(e => e.status === 'sending'))
    }
  }, [globalStreaming])

  // Clear ALL remaining queue entries a few seconds after agent finishes
  // (catches rapid-send orphans that never got individual confirmation)
  useEffect(() => {
    if (!isWorking && !globalStreaming) {
      const t = setTimeout(() => setSentQueue([]), 3000)
      return () => clearTimeout(t)
    }
  }, [isWorking, globalStreaming])

  // ── Phase 1: show cached messages immediately, no WS needed ──────────────
  useEffect(() => {
    if (!sessionKey) return
    if (loadedSessionRef.current === sessionKey) return // already loaded or switching back
    // Reset scroll state
    userScrolledUpRef.current = false
    isInitialScrollRef.current = true
    // Paint cached messages right away so pane isn't blank while WS connects
    const cached = loadMsgCache(sessionKey)
    if (cached.length > 0) {
      setMessages(cached)
    } else {
      setMessages([])
      // No cache — fetch via HTTP immediately so pane isn't blank while WS connects
      let cancelled = false
      authFetch(`${API}/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}&limit=200`)
        .then(r => r.json())
        .then((d: { ok?: boolean; messages?: ChatMessage[] }) => {
          if (cancelled) return
          if (!d.ok || !d.messages?.length) return
          if (loadedSessionRef.current === sessionKey) return // WS already delivered
          setMessages(d.messages)
          saveMsgCache(sessionKey, d.messages)
        })
        .catch(() => {})
      return () => { cancelled = true }
    }
    setAutoRenamed(false)
    setHistoryLimit(200)
    setHasMore(false)
  }, [sessionKey])

  // Clear reply state when switching sessions
  useEffect(() => {
    setReplyingTo(null)
    setHoveredMsgKey(null)
    setHighlightedMsgKey(null)
  }, [sessionKey])

  useEffect(() => {
    // Wait for WS to be both set AND connected (readyState=OPEN).
    // Without the connected check, send() fires while readyState=CONNECTING and silently drops.
    if (!sessionKey || !ws || !connected) return
    const isSameSession = loadedSessionRef.current === sessionKey
    loadedSessionRef.current = sessionKey
    // Only wipe messages when switching to a different session.
    // On ws reconnect (same session), keep old messages visible while history reloads silently.
    if (!isSameSession) {
      // Phase 1 already painted cache - just reset scroll state in case Phase 1 ran before WS
      userScrolledUpRef.current = false
      isInitialScrollRef.current = true
    }
    setLoadedKey(null)
    setSessionCard(null)
    if (!isSameSession) { setAutoRenamed(false); setHistoryLimit(200); setHasMore(false) }
    const reqId = `chat-history-${sessionKey}-${Date.now()}`
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey, limit: historyLimitRef.current } })

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
          // Poll is NO LONGER the primary clear signal - lifecycle:end handles that.
          // Poll only handles: cost tracking + fallback clear when no lifecycle events arrive.
          const lastPollMsg = msgs[msgs.length - 1]
          if (lastPollMsg?.role === 'assistant' && extractText(lastPollMsg.content).trim()) {
            const rawTs = (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).ts ||
                          (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).created_at ||
                          (lastPollMsg as {ts?: string | number; created_at?: string | number; timestamp?: string | number}).timestamp
            const msgTs = rawTs ? new Date(rawTs as string | number).getTime() : 0
            // Only update cost tracking here - isWorking cleared by lifecycle:end
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
            if (waitedTooLong && !runActiveRef.current) {
              setIsWorking(false)
              setWorkingTool(null)
            }
            // Also clear if this is a session opened without a recent send (history load)
            if (lastSentRef.current === 0 && msgTs > 0 && !runActiveRef.current) {
              setIsWorking(false)
              setWorkingTool(null)
            }
          }
          setMessages((prev) => {
            if (msgs.length === 0) return prev

            // ── Step 1: Compute base — NEVER downgrade loaded history ───────────────────────
            // Poll limit (30 idle / 100 active) << history limit (200). Guard must run
            // BEFORE optimistic logic — old code applied guard only when no optimistics
            // existed, causing poll to collapse 200-msg history to 30 whenever user had
            // a pending message. That's the root cause of messages disappearing on send.
            const prevServer = prev.filter(m => typeof m.id !== 'number')
            let base: ChatMessage[]
            if (msgs.length >= prevServer.length) {
              // Poll covers everything we have — use directly
              // Preserve local image content if server stripped the base64
              base = msgs.map(serverMsg => {
                if (serverMsg.role !== 'user' || !Array.isArray(serverMsg.content)) return serverMsg
                const blocks = serverMsg.content as ContentBlock[]
                const hasEmptyImage = blocks.some(b => b.type === 'image' && !(b as Record<string,unknown>).data)
                if (!hasEmptyImage) return serverMsg
                const localMsg = prevServer.find(m =>
                  (m.id !== undefined && m.id === serverMsg.id) ||
                  (getMsgTs(m) > 0 && getMsgTs(m) === getMsgTs(serverMsg))
                )
                if (!localMsg || !Array.isArray(localMsg.content)) return serverMsg
                const localBlocks = localMsg.content as ContentBlock[]
                const localHasImageData = localBlocks.some(b => b.type === 'image' && !!(b as Record<string,unknown>).data)
                return localHasImageData ? { ...serverMsg, content: localMsg.content } : serverMsg
              })
            } else {
              // Poll is truncated: keep prev, append only genuinely new messages
              const prevTs = new Set(prevServer.map(m => getMsgTs(m)).filter(ts => ts > 0))
              const prevIds = new Set(
                prevServer.filter(m => m.id !== undefined && m.id !== null).map(m => m.id)
              )
              // For ts=0 messages: use content fingerprint to avoid appending duplicates each poll
              const prevFp = new Set(prevServer.filter(m => getMsgTs(m) === 0).map(m =>
                `${m.role}:${extractText(m.content).substring(0, 100)}`
              ))
              const newOnes = msgs.filter(m => {
                // Already present by id — this is a ts-update for a WS-echo that had ts=0, not a new msg
                if (m.id !== undefined && m.id !== null && prevIds.has(m.id)) return false
                const ts = getMsgTs(m)
                if (ts > 0) return !prevTs.has(ts)
                return !prevFp.has(`${m.role}:${extractText(m.content).substring(0, 100)}`)
              })
              // Patch real timestamps onto ts=0 entries that the poll now has ts for.
              // WS echoes often lack timestamps; without patching, the message stays ts=0
              // and every subsequent poll re-adds it as "new", eventually landing after
              // assistant replies that already have timestamps.
              const patched = prevServer.map(m => {
                if (m.id !== undefined && m.id !== null) {
                  const pm = msgs.find(p => p.id === m.id)
                  if (pm) {
                    // Merge fresh server data: fills in ts and MediaPaths that WS echo may have lacked
                    const hasMissingTs = getMsgTs(m) === 0 && getMsgTs(pm) > 0
                    const hasMissingMedia = !m.MediaPath && !m.MediaPaths && (pm.MediaPath || pm.MediaPaths)
                    if (hasMissingTs || hasMissingMedia) {
                      // Don't overwrite content when local has image data and server stripped it
                      const localHasImgData = Array.isArray(m.content) &&
                        (m.content as ContentBlock[]).some(b => b.type === 'image' && !!(b as Record<string,unknown>).data)
                      const serverHasEmptyImg = Array.isArray(pm.content) &&
                        (pm.content as ContentBlock[]).some(b => b.type === 'image' && !(b as Record<string,unknown>).data)
                      return localHasImgData && serverHasEmptyImg
                        ? { ...m, ...pm, content: m.content }
                        : { ...m, ...pm }
                    }
                  }
                }
                return m
              })
              // Fast-exit: last message unchanged and nothing new — skip re-render
              if (newOnes.length === 0) {
                const lastPollTs = getMsgTs(msgs[msgs.length - 1])
                const lastPrevTs = getMsgTs(patched[patched.length - 1])
                if (lastPollTs > 0 && lastPollTs === lastPrevTs) return prev
              }
              if (newOnes.length > 0) {
                // Sort by timestamp so out-of-order arrivals land in the right spot.
                // Both ta and tb must be > 0 to sort; ts=0 preserves relative order.
                base = [...patched, ...newOnes].sort((a, b) => {
                  const ta = getMsgTs(a), tb = getMsgTs(b)
                  if (!ta || !tb) return 0
                  return ta - tb
                })
              } else {
                base = patched
              }
            }

            // ── Step 2: Fast-exit for standard case (no optimistics, nothing new) ─────
            const oid = pendingOptimisticIdRef.current
            const optimisticIdx = oid !== null ? prev.findIndex(m => m.id === oid) : -1
            const isOptimistic = optimisticIdx >= 0
            const orphans = isOptimistic ? [] : prev.filter(m => typeof m.id === 'number')

            if (!isOptimistic && orphans.length === 0) {
              // No pending messages — fast-exit if nothing changed
              const lastBase = base[base.length - 1]
              const lastPrev = prevServer[prevServer.length - 1]
              if (lastBase && lastPrev &&
                  getMsgTs(lastBase) > 0 && getMsgTs(lastBase) === getMsgTs(lastPrev) &&
                  base.length === prevServer.length) {
                return prev
              }
              return base
            }

            // ── Step 3: Handle active optimistic ────────────────────────────────
            if (isOptimistic) {
              const optimistic = prev[optimisticIdx]
              const optimisticText = extractText(optimistic.content).substring(0, 80).trim()
              const serverAlreadyHasMsg = !!optimisticText && base.some(
                m => m.role === 'user' && typeof m.id !== 'number' &&
                     extractText(m.content).substring(0, 80).trim() === optimisticText
              )
              if (!serverAlreadyHasMsg) {
                // Also preserve other rapid-send messages (earlier optimistics that became "orphans"
                // because pendingOptimisticIdRef only tracks the latest send)
                const pendingOrphans = prev.filter(m => typeof m.id === 'number' && m.id !== oid).filter(o => {
                  const oText = extractText(o.content).substring(0, 80).trim()
                  if (!oText) return true // image-only: keep, can't match by text
                  return !base.some(bm => bm.role === 'user' && typeof bm.id !== 'number' &&
                    extractText(bm.content).substring(0, 80).trim() === oText)
                })
                return [...base, ...pendingOrphans, optimistic]
              }
              // Server confirmed — drop optimistic
              confirmedOptimisticRef.current = oid
              pendingOptimisticIdRef.current = null
              return base
            }

            // ── Step 4: Handle orphaned optimistics ────────────────────────────
            if (orphans.length > 0) {
              const serverHasOrphans = orphans.every(o => {
                const oText = extractText(o.content).substring(0, 80).trim()
                return !!oText && base.some(
                  m => m.role === 'user' && typeof m.id !== 'number' &&
                       extractText(m.content).substring(0, 80).trim() === oText
                )
              })
              if (!serverHasOrphans) return [...base, ...orphans]
              return base
            }

            return base
          })
          return
        }

        // History response — match by prefix so load-more requests (sent from a separate effect) are also handled
        if (msg.type === 'res' && msg.ok && msg.id?.startsWith(`chat-history-${sessionKey}-`)) {
          let msgs: ChatMessage[] = msg.payload?.messages || []
          // WS chat.history strips base64 from image blocks.
          // Restore from: 1) current state 2) localStorage cache 3) async HTTP (server enriches from JSONL)
          const hasEmptyImages = msgs.some(m =>
            m.role === 'user' && Array.isArray(m.content) &&
            (m.content as ContentBlock[]).some(b => b.type === 'image' && !(b as Record<string,unknown>).data)
          )
          if (hasEmptyImages) {
            // WS chat.history strips base64 from image blocks (gateway optimization).
            // Re-fetch via HTTP: the Octis server enriches image blocks from the JSONL.
            authFetch(`${API}/api/chat-history?sessionKey=${encodeURIComponent(sessionKey)}&limit=${historyLimitRef.current}`)
              .then(r => r.json())
              .then((d: { ok?: boolean; messages?: ChatMessage[] }) => {
                if (!d.ok || !d.messages?.length) return
                // Replace state with enriched HTTP response and update cache
                setMessages(d.messages)
                saveMsgCache(sessionKey, d.messages)
              })
              .catch(() => {})
          }
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
          if (msgs.length > 0) saveMsgCache(sessionKey, msgs)
          // Show "load older" button if response filled the limit (more messages may exist)
          setHasMore(msgs.length >= historyLimitRef.current)
          setMessages((prev) => {
            if (msgs.length === 0) return prev
            // Guard: never downgrade message count during an active agent run.
            // History fetches (esp. load-more) lag behind streaming — replacing state would
            // make messages visually disappear until the agent finishes.
            if (runActiveRef.current) {
              const prevServer = prev.filter(m => typeof m.id !== 'number')
              if (msgs.length < prevServer.length) return prev
            }
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
            lastEventTsRef.current = Date.now()
            if (phase === 'start') {
              runActiveRef.current = true
              setIsWorking(true)
              if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
              workingTimeoutRef.current = setTimeout(() => { runActiveRef.current = false; setIsWorking(false); setWorkingTool(null) }, 10 * 60 * 1000)
            } else if (phase === 'end' || phase === 'error') {
              runActiveRef.current = false
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
            lastEventTsRef.current = Date.now()
            if (phase === 'start') {
              setIsWorking(true)
              if (toolName) setWorkingTool(toolName)
              if (workingTimeoutRef.current) clearTimeout(workingTimeoutRef.current)
              workingTimeoutRef.current = setTimeout(() => { setIsWorking(false); setWorkingTool(null) }, 5 * 60 * 1000)
            }
            return
          }

          // -- Delta: streaming tokens --
          if (evtState === 'delta') {
            lastEventTsRef.current = Date.now()
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
              // Guard: only replace when the echo has real content - empty/flush echoes
              // would blank the optimistic and cause a visible "disappear then reappear" flicker.
              const hasContent = !!extractText(chatMsg.content).trim()
              if (hasContent) {
                const oid = pendingOptimisticIdRef.current
                if (oid !== null) {
                  const optimisticIdx = prev.findIndex((m) => m.id === oid)
                  if (optimisticIdx >= 0) {
                    const optimistic = prev[optimisticIdx]
                    // If WS echo lacks MediaPaths but optimistic had image blocks (base64 preview),
                    // keep the optimistic content so the image stays visible until poll confirms MediaPath.
                    const echoHasImages = (chatMsg.MediaPaths?.length || 0) > 0 || !!chatMsg.MediaPath
                    const optimisticHasImages = !echoHasImages && Array.isArray(optimistic.content) &&
                      (optimistic.content as ContentBlock[]).some(b => (b as {type:string}).type === 'image')
                    const mergedMsg = optimisticHasImages
                      ? { ...chatMsg, content: optimistic.content } // preserve base64 until poll patches MediaPath
                      : chatMsg
                    const next = [...prev]
                    next[optimisticIdx] = mergedMsg
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
  }, [sessionKey, ws, connected, send, setCard]) // historyLimitRef used internally — no dep needed

  // Load-more: when historyLimit increases, re-fetch history WITHOUT re-running the full WS effect.
  // The WS message handler matches by prefix so it picks up the response automatically.
  const historyLimitPrevRef = useRef(200)
  useEffect(() => {
    if (historyLimit === historyLimitPrevRef.current) return
    historyLimitPrevRef.current = historyLimit
    if (!sessionKey || !connected || !ws) return
    if (loadedSessionRef.current !== sessionKey) return // main WS effect handles initial load
    send({ type: 'req', id: `chat-history-${sessionKey}-${Date.now()}`, method: 'chat.history', params: { sessionKey, limit: historyLimit } })
  }, [historyLimit, sessionKey, connected, ws, send])

  // Auto-refresh on return: if tab was hidden and user comes back, immediately fetch history.
  // Prevents the "no reply after 1h" issue where idle poll was paused while hidden.
  useEffect(() => {
    if (!sessionKey || !ws || !connected) return
    let hiddenAt = 0
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      // Refresh on return from any meaningful absence (>10s).
      // Use chat-poll- prefix so the response goes through the existing poll handler.
      const awayMs = hiddenAt > 0 ? Date.now() - hiddenAt : 0
      if (awayMs > 10_000) {
        // Reset scroll so the latest messages scroll into view on return.
        userScrolledUpRef.current = false
        const pollId = `chat-poll-${sessionKey}-${Date.now()}`
        send({ type: 'req', id: pollId, method: 'chat.history', params: { sessionKey, limit: 100 } })
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [sessionKey, ws, connected, send])

  // Polling fallback - two-tier: fast only while waiting for reply, slow otherwise.
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

  // Fast poll (2s) - only while actively waiting for a reply.
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
      body: JSON.stringify({ messages: slim, model: localStorage.getItem('octis-rename-model') || undefined }),
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

  // Auto-rename is intentionally NOT fired automatically here.
  // It must be triggered manually via the ✨ star button in the pane header.
  // Removing the auto-fire useEffect prevents silent token burns on every session open.

  useEffect(() => {
    // Skip auto-scroll when we just loaded older messages (useLayoutEffect handled that)
    if (wasLoadingOlderRef.current) {
      wasLoadingOlderRef.current = false
      return
    }
    // Skip scroll during initial load — useLayoutEffect already snapped to bottom before paint
    if (isInitialScrollRef.current) return
    // Only smooth-scroll new messages when history is fully loaded.
    // Prevents the "refresh flash" when a history re-fetch (reconnect / end-of-run poll)
    // replaces messages and triggers an unwanted scroll to bottom.
    if (loadedKey !== sessionKey) return
    if (!userScrolledUpRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loadedKey, sessionKey])

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
    const API_BASE = (window as {VITE_API_URL?: string}).VITE_API_URL || import.meta.env.VITE_API_URL || ''
    let imgSrc = ''
    if (src?.type === 'base64' && src.data) {
      imgSrc = `data:${src.media_type || 'image/png'};base64,${src.data}`
    } else if (src?.url) {
      imgSrc = src.url
    } else if (directData) {
      imgSrc = `data:${directMime || 'image/png'};base64,${directData}`
    } else if (src?.type === 'file' && (src as Record<string,unknown>).path) {
      const filePath = (src as Record<string,unknown>).path as string
      const filename = filePath.split('/').pop() || ''
      imgSrc = `${API_BASE}/api/media/${encodeURIComponent(filename)}`
    } else if ((block.path || block.file_path) as string | undefined) {
      const filePath = (block.path || block.file_path) as string
      const filename = filePath.split('/').pop() || ''
      imgSrc = `${API_BASE}/api/media/${encodeURIComponent(filename)}`
    }
    if (!imgSrc) return null
    return (
      <div key={key} className="my-1 cursor-pointer rounded-xl overflow-hidden inline-block" style={{ maxWidth: 220, maxHeight: 180 }}
        onClick={() => setLightboxSrc(imgSrc)}>
        <img src={imgSrc} alt="image" className="w-full h-full object-cover hover:opacity-90 transition-opacity"
          style={{ maxWidth: 220, maxHeight: 180 }}
          onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
      </div>
    )
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
        return null  // content-block image — MediaPaths render handles the actual preview
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
      try {
        await authFetch(`${API}/api/session-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey, projectSlug: pendingInit }),
        })
      } catch (e) {
        console.error('[octis] session-init failed:', e)
      }
    }
    const pendingPrefix = consumePendingProjectPrefix(sessionKey)
    let msg = pendingPrefix && input.trim()
      ? `${pendingPrefix}\n\n${input.trim()}`
      : pendingPrefix || input.trim()

    // Prepend reply context so the agent knows which message is being replied to
    if (replyingTo) {
      const roleName = replyingTo.role === 'assistant' ? 'AI' : 'You'
      const safePreview = replyingTo.preview.replace(/"/g, "'").slice(0, 120)
      const idPart = replyingTo.id !== undefined ? ` (${replyingTo.id})` : ''
      msg = `[Replying to ${roleName}${idPart}: "${safePreview}"]\n\n${msg}`
      setReplyingTo(null)
    }

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
    void sendChat({ sessionKey, message: msg, idempotencyKey, deliver: false, attachments: attachments })
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
    // Cancel any pending draft-save debounce — otherwise the 300ms timer fires AFTER clearDraft
    // and re-saves the just-sent text as a new draft (stale draft bug).
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null }
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
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() => {
    // Initialize from draft on mount — same pattern as input/text
    if (!sessionKey) return []
    const data = getDraftData(sessionKey)
    if (!data.files || data.files.length === 0) return []
    return data.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[]
  })
  // Sync pendingFiles to draft when files are added/removed (safe here — pendingFiles is declared above)
  useEffect(() => {
    if (!sessionKey) return
    setDraft(sessionKey, input, pendingFiles)
  }, [pendingFiles, sessionKey]) // eslint-disable-line react-hooks/exhaustive-deps
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
        body: JSON.stringify({ messages: slim, model: localStorage.getItem('octis-rename-model') || undefined }),
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

  // Helper: send a quick-action message with an optimistic entry so it appears immediately.
  // Same pattern as handleSend — the poll/WS echo will confirm + replace it.
  const sendQuickAction = (msg: string, prefix: string) => {
    if (!sessionKey) return
    const idempotencyKey = `octis-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sendChat({ sessionKey, message: msg, deliver: false, idempotencyKey })
    // Add optimistic so message is visible immediately (avoids "message missing" race)
    const optimisticId = Date.now()
    pendingOptimisticIdRef.current = optimisticId
    setMessages(prev => [...prev, { role: 'user', content: msg, id: optimisticId }])
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

  const handleBriefMe    = () => sendQuickAction(getQuickCommands().brief, 'brief')
  const handlePause      = () => sendQuickAction('Pause. Summarize the current state in 3-5 bullet points so we can resume cleanly later: what was decided, what\'s in progress, what\'s next, any blockers. Then stop and wait for me.', 'pause')
  const handleContinue   = () => sendQuickAction('Continue from where we left off. Review the last state summary and resume the next action.', 'continue')
  const handleSave       = () => sendQuickAction(getQuickCommands().save, 'save')
  const handleSteppingAway = () => sendQuickAction(getQuickCommands().away, 'away')

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const handleDelete = async () => {
    if (!sessionKey) return
    setShowDeleteConfirm(false)
    // Remove from active panes
    onClose()
    setSessions(sessions.filter((s: Session) => s.key !== sessionKey))
    const { activePanes, pinToPane } = useSessionStore.getState()
    activePanes.forEach((p: string | null, i: number) => { if (p === sessionKey) pinToPane(i, null) })
    // Keep session in hidden filter so WS sessions.list broadcast can't revive it
    useHiddenStore.getState().hide(sessionKey)
    // Remove from Archives display
    useSessionStore.getState().setHiddenSessions(
      useSessionStore.getState().hiddenSessions.filter((s: Session) => s.key !== sessionKey)
    )
    // Call server to delete from DB + gateway
    authFetch(`${API}/api/session-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    }).catch(e => console.error('delete failed:', e))
    // Clear localStorage cache
    localStorage.removeItem(`octis-msgs-${sessionKey}`)
    localStorage.removeItem(`octis-draft-${sessionKey}`)
  }

  const handleArchive = () => {
    if (!sessionKey) return
    if (confirm('Save and archive this session?')) {
      // Send save instruction to agent (fire-and-forget - NO_REPLY expected)
      const msg = getQuickCommands().archive_msg
      const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
      sendChat({ sessionKey, message: msg, deliver: false, idempotencyKey })
      // Hide only - no gateway delete (sessions needed for productivity audits)
      // Permanently hide from sidebar so gateway sessions.list can't re-surface it
      useHiddenStore.getState().hide(sessionKey)
      setSessions(sessions.filter((s: Session) => s.key !== sessionKey))
      onClose()
    }
  }

  if (!sessionKey) {
    const handleNewSession = () => {
      const key = `session-${Date.now()}`
      useAuthStore.getState().claimSession(key)  // claim before setSessions so ownership check passes
      setSessions([{ key, label: 'New session', sessionKey: key }, ...useSessionStore.getState().sessions])
      const { activePanes: ap, paneCount: pc, pinToPane: pin, setPaneCount: setPC } = useSessionStore.getState()
      const emptyPane = ap.findIndex((p: string | null, i: number) => i < pc && !p)
      if (emptyPane >= 0) { pin(emptyPane, key) }
      else if (pc < 8) { setPC(pc + 1); pin(pc, key) }
      else { pin(pc - 1, key) }
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
      className={`flex min-w-0 border-r border-[#2a3142] transition-all relative ${isFeatured ? 'flex-[3]' : 'flex-1'} ${isFocused ? 'shadow-[inset_3px_0_0_#818cf8,inset_20px_0_32px_rgba(129,140,248,0.08)]' : ''}`}
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
        {/* Status bar at top: animated purple when running, amber when quiet-run, solid green when idle */}
        <div className="h-0.5 w-full shrink-0 overflow-hidden">
          {showWorking && !runQuiet ? (
            <div
              className="h-full bg-gradient-to-r from-transparent via-[#a855f7] to-transparent"
              style={{ animation: 'slide 1.4s ease-in-out infinite', width: '60%' }}
            />
          ) : runQuiet ? (
            <div
              className="h-full bg-gradient-to-r from-transparent via-[#f59e0b] to-transparent"
              style={{ animation: 'slide 2s ease-in-out infinite', width: '60%' }}
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
                <span
                  className="w-2 h-2 rounded-full animate-pulse shrink-0"
                  style={{ background: runQuiet ? '#f59e0b' : '#a855f7' }}
                  title={runQuiet ? 'Running quietly (no events >60s)' : workingTool ? `Running: ${workingTool}` : 'Working...'}
                />
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
                  {(() => { const slug = getTag(sessionKey).project; const emoji = slug ? getProjectEmoji(slug) : ''; return emoji ? <span className="text-[13px] shrink-0 leading-none" title={slug}>{emoji}</span> : null })()}
                  <span
                    className="text-sm font-medium text-white truncate leading-none"
                    title={sessionKey}
                  >
                    {displayName}
                  </span>
                  <button
                    className="opacity-65 hover:opacity-100 transition-opacity text-[11px] text-[#6b7280] hover:text-indigo-400 shrink-0 px-0.5"
                    title="AI auto-rename"
                    disabled={autoNaming}
                    onClick={() => { void handleAutoRename() }}
                  >
                    {autoNaming ? '...' : '✨'}
                  </button>
                </>
              )}
              {runQuiet && (
                <span className="text-[10px] text-[#f59e0b] shrink-0 truncate max-w-[140px] animate-pulse">Running quietly...</span>
              )}
              {!runQuiet && showWorking && workingTool && (
                <span className="text-[10px] text-[#a855f7] shrink-0 truncate max-w-[120px]">{workingTool}...</span>
              )}
            </div>

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
              title="Dev Log — update OCTIS_CHANGES.md"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-indigo-400"
            >
              📝
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
              onClick={() => setCardOpen((s) => !s)}
              title="Session brief"
              className={`h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm ${sessionCard ? 'text-[#a5b4fc] hover:text-white' : 'text-[#3a4152]'}`}
            >
              📋
            </button>
            <div className="w-px h-4 bg-[#2a3142] mx-0.5 shrink-0" />
            <button
              onClick={handleArchive}
              title="Save & archive session"
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm text-[#6b7280] hover:text-yellow-400"
            >
              📦
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              title="Delete session permanently"
              className="h-6 px-1.5 flex items-center justify-center rounded bg-red-900/10 border border-red-900/20 hover:bg-red-900/30 hover:border-red-700/40 transition-colors text-[10px] text-red-400/50 hover:text-red-400 gap-0.5 shrink-0"
            >
              <span>🗑️</span><span className="font-medium">Del</span>
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
          className="flex-1 overflow-y-auto px-4 py-3 space-y-3 chat-scroll"
          onScroll={() => {
            const el = scrollContainerRef.current
            if (!el) return
            // Consider "at bottom" if within 80px of bottom
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            userScrolledUpRef.current = !atBottom
            // Auto-load older messages when scrolled within 150px of the top
            if (el.scrollTop < 150 && hasMore && !isLoadingOlderRef.current) {
              isLoadingOlderRef.current = true
              savedScrollHeightRef.current = el.scrollHeight
              setHistoryLimit(prev => prev + 100)
            }
          }}
        >
          {hasMore && (
            <div className="flex justify-center py-2">
              {isLoadingOlderRef.current ? (
                <span className="text-xs text-[#6b7280] animate-pulse">↑ Loading older messages…</span>
              ) : (
                <button
                  onClick={() => {
                    const el = scrollContainerRef.current
                    if (el) savedScrollHeightRef.current = el.scrollHeight
                    isLoadingOlderRef.current = true
                    setHistoryLimit(prev => prev + 100)
                  }}
                  className="text-xs text-[#6b7280] hover:text-[#a5b4fc] px-3 py-1 rounded-lg hover:bg-[#2a3142] transition-colors"
                >
                  ↑ Load older messages
                </button>
              )}
            </div>
          )}
          {/* Skeleton loader — shown when no messages yet and still loading */}
          {messages.length === 0 && loadedKey !== sessionKey && sessionKey && (
            <div className="space-y-3 px-2 py-3 animate-pulse">
              {[...Array(4)].map((_, i) => (
                <div key={i} className={`flex gap-2 ${i % 3 === 2 ? 'justify-end' : 'justify-start'}`}>
                  <div className={`rounded-xl px-3 py-2 ${i % 3 === 2 ? 'bg-[#6366f1]/30 rounded-br-sm' : 'bg-[#1e2330] rounded-bl-sm'}`}
                    style={{ width: `${[65, 45, 55, 40][i]}%`, height: '2.5rem' }} />
                </div>
              ))}
            </div>
          )}
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
              const msgKey = msg.id !== undefined ? String(msg.id) : String(getMsgTs(msg) || `${msg.role}-${i}`)
              return (
              <React.Fragment key={msgKey}>
              <div
                data-msg-key={msgKey}
                className={`flex gap-2 items-end ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                onMouseEnter={() => setHoveredMsgKey(msgKey)}
                onMouseLeave={() => setHoveredMsgKey(null)}
              >
                {/* Reply button — appears left of user messages on hover */}
                {msg.role === 'user' && (
                  <button
                    onClick={() => setReplyingTo({ id: msg.id, role: 'user', preview: stripReplyCtxText(extractText(msg.content)).slice(0, 120) })}
                    className={`bg-transparent border-0 outline-none text-[#a0aec0] hover:text-white transition-all duration-100 shrink-0 mb-2 leading-none select-none p-0 text-base ${hoveredMsgKey === msgKey ? 'opacity-70 hover:opacity-100' : 'opacity-0 pointer-events-none'}`}
                    title="Reply"
                  >{'\u21A9'}</button>
                )}
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl ${
                    msg.role === 'user'
                      ? 'bg-[#6366f1] text-white rounded-br-sm text-sm octis-user-bubble'
                      : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                  }`}
                  style={highlightedMsgKey === msgKey ? { animation: 'octisFlash 1.4s ease-out forwards' } : {}}
                >
                  {/* Render gateway-stored media attachments (MediaPath/MediaPaths from chat.send) */}
                  {/* ─ Media attachments: grid thumbnails + lightbox ──────────────────────────── */}
                  {(() => {
                    const paths: string[] = msg.MediaPaths && msg.MediaPaths.length > 0
                      ? msg.MediaPaths
                      : msg.MediaPath ? [msg.MediaPath] : []
                    if (paths.length === 0) return null
                    const count = paths.length
                    // Thumb size: 1 image = large, 2–4 = medium grid, 5+ = small grid
                    const thumbSize = count === 1 ? 200 : count <= 4 ? 110 : 80
                    return (
                      <div className="flex flex-wrap gap-1 my-1" style={{ maxWidth: count === 1 ? 210 : Math.min(count, 3) * (thumbSize + 4) + 4 }}>
                        {paths.map((p, i) => {
                          const filename = p.split('/').pop() || ''
                          const mime = msg.MediaPaths ? (msg.MediaTypes?.[i] || msg.MediaType || '') : (msg.MediaType || '')
                          const src = `${API}/api/media/${encodeURIComponent(filename)}`
                          if (mime.includes('pdf')) {
                            return <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-2 bg-[#4f51c0] rounded-lg px-3 py-2 max-w-xs no-underline">
                              <span className="text-2xl">📄</span>
                              <span className="text-xs text-white truncate">{filename}</span>
                            </a>
                          }
                          return (
                            <div key={i}
                              className="cursor-pointer rounded-lg overflow-hidden flex-shrink-0 hover:opacity-90 transition-opacity"
                              style={{ width: thumbSize, height: thumbSize }}
                              onClick={() => setLightboxSrc(src)}
                            >
                              <img src={src} alt="attachment" className="w-full h-full object-cover"
                                onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                  {/* Reply quote bubble — shown when message starts with reply context */}
                  {(() => {
                    const rc = getReplyCtx(msg.content)
                    if (!rc) return null
                    const handleJump = () => {
                      const container = scrollContainerRef.current
                      if (!container) return
                      const findEl = (key: string) =>
                        container.querySelector<HTMLElement>(`[data-msg-key="${key}"]`)
                      const doScroll = (el: HTMLElement, key: string) => {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        setHighlightedMsgKey(key)
                        setTimeout(() => setHighlightedMsgKey(null), 1500)
                      }
                      // Primary: jump by embedded message ID (scoped to this pane)
                      if (rc.msgId) {
                        const el = findEl(rc.msgId)
                        if (el) { doScroll(el, rc.msgId); return }
                      }
                      // Fallback: search messages array chronologically, skip self
                      const previewSnip = rc.preview.slice(0, 60).toLowerCase()
                      const visible = messages.filter(m => !isHeartbeatMsg(m) && !(noiseHidden && isNoiseMsg(m)))
                      for (let idx = 0; idx < visible.length; idx++) {
                        const m = visible[idx]
                        if (m === msg) continue
                        const mText = stripReplyCtxText(extractText(m.content)).toLowerCase()
                        if (mText.includes(previewSnip)) {
                          const mKey = m.id !== undefined ? String(m.id) : String(getMsgTs(m) || `${m.role}-${idx}`)
                          const el = findEl(mKey)
                          if (el) doScroll(el, mKey)
                          return
                        }
                      }
                    }
                    return <ReplyQuoteBubble role={rc.role} preview={rc.preview} isUserMsg={msg.role === 'user'} onJump={handleJump} />
                  })()}
                  {/* user text-only content gets whitespace-pre-wrap; array (image+text) does not */}
                  {(() => {
                    const stripped = stripReplyCtx(msg.content)
                    return msg.role === 'user' && typeof stripped === 'string'
                      ? <span className="whitespace-pre-wrap">{renderContent(stripped)}</span>
                      : renderContent(stripped)
                  })()}
                  {showTs && (
                    <div className={`text-[10px] mt-1 ${msg.role === 'user' ? 'text-[#a5b4fc] text-right' : 'text-[#4b5563]'}`}>
                      {fmtMsgTs(msgTs)}
                    </div>
                  )}
                  {msg.role === 'assistant' && (
                    <DecisionButtons
                      text={extractText(msg.content)}
                      onSelect={(letter) => {
                        if (!sessionKey) return
                        void sendChat({ sessionKey, message: letter })
                      }}
                    />
                  )}
                </div>
                {/* Reply button — appears right of assistant messages on hover */}
                {msg.role === 'assistant' && (
                  <button
                    onClick={() => setReplyingTo({ id: msg.id, role: 'assistant', preview: stripReplyCtxText(extractText(msg.content)).slice(0, 120) })}
                    className={`bg-transparent border-0 outline-none text-[#a0aec0] hover:text-white transition-all duration-100 shrink-0 mb-2 leading-none select-none p-0 text-base ${hoveredMsgKey === msgKey ? 'opacity-70 hover:opacity-100' : 'opacity-0 pointer-events-none'}`}
                    title="Reply"
                  >{'\u21A9'}</button>
                )}
              </div>
              </React.Fragment>
              )
            })}
          {showWorking && (
            <div className="flex gap-2 justify-start">
              <div
                className="px-3 py-2 rounded-xl rounded-bl-sm text-xs flex items-center gap-2"
                style={{
                  background: runQuiet ? '#451a03' : '#1e2330',
                  color: runQuiet ? '#fbbf24' : '#6b7280',
                }}
              >
                <span className="inline-flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: runQuiet ? '#f59e0b' : '#6366f1', animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: runQuiet ? '#f59e0b' : '#6366f1', animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: runQuiet ? '#f59e0b' : '#6366f1', animationDelay: '300ms' }} />
                </span>
                <span>{runQuiet ? 'Running quietly...' : workingTool ? `${workingTool}...` : 'thinking...'}</span>
              </div>
            </div>
          )}
          {messages.length > 0 && lastMsgTime && (
            <div className="flex justify-end pr-1 -mt-1 pb-1">
              <span className="text-[9px] text-[#3a4152] select-none">· {lastMsgTime}</span>
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
          {/* Reply preview bar — shown when replying to a message */}
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 bg-[#1a1f2e] border border-[#2a3142] rounded-lg px-2.5 py-1.5">
              <span className="text-[#6366f1] text-sm shrink-0 leading-none">↩</span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-semibold text-[#6366f1] mb-0.5">
                  Replying to {replyingTo.role === 'assistant' ? 'AI' : 'you'}
                </div>
                <div className="text-xs text-[#6b7280] truncate">{replyingTo.preview}</div>
              </div>
              <button
                onClick={() => setReplyingTo(null)}
                className="text-[#6b7280] hover:text-white shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-[#2a3142] transition-colors text-sm"
                title="Cancel reply"
              >✕</button>
            </div>
          )}
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
          {/* Draft indicator */}
          {input.trim() && !showWorking && (
            <div className="flex items-center gap-1 px-1 pb-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 opacity-70" />
              <span className="text-[10px] text-[#6b7280]">Draft saved</span>
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
              placeholder="Message..."
              value={input}
              rows={1}
              onChange={(e) => {
                const val = e.target.value
                inputUndo.push(input) // push BEFORE update (input = value before change)
                setInput(val)
                // Debounce draft - avoids Zustand re-render on every keystroke
                if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
                draftTimerRef.current = setTimeout(() => { if (sessionKey) setDraft(sessionKey, val, pendingFiles) }, 300)
                // Height via rAF - avoids forced layout reflow on every keystroke
                const ta = e.target
                requestAnimationFrame(() => {
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px'
                })
              }}
              onKeyDown={(e) => {
                // Escape cancels active reply
                if (e.key === 'Escape' && replyingTo) { e.preventDefault(); setReplyingTo(null); return }
                // Undo/redo (Word-style burst coalescing) — must check before Enter
                if (inputUndo.handleKeyDown(e, input, (v) => {
                  setInput(v)
                  if (sessionKey) setDraft(sessionKey, v, pendingFiles)
                  setTimeout(resizeTextarea, 0)
                })) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              onPaste={handlePaste}
            />
            <button
              onClick={handleSend}
              className="bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg px-4 text-sm font-medium transition-colors self-end md:hidden"
              style={{ height: '38px' }}
            >
              ↑
            </button>
          </div>
        </div>
      </div>


      {showDeleteConfirm && sessionKey && (
        <DeleteConfirmModal
          sessionLabel={getLabel(sessionKey) || sessions.find((s: Session) => s.key === sessionKey)?.label || sessionKey}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* ─ Image lightbox ──────────────────────────────────────────────────────── */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[300] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxSrc(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setLightboxSrc(null) }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white text-xl transition-colors"
            onClick={() => setLightboxSrc(null)}
            title="Close (Esc)"
          >×</button>
          {/* Image — click stops propagation so clicking image itself doesn’t close */}
          <img
            src={lightboxSrc}
            alt="Full size"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl select-none"
            onClick={(e) => e.stopPropagation()}
          />
          {/* Open in new tab */}
          <a
            href={lightboxSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-4 right-4 text-xs text-white/50 hover:text-white/80 transition-colors"
            onClick={(e) => e.stopPropagation()}
          >↗ open in new tab</a>
        </div>
      )}
    </div>
  )
}
