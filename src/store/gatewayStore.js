import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// --- Device identity helpers (Web Crypto) ---

async function generateDeviceKey() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  )
  const pubKeyRaw = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const pubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(pubKeyRaw)))

  // Device ID = sha256 of public key (hex, first 32 chars)
  const hash = await crypto.subtle.digest('SHA-256', pubKeyRaw)
  const deviceId = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)

  return { keyPair, pubKeyB64, deviceId }
}

async function signChallenge(privateKey, payload) {
  const encoded = new TextEncoder().encode(payload)
  const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, encoded)
  return btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
}

// Persist device identity across sessions
let _deviceCache = null
async function getOrCreateDevice() {
  if (_deviceCache) return _deviceCache
  const stored = localStorage.getItem('octis-device')
  if (stored) {
    try {
      const d = JSON.parse(stored)
      // Re-import the key
      const privRaw = Uint8Array.from(atob(d.privKeyB64), c => c.charCodeAt(0))
      const pubRaw = Uint8Array.from(atob(d.pubKeyB64), c => c.charCodeAt(0))
      const privateKey = await crypto.subtle.importKey('pkcs8', privRaw, { name: 'Ed25519' }, false, ['sign'])
      _deviceCache = { privateKey, pubKeyB64: d.pubKeyB64, deviceId: d.deviceId }
      return _deviceCache
    } catch (e) {
      console.warn('Failed to restore device key, generating new one', e)
    }
  }

  // Generate new
  const { keyPair, pubKeyB64, deviceId } = await generateDeviceKey()
  const privRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const privKeyB64 = btoa(String.fromCharCode(...new Uint8Array(privRaw)))
  localStorage.setItem('octis-device', JSON.stringify({ pubKeyB64, privKeyB64, deviceId }))
  _deviceCache = { privateKey: keyPair.privateKey, pubKeyB64, deviceId }
  return _deviceCache
}

// Shared message bus for gateway events
const listeners = new Set()
const emit = (msg) => listeners.forEach(fn => fn(msg))

export const useGatewayStore = create(
  persist(
    (set, get) => ({
      gatewayUrl: import.meta.env.VITE_GATEWAY_URL || '',
      gatewayToken: '',
      connected: false,
      ws: null,
      pendingRequests: {},

      setCredentials: (url, token) => set({ gatewayUrl: url, gatewayToken: token }),
      setConnected: (connected) => set({ connected }),

      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },

      connect: () => {
        const { gatewayUrl, gatewayToken, ws } = get()
        if (ws) ws.close()
        if (!gatewayUrl) return

        const wsUrl = gatewayUrl.startsWith('http') ? gatewayUrl.replace(/^http/, 'ws') : gatewayUrl
        const socket = new WebSocket(wsUrl)

        socket.onopen = () => {
          // Wait for challenge — don't send anything yet
          console.log('[octis] WS open, waiting for challenge...')
        }

        socket.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data)
            get().handleMessage(msg)
            emit(msg)

            // Handle challenge-response handshake
            // No device identity sent — gateway runs with dangerouslyDisableDeviceAuth
            // so any stale device key in localStorage would cause device-id-mismatch rejections
            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              const token = get().gatewayToken
              socket.send(JSON.stringify({
                type: 'req',
                id: 'octis-connect',
                method: 'connect',
                params: {
                  minProtocol: 3,
                  maxProtocol: 3,
                  client: {
                    id: 'openclaw-control-ui',
                    version: '0.1.0',
                    platform: 'web',
                    mode: 'ui',
                  },
                  role: 'operator',
                  scopes: ['operator.read', 'operator.write'],
                  caps: [],
                  commands: [],
                  permissions: {},
                  auth: { token },
                  locale: navigator.language || 'en-US',
                  userAgent: 'octis/0.1.0',
                },
              }))
              console.log('[octis] Sent connect (token-only auth)')
            }
          } catch (e) {
            console.warn('[octis] Failed to parse message', e)
          }
        }

        socket.onclose = (e) => {
          console.log('[octis] WS closed:', e.code, e.reason)
          set({ connected: false, ws: null })
        }
        socket.onerror = (e) => {
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
        // Connect response
        if (msg.type === 'res' && msg.id === 'octis-connect') {
          if (msg.ok) {
            console.log('[octis] Connected ✅', msg.payload)
            set({ connected: true })
            useSessionStore.getState().setSessions([])
            // Request sessions list
            const { ws } = useGatewayStore.getState()
            if (ws) ws.send(JSON.stringify({ type: 'req', id: 'sessions-list-init', method: 'sessions.list', params: {} }))
          } else {
            console.error('[octis] Auth failed:', msg.error)
            set({ connected: false })
          }
        }

        if (msg.type === 'res' && (msg.id === 'sessions-list-init' || msg.id === 'sessions-list')) {
          const raw = msg.payload?.sessions || []
          // Normalize: gateway uses sessionKey, our UI uses .key
          const sessions = raw.map(s => ({ ...s, key: s.key || s.sessionKey }))
          useSessionStore.getState().setSessions(sessions)
        }

        // Also handle the old event-based sessions list
        if (msg.type === 'sessions.list.result') {
          const raw = msg.sessions || []
          const sessions = raw.map(s => ({ ...s, key: s.key || s.sessionKey }))
          useSessionStore.getState().setSessions(sessions)
        }

        // Track streaming + last role for status indicators
        if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.sessionKey) {
          const sk = msg.payload.sessionKey
          const role = msg.payload.role
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
      partialize: (s) => ({ gatewayUrl: s.gatewayUrl, gatewayToken: s.gatewayToken })
    }
  )
)

export const useSessionStore = create((set, get) => ({
  sessions: [],
  sessionActivity: {},
  sessionMeta: {},    // { [sessionKey]: { lastRole: 'user'|'assistant', isStreaming: bool } }
  streamingTimers: {},
  activePanes: [null, null, null, null, null],
  paneCount: 2,

  setSessions: (sessions) => set({ sessions }),

  touchSession: (sessionKey) => {
    set(s => ({
      sessionActivity: { ...s.sessionActivity, [sessionKey]: Date.now() }
    }))
  },

  setLastRole: (sessionKey, role) => {
    set(s => ({
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), lastRole: role, isStreaming: false }
      }
    }))
  },

  markStreaming: (sessionKey) => {
    // Clear any existing debounce timer
    const existing = get().streamingTimers[sessionKey]
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      // Streaming stopped — keep lastRole as 'assistant' (needs-you)
      set(s => ({
        sessionMeta: {
          ...s.sessionMeta,
          [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), isStreaming: false }
        },
        streamingTimers: Object.fromEntries(
          Object.entries(s.streamingTimers).filter(([k]) => k !== sessionKey)
        )
      }))
    }, 4000)

    set(s => ({
      streamingTimers: { ...s.streamingTimers, [sessionKey]: timer },
      sessionMeta: {
        ...s.sessionMeta,
        [sessionKey]: { ...(s.sessionMeta[sessionKey] || {}), isStreaming: true, lastRole: 'assistant' }
      }
    }))
  },

  getStatus: (session) => {
    const key = session.key || session.sessionKey
    const meta = get().sessionMeta[key] || {}

    if (meta.isStreaming) return 'working'
    if (meta.lastRole === 'assistant') return 'needs-you'
    // Treat 'user' lastRole as active if recent
    const activity = get().sessionActivity[key]
    const last = activity || session.updatedAt || session.lastActivity || session.updated_at
    if (!last) return 'idle'
    const age = Date.now() - (typeof last === 'number' ? last : new Date(last).getTime())
    if (age < 60 * 60 * 1000) return 'active'
    if (age < 24 * 60 * 60 * 1000) return 'idle'
    return 'dead'
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
}))
