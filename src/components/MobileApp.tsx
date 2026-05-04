import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { io, Socket } from 'socket.io-client'
import { useSessionStore, type Session } from '../store/gatewayStore'
import { agentColors, useLabelStore } from '../store/gatewayStore'
import { authFetch } from '../utils/fetch'
import { timeAgo, capitalizeFirstLetter } from '../utils/date'

const API = (import.meta.env.VITE_API_URL as string) || ''

// Auth fetch function to handle tokens
function useAuthFetch() {
  return useCallback(authFetch, [])
}

function getLabel(sessionKey: string, fallback: string): string {
  const { labels } = useLabelStore.getState() 
  return labels[sessionKey] || fallback
}

export default function MobileApp() {
  const { agentId } = useParams<{ agentId?: string }>() // Optional agentId parameter
  const navigate = useNavigate()
  
  const [sessionList, setSessionList] = useState<Session[]>([])
  const [connecting, setConnecting] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  
  // Load sessions and establish WebSocket connection on mount
  useEffect(() => {
    let ws: Socket | null = null
    let reconnectTimer: NodeJS.Timeout
    
    const connectWs = () => {
      setConnecting(true)
      ws = io(API, { 
        transports: ['websocket'],
        auth: { token: localStorage.getItem('octis_token') },
        path: '/ws'
      })
  
      ws.on('connect', () => {
        console.log('[mobile] WS connected')
        setWsConnected(true) 
        setConnecting(false)
      })
      
      ws.on('disconnect', () => {
        console.log('[mobile] WS disconnected')
        setWsConnected(false)
        setConnecting(false)
      })
  
      ws.on('sessionUpdate', (update) => {
        useSessionStore.getState().updateSession(update.key, update.status, update.estimatedCostUsd)
        setSessionList(prev => prev.map(s => s.key === update.key ? {...s, ...update} : s))
      })
  
      ws.on('connect_error', (err) => {
        console.error('[mobile] WS connection error:', err.message)
        setConnecting(false)
        // Schedule reconnect after delay
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(connectWs, 5000)
        }
      })
    }
    
    const loadData = async () => {
      // First try WS connection
      const connected = useSessionStore.getState().ws?.connected
      if (connected) return // WS is already established from another component
  
      if (!connected) {
        try {
          // Establish WS connection
          useSessionStore.getState().initWs()
        } catch (e) {
          console.warn('[mobile] Could not initialize WS, trying direct refresh')
        }
      }
      
      // Load session list
      const c = useSessionStore.getState().ws?.connected
      if (c) return // WS is fine, no need
      
      try {
        const url = `${API}/api/sessions-list${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`
        const r = await authFetch(url)
        if (!r.ok) return
        const data = await r.json() as { ok: boolean; sessions?: Session[] }
        if (data.ok && data.sessions?.length) {
          setSessionList(data.sessions)
          // Sync to Zustand store with last activity timestamp priority
          for (const s of data.sessions) {
            if (s.lastActivity || s.createdAt) {
              useSessionStore.getState().addRecentSession(s.key, s.lastActivity || s.createdAt!, s.agentId, s.label)
            }
          }
        }
      } catch (e) {
        console.error('[mobile] Session list load failed:', e)
      }
    }
    
    void loadData()
    connectWs()
    
    return () => {
      if (ws) ws.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [agentId])

  // Refresh session list periodically using WS
  useEffect(() => {
    if (!wsConnected) return
    const interval = setInterval(() => {
      // Use existing WS logic instead of fetch
      // The session updates will come through via 'sessionUpdate' events from the WS
    }, 5_000)
    return () => clearInterval(interval)
  }, [wsConnected])

  // Memoized getLabel function (using Zustand store directly)
  const memoGetLabel = useCallback(getLabel, [])

  // Filter functions (now use memoized getLabel for consistency)
  const hideSession = useCallback((s: Session) => {
    if (!s.key) return true
    const key = s.key.toLowerCase()
    // Always hide certain internal sessions that should never appear in UI lists
    if (key.includes(':dashboard:') || key.includes(':admin:')) return true
    // Use getLabel (same as desktop) so server-side labels are checked, not just s.label
    const lbl = memoGetLabel(s.key, s.label || '')
    if (lbl.startsWith('Continue where you left off')) return true
    return false
  }, [memoGetLabel])

  const hideHeartbeat = localStorage.getItem('octis-show-heartbeat-sessions') !== 'true'

  const isHeartbeatSession = useCallback((s: Session) => {
    if (!s.key) return false
    const key = s.key.toLowerCase()
    if (key.includes(':cron:')) return true
    const lbl = (memoGetLabel(s.key, s.label || s.key) || '').toLowerCase()
    return lbl.includes('heartbeat') || lbl.startsWith('read heartbeat')
  }, [memoGetLabel])
  
  // Stable session fingerprint — only recompute visibleSessions when keys/statuses actually change
  const visibleSessions = useCallback(() => {
    return sessionList.filter(s => {
      if (!s.key) return false
      if (hideSession(s)) return false
      if (hideHeartbeat && isHeartbeatSession(s)) return false
      return true
    }).sort((a, b) => {
      // Sort by: 1) Running first, 2) Recently active first
      const aRunning = a.status === 'running' ? 1 : 0
      const bRunning = b.status === 'running' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning // Running first
      
      // Then by last activity or created time
      const aTime = a.lastActivity || a.createdAt || new Date().toISOString()
      const bTime = b.lastActivity || b.createdAt || new Date().toISOString()
      return bTime.localeCompare(aTime) // Newest first
    })
  }, [sessionList, hideSession, hideHeartbeat, isHeartbeatSession])

  // Render the mobile UI
  return (
    <div className="flex flex-col h-screen bg-[#0f1117] text-white">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-[#111319] border-b border-[#22252f] p-4 flex items-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="w-8 h-8 rounded-full bg-[#22252f] flex items-center justify-center hover:bg-[#2a3142] transition-colors"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold truncate">
            {agentId ? `With ${capitalizeFirstLetter(agentId.replace('agent:', ''))}` : 'Sessions'}
          </h1>
          <div className="text-xs text-[#6b7280]">
            {wsConnected ? '● Connected' : connecting ? '↻ Connecting...' : '○ Disconnected'}
          </div>
        </div>
      </header>

      {/* Session List */}
      <main className="flex-1 overflow-y-auto p-4 pb-20">
        {visibleSessions().length === 0 ? (
          <div className="text-center py-12 text-[#6b7280]">
            {sessionList.length === 0 
              ? 'No sessions found' 
              : 'No visible sessions (adjust filters in Settings)'}
          </div>
        ) : (
          <div className="space-y-2">
            {visibleSessions().map(s => {
              const lbl = memoGetLabel(s.key, s.label || '')
          
              // Status styling
              const statusColors = {
                running: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-500' },
                error: { bg: 'bg-red-500/20', text: 'text-red-400', dot: 'bg-red-500' },
                pending: { bg: 'bg-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-500' },
                idle: { bg: 'bg-gray-500/20', text: 'text-gray-400', dot: 'bg-gray-500' }
              }
              const statusColor = s.status ? statusColors[s.status].dot : 'bg-gray-500'
              const statusLabel = s.status ? s.status.charAt(0).toUpperCase() : 'I'
              
              // Time ago calculation
              const ago = s.lastActivity ? timeAgo(s.lastActivity) : s.createdAt ? timeAgo(s.createdAt) : ''
          
              return (
                <button
                  key={s.key}
                  onClick={() => navigate(`/chat/${encodeURIComponent(s.key)}`)}
                  className="w-full p-3 bg-[#181c24] rounded-xl border border-[#22252f] hover:border-[#4f46e5]/50 transition-colors flex items-center gap-3 group"
                >
                  {/* Agent color bar */}
                  <div 
                    className="w-1 h-8 rounded-sm" 
                    style={{ backgroundColor: agentColors[s.agentId] || '#6b7280' }}
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="flex-1 text-sm text-white truncate min-w-0">{lbl}</span>
                      <span className="text-xs shrink-0 font-medium" style={{ color: statusColor }}>{statusLabel}</span>
                      {ago && <span className="text-xs text-[#4b5563] shrink-0">{ago}</span>}
                    </div>
                    {(() => { const cost = useSessionStore.getState().sessionMeta[s.key]?.lastExchangeCost; return cost != null ? <span className="text-[10px] text-[#4b5563] shrink-0 font-mono">${(cost * 100).toFixed(1)}¢</span> : null })()}
                  </div>
                  <span className="text-[#4b5563] shrink-0">›</span>
                </button>
              )
            })}
          </div>
        )}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-[#111319] border-t border-[#22252f] p-3 flex justify-around">
        <button
          onClick={() => navigate('/')}
          className="flex flex-col items-center gap-1 text-xs"
        >
          <div className="w-6 h-6">🏠</div>
          <span>Sessions</span>
        </button>
        <button
          onClick={() => navigate('/settings')}
          className="flex flex-col items-center gap-1 text-xs"
        >
          <div className="w-6 h-6">⚙️</div>
          <span>Settings</span>
        </button>
        <button
          onClick={() => {
            const sessionType = agentId || 'main'
            navigate(`/chat/session:new:${sessionType}:${Date.now()}`)
          }}
          className="w-10 h-10 rounded-full bg-[#4f46e5] flex items-center justify-center"
        >
          +
        </button>
        <button
          onClick={() => navigate('/agents')}
          className="flex flex-col items-center gap-1 text-xs"
        >
          <div className="w-6 h-6">🤖</div>
          <span>Agents</span>
        </button>
        <button
          onClick={() => navigate('/costs')}
          className="flex flex-col items-center gap-1 text-xs"
        >
          <div className="w-6 h-6">💰</div>
          <span>Costs</span>
        </button>
      </nav>
    </div>
  )
}