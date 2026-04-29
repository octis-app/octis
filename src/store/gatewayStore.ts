import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { authFetch } from '../lib/authFetch'
import { useAuthStore } from './authStore'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  key: string
  sessionKey?: string
  id?: string
  sessionId?: string
  label?: string
  cost?: number
  updatedAt?: string | number
  lastActivity?: string | number
  updated_at?: string | number
  // Live usage fields from sessions.list
  estimatedCostUsd?: number
  totalTokens?: number
  contextTokens?: number
  status?: string
}

export interface SessionMeta {
  lastRole?: 'user' | 'assistant'
  isStreaming?: boolean
  unreadCount?: number
  lastExchangeCost?: number // cost of the most recent completed exchange
  runActive?: boolean    // true from lifecycle:start until lifecycle:end — authoritative run-in-progress signal
  lastEventTs?: number   // timestamp of last meaningful WS event for this session
}

export interface ProjectTag {
  project?: string
  card?: string
}

export type SessionStatus = 'working' | 'active' | 'stuck' | 'quiet'

type ConnState = 'disconnected' | 'connecting' | 'connected' | 'suspended'

interface GatewayState {
  gatewayUrl: string
  gatewayToken: string
  agentId: string
  connected: boolean
  ws: WebSocket | null
  pendingRequests: Record<string, unknown>
  _reconnectAttempts: number

  setCredentials: (url: string, token: string, agentId?: string) => void
  setAgentId: (agentId: string) => void
  setConnected: (connected: boolean) => void
  subscribe: (fn: (msg: unknown) => void) => () => void
  connect: () => void
  forceReconnect: () => void
  scheduleReconnect: () => void
  disconnect: () => void
  sendChat: (params: { sessionKey: string; message: string; idempotencyKey?: string; deliver?: boolean; attachments?: { type: string; mimeType: string; content: string }[] }) => Promise<{ ok: boolean; via: 'ws' | 'http'; runId?: string }>
  send: (payload: unknown) => boolean
  handleMessage: (msg: GatewayMessage) => void
}

interface GatewayMessage {
  type: string
  id?: string
  ok?: boolean
  event?: string
  payload?: {
    sessions?: RawSession[]
    sessionKey?: string
    role?: string
    [key: string]: unknown
  }
  sessions?: RawSession[]
  error?: { message?: string } | string
  sessionKey?: string
  role?: string
  content?: unknown
}

interface RawSession {
  key?: string
  sessionKey?: string
  id?: string
  sessionId?: string
  label?: string
  cost?: number
  updatedAt?: string | number
  estimatedCostUsd?: number
  totalTokens?: number
  contextTokens?: number
  status?: string
}

// ─── Device identity helpers (Web Crypto) ────────────────────────────────────

interface DeviceCache {
  privateKey: CryptoKey
  pubKeyB64: string
  deviceId: string
}

let _deviceCache: DeviceCache | null = null

async function getOrCreateDevice(): Promise<DeviceCache> {
  if (_deviceCache) return _deviceCache
  const stored = localStorage.getItem('octis-device')
  if (stored) {
    try {
      const d = JSON.parse(stored)
      const privRaw = Uint8Array.from(atob(d.privKeyB64), (c) => c.charCodeAt(0))
      const privateKey = await crypto.subtle.importKey('pkcs8', privRaw, { name: 'Ed25519' }, false, ['sign'])
      _deviceCache = { privateKey, pubKeyB64: d.pubKeyB64, deviceId: d.deviceId }
      return _deviceCache
    } catch (e) {
      console.warn('Failed to restore device key, generating new one', e)
    }
  }

  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pubKeyRaw = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(pubKeyRaw)))
  const hash = await crypto.subtle.digest('SHA-256', pubKeyRaw)
  const deviceId = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)

  const privRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const privKeyB64 = btoa(String.fromCharCode(...new Uint8Array(privRaw)))
  localStorage.setItem('octis-device', JSON.stringify({ pubKeyB64, privKeyB64, deviceId }))
  _deviceCache = { privateKey: keyPair.privateKey, pubKeyB64, deviceId }
  return _deviceCache
}

// Keep reference so tree-shaking doesn't remove it
void getOrCreateDevice

// ─── Shared message bus ───────────────────────────────────────────────────────

const listeners = new Set<(msg: unknown) => void>()
const emit = (msg: unknown) => listeners.forEach((fn) => fn(msg))

// ─── Auto-tag helpers ───────────────────────────────────────────────────────
// Sessions whose keys contain ':slack:' are automatically assigned to the
// 'Slack' project so they stay out of the main Sessions tab.
function autoTagSlackSessions(sessions: Session[]): void {
  // Defer until useProjectStore is initialized (it's defined later in this module)
  setTimeout(() => {
    const projectStore = useProjectStore.getState()
    for (const s of sessions) {
      if (s.key.includes(':slack:') && !projectStore.tags[s.key]?.project) {
        projectStore.setTag(s.key, 'Slack')
      }
      if (/whatsapp/i.test(s.key) && !projectStore.tags[s.key]?.project) {
        projectStore.setTag(s.key, 'WhatsApp')
      }
    }
  }, 0)
}

// ─── Gateway store ────────────────────────────────────────────────────────────

export const useGatewayStore = create<GatewayState>()(
  persist(
    (set, get) => ({
      gatewayUrl: import.meta.env.VITE_GATEWAY_URL || '',
      gatewayToken: import.meta.env.VITE_GATEWAY_TOKEN || '',
      agentId: '',
      connected: false,
      ws: null,
      pendingRequests: {},
      _reconnectAttempts: 0,

      setCredentials: (url, token, agentId) =>
        set({ gatewayUrl: url, gatewayToken: token, agentId: agentId || '' }),
      setAgentId: (agentId) => set({ agentId: agentId || '' }),
      setConnected: (connected) => set({ connected }),

      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },

      // ─── Connection (simplified) ─────────────────────────────────────────────
      // No state machine. Simple rule: onclose fires → schedule retry with backoff.
      // visibilitychange resets backoff and calls connect() if not connected.
      // This mirrors the pre-Apr19 code that was stable.

      connect: () => {
        const { gatewayUrl, connected, ws: oldWs } = get()
        if (!gatewayUrl) return

        if (!gatewayUrl) return
        // Guard: skip only if the socket is genuinely OPEN and connected.
        // NOT just connected=true — that can be a zombie (iOS killed TCP silently,
        // no onclose fired, connected flag stuck true). Check readyState too.
        if (connected && oldWs && oldWs.readyState === WebSocket.OPEN) return

        // Kill old socket cleanly
        if (oldWs) {
          oldWs.onclose = null; oldWs.onerror = null; oldWs.onmessage = null
          try { oldWs.close() } catch {}
        }
        set({ connected: false, ws: null })

        const wsUrl = gatewayUrl.startsWith('http') ? gatewayUrl.replace(/^http/, 'ws') : gatewayUrl
        const socket = new WebSocket(wsUrl)

        socket.onopen = () => { console.log('[octis] WS open, awaiting challenge...') }

        socket.onmessage = async (event: MessageEvent) => {
          if (get().ws !== socket) return
          try {
            const msg = JSON.parse(event.data as string) as GatewayMessage
            get().handleMessage(msg)
            emit(msg)
            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              if (socket.readyState !== WebSocket.OPEN) return
              const token = get().gatewayToken
              socket.send(JSON.stringify({
                type: 'req', id: 'octis-connect', method: 'connect',
                params: {
                  minProtocol: 3, maxProtocol: 3,
                  client: { id: 'openclaw-control-ui', version: '0.1.0', platform: 'web', mode: 'ui' },
                  role: 'operator',
                  scopes: ['operator.read', 'operator.write', 'operator.admin'],
                  caps: [], commands: [], permissions: {},
                  auth: { token },
                  locale: navigator.language || 'en-US',
                  userAgent: 'octis/0.1.0',
                },
              }))
              console.log('[octis] Sent connect response')
            }
          } catch (e) { console.warn('[octis] Failed to parse message', e) }
        }

        // Keepalive ping every 45s
        const pingInterval = setInterval(() => {
          if (get().ws === socket && socket.readyState === WebSocket.OPEN && get().connected)
            try { socket.send(JSON.stringify({ type: 'req', id: `ping-${Date.now()}`, method: 'sessions.list', params: { limit: 1 } })) } catch {} // keepalive — no agentId filter needed
        }, 45000)

        socket.onclose = (e: CloseEvent) => {
          clearInterval(pingInterval)
          if (get().ws !== socket) return
          console.log(`[octis] WS closed (${e.code})`)
          set({ ws: null, connected: false })
          // Always schedule reconnect regardless of visibility.
          // iOS fires onclose when JS resumes, so this works even after backgrounding.
          const attempts = get()._reconnectAttempts || 0
          const delay = Math.min(1000 * Math.pow(2, attempts), 10000)
          console.log(`[octis] Reconnecting in ${delay}ms (attempt ${attempts + 1})`)
          set({ _reconnectAttempts: attempts + 1 })
          setTimeout(() => {
            if (!useGatewayStore.getState().connected) useGatewayStore.getState().connect()
          }, delay)
        }

        socket.onerror = (e: Event) => {
          if (get().ws !== socket) return
          console.warn('[octis] WS error', e)
        }

        set({ ws: socket })
      },

      // Keep forceReconnect for watchdog — kills socket and reconnects immediately
      forceReconnect: () => {
        const { ws } = get()
        if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close() } catch {} }
        set({ ws: null, connected: false, _reconnectAttempts: 0 })
        useGatewayStore.getState().connect()
      },

      // scheduleReconnect: exponential backoff, used on auth failure
      scheduleReconnect: () => {
        const attempts = get()._reconnectAttempts || 0
        const delay = Math.min(1000 * Math.pow(2, attempts), 10000)
        set({ _reconnectAttempts: attempts + 1 })
        setTimeout(() => {
          if (!useGatewayStore.getState().connected) useGatewayStore.getState().connect()
        }, delay)
      },

      disconnect: () => {
        const { ws } = get()
        if (ws) { ws.onclose = null; try { ws.close() } catch {} }
        set({ ws: null, connected: false })
      },

      send: (payload) => {
        const { ws } = get()
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload))
          return true
        }
        return false
      },

      // sendChat: WS-first with HTTP fallback for chat.send specifically.
      // When WS is dead (iOS zombie TCP, disconnect, etc.), routes through
      // the server which proxies to the gateway via its own connection.
      sendChat: async (params: {
        sessionKey: string
        message: string
        idempotencyKey?: string
        deliver?: boolean
        attachments?: { type: string; mimeType: string; content: string }[]
        model?: string
        provider?: string
      }): Promise<{ ok: boolean; via: 'ws' | 'http'; runId?: string }> => {
        const { ws, connected } = get()
        const API = (import.meta as Record<string, unknown>).env
          ? ((import.meta as Record<string, unknown>).env as Record<string, string>).VITE_API_URL || ''
          : ''
        // Try WS if the socket is genuinely open
        if (connected && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'req',
              id: `chat-send-${Date.now()}`,
              method: 'chat.send',
              params,
            }))
            return { ok: true, via: 'ws' }
          } catch (e) {
            console.warn('[octis] WS send failed, falling back to HTTP', e)
          }
        }
        // HTTP fallback — reliable even when WS is dead
        console.log('[octis] Sending via HTTP fallback')
        try {
          const r = await fetch(`${API}/api/chat-send`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
          })
          const data = await r.json() as { ok: boolean; runId?: string; error?: string }
          return { ok: r.ok, via: 'http', runId: data.runId }
        } catch (e) {
          console.error('[octis] HTTP chat-send also failed', e)
          return { ok: false, via: 'http' }
        }
      },

      handleMessage: (msg) => {
        if (msg.type === 'res' && msg.id === 'octis-connect') {
          if (msg.ok) {
            console.log('[octis] Connected ✅', msg.payload)
            set({ connected: true, _reconnectAttempts: 0 })
            // Don't clear sessions on reconnect — keep stale list visible while new one loads.
            // Clearing caused project page to flash empty on every iOS WS reconnect.
            const { ws } = useGatewayStore.getState()
            if (ws) {
              const { agentId: aid } = useGatewayStore.getState()
              ws.send(
                JSON.stringify({
                  type: 'req',
                  id: 'sessions-list-init',
                  method: 'sessions.list',
                  params: aid ? { agentId: aid, limit: 100 } : { limit: 100 },
                })
              )
            }
          } else {
            console.error('[octis] Auth failed:', msg.error)
            set({ connected: false })
            useGatewayStore.getState().scheduleReconnect()
          }
        }

        if (
          msg.type === 'res' &&
          (msg.id === 'sessions-list-init' || msg.id === 'sessions-list' || (typeof msg.id === 'string' && msg.id.startsWith('sessions-list-')))
        ) {
          const raw: RawSession[] = msg.payload?.sessions || []
          const sessions: Session[] = raw.map((s) => ({ ...s, key: s.key || s.sessionKey || '' }))
          const labelStore = useLabelStore.getState()
          sessions.forEach((s) => {
            const uuid = s.id || s.sessionId
            const gKey = s.key
            if (uuid && gKey && uuid !== gKey) {
              const uuidLabel = labelStore.labels[uuid]
              if (uuidLabel && !labelStore.labels[gKey]) {
                labelStore.setLabel(gKey, uuidLabel)
              }
              labelStore.setLabel('__uuid__' + gKey, uuid)
            }
          })
          useSessionStore.getState().setSessions(sessions)
          // Auto-tag Slack sessions to the Slack project
          autoTagSlackSessions(sessions)
          // Cache to localStorage so next load is instant
          if (msg.id === 'sessions-list-init') {
            const { agentId } = useGatewayStore.getState()
            try { localStorage.setItem(`octis-session-cache-${agentId || 'default'}`, JSON.stringify(sessions)) } catch {}
          }
        }

        if (msg.type === 'sessions.list.result') {
          const raw: RawSession[] = msg.sessions || []
          const sessions: Session[] = raw.map((s) => ({ ...s, key: s.key || s.sessionKey || '' }))
          useSessionStore.getState().setSessions(sessions)
          autoTagSlackSessions(sessions)
        }

        if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.sessionKey) {
          const sk = msg.payload.sessionKey as string
          const payload = msg.payload as Record<string, unknown>
          const stream = payload.stream as string | undefined
          const state = payload.state as string | undefined
          const role = payload.role as string | undefined

          if (stream === 'lifecycle') {
            // Authoritative run signal from the gateway runner
            const phase = (payload.data as Record<string, unknown>)?.phase as string | undefined
            if (phase === 'start') {
              useSessionStore.getState().markRunStart(sk)
            } else if (phase === 'end' || phase === 'error') {
              useSessionStore.getState().markRunEnd(sk)
            }
          } else if (stream === 'tool') {
            // Tool executing — keep streaming indicator alive
            const phase = (payload.data as Record<string, unknown>)?.phase as string | undefined
            if (phase === 'start') useSessionStore.getState().markStreaming(sk)
          } else if (state === 'delta') {
            // Streaming tokens
            useSessionStore.getState().markStreaming(sk)
          } else if (state === 'final') {
            // Stream finalized — do NOT clear here; wait for lifecycle:end
          } else if (role === 'assistant') {
            useSessionStore.getState().markStreaming(sk)
          } else if (role === 'user') {
            useSessionStore.getState().setLastRole(sk, 'user')
          }
          useSessionStore.getState().touchSession(sk)
        }
        if (msg.type === 'chat' && msg.sessionKey) {
          const sk = msg.sessionKey
          const role = msg.role
          if (role === 'assistant') {
            useSessionStore.getState().markStreaming(sk)
          } else if (role === 'user') {
            useSessionStore.getState().setLastRole(sk, 'user')
          }
          useSessionStore.getState().touchSession(sk)
        }
      },
    }),
    {
      name: 'octis-gateway',
      partialize: (s) => ({
        gatewayUrl: s.gatewayUrl,
        gatewayToken: s.gatewayToken,
        agentId: s.agentId,
      }),
    }
  )
)

// ─── Draft store ─────────────────────────────────────────────────────────────

// Drafts persist across reloads (localStorage) AND across devices (server sync).

const DRAFT_LS_KEY = 'octis-drafts-v2'
const DRAFT_API_BASE = ((import.meta as any).env?.VITE_API_URL as string) || ''

/** Structured draft: text + optional pending image/file attachments */
export interface DraftData {
  text: string
  // Pending files (images, PDFs) — stored as-is so they survive reload.
  // Only images/docs with dataUrls are persisted; video objectUrls are skipped.
  files?: Array<{
    dataUrl: string
    mimeType: string
    name: string
    kind: 'image' | 'document' | 'video'
    saveToWorkspace: boolean
    extractedText?: string
    pages?: number
    _key?: number
  }>
}

function serializeDraft(d: DraftData): string {
  return JSON.stringify(d)
}
function deserializeDraft(raw: string): DraftData {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'text' in parsed) return parsed as DraftData
    // Legacy: plain string
    if (typeof parsed === 'string') return { text: parsed }
  } catch {}
  // Legacy: raw string (not JSON)
  return { text: raw }
}

function draftLoadFromLS(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(DRAFT_LS_KEY) || '{}') } catch { return {} }
}
function draftSaveToLS(drafts: Record<string, string>) {
  try { localStorage.setItem(DRAFT_LS_KEY, JSON.stringify(drafts)) } catch {}
}
async function draftApiCall(path: string, method: string, body?: object) {
  try {
    await fetch(`${DRAFT_API_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {}
}

interface DraftState {
  drafts: Record<string, string> // serialized DraftData strings
  _syncTimers: Record<string, ReturnType<typeof setTimeout>>
  /** Save structured draft (text + optional files) */
  setDraft: (sessionKey: string, text: string, files?: DraftData['files']) => void
  /** Get structured draft data */
  getDraftData: (sessionKey: string) => DraftData
  /** Convenience: get only text part */
  getDraft: (sessionKey: string) => string
  clearDraft: (sessionKey: string) => void
  /** Returns true if the draft was intentionally cleared (tombstone present) — prevents server re-restore */
  isDraftCleared: (sessionKey: string) => boolean
  hydrateFromServer: () => Promise<void>
}

export const useDraftStore = create<DraftState>()((set, get) => ({
  drafts: draftLoadFromLS(),
  _syncTimers: {},

  setDraft: (sessionKey, text, files?) => {
    // Omit video files (objectUrls not serializable) and skip saving if both empty
    const persistFiles = files?.filter(f => f.kind !== 'video' && f.dataUrl) ?? []
    const hasContent = !!text || persistFiles.length > 0
    const serialized = hasContent ? serializeDraft({ text, files: persistFiles.length ? persistFiles : undefined }) : ''
    set((s) => {
      const newDrafts = serialized
        ? { ...s.drafts, [sessionKey]: serialized }
        : (() => { const d = { ...s.drafts }; delete d[sessionKey]; return d })()
      draftSaveToLS(newDrafts)
      return { drafts: newDrafts }
    })
    // Debounce server sync 1.5s
    const existing = get()._syncTimers[sessionKey]
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      void draftApiCall(
        `/api/drafts/${encodeURIComponent(sessionKey)}`,
        serialized ? 'PUT' : 'DELETE',
        serialized ? { text: serialized } : undefined
      )
      set(s => { const t = { ...s._syncTimers }; delete t[sessionKey]; return { _syncTimers: t } })
    }, 1500)
    set(s => ({ _syncTimers: { ...s._syncTimers, [sessionKey]: timer } }))
  },

  getDraftData: (sessionKey) => {
    const raw = get().drafts[sessionKey]
    if (!raw) return { text: '' }
    return deserializeDraft(raw)
  },

  getDraft: (sessionKey) => {
    const raw = get().drafts[sessionKey]
    if (!raw) return ''
    return deserializeDraft(raw).text
  },

  clearDraft: (sessionKey) => {
    const existing = get()._syncTimers[sessionKey]
    if (existing) clearTimeout(existing)
    set((s) => {
      const d = { ...s.drafts }; delete d[sessionKey]
      // Write '' tombstone to localStorage — hydrateFromServer merges:
      //   localDrafts[k] !== undefined ? localDrafts[k] : serverValue
      // With the tombstone, '' !== undefined → uses '' (empty) instead of the stale server
      // draft, preventing it from coming back while the DELETE request is still in-flight.
      draftSaveToLS({ ...d, [sessionKey]: '' })
      const t = { ...s._syncTimers }; delete t[sessionKey]
      return { drafts: d, _syncTimers: t }
    })
    void draftApiCall(`/api/drafts/${encodeURIComponent(sessionKey)}`, 'DELETE')
    // Remove the '' tombstone from localStorage after 10s (server DELETE should be processed by then)
    setTimeout(() => {
      const current = draftLoadFromLS()
      if (current[sessionKey] === '') { delete current[sessionKey]; draftSaveToLS(current) }
    }, 10000)
  },

  isDraftCleared: (sessionKey) => {
    return draftLoadFromLS()[sessionKey] === ''
  },

  hydrateFromServer: async () => {
    try {
      const resp = await fetch(`${DRAFT_API_BASE}/api/drafts`, {
        credentials: 'include',
      })
      const data = await resp.json()
      if (!data.ok) return
      const localDrafts = draftLoadFromLS()
      const merged: Record<string, string> = {}
      for (const [k, v] of Object.entries(data.drafts as Record<string, { text: string }>)) {
        if (v?.text) merged[k] = localDrafts[k] !== undefined ? localDrafts[k] : v.text
      }
      for (const [k, v] of Object.entries(localDrafts)) {
        if (v) merged[k] = v
      }
      draftSaveToLS(merged)
      set({ drafts: merged })
    } catch {}
  },
}))

// ─── Label store ──────────────────────────────────────────────────────────────

interface LabelState {
  labels: Record<string, string>
  setLabel: (sessionKey: string, label: string) => void
  getLabel: (sessionKey: string, fallback?: string) => string
}

export const useLabelStore = create<LabelState>()(
  persist(
    (set, get) => ({
      labels: {},
      setLabel: (sessionKey, label) =>
        set((s) => ({ labels: { ...s.labels, [sessionKey]: label } })),
      getLabel: (sessionKey, fallback = '') =>
        get().labels[sessionKey] || fallback,
    }),
    { name: 'octis-labels' }
  )
)

// ─── Hidden store (persisted archive) ───────────────────────────────────────

const HIDDEN_API = (import.meta as any).env?.VITE_API_URL || ''

async function getHiddenAuthToken(): Promise<string> {
  try {
    // @ts-ignore
    const token = null
    return token || ''
  } catch { return '' }
}

async function fetchHiddenSessionDetails(token?: string): Promise<Session[]> {
  try {
    const hdrs: Record<string, string> = {}
    if (token) hdrs['Authorization'] = `Bearer ${token}`
    const r = await fetch(`${HIDDEN_API}/api/hidden-session-details`, { headers: hdrs, credentials: 'include' })
    if (!r.ok) return []
    return await r.json() as Session[]
  } catch { return [] }
}

async function fetchHiddenFromServer(token?: string): Promise<string[]> {
  try {
    const t = token || await getHiddenAuthToken()
    const r = await fetch(`${HIDDEN_API}/api/hidden-sessions`, {
      credentials: 'include',
    })
    if (!r.ok) return []
    return await r.json()
  } catch { return [] }
}

async function pushHideToServer(sessionKey: string, hide: boolean): Promise<void> {
  try {
    await authFetch(`${HIDDEN_API}/api/hidden-sessions/${hide ? 'hide' : 'unhide'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    })
  } catch { /* best-effort */ }
}

interface HiddenState {
  hidden: Set<string>
  hydrated: boolean
  hide: (sessionKey: string) => void
  unhide: (sessionKey: string) => void
  isHidden: (sessionKey: string) => boolean
  hydrateFromServer: (token?: string) => Promise<void>
}

export const useHiddenStore = create<HiddenState>()(
  persist(
    (set, get) => ({
      hidden: new Set<string>(),
      hydrated: false,

      hydrateFromServer: async (token?: string) => {
        const keys = await fetchHiddenFromServer(token)
        // Server is the source of truth. Replace local Set with server keys,
        // but preserve any keys that were hidden locally in the last 90s
        // (in-flight archives not yet persisted — race condition on fast WS reconnect).
        const serverSet = new Set(keys)
        set(s => {
          const preserved = new Set<string>()
          const cutoff = Date.now() - 90_000
          s.hidden.forEach(k => {
            // Keep locally-added keys not on the server only if they are very recent.
            // We don't have a timestamp per key, so keep ALL local keys that are
            // absent from the server only if the store was just hydrated < 90s ago.
            // If already hydrated (second call), trust the server fully.
            if (!s.hydrated && !serverSet.has(k)) preserved.add(k)
          })
          return { hydrated: true, hidden: new Set([...serverSet, ...preserved]) }
        })
        // Re-filter sessions so any unarchived sessions immediately reappear.
        const sessionStore = useSessionStore.getState()
        if (sessionStore.sessions.length > 0) {
          sessionStore.setSessions([...sessionStore.sessions])
        }
      },

      hide: (sessionKey) => {
        set((s) => ({ hidden: new Set([...s.hidden, sessionKey]) }))
        pushHideToServer(sessionKey, true)
      },

      unhide: (sessionKey) => {
        set((s) => { const h = new Set(s.hidden); h.delete(sessionKey); return { hidden: h } })
        pushHideToServer(sessionKey, false)
      },

      isHidden: (sessionKey) => get().hidden.has(sessionKey),
    }),
    {
      name: 'octis-hidden-sessions',
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name)
          if (!raw) return null
          try {
            const parsed = JSON.parse(raw)
            if (parsed?.state?.hidden) {
              parsed.state.hidden = new Set(parsed.state.hidden)
            }
            return parsed
          } catch { return null }
        },
        setItem: (name, value) => {
          const v = { ...value, state: { ...value.state, hidden: [...(value.state.hidden as Set<string>)] } }
          localStorage.setItem(name, JSON.stringify(v))
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    }
  )
)

// ─── Pinned sessions store ────────────────────────────────────────────────────
const PINNED_API = (import.meta as any).env?.VITE_API_URL || ''

async function getPinnedAuthToken(): Promise<string> {
  try {
    // @ts-ignore
    const token = null
    return token || ''
  } catch { return '' }
}

async function fetchPinnedFromServer(token?: string): Promise<string[]> {
  try {
    const t = token || await getPinnedAuthToken()
    const r = await fetch(`${PINNED_API}/api/pinned-sessions`, {
      credentials: 'include',
    })
    if (!r.ok) return []
    return await r.json()
  } catch { return [] }
}

async function pushPinToServer(sessionKey: string, pin: boolean): Promise<void> {
  try {
    await authFetch(`${PINNED_API}/api/pinned-sessions/${pin ? 'pin' : 'unpin'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    })
  } catch { /* best-effort */ }
}

interface PinnedState {
  pinned: Set<string>
  hydrated: boolean
  pin: (sessionKey: string) => void
  unpin: (sessionKey: string) => void
  isPinned: (sessionKey: string) => boolean
  hydrateFromServer: (token?: string) => Promise<void>
}

export const usePinnedStore = create<PinnedState>()(
  persist(
    (set, get) => ({
      pinned: new Set<string>(),
      hydrated: false,

      hydrateFromServer: async (token?: string) => {
        const keys = await fetchPinnedFromServer(token)
        set({ hydrated: true, pinned: new Set(keys) })
      },

      pin: (sessionKey) => {
        set((s) => ({ pinned: new Set([...s.pinned, sessionKey]) }))
        pushPinToServer(sessionKey, true)
      },

      unpin: (sessionKey) => {
        set((s) => { const p = new Set(s.pinned); p.delete(sessionKey); return { pinned: p } })
        pushPinToServer(sessionKey, false)
      },

      isPinned: (sessionKey) => get().pinned.has(sessionKey),
    }),
    {
      name: 'octis-pinned-sessions',
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name)
          if (!raw) return null
          try {
            const parsed = JSON.parse(raw)
            if (parsed?.state?.pinned) {
              parsed.state.pinned = new Set(parsed.state.pinned)
            }
            return parsed
          } catch { return null }
        },
        setItem: (name, value) => {
          const v = { ...value, state: { ...value.state, pinned: [...(value.state.pinned as Set<string>)] } }
          localStorage.setItem(name, JSON.stringify(v))
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    }
  )
)

// ─── Project store ────────────────────────────────────────────────────────────

// Server sync helpers for project tags
const API_BASE = (import.meta as any).env?.VITE_API_URL || ''

async function getAuthToken(): Promise<string> {
  try {
    // @ts-ignore
    const token = null
    return token || ''
  } catch { return '' }
}

async function fetchServerProjectTags(token?: string): Promise<Record<string, string>> {
  try {
    const t = token || await getAuthToken()
    const r = await fetch(`${API_BASE}/api/session-projects`, {
      credentials: 'include',
    })
    if (!r.ok) return {}
    return await r.json()
  } catch { return {} }
}

async function pushProjectTagToServer(sessionKey: string, projectTag: string): Promise<void> {
  try {
    await authFetch(`${API_BASE}/api/session-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, projectTag }),
    })
  } catch { /* best-effort */ }
}

interface ProjectState {
  tags: Record<string, ProjectTag>
  hydrated: boolean
  projectMeta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }>
  setProjectMeta: (meta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }>) => void
  getProjectEmoji: (slug: string) => string
  setTag: (sessionKey: string, project: string) => void
  setCard: (sessionKey: string, card: string) => void
  getTag: (sessionKey: string) => ProjectTag
  getProjects: () => Record<string, string[]>
  hydrateFromServer: (token?: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      tags: {},
      hydrated: false,
      projectMeta: {},

      setProjectMeta: (meta) => set({ projectMeta: meta }),
      getProjectEmoji: (slug) => get().projectMeta[slug]?.emoji || '',

      hydrateFromServer: async (token?: string) => {
        const serverTags = await fetchServerProjectTags(token)
        set((s) => ({
          hydrated: true,
          tags: {
            ...s.tags,
            ...Object.fromEntries(
              Object.entries(serverTags).map(([sk, project]) => [
                sk,
                { ...(s.tags[sk] || {}), project },
              ])
            ),
          },
        }))
      },

      setTag: (sessionKey, project) => {
        set((s) => ({
          tags: {
            ...s.tags,
            [sessionKey]: { ...(s.tags[sessionKey] || {}), project },
          },
        }))
        pushProjectTagToServer(sessionKey, project)
      },

      setCard: (sessionKey, card) =>
        set((s) => ({
          tags: {
            ...s.tags,
            [sessionKey]: { ...(s.tags[sessionKey] || {}), card },
          },
        })),

      getTag: (sessionKey) => get().tags[sessionKey] || {},

      getProjects: () => {
        const all = get().tags
        const projects: Record<string, string[]> = {}
        Object.entries(all).forEach(([sk, meta]) => {
          if (meta.project) {
            if (!projects[meta.project]) projects[meta.project] = []
            projects[meta.project].push(sk)
          }
        })
        return projects
      },
    }),
    { name: 'octis-projects' }
  )
)

// ─── Session store ────────────────────────────────────────────────────────────

// External Maps — not Zustand state, so mutations never trigger re-renders.
// streamingTimerMap: tracks 90s fallback timeouts for clearing isStreaming.
// touchThrottleMap: ensures touchSession fires at most once per 2s per session.
const streamingTimerMap = new Map<string, ReturnType<typeof setTimeout>>()
const touchThrottleMap = new Map<string, number>()
const TOUCH_THROTTLE_MS = 2000

interface SessionState {
  sessions: Session[]
  sessionActivity: Record<string, number>
  sessionMeta: Record<string, SessionMeta>
  /** @deprecated timers moved to external streamingTimerMap — kept for interface compat, always {} */
  streamingTimers: Record<string, ReturnType<typeof setTimeout>>
  costHistory: Record<string, { ts: number; cost: number }[]>
  activePanes: (string | null)[]
  paneCount: number
  paneLayout: 'row' | 'grid' | 'featured'
  manualOrder: string[]
  pendingProjectPrefixes: Record<string, string>
  pendingProjectInits: Record<string, string>

  hiddenSessions: Session[]
  setHiddenSessions: (sessions: Session[]) => void
  hydrateHiddenFromServer: (token?: string) => Promise<void>
  setSessions: (sessions: Session[]) => void
  getCostDelta: (sessionKey: string) => number | null
  touchSession: (sessionKey: string) => void
  setLastRole: (sessionKey: string, role: 'user' | 'assistant') => void
  markStreaming: (sessionKey: string) => void
  markRunStart: (sessionKey: string) => void
  markRunEnd: (sessionKey: string) => void
  incrementUnread: (sessionKey: string) => void
  clearUnread: (sessionKey: string) => void
  getUnreadCount: (sessionKey: string) => number
  setLastExchangeCost: (sessionKey: string, cost: number) => void
  getStatus: (session: Session) => SessionStatus
  getLastActivityMs: (session: Session) => number | null
  getSortedSessions: () => Session[]
  setManualOrder: (keys: string[]) => void
  setPendingProjectPrefix: (sessionKey: string, prefix: string) => void
  consumePendingProjectPrefix: (sessionKey: string) => string | null
  setPendingProjectInit: (sessionKey: string, projectSlug: string) => void
  consumePendingProjectInit: (sessionKey: string) => string | null
  setSessionProject: (sessionKey: string, projectTag: string) => void
  pinToPane: (paneIndex: number, sessionKey: string | null) => void
  setPaneCount: (n: number) => void
  setPaneLayout: (layout: 'row' | 'grid' | 'featured') => void
  getActiveCount: () => number
}

export const useSessionStore = create<SessionState>()(persist((set, get) => ({
  sessions: [],
  hiddenSessions: [],
  sessionActivity: {},
  sessionMeta: {},
  costHistory: {},
  streamingTimers: {}, // always empty — timers live in external streamingTimerMap
  activePanes: [null, null, null, null, null, null, null, null],
  paneCount: 2,
  paneLayout: 'row',
  manualOrder: [],
  pendingProjectPrefixes: {},
  pendingProjectInits: {},

  setHiddenSessions: (sessions) => set({ hiddenSessions: sessions }),
  hydrateHiddenFromServer: async (token?: string) => {
    const fetched = await fetchHiddenSessionDetails(token)
    // Replace the list entirely so unarchived sessions disappear immediately
    set({ hiddenSessions: fetched })
  },

  setSessions: (sessions) => {
    // Deduplicate by key — gateway sometimes sends the same session under different forms
    const seen = new Set<string>()
    const hiddenStore = useHiddenStore.getState()
    const hiddenCollected: Session[] = []
    const deduped = sessions.filter((s) => {
      if (!s.key || seen.has(s.key)) return false
      if (hiddenStore.isHidden(s.key) || hiddenStore.isHidden(s.id || '') || hiddenStore.isHidden(s.sessionId || '')) {
        hiddenCollected.push({ ...s, key: s.key || s.id || s.sessionId || '' })
        return false
      }
      // Isolation: show session if it belongs to this user's primary agent namespace OR is explicitly owned.
      // This replaces the old single-agentId guard — supports multi-agent sessions while preventing
      // cross-user leakage (each user's sessions live under their agent:<mainAgentId>:* namespace).
      const { mainAgentId, ownedSessions } = useAuthStore.getState()
      if (mainAgentId || (ownedSessions instanceof Set)) {
        const agentPrefixMatch = (s.key || '').match(/^agent:([^:]+):/)
        const sessionAgentId = agentPrefixMatch?.[1] || (s as any).agentId || ''
        const isPrimaryAgent = !!(mainAgentId && sessionAgentId === mainAgentId)
        const shortKey = (s.key || '').match(/^agent:[^:]+:(session-\d+)$/)?.[1]
        const isOwned = ownedSessions instanceof Set && (ownedSessions.has(s.key) || !!(shortKey && ownedSessions.has(shortKey)))
        if (!isPrimaryAgent && !isOwned) return false
      }
      seen.add(s.key)
      // Also mark the short form (session-<ts>) as seen so the pendingLocal filter drops it
      // immediately when the gateway returns the full agent:main:session-<ts> key.
      // Without this, both keys linger for up to 2 min and appear as duplicates.
      const shortMatch = s.key.match(/^agent:[^:]+:(session-\d+)$/)
      if (shortMatch) seen.add(shortMatch[1])
      return true
    })
    // Auto-copy project tags from optimistic key (session-<ts>) to real gateway key (agent:main:session-<ts>).
    // This runs on every setSessions call so it works even when the originating component has unmounted.
    const projectStore = useProjectStore.getState()
    for (const s of deduped) {
      const shortMatch = s.key.match(/^agent:[^:]+:(session-\d+)$/)
      if (shortMatch) {
        const optimisticKey = shortMatch[1]
        const optimisticTag = projectStore.getTag(optimisticKey)
        if (optimisticTag.project && !projectStore.getTag(s.key).project) {
          // Copy tag to real key (setTag also pushes to server)
          projectStore.setTag(s.key, optimisticTag.project)
        }
      }
    }
    // Update cost history for sessions with live cost data
    const now = Date.now()
    set((state) => {
      // Preserve locally-created pending sessions (key = "session-<timestamp>") that haven't
      // appeared on the gateway yet — they get wiped otherwise on the next 30s poll.
      // TTL: drop pending sessions older than 2 minutes — they never get a matching gateway key
      // so they accumulate as ghost sessions (same label as real sessions, vanish on reload).
      const pendingLocal = state.sessions.filter((s) => {
        if (!/^session-\d+$/.test(s.key) || seen.has(s.key)) return false
        // Don't revive sessions that have been permanently deleted or archived
        if (hiddenStore.isHidden(s.key)) return false
        const ts = parseInt(s.key.split('-')[1], 10)
        return !isNaN(ts) && (now - ts) < 2 * 60 * 1000 // keep for max 2 min
      })
      const newHistory = { ...state.costHistory }
      for (const s of deduped) {
        if (s.estimatedCostUsd != null) {
          const prev = newHistory[s.key] || []
          const updated = [...prev, { ts: now, cost: s.estimatedCostUsd }].slice(-5)
          newHistory[s.key] = updated
        }
      }
      // Merge WS-known hidden sessions with DB-hydrated sessions that aren't in the WS list.
      // Without this, old bare-UUID sessions (from hydrateHiddenFromServer) get wiped on every
      // WS sessions.list update — causing the Sessions-tab ARCHIVED and Projects-tab ARCHIVED
      // views to diverge (one has full DB list, the other only WS-known subset).
      const wsKeys = new Set([...deduped.map((s) => s.key), ...hiddenCollected.map((s) => s.key)])
      const dbOnlyHidden = state.hiddenSessions.filter(
        (s) => !wsKeys.has(s.key) && hiddenStore.isHidden(s.key)
      )
      // Migrate optimistic pane keys (session-<ts>) to real gateway keys (agent:main:session-<ts>).
      // This is what causes the "lost highlight" + duplicate pane bug: the pane was opened with
      // the local optimistic key, but after WS sync the session.key is the full gateway key.
      // activePanes.includes(session.key) returns false → isPinned = false → highlight gone →
      // re-click opens a second pane with the real key → duplicate window.
      let panesUpdated = false
      const updatedActivePanes = state.activePanes.map((pane: string | null) => {
        if (!pane || !/^session-\d+$/.test(pane)) return pane
        const realSession = deduped.find((s) => {
          const m = s.key.match(/^agent:[^:]+:(session-\d+)$/)
          return m && m[1] === pane
        })
        if (realSession) { panesUpdated = true; return realSession.key }
        return pane
      })
      return {
        sessions: [...pendingLocal, ...deduped],
        costHistory: newHistory,
        hiddenSessions: [...hiddenCollected, ...dbOnlyHidden],
        ...(panesUpdated ? { activePanes: updatedActivePanes } : {}),
      }
    })
  },

  getCostDelta: (sessionKey) => {
    const history = get().costHistory[sessionKey]
    if (!history || history.length < 2) return null
    const last = history[history.length - 1]
    const prev = history[history.length - 2]
    const deltaMs = last.ts - prev.ts
    if (deltaMs < 5000) return null // too close together
    return last.cost - prev.cost
  },

  touchSession: (sessionKey) => {
    // Throttle: max one Zustand update per session per 2s.
    // During active streaming this fires on every token — without throttling
    // it triggers a full re-render cascade on every WS message.
    const now = Date.now()
    const last = touchThrottleMap.get(sessionKey) || 0
    if (now - last < TOUCH_THROTTLE_MS) return
    touchThrottleMap.set(sessionKey, now)
    set((s) => ({
      sessionActivity: { ...s.sessionActivity, [sessionKey]: now },
    }))
  },

  incrementUnread: (sessionKey) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          unreadCount: ((s.sessionMeta[sessionKey]?.unreadCount) || 0) + 1,
        },
      },
    }))
  },

  clearUnread: (sessionKey) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), unreadCount: 0 },
      },
    }))
  },

  getUnreadCount: (sessionKey) => {
    return get().sessionMeta[sessionKey]?.unreadCount || 0
  },

  setLastRole: (sessionKey, role) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          lastRole: role,
          // Only clear isStreaming if runActive is NOT set — preserve streaming during active runs
          isStreaming: s.sessionMeta[sessionKey]?.runActive ? (s.sessionMeta[sessionKey]?.isStreaming ?? false) : false,
        },
      },
    }))
  },

  setLastExchangeCost: (sessionKey, cost) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), lastExchangeCost: cost },
      },
    }))
  },

  markStreaming: (sessionKey) => {
    // Reset the 5-min fallback timer — stored in external Map so this never triggers a re-render.
    const existing = streamingTimerMap.get(sessionKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      streamingTimerMap.delete(sessionKey)
      set((s) => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), isStreaming: false },
        },
      }))
    }, 5 * 60_000)
    streamingTimerMap.set(sessionKey, timer)

    // Only call Zustand set() if isStreaming is not already true.
    // Previously this fired on every streaming token (10-20/sec) → re-render storm.
    // Now it fires once per streaming run (false→true transition only).
    if (!get().sessionMeta[sessionKey]?.isStreaming) {
      set((s) => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: {
            ...(s.sessionMeta[sessionKey] || {}),
            isStreaming: true,
            lastRole: 'assistant',
            lastEventTs: Date.now(),
          },
        },
      }))
    }
  },

  markRunStart: (sessionKey) => {
    set(s => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          runActive: true,
          lastEventTs: Date.now(),
          isStreaming: true,
          lastRole: undefined,
        },
      },
    }))
    // Reset the streaming timer
    const existing = streamingTimerMap.get(sessionKey)
    if (existing) clearTimeout(existing)
    // 10-min max timeout — if no lifecycle:end for 10 min, assume dead
    const timer = setTimeout(() => {
      streamingTimerMap.delete(sessionKey)
      set(s => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), isStreaming: false, runActive: false },
        },
      }))
    }, 10 * 60 * 1000)
    streamingTimerMap.set(sessionKey, timer)
  },

  markRunEnd: (sessionKey) => {
    // Clear the streaming timer
    const existing = streamingTimerMap.get(sessionKey)
    if (existing) clearTimeout(existing)
    streamingTimerMap.delete(sessionKey)
    set(s => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          runActive: false,
          isStreaming: false,
          lastRole: 'assistant',
          lastEventTs: Date.now(),
        },
      },
    }))
  },

  getLastActivityMs: (session) => {
    const key = session.key || session.sessionKey || ''
    let activity = get().sessionActivity[key]
    // Temp sessions (session-<ts>) get their activity tracked under the real gateway key
    // (agent:<agentId>:session-<ts>). Bridge the lookup so status reflects actual activity.
    if (!activity && /^session-\d+$/.test(key)) {
      const { agentId } = useGatewayStore.getState()
      if (agentId) activity = get().sessionActivity[`agent:${agentId}:${key}`]
    }
    const last = activity || session.updatedAt || session.lastActivity || session.updated_at
    if (!last) return null
    return typeof last === 'number' ? last : new Date(last).getTime()
  },

  getStatus: (session) => {
    const key = session.key || session.sessionKey || ''
    // Resolve temp key to real key for meta lookup (same bridge as getLastActivityMs)
    const resolvedKey = (() => {
      if (!/^session-\d+$/.test(key)) return key
      const { agentId } = useGatewayStore.getState()
      if (!agentId) return key
      const realKey = `agent:${agentId}:${key}`
      return get().sessionMeta[realKey] ? realKey : key
    })()
    const meta = get().sessionMeta[resolvedKey] || {}

    // runActive = authoritative "run in progress" signal from lifecycle events
    if (meta.runActive) {
      // Check if run has gone quiet (no events for >3 min) → show stuck instead
      const lastEvt = meta.lastEventTs || 0
      const silentMs = Date.now() - lastEvt
      if (lastEvt > 0 && silentMs > 3 * 60 * 1000) return 'stuck'
      return 'working'
    }

    if (meta.isStreaming) return 'working'

    const lastMs = get().getLastActivityMs(session)
    if (!lastMs) return 'quiet'
    const age = Date.now() - lastMs

    // User sent a message and no reply yet
    if (meta.lastRole === 'user') {
      if (age > 5 * 60 * 1000) return 'stuck'   // sent >5 min ago with no reply = stuck
      return 'working'                            // sent recently, waiting for reply
    }

    // Assistant replied (or lastRole unknown) — use recency for active/quiet
    if (age < 30 * 60 * 1000) return 'active'  // active in last 30 min
    return 'quiet'
  },

  getSortedSessions: () => {
    const { sessions, getStatus, manualOrder } = get()
    // Tagged + active sessions always float to top automatically
    const projectState = useProjectStore.getState()
    const isTaggedAndActive = (s: Session) => {
      const tag = projectState.getTag(s.key)
      const status = getStatus(s)
      return !!(tag?.project) && status !== 'quiet'
    }
    if (manualOrder.length > 0) {
      const orderMap = new Map(manualOrder.map((k, i) => [k, i]))
      return [...sessions].sort((a, b) => {
        const at = isTaggedAndActive(a) ? 0 : 1
        const bt = isTaggedAndActive(b) ? 0 : 1
        if (at !== bt) return at - bt
        const ia = orderMap.has(a.key) ? orderMap.get(a.key)! : 9999
        const ib = orderMap.has(b.key) ? orderMap.get(b.key)! : 9999
        return ia - ib
      })
    }
    const order: Record<SessionStatus, number> = {
      'working':   0,
      'stuck':     1,
      'active':    2,
      'quiet':     3,
    }
    return [...sessions].sort((a, b) => {
      // Tagged + active sessions always float to top
      const at = isTaggedAndActive(a) ? 0 : 1
      const bt = isTaggedAndActive(b) ? 0 : 1
      if (at !== bt) return at - bt
      // Within same tier: sort by status
      const sa = order[getStatus(a)] ?? 5
      const sb = order[getStatus(b)] ?? 5
      return sa - sb
    })
  },

  setManualOrder: (keys) => set({ manualOrder: keys }),

  setPendingProjectPrefix: (sessionKey, prefix) => set((state) => ({
    pendingProjectPrefixes: { ...state.pendingProjectPrefixes, [sessionKey]: prefix },
  })),

  consumePendingProjectPrefix: (sessionKey) => {
    const prefix = get().pendingProjectPrefixes[sessionKey] ?? null
    if (prefix) {
      set((state) => {
        const next = { ...state.pendingProjectPrefixes }
        delete next[sessionKey]
        return { pendingProjectPrefixes: next }
      })
    }
    return prefix
  },

  setPendingProjectInit: (sessionKey, projectSlug) => set((state) => ({
    pendingProjectInits: { ...state.pendingProjectInits, [sessionKey]: projectSlug },
  })),

  consumePendingProjectInit: (sessionKey) => {
    const slug = get().pendingProjectInits[sessionKey] ?? null
    if (slug) {
      set((state) => {
        const next = { ...state.pendingProjectInits }
        delete next[sessionKey]
        return { pendingProjectInits: next }
      })
    }
    return slug
  },

  setSessionProject: (sessionKey, projectTag) => {
    useProjectStore.getState().setTag(sessionKey, projectTag)
  },

  pinToPane: (paneIndex, sessionKey) => {
    const panes = [...get().activePanes]
    // Prevent duplicate panes: if this session is already open in another slot, bail out.
    // Closing a pane (sessionKey = null) is always allowed.
    if (sessionKey !== null) {
      const existingIdx = panes.indexOf(sessionKey)
      if (existingIdx >= 0 && existingIdx !== paneIndex) return
    }
    panes[paneIndex] = sessionKey
    set({ activePanes: panes })
  },

  setPaneCount: (n) => set({ paneCount: Math.min(8, Math.max(1, n)) }),
  setPaneLayout: (layout) => set({ paneLayout: layout }),

  getActiveCount: () => {
    const { sessions, getStatus } = get()
    return sessions.filter((s) => getStatus(s) === 'active').length
  },
}), {
  name: 'octis-session-layout',
  onRehydrateStorage: () => (state) => {
    // Deduplicate activePanes on load — stale localStorage can contain the same key twice
    if (state && state.activePanes) {
      const seen = new Set<string>()
      state.activePanes = state.activePanes.map((k: string | null) => {
        if (!k) return null
        if (seen.has(k)) return null
        seen.add(k)
        return k
      })
    }
  },
  partialize: (s) => ({
    activePanes: s.activePanes,
    paneCount: s.paneCount,
    paneLayout: s.paneLayout,
    manualOrder: s.manualOrder,
    // Persist minimal session metadata only (not full message history)
    sessions: s.sessions.slice(0, 200).map((sess) => ({
      key: sess.key,
      sessionKey: sess.sessionKey,
      id: sess.id,
      sessionId: sess.sessionId,
      label: sess.label,
      cost: sess.cost,
      updatedAt: sess.updatedAt,
      lastActivity: sess.lastActivity,
      updated_at: sess.updated_at,
      estimatedCostUsd: sess.estimatedCostUsd,
      totalTokens: sess.totalTokens,
      contextTokens: sess.contextTokens,
      status: sess.status,
    })),
  }),
}))
