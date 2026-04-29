import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { useGatewayStore, useSessionStore, useProjectStore, useLabelStore, useDraftStore, Session, DraftData } from '../store/gatewayStore'
import { authFetch } from '../lib/authFetch'
import { useTextareaUndo } from '../hooks/useTextareaUndo'
import { useAuthStore } from '../store/authStore'
import DecisionButtons from './DecisionButtons'

// Quick Commands helpers
const QUICK_COMMAND_DEFAULTS = {
  brief: "if applicable: update memory/module1-email-rules.md with all relevant decision and information in this session",
  away: "I am stepping away for a while. Please do the following:\n1. Summarize what you are currently working on (1-2 sentences).\n2. List anything you are blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\n3. List everything you CAN do autonomously while I am gone, in order.\n4. Estimate how long you can run without me.\nBe concise. I will read this on my phone.",
  save: "Before ending, update MEMORY.md/TODOS.md, checked against full project context. MEMORY.md = durable reusable context; TODOS.md = clear pending tasks. For long updates, inspect current memory + verified project files first; preserve useful context, clean duplicates/conflicts, add missing recurring info/preferences/source-checking safeguards, and flag uncertainty instead of guessing. Do not save temporary noise, assumptions, secrets, or ambiguous info. Only claim saved if file update succeeded; summarize memory changes, TODOs, cleanup, and anything not confidently added.\n\nIf this session modified Octis code, update `/opt/octis/OCTIS_CHANGES.md` with only relevant dev work since last log update: code changes, fixes, config/schema/API/dependency changes, decisions, known issues, and test/verification results. Keep entries clear and specific so the original GitHub app owner understands what changed, why, what was tested, and what needs review. Never claim logged/fixed/tested unless actually done.",
  archive_msg: "💾 Final save - If not already save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.",
}

function getQuickCommands() {
  try {
    return { ...QUICK_COMMAND_DEFAULTS, ...JSON.parse(localStorage.getItem('octis-quick-commands') || '{}') }
  } catch { return { ...QUICK_COMMAND_DEFAULTS } }
}

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
function renderImageBlock(b: ContentBlock | Record<string, unknown>, key: number, onLightbox?: (src: string) => void): React.ReactNode {
  const block = b as Record<string, unknown>;
  const src = block.source as { type?: string; data?: string; media_type?: string; url?: string } | undefined;
  const directData = block.data as string | undefined;
  const directMime = (block.mimeType || block.media_type) as string | undefined;
  const API_BASE = (window as {VITE_API_URL?: string}).VITE_API_URL || '';
  let imgSrc = '';
  if (src?.type === 'base64' && src.data) {
    imgSrc = `data:${src.media_type || 'image/png'};base64,${src.data}`;
  } else if (src?.url) {
    imgSrc = src.url;
  } else if (directData) {
    imgSrc = `data:${directMime || 'image/png'};base64,${directData}`;
  } else if (src?.type === 'file' && (src as Record<string,unknown>).path) {
    const filename = ((src as Record<string,unknown>).path as string).split('/').pop() || '';
    imgSrc = `${API_BASE}/api/media/${encodeURIComponent(filename)}`;
  } else if (block.path || block.file_path) {
    const filename = ((block.path || block.file_path) as string).split('/').pop() || '';
    imgSrc = `${API_BASE}/api/media/${encodeURIComponent(filename)}`;
  }
  if (!imgSrc) return null;
  return (
    <div key={key} className="my-1 cursor-pointer rounded-xl overflow-hidden inline-block" style={{ maxWidth: 220, maxHeight: 180 }}
      onClick={() => onLightbox?.(imgSrc)}>
      <img src={imgSrc} alt="image" className="w-full h-full object-cover hover:opacity-90 transition-opacity"
        style={{ maxWidth: 220, maxHeight: 180 }}
        onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} />
    </div>
  );
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
  // Handle bare data URI images (e.g. base64 QR codes)
  if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(text.trim())) {
    return <img key={key} src={text.trim()} alt="image"
      className="max-w-full rounded-lg my-1 max-h-64 object-contain"
      style={{ maxWidth: '100%', borderRadius: '8px' }}
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
  }

  // Render text with clickable URLs and inline images
  const lines = text.split('\n')
  const rendered = lines.flatMap((line, li) => {
    // Markdown image: ![alt](url)
    const mdImg = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/)
    if (mdImg) {
      return [<img key={`img-${li}`} src={mdImg[2]} alt={mdImg[1]}
        className="max-w-full rounded-lg my-1 max-h-64 object-contain"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />]
    }
    // MEDIA:<url> directive
    const mediaLine = line.match(/^MEDIA:(https?:\/\/\S+)$/)
    if (mediaLine) {
      const mUrl = mediaLine[1]
      const isImg = /\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(mUrl)
      return [isImg
        ? <img key={`m-${li}`} src={mUrl} alt="image"
            className="max-w-full rounded-lg my-1 max-h-64 object-contain"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        : <a key={`m-${li}`} href={mUrl} target="_blank" rel="noopener noreferrer"
            className="text-[#818cf8] underline break-all">{mUrl}</a>]
    }
    // Data URI image on its own line
    if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(line.trim())) {
      return [<img key={`di-${li}`} src={line.trim()} alt="image"
        className="max-w-full rounded-lg my-1 max-h-64 object-contain"
        style={{ maxWidth: '100%', borderRadius: '8px' }}
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />]
    }

    // Split by URLs to make them clickable
    const urlParts = line.split(/(https?:\/\/[^\s<>"{}|\\^`\[\]*]+)/g)
    const lineNodes = urlParts.map((p, pi) =>
      /^https?:\/\//.test(p)
        ? <a key={pi} href={p} target="_blank" rel="noopener noreferrer"
            className="text-[#818cf8] underline break-all">{p}</a>
        : <span key={pi}>{p}</span>
    )
    return [<span key={`line-${li}`}>{lineNodes}{li < lines.length - 1 ? '\n' : ''}</span>]
  })
  return <span key={key} style={{ whiteSpace: 'pre-wrap' }}>{rendered}</span>
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
    // System-injected lifecycle messages (memory flush, compaction, etc.)
    if (text.startsWith('Pre-compaction memory flush') || text.startsWith('Pre-compaction context flush')) return true
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


// ─── Mobile Model Badge ──────────────────────────────────────────────────────

interface MobileModelInfo {
  model: string
  displayName: string
  provider: string
  isFallback: boolean
  defaultModel: string
  fallbacks: string[]
}

interface MobileProviderHealth {
  errorCount: number
  lastFailureAt: number | null
  healthy: boolean
}

function mobileModelShortName(modelId: string): string {
  const map: Record<string, string> = {
    'anthropic/claude-sonnet-4-6': 'Sonnet',
    'anthropic/claude-sonnet-4-5': 'Sonnet',
    'anthropic/claude-opus-4-5': 'Opus',
    'anthropic/claude-opus-4': 'Opus',
    'anthropic/claude-haiku-4-5': 'Haiku',
    'anthropic/claude-haiku-4': 'Haiku',
    'google/gemini-2.0-flash': 'Gemini Flash',
    'google/gemini-2.0-pro': 'Gemini Pro',
    'google/gemini-1.5-pro': 'Gemini 1.5 Pro',
    'google/gemini-1.5-flash': 'Gemini Flash',
    'openai/gpt-4o': 'GPT-4o',
    'openai/gpt-4o-mini': 'GPT-4o mini',
  }
  if (map[modelId]) return map[modelId]
  const parts = modelId.split('/')
  return parts[parts.length - 1] || modelId
}

function MobileModelBadge({ sessionKey }: { sessionKey: string }) {
  const [modelInfo, setModelInfo] = useState<MobileModelInfo | null>(null)
  const [providerHealth, setProviderHealth] = useState<Record<string, MobileProviderHealth>>({})
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const { sendChat } = useGatewayStore()

  const fetchModel = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/api/session-model?sessionKey=${encodeURIComponent(sessionKey)}`)
      if (res.ok) setModelInfo(await res.json())
    } catch {}
  }, [sessionKey])

  const fetchHealth = useCallback(async () => {
    try {
      const res = await authFetch(`${API}/api/provider-health`)
      if (res.ok) {
        const data = await res.json()
        setProviderHealth(data.providers || {})
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchModel()
    fetchHealth()
    const t = setInterval(() => { fetchModel(); fetchHealth() }, 30000)
    return () => clearInterval(t)
  }, [fetchModel, fetchHealth])

  const switchModel = async (modelId: string) => {
    setOpen(false)
    setSwitching(true)
    const { ws, connected } = useGatewayStore.getState()
    // Use sessions.patch to set model override directly
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'req',
        id: `model-switch-${Date.now()}`,
        method: 'sessions.patch',
        params: { key: sessionKey, model: modelId },
      }))
    }
    setTimeout(() => { void fetchModel(); setSwitching(false) }, 2000)
  }

  if (!modelInfo) return null

  const isFallback = modelInfo.isFallback
  const pillClass = isFallback
    ? 'bg-amber-900/40 text-amber-300 border-amber-600/50'
    : 'bg-[#1e2330] text-[#a5b4fc] border-[#2a3142]'

  const allModels = [modelInfo.defaultModel, ...modelInfo.fallbacks].filter(
    (m, i, arr) => arr.indexOf(m) === i
  )

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        title={`Model: ${modelInfo.model}${isFallback ? ' (fallback)' : ''}`}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-mono select-none ${
          switching ? 'opacity-50' : ''
        } ${pillClass}`}
      >
        {isFallback && <span>⚡</span>}
        <span>{switching ? '...' : modelInfo.displayName}</span>
        <span className="text-[8px] opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 bg-[#1a1f2e] border border-[#2a3142] rounded-xl shadow-2xl p-2 min-w-[190px] text-xs">
          <div className="text-[#6b7280] text-[10px] font-medium px-2 pb-1.5">Switch model</div>
          {allModels.map(m => {
            const provName = m.split('/')[0]
            const health = providerHealth[provName]
            const hasError = health && health.errorCount > 0 && !health.healthy
            const isCurrent = modelInfo.model === m
            return (
              <button
                key={m}
                onClick={() => switchModel(m)}
                className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left ${
                  isCurrent ? 'bg-[#6366f1]/20 text-[#a5b4fc]' : 'text-[#e8eaf0]'
                }`}
              >
                <span className="flex-1">{mobileModelShortName(m)}</span>
                {hasError && <span className="text-amber-400">⚠</span>}
                {isCurrent && <span className="text-[#6366f1]">✓</span>}
              </button>
            )
          })}
          <button
            onClick={() => setOpen(false)}
            className="w-full text-center text-[#6b7280] text-[10px] pt-1.5 pb-0.5"
          >Close</button>
        </div>
      )}
    </div>
  )
}

// ─── Reply helpers (mirrors ChatPane) ──────────────────────────────────────────────

function getMobileReplyCtx(content: MessageContent): { role: string; preview: string; msgId?: string } | null {
  const text = extractText(content)
  const m = text.match(/^\[Replying to ([^(:]+?)(?:\s*\(([^)]+)\))?:\s*"([^"]{0,150})"\]\n\n/)
  if (!m) return null
  return { role: m[1].trim(), preview: m[3], msgId: m[2] || undefined }
}

function stripMobileReplyCtxText(text: string): string {
  return text.replace(/^\[Replying to [^:]+: "[^"]{0,150}"\]\n\n/, '')
}

function stripMobileReplyCtx(content: MessageContent): MessageContent {
  if (typeof content === 'string') return stripMobileReplyCtxText(content)
  if (Array.isArray(content)) {
    const arr = content as ContentBlock[]
    const firstTextIdx = arr.findIndex(b => b.type === 'text')
    if (firstTextIdx === -1) return content
    const ft = arr[firstTextIdx] as ContentBlock & { text: string }
    const stripped = stripMobileReplyCtxText(ft.text)
    if (stripped === ft.text) return content
    const updated = [...arr]
    updated[firstTextIdx] = { ...ft, text: stripped }
    return updated
  }
  return content
}

function MobileReplyQuoteBubble({ role, preview, isUserMsg, onJump }: { role: string; preview: string; isUserMsg: boolean; onJump?: () => void }) {
  return (
    <div
      className={`mb-1.5 px-2 py-1 rounded-lg border-l-2 text-xs max-w-full ${
        isUserMsg ? 'bg-[#4f51c0]/30 border-[#a5b4fc]/70' : 'bg-[#0f1117]/60 border-[#4b5563]'
      } ${onJump ? 'active:opacity-70' : ''}`}
      style={{ opacity: onJump ? 0.9 : undefined }}
      onPointerDown={e => onJump && e.stopPropagation()}
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
const MAX_MESSAGES_PER_SESSION = 200
const DEFAULT_HISTORY_LIMIT = 200
const LOAD_MORE_INCREMENT = 100

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
  const { send, sendChat, ws, connect, connected } = useGatewayStore()
  const { consumePendingProjectInit, getStatus } = useSessionStore()
  const { getLabel, setLabel } = useLabelStore()
  const { claimSession } = useAuthStore()
  // Initialize from cache if available
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const cached = session?.key ? getMsgCache(session.key) : null
    return (cached && cached.length > 0) ? cached : []
  })
  const [loadedKey, setLoadedKey] = useState<string | null>(session?.key && getMsgCache(session.key) ? session.key : null)
  const { getDraft, getDraftData, setDraft, clearDraft, hydrateFromServer: hydrateDraftsFromServer } = useDraftStore()
  const [input, setInput] = useState(() => getDraftData(session?.key || '').text)
  type PendingFile = { dataUrl: string; mimeType: string; name: string; kind: 'image' | 'document' | 'video'; saveToWorkspace: boolean; extractedText?: string; extracting?: boolean; pages?: number; videoObjectUrl?: string; _key?: number }
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() => {
    // Initialize from draft on mount — same pattern as input/text above
    const data = getDraftData(session?.key || '')
    if (!data.files || data.files.length === 0) return []
    return data.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[]
  })
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
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const confirmedSentRef = useRef<number | null>(null)
  // Track message count before send — used to unblock polls once server confirms receipt
  const preSendCountRef = useRef<number>(0)
  const [noiseHidden, setNoiseHidden] = useState(() => {
    try { return localStorage.getItem('octis-noise-hidden') !== 'false' } catch { return true }
  })
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [autoRenaming, setAutoRenaming] = useState(false)
  const [historyLimit, setHistoryLimit] = useState(DEFAULT_HISTORY_LIMIT)
  const [hasMore, setHasMore] = useState(false)
  // Sync pendingFiles to draft when files change (images persist in draft)
  useEffect(() => {
    if (!session?.key) return
    setDraft(session.key, input, pendingFiles)
  }, [pendingFiles, session?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep historyLimitRef in sync so WS closures always see the latest value
  // (useState closures capture stale values; refs don't)
  useEffect(() => { historyLimitRef.current = historyLimit }, [historyLimit])

  // When hasMore becomes true and we're already near the visual top (high scrollTop in
  // flex-col-reverse), auto-trigger load without waiting for another scroll event.
  useEffect(() => {
    if (!hasMore || isLoadingMoreRef.current || loadedKey !== session?.key) return
    const el = scrollRef.current
    if (!el) return
    const nearTop = el.scrollTop >= el.scrollHeight - el.clientHeight - 150
    if (nearTop) {
      isLoadingMoreRef.current = true
      const newLimit = historyLimitRef.current + LOAD_MORE_INCREMENT
      historyLimitRef.current = newLimit
      setHistoryLimit(newLimit)
      setHasMore(false)
      const reqId = `chat-history-loadmore-${session?.key}-${Date.now()}`
      currentHistoryReqIdRef.current = reqId
      send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session?.key, limit: newLimit } })
    }
  }, [hasMore])

  // Cache-sync: write full server messages to cache whenever they update.
  // Never let poll writes (truncated) overwrite full history — the effect always
  // sees the post-merge state (guard ensures prev is never downgraded).
  useEffect(() => {
    if (!session?.key || messages.length === 0 || loadedKey !== session.key) return
    const serverMsgs = messages.filter(m => typeof m.id !== 'number')
    if (serverMsgs.length > 0) setMsgCache(session.key, serverMsgs)
  }, [messages, session?.key, loadedKey])

  // Clear reply state when session changes
  useEffect(() => {
    setReplyingTo(null)
    setHighlightedMsgKey(null)
  }, [session?.key]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showArchiveSheet, setShowArchiveSheet] = useState(false)
  const [copiedMsgId, setCopiedMsgId] = useState<string | number | null>(null)
  // Reply state
  const [replyingTo, setReplyingTo] = useState<{ id: string | number | undefined; role: 'user' | 'assistant'; preview: string } | null>(null)
  const [highlightedMsgKey, setHighlightedMsgKey] = useState<string | null>(null)
  const [swipeHint, setSwipeHint] = useState<string | null>(null)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const touchStartTime = useRef(0)
  const isDraggingRef = useRef(false)
  const isScrollingRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputUndo = useTextareaUndo()
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
  const historyLimitRef = useRef(DEFAULT_HISTORY_LIMIT) // always up-to-date in WS closures
  const isLoadingMoreRef = useRef(false) // prevents double-trigger on rapid scroll
  const wasLoadingMoreRef = useRef(false) // set before setMessages, consumed in useLayoutEffect to block scroll-to-bottom

  // Stable refs so the swipe useEffect never re-registers mid-gesture.
  // recentSessions + onSwitch get new references on every MobileApp render (slice, arrow fn);
  // putting them in the dep array causes listener teardown/re-add on every WS message —
  // which resets `locked` mid-swipe and kills the gesture. Refs fix this.
  const recentSessionsRef = useRef(recentSessions)
  recentSessionsRef.current = recentSessions
  const onSwitchRef = useRef(onSwitch)
  onSwitchRef.current = onSwitch
  const sessionKeyRef = useRef(session?.key)
  sessionKeyRef.current = session?.key

  // Horizontal swipe-to-switch.
  // Listener on outerRef (fixed non-scrollable wrapper) — iOS doesn’t compete here.
  // Runs ONCE on mount. Uses refs for fresh values without re-registering.
  useEffect(() => {
    const el = outerRef.current
    if (!el) return

    let startX = 0, startY = 0, startTime = 0
    let locked: 'none' | 'swipe' | 'scroll' = 'none'

    const onStart = (e: TouchEvent) => {
      // Don't intercept touches starting inside the recent sessions strip — let it scroll freely
      if (stripRef.current?.contains(e.target as Node)) return
      // Don't intercept left-edge swipes (iOS back gesture starts within 20px of left edge)
      if (e.touches[0].clientX < 20) return
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      startTime = Date.now()
      locked = 'none'
      el.style.transition = ''
    }

    // Visual target is the scroll container (messages only) — header + input stay fixed.
    // Gesture capture stays on outerRef so iOS doesn’t compete for the touch.
    const msgEl = () => scrollRef.current

    const onMove = (e: TouchEvent) => {
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      const adx = Math.abs(dx), ady = Math.abs(dy)

      if (locked === 'scroll') return
      if (locked === 'none') {
        if (adx < 15 && ady < 15) return
        if (adx < ady * 2.5) { locked = 'scroll'; return }
        locked = 'swipe'
      }

      e.preventDefault()
      const m = msgEl(); if (!m) return

      const sessions = recentSessionsRef.current
      const switchFn = onSwitchRef.current

      if (!sessions || !switchFn || sessions.length === 0) {
        m.style.transform = `translateX(${dx * 0.15}px)`
        return
      }

      const idx = sessions.findIndex(s => s.key === sessionKeyRef.current)
      const wouldGoTo = dx < 0 ? idx + 1 : idx - 1
      const atEdge = wouldGoTo < 0 || wouldGoTo >= sessions.length
      m.style.transform = `translateX(${atEdge ? dx * 0.15 : dx}px)`
    }

    const onEnd = (e: TouchEvent) => {
      const sessions = recentSessionsRef.current
      const switchFn = onSwitchRef.current
      const m = msgEl()
      if (locked !== 'swipe' || !sessions || !switchFn) {
        if (locked === 'swipe' && m) {
          m.style.transition = 'transform 200ms cubic-bezier(0.25,0.46,0.45,0.94)'
          m.style.transform = 'translateX(0)'
          setTimeout(() => { m.style.transition = '' }, 210)
        }
        locked = 'none'
        return
      }
      const deltaX = e.changedTouches[0].clientX - startX
      const deltaY = e.changedTouches[0].clientY - startY
      const elapsed = Date.now() - startTime
      const velocityX = Math.abs(deltaX) / Math.max(elapsed, 1)
      const isFastFlick = velocityX > 0.3 && Math.abs(deltaX) > 20
      const isLongSwipe = Math.abs(deltaX) >= 50 && Math.abs(deltaX) > Math.abs(deltaY) * 2
      if (!m || (!isFastFlick && !isLongSwipe)) {
        if (m) {
          m.style.transition = 'transform 200ms cubic-bezier(0.25,0.46,0.45,0.94)'
          m.style.transform = 'translateX(0)'
          setTimeout(() => { m.style.transition = '' }, 210)
        }
        locked = 'none'
        return
      }
      const idx = sessions.findIndex(s => s.key === sessionKeyRef.current)
      const newIdx = deltaX < 0 ? idx + 1 : idx - 1
      if (newIdx < 0 || newIdx >= sessions.length) {
        m.style.transition = 'transform 200ms cubic-bezier(0.25,0.46,0.45,0.94)'
        m.style.transform = 'translateX(0)'
        setTimeout(() => { m.style.transition = '' }, 210)
        locked = 'none'
        return
      }
      const target = deltaX < 0 ? '-100vw' : '100vw'
      setSwipeHint(deltaX < 0 ? 'Next →' : '← Previous')
      setTimeout(() => setSwipeHint(null), 600)
      m.style.transition = 'transform 180ms cubic-bezier(0.4,0,0.2,1)'
      m.style.transform = `translateX(${target})`
      setTimeout(() => {
        // Switch session FIRST so new content renders while off-screen (transform still set).
        // Then snap to center — new content appears without flash of old content.
        switchFn(sessions[newIdx])
        requestAnimationFrame(() => requestAnimationFrame(() => {
          m.style.transition = ''
          m.style.transform = ''
        }))
      }, 185)
      locked = 'none'
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
    }
  }, []) // stable — runs once, reads fresh values via refs

  // Scroll to bottom without triggering userScrolledUp detection
  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0 // flex-col-reverse: 0 = bottom
  }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)

  // ResizeObserver: re-compute textarea height when container width changes
  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    const ro = new ResizeObserver(() => {
      if (!ta.value) return
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, [])

  // HTTP history fetch — declared EARLY (before its first useEffect dep array) to avoid TDZ on iOS.
  // Must be declared before any useEffect that lists it in deps, or React evaluates dep array
  // during render before the const is initialized → "Cannot access before initialization".
  const fetchHistoryHttp = useCallback(async (limit: number) => {
    if (!session?.key) return
    try {
      const r = await fetch(`${API}/api/chat-history?sessionKey=${encodeURIComponent(session.key)}&limit=${limit}`, { credentials: 'include' })
      if (!r.ok) return
      const data = await r.json() as { ok: boolean; messages?: ChatMessage[] }
      if (!data.ok || !data.messages?.length) return
      setMessages(data.messages)
      setMsgCache(session.key, data.messages)
      const last = data.messages[data.messages.length - 1]
      if (last?.role === 'assistant') {
        const txt = typeof last.content === 'string' ? last.content.trim() : ''
        if (txt && txt !== 'HEARTBEAT_OK') setSending(false)
      }
    } catch { /* best-effort */ }
  }, [session?.key]) // eslint-disable-line react-hooks/exhaustive-deps

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
    let hiddenAt = 0
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      // Returning to visible
      const awayMs = hiddenAt > 0 ? Date.now() - hiddenAt : 0
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        // WS is alive — just refresh history immediately (no reconnect needed)
        // If away >60s, use larger limit to catch any missed replies
        const limit = awayMs > 60_000 ? historyLimit : 30
        send({ type: 'req', id: `chat-history-return-${session?.key}-${Date.now()}`, method: 'chat.history', params: { sessionKey: session?.key, limit } })
      } else {
        // WS dropped — fetch history via HTTP immediately so messages appear right away,
        // then reconnect in parallel (ws-change effect will also re-fetch once live).
        const limit = awayMs > 60_000 ? historyLimit : 30
        void fetchHistoryHttp(limit)
        connect()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [connect, connected, ws, session?.key, send, fetchHistoryHttp])

  // Claim session ownership when session opens
  useEffect(() => {
    if (session?.key) claimSession(session.key)
  }, [session?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session?.key || !ws) return

    // Load draft for new session
    inputUndo.reset() // new session = fresh undo history
    const localDraftData = getDraftData(session.key)
    setInput(localDraftData.text)
    if (localDraftData.files && localDraftData.files.length > 0) {
      setPendingFiles(localDraftData.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[])
    } else if (!localDraftData.text) {
      setPendingFiles([]) // clear files on session switch if no draft
    }
    // Resize textarea to fit draft content after DOM updates
    if (localDraftData.text) {
      requestAnimationFrame(() => {
        if (!inputRef.current) return
        inputRef.current.style.height = 'auto'
        inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
      })
    }
    // If no local draft, check server for cross-device draft
    if (!localDraftData.text && !localDraftData.files?.length) {
      void (async () => {
        try {
          const resp = await authFetch(`${API}/api/drafts/${encodeURIComponent(session.key)}`)
          if (!resp.ok) return
          const data = await resp.json()
          // Guard: skip if we already have any local draft (text or files)
          const currentData = getDraftData(session.key)
          if (data.text && !currentData.text && !(currentData.files?.length)) {
            const parsed: DraftData = (() => {
              try { const p = JSON.parse(data.text); if (p && typeof p === 'object' && 'text' in p) return p } catch {}
              return { text: data.text as string }
            })()
            setDraft(session.key, parsed.text, parsed.files)
            setInput(parsed.text)
            if (parsed.files?.length) setPendingFiles(parsed.files.map((f, i) => ({ ...f, _key: Date.now() + i })) as PendingFile[])
            requestAnimationFrame(() => {
              if (!inputRef.current) return
              inputRef.current.style.height = 'auto'
              inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
            })
          }
        } catch {}
      })()
    }
    // Only reset sending state on an actual session switch, NOT on WS reconnect.
    // Resetting on reconnect kills the thinking indicator and stops the fast poll
    // mid-response, causing replies to not appear without a hard refresh.
    const isSessionSwitch = prevSessionKeyRef.current !== session.key
    if (isSessionSwitch) setSending(false)
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
    // Reset limit + hasMore on session switch
    setHistoryLimit(DEFAULT_HISTORY_LIMIT)
    historyLimitRef.current = DEFAULT_HISTORY_LIMIT
    isLoadingMoreRef.current = false
    setHasMore(false)

    // Use proper req/method format (not old type-based format)
    const reqId = `chat-history-${session.key}-${Date.now()}`
    currentHistoryReqIdRef.current = reqId
    const sent = send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session.key, limit: DEFAULT_HISTORY_LIMIT } })
    // WS not ready yet — fetch via HTTP immediately so messages don't wait for WS to connect
    if (!sent) void fetchHistoryHttp(DEFAULT_HISTORY_LIMIT)

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

          // Content-match is the authoritative check for user-message confirmation.
          // Count-only check (msgs.length > preSendCountRef) fires false positives when
          // any background message (heartbeat, tool call) increments the count — causing
          // the optimistic to be dropped and sending cleared against the OLD assistant reply.
          const pendingRaw = localStorage.getItem(`octis-pending-${session.key}`)
          let serverHasUserMsg = false
          if (pendingRaw) {
            try {
              const { text } = JSON.parse(pendingRaw) as { text: string; timestamp: number }
              serverHasUserMsg = !!text && msgs.some(m => {
                if (m.role !== 'user' || typeof m.id === 'number') return false
                if (typeof m.content === 'string') return m.content.slice(0, 80) === text.slice(0, 80)
                if (Array.isArray(m.content)) {
                  const textBlock = (m.content as Array<{type: string; text?: string}>).find(b => b.type === 'text')
                  return (textBlock?.text || '').slice(0, 80) === text.slice(0, 80)
                }
                return false
              })
            } catch {}
          } else {
            // No pending entry — not in a send or already confirmed. Use count as fallback.
            serverHasUserMsg = msgs.length > preSendCountRef.current
          }

          if (serverHasUserMsg) {
            localStorage.removeItem(`octis-pending-${session.key}`)
          }

          // Apply server messages. Guard: never downgrade loaded history with a shorter poll.
          // Old code returned [...msgs, ...optimistics] where msgs was the 30-msg poll result,
          // collapsing 200-msg history to 30 whenever an optimistic message was active.
          setMessages((prev) => {
            if (msgs.length === 0) return prev
            // Compute base: keep prev if poll is truncated, appending only new messages
            const prevServer = prev.filter(m => typeof m.id !== 'number')
            let base: ChatMessage[]
            if (msgs.length >= prevServer.length) {
              base = msgs
            } else {
              const prevTs = new Set(prevServer.map(m => getMsgTs(m)).filter(ts => ts > 0))
              const prevFp = new Set(prevServer.filter(m => getMsgTs(m) === 0).map(m =>
                `${m.role}:${extractText(m.content).substring(0, 100)}`
              ))
              const newOnes = msgs.filter(m => {
                const ts = getMsgTs(m)
                if (ts > 0) return !prevTs.has(ts)
                return !prevFp.has(`${m.role}:${extractText(m.content).substring(0, 100)}`)
              })
              base = newOnes.length > 0 ? [...prevServer, ...newOnes] : prevServer
            }
            // Preserve optimistic messages until server confirms
            const optimistics = prev.filter(m => typeof m.id === 'number')
            if (optimistics.length > 0 && !serverHasUserMsg) {
              return [...base, ...optimistics]
            }
            return base
          })

          // Cache is written by the cache-sync effect below (not here), because poll
          // results are truncated (30 msgs) and would overwrite the full 200-msg cache.

          // Clear sending only when server confirmed our user message AND assistant replied.
          // This prevents clearing against the previous exchange’s assistant reply.
          if (serverHasUserMsg) {
            const lastMsg = msgs[msgs.length - 1]
            if (lastMsg?.role === 'assistant') {
              const txt = typeof lastMsg.content === 'string' ? lastMsg.content.trim() : ''
              if (txt && txt !== 'HEARTBEAT_OK') setSending(false)
            }
          }
          return
        }

        // History response (match current reqId — handles re-sent requests after reconnect)
        if (msg.type === 'res' && msg.id === currentHistoryReqIdRef.current && msg.ok) {
          let msgs: ChatMessage[] = msg.payload?.messages || []
          // WS strips base64 from image blocks. Restore from cache, fallback to HTTP.
          const hasEmptyImages = msgs.some(m =>
            m.role === 'user' && Array.isArray(m.content) &&
            (m.content as ContentBlock[]).some(b => (b as {type:string}).type === 'image' && !(b as Record<string,unknown>).data)
          )
          if (hasEmptyImages) {
            fetch(`${API}/api/chat-history?sessionKey=${encodeURIComponent(session.key)}&limit=${historyLimitRef.current}`, { credentials: 'include' })
              .then(r => r.json())
              .then((d: { ok?: boolean; messages?: ChatMessage[] }) => {
                if (!d.ok || !d.messages?.length) return
                setMessages(d.messages as ChatMessage[])
                setMsgCache(session.key, d.messages as ChatMessage[])
              })
              .catch(() => {})
          }
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
          // Don't clear sending here — the poll handler and streaming handler own that.
          // Clearing on every history load (when pendingRaw is null) kills the thinking
          // indicator and stops the fast poll mid-response.
          // Signal useLayoutEffect to NOT scroll to visual bottom (user was scrolled up reading history).
          // Must be set BEFORE setMessages so the layout effect sees it during this commit.
          wasLoadingMoreRef.current = true
          isLoadingMoreRef.current = false
          setMessages(finalMsgs)
          setLoadedKey(session.key)
          // Show load-more button if we got a full page (more may exist)
          // Use ref instead of state to avoid stale closure (historyLimit may have changed since request)
          setHasMore(finalMsgs.length >= historyLimitRef.current)
          // Write to cache after receiving fresh history
          setMsgCache(session.key, finalMsgs)
        }

        // Streaming event
        if (msg.type === 'event' && msg.event === 'chat') {
          const payload = msg.payload as { sessionKey?: string; role?: string; content?: string; id?: string | number }
          if (payload?.sessionKey === session.key) {
            // Only clear sending when actual assistant content arrives.
            // Empty/flush events and lifecycle events fire immediately when the model
            // starts processing — clearing sending at that point breaks two things:
            //   1. The optimistic message guard (poll drops it since sendingRef=false)
            //   2. The message queue (follow-up send can't queue, fires immediately)
            const hasAssistantContent = !!(payload.content && payload.role === 'assistant')
            if (hasAssistantContent) {
              setSending(false)
              localStorage.removeItem(`octis-pending-${session.key}`)
              setSentQueue(prev => prev.filter(e => e.status === 'sending'))
            }
            // Only update messages if content is non-empty — empty payloads are flush events
            if (payload.content) {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === payload.id)
                if (idx >= 0) {
                  const next = [...prev]
                  next[idx] = { ...next[idx], content: payload.content || '' }
                  return next
                }
                // User echo: replace pending optimistic rather than appending a duplicate
                if (payload.role === 'user') {
                  const hasContent = !!(payload.content || '').trim()
                  if (hasContent) {
                    const optimisticIdx = prev.findIndex(m => typeof m.id === 'number')
                    if (optimisticIdx >= 0) {
                      const optimistic = prev[optimisticIdx]
                      const echoHasImages = Array.isArray(payload.content) &&
                        (payload.content as ContentBlock[]).some((b: {type:string}) => b.type === 'image')
                      const optimisticHasImages = Array.isArray(optimistic.content) &&
                        (optimistic.content as ContentBlock[]).some(b => (b as {type:string}).type === 'image')
                      const mergedContent = (optimisticHasImages && !echoHasImages)
                        ? optimistic.content
                        : (payload.content || '')
                      const next = [...prev]
                      next[optimisticIdx] = { role: 'user', content: mergedContent, id: payload.id }
                      return next
                    }
                  }
                  return prev // let poll handle confirmation
                }
                return [...prev, { role: payload.role || 'assistant', content: payload.content || '', id: payload.id }]
              })
            }
          }
        }

        // Flat chat event (older gateway)
        if (msg.type === 'chat' && msg.sessionKey === session.key) {
          // Only clear sending on actual assistant replies, not user echoes
          if (msg.role === 'assistant' && msg.content) setSending(false)
          setSentQueue(prev => prev.filter(e => e.status === 'sending'))
          const flatMsg: ChatMessage = { role: msg.role || 'assistant', content: msg.content || '', id: msg.id_msg }
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === flatMsg.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], content: flatMsg.content }
              return next
            }
            // User echo: replace pending optimistic rather than appending a duplicate
            if (flatMsg.role === 'user') {
              const hasContent = !!(flatMsg.content || '').trim()
              if (hasContent) {
                const optimisticIdx = prev.findIndex(m => typeof m.id === 'number')
                if (optimisticIdx >= 0) {
                  const optimistic = prev[optimisticIdx]
                  const echoHasImages = Array.isArray(flatMsg.content) &&
                    (flatMsg.content as ContentBlock[]).some(b => (b as {type:string}).type === 'image')
                  const optimisticHasImages = Array.isArray(optimistic.content) &&
                    (optimistic.content as ContentBlock[]).some(b => (b as {type:string}).type === 'image')
                  const mergedMsg = (optimisticHasImages && !echoHasImages)
                    ? { ...flatMsg, content: optimistic.content }
                    : flatMsg
                  const next = [...prev]
                  next[optimisticIdx] = mergedMsg
                  return next
                }
              }
              return prev // let poll handle confirmation
            }
            return [...prev, flatMsg]
          })
        }
      } catch {}
    }

    ws.addEventListener('message', handleMsg)
    return () => ws.removeEventListener('message', handleMsg)
  }, [session?.key, ws, send])

  // Re-fetch history whenever the connection (re-)establishes.
  // IMPORTANT: do NOT gate this on loadedKey — that guard prevented re-fetches after
  // app resume/reconnect, leaving the user looking at stale cached messages until
  // they manually switched sessions. Every reconnect should pull fresh history.
  useEffect(() => {
    if (!connected || !session?.key || !ws) return
    const reqId = `chat-history-reconnect-${session.key}-${Date.now()}`
    currentHistoryReqIdRef.current = reqId
    send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session.key, limit: historyLimit } })
  }, [connected, session?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Idle poll (15s) — WS when connected, HTTP when WS is dead.
  // Runs regardless of WS state so replies always arrive even when disconnected.
  useEffect(() => {
    if (!session?.key) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (sendingRef.current) return // fast-poll handles this
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        send({ type: 'req', id: `chat-poll-mobile-${session.key}-${Date.now()}`, method: 'chat.history', params: { sessionKey: session.key, limit: 30 } })
      } else {
        void fetchHistoryHttp(30)
      }
    }, 15000)
    return () => clearInterval(interval)
  }, [session?.key, ws, connected, send, fetchHistoryHttp])

  // Fast poll (3s) — only while waiting for a reply. WS or HTTP fallback.
  useEffect(() => {
    if (!session?.key || !sending) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        send({ type: 'req', id: `chat-poll-mobile-${session.key}-${Date.now()}`, method: 'chat.history', params: { sessionKey: session.key, limit: 50 } })
      } else {
        void fetchHistoryHttp(50)
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [session?.key, ws, connected, sending, send, fetchHistoryHttp])

  // Track message count for "new message arrived" detection (used for auto-scroll with col-reverse).
  // useLayoutEffect fires synchronously before paint — eliminates the visible scroll jerk
  // that occurs when useEffect fires after the browser has already painted the old position.
  useLayoutEffect(() => {
    const newCount = messages.length
    const hadNewMessage = newCount > lastMsgCountRef.current
    lastMsgCountRef.current = newCount
    if (!hadNewMessage) return
    // When loading older messages, NEVER scroll to visual bottom regardless of userScrolledUpRef.
    // wasLoadingMoreRef is set by the WS handler before setMessages, consumed here once.
    if (wasLoadingMoreRef.current) {
      wasLoadingMoreRef.current = false
      return
    }
    // Only scroll if user hasn't scrolled up to read history.
    // Don't force-scroll on background poll refreshes — that jerks the view away from history.
    // Force-scroll only when the user is actively in a conversation (not scrolled up).
    if (!userScrolledUpRef.current) {
      const el = scrollRef.current
      if (el) {
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
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
      setInput('')
      clearDraft(session.key)
      return
    }
    let msg = effectiveInput.trim()

    // Prepend reply context so the agent knows which message is being replied to
    if (replyingTo && !overrideMsg) {
      const roleName = replyingTo.role === 'assistant' ? 'AI' : 'You'
      const safePreview = replyingTo.preview.replace(/"/g, "'").slice(0, 120)
      const idPart = replyingTo.id !== undefined ? ` (${replyingTo.id})` : ''
      msg = `[Replying to ${roleName}${idPart}: "${safePreview}"]\n\n${msg}`
      setReplyingTo(null)
    }

    // Save to workspace if toggled for any file
    for (const pf of pendingFiles.filter(f => f.saveToWorkspace)) {
      try {
        const token = null
        const res = await authFetch(`${API}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
      try {
        await authFetch(`${API}/api/session-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey: session.key, projectSlug: pendingInit }),
        })
      } catch (e) {
        console.error('[octis-mobile] session-init failed:', e)
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
    // sendChat uses WS if alive, falls back to HTTP if WS is dead/zombie
    sendChat({ sessionKey: session.key, message: msg, idempotencyKey, deliver: false, attachments: attachments })
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
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = null
    setInput('')
    clearDraft(session.key)
    // Reset textarea height to 1 line after send
    if (inputRef.current) { inputRef.current.style.height = 'auto' }
    preSendCountRef.current = messages.filter(m => typeof m.id !== 'number').length  // server-only count; excludes any orphaned optimistics
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


  // Native touch isolation for the recent sessions strip.
  // React's onTouchMove stopPropagation only stops synthetic events — native listeners on outerRef
  // (swipe handler) and the browser's scroll discovery can still fire. Using a non-passive native
  // touchmove listener that calls stopPropagation + conditionally preventDefault stops both:
  // - prevents the swipe-to-switch gesture from hijacking strip scrolls
  // - prevents the vertical touch component from leaking into the messages scroll container
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const onTouchMove = (e: TouchEvent) => {
      e.stopPropagation()
      // Suppress vertical scroll propagation to the messages container
      if (e.cancelable) e.preventDefault()
    }
    const onTouchStart = (e: TouchEvent) => e.stopPropagation()
    const onTouchEnd = (e: TouchEvent) => e.stopPropagation()
    strip.addEventListener('touchstart', onTouchStart, { passive: true })
    strip.addEventListener('touchmove', onTouchMove, { passive: false })
    strip.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      strip.removeEventListener('touchstart', onTouchStart)
      strip.removeEventListener('touchmove', onTouchMove)
      strip.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

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

  const { getTag, getProjectEmoji, setTag, projectMeta } = useProjectStore()
  const label = getLabel(session?.key || '') || session?.label || session?.key || 'Chat'
  const [showAssignSheet, setShowAssignSheet] = useState(false)
  const handleReassign = (slug: string) => {
    setTag(session.key, slug)
    setShowAssignSheet(false)
    authFetch('/api/session-projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: session.key, projectTag: slug }),
    }).catch(() => {})
  }

  const startEditing = () => {
    setRenameValue(label)
    setEditing(true)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleRename = () => {
    const trimmed = renameValue.trim()
    if (!trimmed) { setEditing(false); return }
    setLabel(session.key, trimmed)
    send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { key: session.key, label: trimmed } })
    void authFetch(`${API}/api/session-rename`, {
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
        body: JSON.stringify({ messages: slim, model: localStorage.getItem('octis-rename-model') || undefined }),
      })
      const data = await res.json() as { label?: string }
      if (data.label) {
        setLabel(session.key, data.label)
        send({ type: 'req', id: `sessions-patch-${Date.now()}`, method: 'sessions.patch', params: { key: session.key, label: data.label } })
        void authFetch(`${API}/api/session-rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionKey: session.key, label: data.label }),
        })
      }
    } catch {}
    setAutoRenaming(false)
  }

  return (
    <div ref={outerRef} data-testid="chat-swipe-area" className="bg-[#181c24] flex flex-col overflow-hidden" style={{ position: 'fixed', top: 0, left: 0, right: 0 }}>
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
        <MobileModelBadge sessionKey={session.key} />
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
        {(() => {
          const qc = getQuickCommands()
          const quickActions = [
            { icon: '📝', label: 'Dev Log', msg: qc.brief },
            { icon: '🚪', label: 'Away', msg: qc.away },
            { icon: '💾', label: 'Save', msg: qc.save },
          ]
          return quickActions.map(({ icon, label, msg }) => (
          <button
            key={label}
            onClick={() => {
              const idempotencyKey = `octis-quick-${Date.now()}-${Math.random().toString(36).slice(2)}`
              sendChat({ sessionKey: session.key, message: msg, idempotencyKey })
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
          ))
        })()}
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
          style={{ scrollbarWidth: 'none', touchAction: 'pan-x', overscrollBehavior: 'contain' } as React.CSSProperties}
          onScroll={(e) => { stripScrollLeft.current = (e.target as HTMLDivElement).scrollLeft }}
        >
          {recentSessions.map((s) => {
            const pillEmoji = getProjectEmoji(getTag(s.key).project || '')
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
                {pillEmoji && <span className="text-[10px]">{pillEmoji}</span>}
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
        data-testid="chat-messages-scroll"
        className="h-full overflow-y-auto px-4 py-3 space-y-3 space-y-reverse flex flex-col-reverse" style={{ overflowAnchor: 'none' } as React.CSSProperties}
        // Touch handlers are on the DOM element via useEffect (non-passive, for preventDefault support)
        onScroll={() => {
          if (programmaticScrollRef.current) return
          const el = scrollRef.current
          if (!el) return
          // With flex-col-reverse, scrollTop=0 is the bottom. User scrolled up = scrollTop > 80
          userScrolledUpRef.current = el.scrollTop > 80
          // Auto-trigger load-more when user scrolls near the top (visual top = high scrollTop in col-reverse)
          if (hasMore && loadedKey === session?.key && !isLoadingMoreRef.current) {
            const nearTop = el.scrollTop >= el.scrollHeight - el.clientHeight - 150
            if (nearTop) {
              isLoadingMoreRef.current = true
              const newLimit = historyLimitRef.current + LOAD_MORE_INCREMENT
              historyLimitRef.current = newLimit
              setHistoryLimit(newLimit)
              setHasMore(false)
              const reqId = `chat-history-loadmore-${session?.key}-${Date.now()}`
              currentHistoryReqIdRef.current = reqId
              send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session?.key, limit: newLimit } })
            }
          }
        }}
      >
        {/* Loading indicator when no messages and history not yet loaded */}
        {/* Thinking dots — must be FIRST child in flex-col-reverse so they appear at visual bottom */}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-[#1e2330] px-4 py-3 rounded-2xl rounded-bl-sm flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '200ms' }} />
              <span className="w-2 h-2 rounded-full bg-[#6b7280] inline-block" style={{ animation: 'typingBounce 1.2s infinite', animationDelay: '400ms' }} />
            </div>
          </div>
        )}
        {loadedKey !== session?.key && messages.length === 0 && (
          <div className="flex flex-col gap-3 px-4 py-4 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className={`flex ${i % 3 === 2 ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`rounded-2xl ${i % 3 === 2 ? 'bg-[#6366f1]/30' : 'bg-[#1e2330]'}`}
                  style={{ width: `${[62, 48, 55, 38][i]}%`, height: '2.8rem' }}
                />
              </div>
            ))}
            {!connected && (
              <div className="flex justify-center mt-4">
                <span className="text-xs text-[#4b5563]">Reconnecting…</span>
              </div>
            )}
          </div>
        )}
        {/* Show messages from cache while loading (when loadedKey doesn't match yet) */}
        {(() => {
          const showMessages = (loadedKey === session?.key || (loadedKey === null && messages.length > 0))
            ? messages
            : []
          // Reverse so newest is first in DOM — flex-col-reverse makes it appear at visual bottom
          const filtered = showMessages
            .filter((msg) => !isHeartbeatMsg(msg) && !(noiseHidden && isNoiseMsg(msg)) && !(msg.role === 'assistant' && extractText(msg.content).trimStart().startsWith('📁 **')))
            .filter((msg, idx, arr) => {
              // Dedup by id (same as ChatPane)
              if (msg.id !== undefined && msg.id !== null) {
                return arr.findIndex(m => m.id === msg.id) === idx
              }
              const fp = `${msg.role}-${extractText(msg.content).substring(0, 100)}`
              return arr.findIndex(m => m.id === undefined && `${m.role}-${extractText(m.content).substring(0, 100)}` === fp) === idx
            })
          const reversed = [...filtered].reverse()
          return (<>
            {reversed.map((msg, i) => (
            <div
              key={msg.id !== undefined ? String(msg.id) : i}
              data-msg-key={msg.id !== undefined ? String(msg.id) : String(getMsgTs(msg) || i)}
              className={`flex items-end gap-1 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* Reply button — left of user messages (always visible, subtle) */}
              {msg.role === 'user' && (
                <button
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); setReplyingTo({ id: msg.id, role: 'user', preview: stripMobileReplyCtxText(extractText(msg.content)).slice(0, 120) }) }}
                  className="bg-transparent border-0 outline-none text-[#4b5563]/50 active:text-[#a5b4fc] shrink-0 mb-2 leading-none text-sm select-none p-1.5 -mr-1"
                  style={{ fontFamily: 'inherit', WebkitAppearance: 'none' }}
                  title="Reply"
                >{'\u21A9\uFE0E'}</button>
              )}
              <div
                className={`max-w-[85%] px-3 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-[#6366f1] text-white rounded-br-sm'
                    : 'bg-[#1e2330] text-[#e8eaf0] rounded-bl-sm'
                }`}
                style={highlightedMsgKey === (msg.id !== undefined ? String(msg.id) : String(getMsgTs(msg) || i)) ? { animation: 'octisFlash 1.4s ease-out forwards' } : {}}
              >
                {(() => {
                    const paths: string[] = msg.MediaPaths && msg.MediaPaths.length > 0
                      ? msg.MediaPaths as string[]
                      : msg.MediaPath ? [msg.MediaPath as string] : []
                    if (paths.length === 0) return null
                    const count = paths.length
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
                {/* Reply quote bubble */}
                {(() => {
                  const rc = getMobileReplyCtx(msg.content)
                  if (!rc) return null
                  const handleJump = () => {
                    const container = scrollRef.current
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
                      const mText = stripMobileReplyCtxText(extractText(m.content)).toLowerCase()
                      if (mText.includes(previewSnip)) {
                        const mKey = m.id !== undefined ? String(m.id) : String(getMsgTs(m) || idx)
                        const el = findEl(mKey)
                        if (el) doScroll(el, mKey)
                        return
                      }
                    }
                  }
                  return <MobileReplyQuoteBubble role={rc.role} preview={rc.preview} isUserMsg={msg.role === 'user'} onJump={handleJump} />
                })()}
                {renderMessageContent(stripMobileReplyCtx(msg.content))}
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
                {msg.role === 'assistant' && (
                  <DecisionButtons
                    text={extractText(msg.content)}
                    onSelect={(letter) => handleSend(letter)}
                  />
                )}
              </div>
              {/* Reply button — right of assistant messages */}
              {msg.role === 'assistant' && (
                <button
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); setReplyingTo({ id: msg.id, role: 'assistant', preview: stripMobileReplyCtxText(extractText(msg.content)).slice(0, 120) }) }}
                  className="bg-transparent border-0 outline-none text-[#4b5563]/50 active:text-[#a5b4fc] shrink-0 mb-2 leading-none text-sm select-none p-1.5 -ml-1"
                  style={{ fontFamily: 'inherit', WebkitAppearance: 'none' }}
                  title="Reply"
                >{'\u21A9\uFE0E'}</button>
              )}
            </div>
          ))}
            {/* Load-more: LAST in DOM = visual TOP in flex-col-reverse */}
            {hasMore && loadedKey === session?.key && (
              <div className="flex justify-center py-3">
                {isLoadingMoreRef.current ? (
                  <span className="text-xs text-[#6b7280] animate-pulse">↑ Loading older messages…</span>
                ) : (
                  <button
                    onClick={() => {
                      if (isLoadingMoreRef.current) return
                      isLoadingMoreRef.current = true
                      const newLimit = historyLimitRef.current + LOAD_MORE_INCREMENT
                      historyLimitRef.current = newLimit
                      setHistoryLimit(newLimit)
                      setHasMore(false)
                      const reqId = `chat-history-loadmore-${session?.key}-${Date.now()}`
                      currentHistoryReqIdRef.current = reqId
                      send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: session?.key, limit: newLimit } })
                    }}
                    className="text-xs text-[#6366f1] bg-[#1e2330] px-4 py-2 rounded-full border border-[#6366f1]/30 active:opacity-70"
                  >
                    ↑ Load older
                  </button>
                )}
              </div>
            )}
          </>)
        })()}

      </div>
      </div>
      <div
        className="px-3 pt-2 pb-2 bg-[#181c24] border-t border-[#2a3142] shrink-0"
      >
        {/* Reply preview bar — shown when replying to a message */}
        {replyingTo && (
          <div className="mb-2 flex items-center gap-2 bg-[#1a1f2e] border border-[#2a3142] rounded-xl px-3 py-2">
            <span className="text-[#6366f1] text-base shrink-0 leading-none">↩</span>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold text-[#6366f1] mb-0.5">
                Replying to {replyingTo.role === 'assistant' ? 'AI' : 'you'}
              </div>
              <div className="text-xs text-[#6b7280] truncate">{replyingTo.preview}</div>
            </div>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => setReplyingTo(null)}
              className="text-[#6b7280] active:text-white shrink-0 w-6 h-6 flex items-center justify-center rounded-full active:bg-[#2a3142] text-sm"
            >✕</button>
          </div>
        )}
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
              const val = e.target.value
              inputUndo.push(input) // push BEFORE update
              setInput(val)
              // Debounce draft save — writing Zustand on every keystroke causes re-renders
              if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
              draftTimerRef.current = setTimeout(() => setDraft(session.key, val, pendingFiles), 300)
              // Height via rAF — avoids forced layout reflow (height='auto' flushes layout) on every key
              const el = e.target
              requestAnimationFrame(() => {
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 120) + 'px'
              })
            }}
            onKeyDown={(e) => {
              // Escape cancels active reply
              if (e.key === 'Escape' && replyingTo) { e.preventDefault(); setReplyingTo(null); return }
              inputUndo.handleKeyDown(e, input, (v) => {
                setInput(v)
                setDraft(session.key, v)
                requestAnimationFrame(() => {
                  if (!inputRef.current) return
                  inputRef.current.style.height = 'auto'
                  inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px'
                })
              })
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
              onClick={() => { setShowArchiveSheet(false); setShowAssignSheet(true) }}
              className="w-full text-left px-4 py-3.5 rounded-xl text-white text-sm hover:bg-[#2a3142] transition-colors flex items-center gap-3"
            >
              <span>{getProjectEmoji(getTag(session.key).project || '') || '📁'}</span>
              <span>Assign to project…</span>
            </button>
            <div className="border-t border-[#2a3142] my-1" />
            <button
              onClick={() => {
                setShowArchiveSheet(false)
                // Send final save instruction (fire-and-forget, NO_REPLY expected)
                const idempotencyKey = `octis-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`
                sendChat({
                  sessionKey: session.key,
                  message: getQuickCommands().archive_msg,
                  deliver: false,
                  idempotencyKey,
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

      {/* Assign to project sheet */}
      {showAssignSheet && (
        <div
          className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/60"
          onClick={() => setShowAssignSheet(false)}
        >
          <div
            className="bg-[#181c24] rounded-t-3xl border-t border-[#2a3142] px-4 pt-4 pb-8"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-10 h-1 bg-[#2a3142] rounded-full mx-auto mb-4" />
            <div className="text-[#6b7280] text-xs font-medium mb-3 px-1">Assign to project</div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {Object.entries(projectMeta)
                .filter(([slug]) => slug !== getTag(session.key).project)
                .map(([slug, meta]) => (
                  <button
                    key={slug}
                    onClick={() => handleReassign(slug)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left active:bg-[#2a3142] transition-colors"
                  >
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0" style={{ background: meta.color + '22', border: `1px solid ${meta.color}44` }}>
                      {meta.emoji}
                    </div>
                    <span className="text-sm font-medium text-white">{meta.name}</span>
                  </button>
                ))}
              {getTag(session.key).project && (
                <button
                  onClick={() => handleReassign('')}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left active:bg-[#2a3142] transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0 bg-[#1e2330] border border-[#2a3142]">📂</div>
                  <span className="text-sm text-[#6b7280]">Unassign from project</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* ─ Image lightbox ──────────────────────────────────────────────── */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[300] bg-black/90 flex items-center justify-center"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            className="absolute top-4 right-4 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 active:bg-white/20 text-white text-xl"
            onClick={() => setLightboxSrc(null)}
          >×</button>
          <img
            src={lightboxSrc}
            alt="Full size"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <a
            href={lightboxSrc}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-4 right-4 text-xs text-white/50"
            onClick={(e) => e.stopPropagation()}
          >↗ open in new tab</a>
        </div>
      )}
    </div>
  )
}
