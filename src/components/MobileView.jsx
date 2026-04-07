import { useState, useRef } from 'react'
import { useSessionStore, useGatewayStore } from '../store/gatewayStore'
import MobileSessionCard from './MobileSessionCard'
import CostsPanel from './CostsPanel'
import MemoryPanel from './MemoryPanel'

export default function MobileView({ onSettingsClick }) {
  const { sessions, getStatus } = useSessionStore()
  const { connected } = useGatewayStore()
  const [activeTab, setActiveTab] = useState('active')
  const [activeCardIdx, setActiveCardIdx] = useState(0)
  const [filter, setFilter] = useState('active')
  const touchStartX = useRef(null)
  const touchStartY = useRef(null)

  // Filter sessions for card view
  const cardSessions = sessions.filter(s => {
    const st = getStatus(s)
    if (filter === 'active') return st === 'active'
    if (filter === 'idle') return st === 'idle'
    return true // all
  })

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current)
    if (Math.abs(dx) > 50 && dy < 80) {
      if (dx < 0) setActiveCardIdx(i => Math.min(i + 1, cardSessions.length - 1))
      else setActiveCardIdx(i => Math.max(i - 1, 0))
    }
    touchStartX.current = null
  }

  const counts = {
    active: sessions.filter(s => getStatus(s) === 'active').length,
    idle: sessions.filter(s => getStatus(s) === 'idle').length,
    all: sessions.length,
  }

  return (
    <div className="flex flex-col h-screen bg-[#0f1117] overflow-hidden">

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-safe pt-4 pb-3 bg-[#181c24] border-b border-[#2a3142] shrink-0">
        <span className="text-xl">🐙</span>
        <span className="text-sm font-semibold text-white">Octis</span>
        <button
          onClick={onSettingsClick}
          className={`text-sm font-medium px-2 py-1 rounded-lg ${connected ? 'text-green-400' : 'text-red-400'}`}
        >
          {connected ? '● live' : '● off'}
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex flex-col">

        {activeTab === 'sessions' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Filter pills */}
            <div className="flex gap-2 px-4 py-3 shrink-0">
              {[
                { id: 'active', label: `🟢 Active ${counts.active}` },
                { id: 'idle', label: `🟡 Idle ${counts.idle}` },
                { id: 'all', label: `All ${counts.all}` },
              ].map(f => (
                <button
                  key={f.id}
                  onClick={() => { setFilter(f.id); setActiveCardIdx(0) }}
                  className={`text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
                    filter === f.id ? 'bg-[#6366f1] text-white' : 'bg-[#1e2330] text-[#6b7280]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Card carousel */}
            {cardSessions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div className="text-4xl mb-3">🐙</div>
                  <div className="text-[#6b7280] text-sm">No {filter} sessions</div>
                </div>
              </div>
            ) : (
              <div
                className="flex-1 overflow-hidden px-4 pb-4"
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
              >
                {/* Dots indicator */}
                {cardSessions.length > 1 && (
                  <div className="flex justify-center gap-1.5 mb-3">
                    {cardSessions.map((_, i) => (
                      <button
                        key={i}
                        onClick={() => setActiveCardIdx(i)}
                        className={`rounded-full transition-all ${
                          i === activeCardIdx ? 'w-5 h-1.5 bg-[#6366f1]' : 'w-1.5 h-1.5 bg-[#2a3142]'
                        }`}
                      />
                    ))}
                  </div>
                )}

                {/* Single card view */}
                <div className="h-full overflow-hidden">
                  {cardSessions[activeCardIdx] && (
                    <MobileSessionCard
                      key={cardSessions[activeCardIdx].key}
                      session={cardSessions[activeCardIdx]}
                      isActive={true}
                    />
                  )}
                </div>

                {/* Swipe hint */}
                {cardSessions.length > 1 && (
                  <div className="text-center mt-2">
                    <span className="text-xs text-[#4b5563]">
                      {activeCardIdx + 1} / {cardSessions.length} · swipe to navigate
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'costs' && (
          <div className="flex-1 overflow-y-auto">
            <CostsPanel />
          </div>
        )}

        {activeTab === 'memory' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <MemoryPanel />
          </div>
        )}
      </div>

      {/* Bottom nav */}
      <div className="flex bg-[#181c24] border-t border-[#2a3142] pb-safe shrink-0">
        {[
          { id: 'sessions', icon: '💬', label: 'Sessions' },
          { id: 'costs', icon: '💰', label: 'Costs' },
          { id: 'memory', icon: '🧠', label: 'Memory' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 transition-colors ${
              activeTab === tab.id ? 'text-[#6366f1]' : 'text-[#6b7280]'
            }`}
          >
            <span className="text-xl">{tab.icon}</span>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
