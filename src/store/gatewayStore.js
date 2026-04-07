import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Shared message bus for gateway events
const listeners = new Set()
const emit = (msg) => listeners.forEach(fn => fn(msg))

// ── Background name prefetch ──────────────────────────────────────────────────
// Fetch minimal history for sessions that don't have a name yet.
// Batched with a small delay to avoid hammering the gateway.
let prefetchQueue = []
let prefetchTimer = null

function resolveContentStatic(c) {
  if (!c) return ''
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : x?.text ?? '').join('')
  return c?.text ?? ''
}

function extractNameFromMessages(msgs) {
  // Try session card topic first
  const card = msgs.find(m => m.role === 'assistant' && resolveContentStatic(m.content)?.includes('📋'))
  if (card) {
    const text = resolveContentStatic(card.content)
    const match = text.match(/📋\s+\*?\*?(.+?)\*?\*?[\n\r]/)
    if (match) return match[1].replace(/[*[\]]/g, '').trim()
  }
  // Try first user message
  const firstUser = msgs.find(m => m.role === 'user')
  if (firstUser) {
    const text = resolveContentStatic(firstUser.content)
    if (text) return text.length <= 60 ? text : text.slice(0, 57) + '…'
  }
  return null
}

export function prefetchSessionNames(sessions, send) {
  const { displayNameOverrides, sessionCards } = useSessionStore.getState()
  // Queue sessions that don't have a name yet (not in overrides, or name === key)
  const toFetch = sessions.filter(s => {
    const override = displayNameOverrides[s.key]
    const hasName = override && override !== s.key
    return !hasName
  }).slice(0, 30) // cap at 30 to avoid overload

  if (toFetch.length === 0) return

  // Stagger requests: 200ms apart to avoid hammering gateway
  toFetch.forEach((session, i) => {
    setTimeout(() => {
      send({
        type: 'req',
        id: `prefetch-${session.key}`,
        method: 'chat.history',
        params: { sessionKey: session.key, limit: 20 }
      })
    }, i * 200)
  })
}
// ────────────────────────────────────────────────────────────────────────────

// Default API server URL (Octis VPS — for costs/memory HTTP endpoints)
const DEFAULT_API = import.meta.env.VITE_API_URL || 'https://octis.duckdns.org/api'
// Gateway URL for WebSocket chat
const DEFAULT_GW = import.meta.env.VITE_GW_URL || 'wss://octis.duckdns.org/ws'
const DEFAULT_GW_TOKEN = import.meta.env.VITE_GW_TOKEN || '8UJBwudjSyOifNfPltG0Nedqn1w5UcmTY9abYqGrAcY'
const DEFAULT_API_TOKEN = import.meta.env.VITE_OCTIS_TOKEN || 'octis-yumi-2026'

// Bump this version whenever env defaults change — forces localStorage reset for all users
const STORE_VERSION = 2

export const useGatewayStore = create(
  persist(
    (set, get) => ({
      apiUrl: DEFAULT_API,
      gatewayUrl: DEFAULT_GW,
      gatewayToken: DEFAULT_GW_TOKEN,
      apiToken: DEFAULT_API_TOKEN,
      connected: false,
      ws: null,
      pendingRequests: {},

      setCredentials: (gatewayUrl, gatewayToken) => set({ gatewayUrl, gatewayToken }),
      setConnected: (connected) => set({ connected }),

      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },

      connect: () => {
        const { gatewayUrl, gatewayToken, ws } = get()
        if (ws) ws.close()
        if (!gatewayUrl) return

        const socket = new WebSocket(gatewayUrl)

        socket.onopen = () => {
          // Send connect handshake after receiving challenge
          setTimeout(() => {
            socket.send(JSON.stringify({
              type: 'req', id: 'octis-connect', method: 'connect',
              params: {
                minProtocol: 3, maxProtocol: 3,
                client: { id: 'openclaw-control-ui', version: '0.1.0', platform: 'web', mode: 'ui' },
                role: 'operator',
                scopes: ['operator.read', 'operator.write'],
                caps: [], commands: [], permissions: {},
                auth: { token: gatewayToken },
                locale: 'en-US',
                userAgent: 'octis/0.1.0',
              }
            }))
          }, 50)
        }

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            get().handleMessage(msg)
            emit(msg)
          } catch {}
        }

        socket.onclose = () => {
          set({ connected: false, ws: null })
        }

        socket.onerror = () => {
          set({ connected: false, ws: null })
          window.dispatchEvent(new CustomEvent('octis:gateway-error'))
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
        // Connect response — gateway returns res with payload.type === 'hello-ok'
        if (msg.type === 'res' && msg.id === 'octis-connect' && msg.ok) {
          set({ connected: true })
          useGatewayStore.getState().send({ type: 'req', id: `sl-boot-${Date.now()}`, method: 'sessions.list', params: {} })
        }
        // Sessions list result — payload has .sessions array
        if (msg.type === 'res' && msg.ok && Array.isArray(msg.payload?.sessions)) {
          useSessionStore.getState().setSessions(msg.payload.sessions)
          // Background prefetch names for sessions we haven't opened yet
          prefetchSessionNames(msg.payload.sessions, get().send)
        }
        // sessions.changed event
        if (msg.type === 'event' && msg.event === 'sessions.changed') {
          const sessions = msg.payload?.sessions
          if (Array.isArray(sessions)) {
            useSessionStore.getState().setSessions(sessions)
            prefetchSessionNames(sessions, get().send)
          }
        }
        // Background prefetch history responses — extract name + session card
        if (msg.type === 'res' && msg.ok && msg.id?.startsWith('prefetch-')) {
          const sessionKey = msg.id.replace('prefetch-', '')
          const msgs = msg.payload?.messages ?? []
          if (msgs.length > 0) {
            const sessionStore = useSessionStore.getState()
            // Only set name if not already overridden by user
            const existing = sessionStore.displayNameOverrides[sessionKey]
            const session = sessionStore.sessions.find(s => s.key === sessionKey)
            const isDefault = !existing || existing === sessionKey
            if (isDefault) {
              const name = extractNameFromMessages(msgs)
              if (name) sessionStore.setDisplayNameOverride(sessionKey, name)
            }
            // Always cache session card if found
            const card = msgs.find(m => m.role === 'assistant' && resolveContentStatic(m.content)?.includes('📋'))
            if (card && !sessionStore.sessionCards[sessionKey]) {
              sessionStore.setSessionCard(sessionKey, resolveContentStatic(card.content).split('\n').slice(0, 8).join('\n'))
            }
            // Update message count
            const realMsgs = msgs.filter(m => m.role === 'user' || m.role === 'assistant')
            sessionStore.setMessageCount(sessionKey, realMsgs.length)
          }
        }

        // Chat activity tracking
        if (msg.type === 'event') {
          const sk = msg.payload?.sessionKey || msg.sessionKey
          if (sk) useSessionStore.getState().touchSession(sk)
        }
      },
    }),
    {
      name: 'octis-gateway',
      version: STORE_VERSION,
      // When version bumps, reset stored credentials to current env defaults
      migrate: (stored, fromVersion) => {
        return {
          ...stored,
          gatewayUrl: DEFAULT_GW,
          gatewayToken: DEFAULT_GW_TOKEN,
          apiUrl: DEFAULT_API,
          apiToken: DEFAULT_API_TOKEN,
        }
      },
      partialize: (s) => ({ apiUrl: s.apiUrl, apiToken: s.apiToken, gatewayUrl: s.gatewayUrl, gatewayToken: s.gatewayToken })
    }
  )
)

// ── Project classification ──────────────────────────────────────────────────
// Rules: checked in order, first match wins. Key and label are both searched.
// Add/edit rules here — no code changes needed elsewhere.
export const PROJECT_RULES = [
  { project: 'Octis',        patterns: [/octis/i] },
  { project: 'Sage',         patterns: [/sage/i, /intacct/i, /billing/i, /invoice/i, /facture/i] },
  { project: 'BS Migration', patterns: [/bs.migr/i, /building.*stack/i, /stack.*build/i, /buildium/i, /bs_build/i] },
  { project: 'Loan System',  patterns: [/loan/i, /pr[eê]t/i, /directus/i] },
  { project: 'Google Drive', patterns: [/drive/i, /gdrive/i, /gcp/i] },
  { project: 'Deal Analyzer',patterns: [/centurion/i, /centris/i, /deal/i, /zipplex/i] },
  { project: 'Beatimo Ops',  patterns: [/nexus/i, /beatimo/i, /billing/i, /monday/i] },
  { project: 'Infra',        patterns: [/infra/i, /nginx/i, /vm\b/i, /vps/i, /docker/i, /cron/i, /deploy/i] },
]

export function classifySession(session) {
  // Respect manually assigned project
  if (session.project) return session.project
  const haystack = [session.displayName, session.label, session.key].filter(Boolean).join(' ')
  for (const rule of PROJECT_RULES) {
    if (rule.patterns.some(p => p.test(haystack))) return rule.project
  }
  return 'General'
}

export function timeAgo(ts) {
  if (!ts) return ''
  const age = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime())
  if (age < 60_000) return 'just now'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`
  if (age < 7 * 86_400_000) return `${Math.floor(age / 86_400_000)}d ago`
  return `${Math.floor(age / (7 * 86_400_000))}w ago`
}
// ────────────────────────────────────────────────────────────────────────────

export const useSessionStore = create(
  persist(
    (set, get) => ({
      sessions: [],
      sessionActivity: {},
      activePanes: [null, null, null, null, null],
      paneCount: 2,
      // Manual project overrides: { [sessionKey]: projectName }
      projectOverrides: {},
      // Collapsed project folders: Set serialised as array
      collapsedProjects: [],

      displayNameOverrides: {},
      // Task status per session: 'todo' | 'doing' | 'done' | 'backlog' | 'archived'
      sessionStatuses: {},
      // Message counts per session (loaded from history)
      messageCounts: {},

      setDisplayNameOverride: (sessionKey, name) => {
        set(s => ({ displayNameOverrides: { ...s.displayNameOverrides, [sessionKey]: name } }))
      },

      getDisplayName: (session) => {
        const overrides = get().displayNameOverrides
        if (overrides[session?.key]) return overrides[session.key]
        return session.displayName || session.label || session.key
      },

      setSessionStatus: (sessionKey, status) => {
        set(s => ({ sessionStatuses: { ...s.sessionStatuses, [sessionKey]: status } }))
      },

      getSessionStatus: (sessionKey) => {
        return get().sessionStatuses[sessionKey] || 'todo'
      },

      setMessageCount: (sessionKey, count) => {
        set(s => ({ messageCounts: { ...s.messageCounts, [sessionKey]: count } }))
      },

      // Session cards keyed by sessionKey — populated when history loads
      sessionCards: {},
      setSessionCard: (sessionKey, cardText) => {
        set(s => ({ sessionCards: { ...s.sessionCards, [sessionKey]: cardText } }))
      },

      setSessions: (sessions) => set({ sessions }),

      touchSession: (sessionKey) => {
        set(s => ({
          sessionActivity: { ...s.sessionActivity, [sessionKey]: Date.now() }
        }))
      },

      setProjectOverride: (sessionKey, project) => {
        set(s => ({ projectOverrides: { ...s.projectOverrides, [sessionKey]: project } }))
      },

      toggleCollapsed: (project) => {
        set(s => {
          const next = s.collapsedProjects.includes(project)
            ? s.collapsedProjects.filter(p => p !== project)
            : [...s.collapsedProjects, project]
          return { collapsedProjects: next }
        })
      },

      getStatus: (session) => {
        if (session.status === 'active') return 'active'
        if (session.status === 'idle') return 'idle'
        if (session.status === 'dead' || session.status === 'archived') return 'dead'
        const activity = get().sessionActivity[session.key]
        const last = activity || session.updatedAt || session.lastActivity || session.updated_at
        if (!last) return 'idle'
        const age = Date.now() - (typeof last === 'number' ? last : new Date(last).getTime())
        if (age < 60 * 60 * 1000) return 'active'
        if (age < 24 * 60 * 60 * 1000) return 'idle'
        return 'dead'
      },

      getLastActive: (session) => {
        const activity = get().sessionActivity[session.key]
        return activity || session.updatedAt || session.lastActivity || session.updated_at || null
      },

      getProject: (session) => {
        const overrides = get().projectOverrides
        if (overrides[session.key]) return overrides[session.key]
        return classifySession(session)
      },

      pinToPane: (paneIndex, sessionKey) => {
        const panes = [...get().activePanes]
        panes[paneIndex] = sessionKey
        set({ activePanes: panes })
      },

      setPaneCount: (n) => set({ paneCount: Math.min(5, Math.max(1, n)) }),

      getActiveCount: () => {
        const { sessions, getStatus } = get()
        return sessions.filter(s => getStatus(s) === 'active').length
      },
    }),
    {
      name: 'octis-sessions',
      partialize: (s) => ({
        activePanes: s.activePanes,
        paneCount: s.paneCount,
        projectOverrides: s.projectOverrides,
        collapsedProjects: s.collapsedProjects,
        displayNameOverrides: s.displayNameOverrides,
        sessionStatuses: s.sessionStatuses,
      })
    }
  )
)
