import { useState, useEffect } from 'react'
import { useGatewayStore, useSessionStore } from './store/gatewayStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'

export default function App() {
  const { connected, gatewayUrl, connect } = useGatewayStore()
  const { activePanes, paneCount, setPaneCount, pinToPane } = useSessionStore()
  const [showConnect, setShowConnect] = useState(false)

  // Auto-connect on load if credentials exist
  useEffect(() => {
    if (gatewayUrl && !connected) connect()
  }, [])

  useEffect(() => {
    if (!connected && !gatewayUrl) setShowConnect(true)
  }, [connected, gatewayUrl])

  const visiblePanes = activePanes.slice(0, paneCount)

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117]">
      <Sidebar onSettingsClick={() => setShowConnect(true)} />

      {/* Pane layout */}
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

      {/* Pane count switcher */}
      <div className="fixed bottom-4 right-4 flex gap-1 bg-[#181c24] border border-[#2a3142] rounded-lg p-1 shadow-lg">
        {[1,2,3,4,5].map(n => (
          <button
            key={n}
            onClick={() => setPaneCount(n)}
            className={`w-7 h-7 text-xs rounded transition-colors ${paneCount === n ? 'bg-[#6366f1] text-white' : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'}`}
          >
            {n}
          </button>
        ))}
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}
