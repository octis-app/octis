import { useState, useEffect } from 'react'
import { useGatewayStore, useSessionStore } from './store/gatewayStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import CostsPanel from './components/CostsPanel'
import MemoryPanel from './components/MemoryPanel'
import MobileView from './components/MobileView'
import ErrorBoundary from './components/ErrorBoundary'

const NAV = [
  { id: 'sessions', label: '💬 Sessions' },
  { id: 'costs', label: '💰 Costs' },
  { id: 'memory', label: '🧠 Memory' },
]

// Detect mobile: screen width < 768px
function useIsMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const check = () => setMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return mobile
}

export default function App() {
  const { connected, gatewayUrl, gatewayToken, connect, setCredentials } = useGatewayStore()
  const { activePanes, paneCount, setPaneCount, pinToPane } = useSessionStore()
  const [showConnect, setShowConnect] = useState(false)
  const [activeNav, setActiveNav] = useState('sessions')
  const isMobile = useIsMobile()

  useEffect(() => {
    // Always use the baked-in VPS URL — override any stale localhost value from localStorage
    const defaultUrl = import.meta.env.VITE_GW_URL || 'ws://34.152.7.106:18789'
    const defaultToken = import.meta.env.VITE_GW_TOKEN || '639c6816ff74eb188727ff5ff62423be0de9b6e1f62862e1f6f6207970c284b5'
    const isStale = !gatewayUrl || gatewayUrl.includes('127.0.0.1') || gatewayUrl.includes('localhost')
    const url = isStale ? defaultUrl : gatewayUrl
    const token = gatewayToken || defaultToken
    if (isStale) setCredentials(url, token)
    if (!connected) connect()
    const onError = () => setShowConnect(true)
    window.addEventListener('octis:gateway-error', onError)
    return () => window.removeEventListener('octis:gateway-error', onError)
  }, [])

  const visiblePanes = activePanes.slice(0, paneCount)

  // Mobile layout
  if (isMobile) {
    return (
      <ErrorBoundary>
        <MobileView onSettingsClick={() => setShowConnect(true)} />
        {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      </ErrorBoundary>
    )
  }

  // Desktop layout
  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-[#0f1117]">
        {/* Left nav */}
        <div className="flex flex-col w-14 bg-[#181c24] border-r border-[#2a3142] items-center py-4 gap-2 shrink-0">
          <div className="text-2xl mb-2">🐙</div>
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
          <button
            onClick={() => setShowConnect(true)}
            title="Gateway Settings"
            className={`w-9 h-9 rounded-lg text-sm transition-colors flex items-center justify-center ${
              connected ? 'text-green-400 hover:bg-[#2a3142]' : 'text-red-400 hover:bg-[#2a3142]'
            }`}
          >
            {connected ? '🟢' : '🔴'}
          </button>
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
      </div>
    </ErrorBoundary>
  )
}
