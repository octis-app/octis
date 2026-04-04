import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Shared message bus for gateway events
const listeners = new Set()
const emit = (msg) => listeners.forEach(fn => fn(msg))

export const useGatewayStore = create(
  persist(
    (set, get) => ({
      gatewayUrl: '',
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

        const wsUrl = gatewayUrl.replace(/^http/, 'ws')
        const socket = new WebSocket(wsUrl)

        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: 'connect',
            params: { auth: { token: gatewayToken }, mode: 'operator' }
          }))
        }

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            get().handleMessage(msg)
            emit(msg)
          } catch {}
        }

        socket.onclose = () => set({ connected: false, ws: null })
        socket.onerror = () => {
          set({ connected: false, ws: null })
          // Signal app to show connect modal
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
        if (msg.type === 'connect.ack') {
          set({ connected: true })
          useGatewayStore.getState().send({ type: 'sessions.list' })
        }
        if (msg.type === 'sessions.list.result') {
          useSessionStore.getState().setSessions(msg.sessions || [])
        }
        // Update session activity on any chat event
        if (msg.type === 'chat' && msg.sessionKey) {
          useSessionStore.getState().touchSession(msg.sessionKey)
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
  sessionActivity: {}, // sessionKey -> timestamp of last activity
  activePanes: [null, null, null, null, null],
  paneCount: 2,

  setSessions: (sessions) => set({ sessions }),

  touchSession: (sessionKey) => {
    set(s => ({
      sessionActivity: { ...s.sessionActivity, [sessionKey]: Date.now() }
    }))
  },

  getStatus: (session) => {
    // Use real-time activity tracking if available
    const activity = get().sessionActivity[session.key]
    const last = activity || session.updatedAt || session.lastActivity || session.updated_at
    if (!last) return 'idle'
    const age = Date.now() - (typeof last === 'number' ? last : new Date(last).getTime())
    if (age < 60 * 60 * 1000) return 'active'       // < 1h
    if (age < 24 * 60 * 60 * 1000) return 'idle'    // < 24h
    return 'dead'                                     // > 24h
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
