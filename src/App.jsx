import { useState, useEffect } from 'react'
import { useAuth, useUser, SignedIn, SignedOut, UserButton } from '@clerk/clerk-react'
import { useGatewayStore, useSessionStore, useLabelStore } from './store/gatewayStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import CostsPanel from './components/CostsPanel'
import MemoryPanel from './components/MemoryPanel'
import SettingsPanel from './components/SettingsPanel'
import MobileApp from './components/MobileApp'
import AuthGate from './components/AuthGate'

// Detect mobile: screen width <768px or touch device
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return mobile
}

const NAV = [
  { id: 'sessions', label: '💬 Sessions' },
  { id: 'costs', label: '💰 Costs' },
  { id: 'memory', label: '🧠 Memory' },
]

const API = import.meta.env.VITE_API_URL || ''

export default function App() {
  const { isSignedIn, isLoaded, getToken } = useAuth()

  // Show auth gate while Clerk loads or when not signed in
  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1117]">
        <span className="text-[#6b7280] text-sm">Loading…</span>
      </div>
    )
  }
  if (!isSignedIn) return <AuthGate />

  return <AuthenticatedApp getToken={getToken} />
}

function AuthenticatedApp({ getToken }) {
  const { connected, gatewayUrl, gatewayToken, agentId, connect, setCredentials } = useGatewayStore()
  const { activePanes, paneCount, setPaneCount, pinToPane } = useSessionStore()
  const { labels, setLabel } = useLabelStore()
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeNav, setActiveNav] = useState('sessions')
  const isMobile = useIsMobile()

  // Fetch gateway config from server using Clerk JWT (runs once after sign-in)
  useEffect(() => {
    if (gatewayUrl && gatewayToken) {
      // Already have credentials (e.g. from localStorage) — just connect
      // agentId is also persisted, so it will filter automatically
      if (!connected) connect()
      return
    }
    const fetchConfig = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API}/api/gateway-config`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`)
        const data = await res.json()
        setCredentials(data.url, data.token, data.agentId)
        connect()
      } catch (e) {
        console.error('[octis] Failed to fetch gateway config:', e)
        // Fall back to connect modal
        setShowConnect(true)
      }
    }
    fetchConfig()
  }, [])

  // Seed session labels from DB — runs on startup and whenever sessions connect
  const { sessions } = useSessionStore()
  useEffect(() => {
    fetch(`${API}/api/session-labels`)
      .then(r => r.json())
      .then(data => {
        if (typeof data === 'object' && !data.error) {
          // data is { uuid: label }
          // Store by UUID first
          Object.entries(data).forEach(([uuid, label]) => {
            if (!labels[uuid]) setLabel(uuid, label)
          })
          // Also try to match against loaded sessions by their sessionId
          sessions.forEach(s => {
            const uuid = s.id || s.sessionId
            const gKey = s.key
            if (uuid && data[uuid] && !labels[gKey]) {
              setLabel(gKey, data[uuid])
            }
          })
        }
      })
      .catch(() => {})
  }, []) // run once on mount

  // Re-seed when sessions load from gateway
  useEffect(() => {
    if (!sessions.length) return
    fetch(`${API}/api/session-labels`)
      .then(r => r.json())
      .then(data => {
        if (typeof data === 'object' && !data.error) {
          sessions.forEach(s => {
            const uuid = s.id || s.sessionId
            const gKey = s.key
            if (uuid && data[uuid] && !labels[gKey]) {
              setLabel(gKey, data[uuid])
            }
          })
        }
      })
      .catch(() => {})
  }, [sessions.length])


  useEffect(() => {
    if (!connected && !gatewayUrl) setShowConnect(true)
  }, [connected, gatewayUrl])

  // Render mobile layout on small screens
  if (isMobile) {
    return <MobileApp />
  }

  const visiblePanes = activePanes.slice(0, paneCount)

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117]">
      {/* Left nav */}
      <div className="flex flex-col w-14 bg-[#181c24] border-r border-[#2a3142] items-center py-4 gap-2 shrink-0">
        <button onClick={() => setShowSettings(true)} className="text-2xl mb-2 hover:opacity-70 transition-opacity" title="Settings">🐙</button>
        {NAV.map(n => (
          <button
            key={n.id}
            onClick={() => setActiveNav(n.id)}
            title={n.label}
            className={`w-9 h-9 rounded-lg text-lg transition-colors flex items-center justify-center ${
              activeNav === n.id ? 'bg-[#6366f1]' : 'hover:bg-[#2a3142] text-[#6b7280]'
            }`}
          >
            {n.label.split(' ')[0]}
          </button>
        ))}
        <div className="flex-1" />
        {/* Connection status */}
        <button
          onClick={() => setShowConnect(true)}
          title="Gateway Settings"
          className={`w-9 h-9 rounded-lg text-sm transition-colors flex items-center justify-center ${
            connected ? 'text-green-400 hover:bg-[#2a3142]' : 'text-red-400 hover:bg-[#2a3142]'
          }`}
        >
          {connected ? '🟢' : '🔴'}
        </button>
        {/* User avatar / sign-out */}
        <div className="mt-2 mb-1">
          <UserButton
            appearance={{
              elements: {
                avatarBox: 'w-8 h-8',
                userButtonPopoverCard: 'bg-[#181c24] border border-[#2a3142]',
                userButtonPopoverActionButton: 'text-[#e8eaf0] hover:bg-[#2a3142]',
                userButtonPopoverActionButtonText: 'text-[#e8eaf0]',
                userButtonPopoverFooter: 'hidden',
              }
            }}
          />
        </div>
      </div>

      {/* Main content */}
      {activeNav === 'sessions' && (
        <>
          <Sidebar onSettingsClick={() => setShowConnect(true)} />
          <div className="flex flex-1 overflow-hidden">
            {visiblePanes.map((sessionKey, i) => (
              <ChatPane
                key={i}
                sessionKey={sessionKey}
                paneIndex={i}
                onClose={() => pinToPane(i, null)}
              />
            ))}
          </div>
          {/* Pane switcher */}
          <div className="fixed bottom-4 right-4 flex gap-1 bg-[#181c24] border border-[#2a3142] rounded-lg p-1 shadow-lg z-40">
            {[1,2,3,4,5].map(n => (
              <button
                key={n}
                onClick={() => setPaneCount(n)}
                className={`w-7 h-7 text-xs rounded transition-colors ${
                  paneCount === n ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </>
      )}

      {activeNav === 'costs' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold">💰 Costs</h1>
          </div>
          <CostsPanel />
        </div>
      )}

      {activeNav === 'memory' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold">🧠 Memory</h1>
          </div>
          <MemoryPanel />
        </div>
      )}

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}
