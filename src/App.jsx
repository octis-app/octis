import { useState, useEffect } from 'react'
import { useGatewayStore, useSessionStore } from './store/gatewayStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import CostsPanel from './components/CostsPanel'
import MemoryPanel from './components/MemoryPanel'
import ErrorBoundary from './components/ErrorBoundary'

const NAV = [
  { id: 'sessions', label: '💬 Sessions' },
  { id: 'costs', label: '💰 Costs' },
  { id: 'memory', label: '🧠 Memory' },
]

export default function App() {
  const { connected, gatewayUrl, connect } = useGatewayStore()
  const { activePanes, paneCount, setPaneCount, pinToPane } = useSessionStore()
  const [showConnect, setShowConnect] = useState(false)
  const [activeNav, setActiveNav] = useState('sessions')

  useEffect(() => {
    if (gatewayUrl && !connected) connect()
    const onError = () => setShowConnect(true)
    window.addEventListener('octis:gateway-error', onError)
    return () => window.removeEventListener('octis:gateway-error', onError)
  }, [])

  useEffect(() => {
    if (!connected && !gatewayUrl) setShowConnect(true)
  }, [connected, gatewayUrl])

  const visiblePanes = activePanes.slice(0, paneCount)

  return (
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
  )
}
