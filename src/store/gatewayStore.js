import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useGatewayStore = create(
  persist(
    (set, get) => ({
      gatewayUrl: '',
      gatewayToken: '',
      connected: false,
      ws: null,

      setCredentials: (url, token) => set({ gatewayUrl: url, gatewayToken: token }),

      setConnected: (connected) => set({ connected }),

      connect: () => {
        const { gatewayUrl, gatewayToken, ws } = get()
        if (ws) ws.close()
        if (!gatewayUrl) return

        const socket = new WebSocket(gatewayUrl.replace(/^http/, 'ws'))

        socket.onopen = () => {
          socket.send(JSON.stringify({
            type: 'connect',
            params: { auth: { token: gatewayToken }, mode: 'operator' }
          }))
        }

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data)
            useGatewayStore.getState().handleMessage(msg)
          } catch {}
        }

        socket.onclose = () => set({ connected: false, ws: null })
        socket.onerror = () => set({ connected: false })

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
        }
      },

      handleMessage: (msg) => {
        if (msg.type === 'connect.ack') {
          set({ connected: true })
          // Load sessions after connect
          useGatewayStore.getState().send({ type: 'sessions.list' })
        }
        if (msg.type === 'sessions.list.result') {
          useSessionStore.getState().setSessions(msg.sessions || [])
        }
      },
    }),
    { name: 'octis-gateway', partialize: (s) => ({ gatewayUrl: s.gatewayUrl, gatewayToken: s.gatewayToken }) }
  )
)

export const useSessionStore = create((set, get) => ({
  sessions: [],
  activePanes: [null, null, null, null, null], // up to 5 panes
  paneCount: 2,

  setSessions: (sessions) => set({ sessions }),

  getStatus: (session) => {
    const last = session.updatedAt || session.lastActivity
    if (!last) return 'idle'
    const age = Date.now() - new Date(last).getTime()
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
}))
