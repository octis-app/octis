import { useEffect, useRef } from 'react'
import { useGatewayStore, useSessionStore, Session } from '../store/gatewayStore'
import { saveMsgCache, getMsgCacheAgeMs } from '../lib/msgCache'

/**
 * Background preloader: when WS connects, pre-fetch chat history for the top
 * 10 most recently active sessions and cache them in localStorage. When the user
 * switches to a session, ChatPane loads the cache instantly — no 5s wait.
 *
 * Purely additive — if it fails silently, no UX impact.
 */
export function useSessionPreloader() {
  const connected = useGatewayStore(s => s.connected)
  const ws = useGatewayStore(s => s.ws)
  const send = useGatewayStore(s => s.send)
  const subscribe = useGatewayStore(s => s.subscribe)
  const sessions = useSessionStore(s => s.sessions)

  const preloadedRef = useRef(false)

  useEffect(() => {
    // Only run once per WS connect cycle
    if (!connected || !ws || !send || sessions.length === 0) return
    if (preloadedRef.current) return
    preloadedRef.current = true

    // Pick top 10 sessions sorted by lastActivity desc
    const sorted = [...sessions].sort((a: Session, b: Session) => {
      const aTs = a.lastActivity ?? a.updatedAt ?? a.updated_at ?? 0
      const bTs = b.lastActivity ?? b.updatedAt ?? b.updated_at ?? 0
      return Number(bTs) - Number(aTs)
    })
    const top10 = sorted.slice(0, 10)

    // Stagger sends every 150ms
    top10.forEach((session: Session, index: number) => {
      const key = session.key
      if (!key) return

      // Skip if cache is still fresh (< 2 min)
      if (getMsgCacheAgeMs(key) < 2 * 60 * 1000) return

      setTimeout(() => {
        try {
          const reqId = `preload-${key}-${Date.now()}`
          send({ type: 'req', id: reqId, method: 'chat.history', params: { sessionKey: key, limit: 30 } })
        } catch { /* silent */ }
      }, index * 150)
    })
  }, [connected, ws, send, sessions])

  // Listen for preload responses via shared bus (not raw ws.onmessage)
  useEffect(() => {
    const unsub = subscribe((raw: unknown) => {
      try {
        const msg = raw as { type?: string; id?: string; result?: { messages?: unknown[] } }
        if (typeof msg.id !== 'string' || !msg.id.startsWith('preload-')) return
        if (msg.type !== 'res') return
        const messages = msg.result?.messages
        if (!Array.isArray(messages)) return

        // Extract sessionKey from the preload-<key>-<ts> reqId
        const parts = msg.id.split('-')
        if (parts.length < 2) return
        // Rejoin everything except first and last segments (preload + ts)
        const key = parts.slice(1, -1).join('-') || parts[1]
        if (!key) return

        saveMsgCache(key, messages as Array<{ id: string | number; role: string; content: string }>)
      } catch { /* silent */ }
    })
    return unsub
  }, [subscribe])

  // Reset flag when WS disconnects, so preloading runs again on reconnect
  useEffect(() => {
    if (!connected) {
      preloadedRef.current = false
    }
  }, [connected])
}