import { useState } from 'react'
import { useGatewayStore, useSessionStore } from '../store/gatewayStore'
import MobileSessionCard from './MobileSessionCard'
import MobileFullChat from './MobileFullChat'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'
import ConnectModal from './ConnectModal'

const TABS = [
  { id: 'sessions', icon: '💬', label: 'Sessions' },
  { id: 'costs', icon: '💰', label: 'Costs' },
  { id: 'memory', icon: '🧠', label: 'Memory' },
]

export default function MobileApp() {
  const { connected, gatewayUrl } = useGatewayStore()
  const { sessions, getStatus } = useSessionStore()
  const [tab, setTab] = useState('sessions')
  const [fullChatSession, setFullChatSession] = useState(null)
  const [showConnect, setShowConnect] = useState(!gatewayUrl)
  const [filter, setFilter] = useState('all')

  const filtered = sessions.filter(s => {
    if (filter === 'active') return getStatus(s) === 'active'
    if (filter === 'idle') return getStatus(s) === 'idle'
    return true
  })

  const counts = {
    active: sessions.filter(s => getStatus(s) === 'active').length,
    idle: sessions.filter(s => getStatus(s) === 'idle').length,
  }

  if (fullChatSession) {
    return <MobileFullChat session={fullChatSession} onBack={() => setFullChatSession(null)} />
  }

  return (
    <div className="flex flex-col bg-[#0f1117] overflow-hidden"
      style={{ height: '100dvh' }}>

      {/* Status bar area */}
      <div className="bg-[#181c24] border-b border-[#2a3142] shrink-0"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🐙</span>
            <span className="text-white font-semibold text-base tracking-tight">Octis</span>
          </div>
          <button
            onClick={() => setShowConnect(true)}
            className="flex items-center gap-1.5 text-xs text-[#6b7280] hover:text-white transition-colors"
          >
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'sessions' && (
          <>
            {/* Filter pills */}
            <div className="flex gap-2 px-4 pt-3 pb-2 shrink-0">
              {[
                { id: 'all', label: `All ${sessions.length}` },
                { id: 'active', label: `🟢 ${counts.active}` },
                { id: 'idle', label: `🟡 ${counts.idle}` },
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    filter === f.id
                      ? 'bg-[#6366f1] text-white'
                      : 'bg-[#1e2330] text-[#6b7280] active:bg-[#2a3142]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Swipeable card carousel */}
            {filtered.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center px-8">
                  <div className="text-4xl mb-3">🐙</div>
                  <div className="text-[#6b7280] text-sm">
                    {sessions.length === 0
                      ? 'No sessions yet. Connect to your gateway to get started.'
                      : 'No sessions match this filter.'}
                  </div>
                  {!connected && (
                    <button
                      onClick={() => setShowConnect(true)}
                      className="mt-4 bg-[#6366f1] text-white text-sm px-5 py-2.5 rounded-xl"
                    >
                      Connect to Gateway
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="flex-1 overflow-x-auto overflow-y-hidden"
                style={{
                  scrollSnapType: 'x mandatory',
                  WebkitOverflowScrolling: 'touch',
                  scrollbarWidth: 'none',
                }}
              >
                <div className="flex gap-4 px-4 h-full items-start pt-1 pb-3"
                  style={{ width: `calc(${filtered.length} * (100vw - 1rem))` }}>
                  {filtered.map(session => (
                    <MobileSessionCard
                      key={session.key}
                      session={session}
                      onOpenFull={setFullChatSession}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Swipe hint */}
            {filtered.length > 1 && (
              <div className="text-center py-1 shrink-0">
                <div className="flex justify-center gap-1.5">
                  {filtered.map((_, i) => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#2a3142]" />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'costs' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
              <h1 className="text-white font-semibold text-sm">💰 Costs</h1>
            </div>
            <CostsPanel />
          </div>
        )}

        {tab === 'memory' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#2a3142] bg-[#181c24] shrink-0">
              <h1 className="text-white font-semibold text-sm">🧠 Memory</h1>
            </div>
            <MemoryPanel />
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <div
        className="bg-[#181c24] border-t border-[#2a3142] shrink-0"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors ${
                tab === t.id ? 'text-[#6366f1]' : 'text-[#6b7280]'
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span className="text-[10px] font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
    </div>
  )
}
