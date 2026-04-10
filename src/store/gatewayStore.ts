import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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
}

export interface SessionMeta {
  lastRole?: 'user' | 'assistant'
  isStreaming?: boolean
}

export interface ProjectTag {
  project?: string
  card?: string
}

export type SessionStatus = 'working' | 'needs-you' | 'active' | 'stuck' | 'quiet'

interface GatewayState {
  gatewayUrl: string
  gatewayToken: string
  agentId: string
  connected: boolean
  ws: WebSocket | null
  pendingRequests: Record<string, unknown>
  _reconnectAttempts?: number

  setCredentials: (url: string, token: string, agentId?: string) => void
  setAgentId: (agentId: string) => void
  setConnected: (connected: boolean) => void
  subscribe: (fn: (msg: unknown) => void) => () => void
  connect: () => void
  disconnect: () => void
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

      setCredentials: (url, token, agentId) =>
        set({ gatewayUrl: url, gatewayToken: token, agentId: agentId || '' }),
      setAgentId: (agentId) => set({ agentId: agentId || '' }),
      setConnected: (connected) => set({ connected }),

      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },

      connect: () => {
        const { gatewayUrl, ws: oldWs } = get()
        if (!gatewayUrl) return

        if (oldWs) {
          oldWs.onclose = null
          oldWs.onerror = null
          oldWs.onmessage = null
          try { oldWs.close() } catch {}
        }

        set({ connected: false, ws: null })

        const wsUrl = gatewayUrl.startsWith('http')
          ? gatewayUrl.replace(/^http/, 'ws')
          : gatewayUrl
        const socket = new WebSocket(wsUrl)

        socket.onopen = () => {
          console.log('[octis] WS open, waiting for challenge...')
        }

        socket.onmessage = async (event: MessageEvent) => {
          if (get().ws !== socket) return
          try {
            const msg = JSON.parse(event.data as string) as GatewayMessage
            get().handleMessage(msg)
            emit(msg)

            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              const token = get().gatewayToken
              socket.send(
                JSON.stringify({
                  type: 'req',
                  id: 'octis-connect',
                  method: 'connect',
                  params: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: { id: 'openclaw-control-ui', version: '0.1.0', platform: 'web', mode: 'ui' },
                    role: 'operator',
                    scopes: ['operator.read', 'operator.write'],
                    caps: [],
                    commands: [],
                    permissions: {},
                    auth: { token },
                    locale: navigator.language || 'en-US',
                    userAgent: 'octis/0.1.0',
                  },
                })
              )
              console.log('[octis] Sent connect (token-only auth)')
            }
          } catch (e) {
            console.warn('[octis] Failed to parse message', e)
          }
        }

        socket.onclose = (e: CloseEvent) => {
          if (get().ws !== socket) return
          console.log('[octis] WS closed:', e.code, e.reason)
          set({ connected: false, ws: null })
          if (e.code !== 1000) {
            const delay = Math.min(1000 * Math.pow(2, get()._reconnectAttempts || 0), 30000)
            set((s) => ({ _reconnectAttempts: (s._reconnectAttempts || 0) + 1 }))
            console.log(`[octis] Reconnecting in ${delay}ms...`)
            setTimeout(() => {
              if (!useGatewayStore.getState().connected) {
                useGatewayStore.getState().connect()
              }
            }, delay)
          }
        }

        socket.onerror = (e: Event) => {
          if (get().ws !== socket) return
          console.warn('[octis] WS error', e)
          set({ connected: false })
        }

        set({ ws: socket })
      },

      disconnect: () => {
        const { ws } = get()
        if (ws) ws.close()
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

      handleMessage: (msg) => {
        if (msg.type === 'res' && msg.id === 'octis-connect') {
          if (msg.ok) {
            console.log('[octis] Connected ✅', msg.payload)
            set({ connected: true, _reconnectAttempts: 0 })
            useSessionStore.getState().setSessions([])
            const { ws, agentId } = useGatewayStore.getState()
            const listParams = agentId ? { agentId } : {}
            if (ws) {
              ws.send(
                JSON.stringify({
                  type: 'req',
                  id: 'sessions-list-init',
                  method: 'sessions.list',
                  params: listParams,
                })
              )
            }
          } else {
            console.error('[octis] Auth failed:', msg.error)
            set({ connected: false })
          }
        }

        if (
          msg.type === 'res' &&
          (msg.id === 'sessions-list-init' || msg.id === 'sessions-list')
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
        }

        if (msg.type === 'sessions.list.result') {
          const raw: RawSession[] = msg.sessions || []
          const sessions: Session[] = raw.map((s) => ({ ...s, key: s.key || s.sessionKey || '' }))
          useSessionStore.getState().setSessions(sessions)
        }

        if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.sessionKey) {
          const sk = msg.payload.sessionKey as string
          const role = msg.payload.role as string
          if (role === 'assistant') {
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

// ─── Project store ────────────────────────────────────────────────────────────

interface ProjectState {
  tags: Record<string, ProjectTag>
  setTag: (sessionKey: string, project: string) => void
  setCard: (sessionKey: string, card: string) => void
  getTag: (sessionKey: string) => ProjectTag
  getProjects: () => Record<string, string[]>
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      tags: {},

      setTag: (sessionKey, project) =>
        set((s) => ({
          tags: {
            ...s.tags,
            [sessionKey]: { ...(s.tags[sessionKey] || {}), project },
          },
        })),

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

interface SessionState {
  sessions: Session[]
  sessionActivity: Record<string, number>
  sessionMeta: Record<string, SessionMeta>
  streamingTimers: Record<string, ReturnType<typeof setTimeout>>
  activePanes: (string | null)[]
  paneCount: number

  setSessions: (sessions: Session[]) => void
  touchSession: (sessionKey: string) => void
  setLastRole: (sessionKey: string, role: 'user' | 'assistant') => void
  markStreaming: (sessionKey: string) => void
  getStatus: (session: Session) => SessionStatus
  getLastActivityMs: (session: Session) => number | null
  getSortedSessions: () => Session[]
  setSessionProject: (sessionKey: string, projectTag: string) => void
  pinToPane: (paneIndex: number, sessionKey: string | null) => void
  setPaneCount: (n: number) => void
  getActiveCount: () => number
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  sessionActivity: {},
  sessionMeta: {},
  streamingTimers: {},
  activePanes: [null, null, null, null, null],
  paneCount: 2,

  setSessions: (sessions) => set({ sessions }),

  touchSession: (sessionKey) => {
    set((s) => ({
      sessionActivity: { ...s.sessionActivity, [sessionKey]: Date.now() },
    }))
  },

  setLastRole: (sessionKey, role) => {
    set((s) => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          lastRole: role,
          isStreaming: false,
        },
      },
    }))
  },

  markStreaming: (sessionKey) => {
    const existing = get().streamingTimers[sessionKey]
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      set((s) => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), isStreaming: false },
        },
        streamingTimers: Object.fromEntries(
          Object.entries(s.streamingTimers).filter(([k]) => k !== sessionKey)
        ),
      }))
    }, 4000)

    set((s) => ({
      streamingTimers: { ...s.streamingTimers, [sessionKey]: timer },
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: {
          ...(s.sessionMeta[sessionKey] || {}),
          isStreaming: true,
          lastRole: 'assistant',
        },
      },
    }))
  },

  getLastActivityMs: (session) => {
    const key = session.key || session.sessionKey || ''
    const activity = get().sessionActivity[key]
    const last = activity || session.updatedAt || session.lastActivity || session.updated_at
    if (!last) return null
    return typeof last === 'number' ? last : new Date(last).getTime()
  },

  getStatus: (session) => {
    const key = session.key || session.sessionKey || ''
    const meta = get().sessionMeta[key] || {}

    if (meta.isStreaming) return 'working'
    if (meta.lastRole === 'assistant') return 'needs-you'

    const lastMs = get().getLastActivityMs(session)
    if (!lastMs) return 'quiet'
    const age = Date.now() - lastMs

    // "Stuck" = was recently active (within last hour) but silent for 5min
    // Old sessions with no recent activity are just "quiet"
    const recentlyActive = age < 60 * 60 * 1000   // active in last hour
    const silentTooLong  = age > 5 * 60 * 1000    // no activity for 5min
    if (recentlyActive && silentTooLong) return 'stuck'

    if (age < 24 * 60 * 60 * 1000) return 'active'
    return 'quiet'
  },

  getSortedSessions: () => {
    const { sessions, getStatus } = get()
    const order: Record<SessionStatus, number> = {
      'needs-you': 0,
      'working':   1,
      'stuck':     2,
      'active':    3,
      'quiet':     4,
    }
    return [...sessions].sort((a, b) => {
      const sa = order[getStatus(a)] ?? 5
      const sb = order[getStatus(b)] ?? 5
      return sa - sb
    })
  },

  setSessionProject: (sessionKey, projectTag) => {
    useProjectStore.getState().setTag(sessionKey, projectTag)
  },

  pinToPane: (paneIndex, sessionKey) => {
    const panes = [...get().activePanes]
    panes[paneIndex] = sessionKey
    set({ activePanes: panes })
  },

  setPaneCount: (n) => set({ paneCount: Math.min(5, Math.max(1, n)) }),

  getActiveCount: () => {
    const { sessions, getStatus } = get()
    return sessions.filter((s) => getStatus(s) === 'active').length
  },
}))
