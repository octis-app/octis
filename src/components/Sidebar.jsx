import { useSessionStore, useGatewayStore } from '../store/gatewayStore'

const statusColors = {
  active: '#22c55e',
  idle: '#f59e0b',
  dead: '#6b7280',
  blocked: '#ef4444',
}

const statusLabels = {
  active: 'Active',
  idle: 'Idle',
  dead: 'Dead',
  blocked: 'Blocked',
}

export default function Sidebar({ onSettingsClick }) {
  const { sessions, getStatus, pinToPane, activePanes, paneCount } = useSessionStore()
  const { connected } = useGatewayStore()

  return (
    <aside className="w-60 shrink-0 bg-[#181c24] border-r border-[#2a3142] flex flex-col h-screen">
      {/* Header */}
      <div className="px-4 py-4 border-b border-[#2a3142] flex items-center gap-2">
        <span className="text-xl">🐙</span>
        <span className="font-semibold text-white tracking-tight">Octis</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-xs text-[#6b7280]">{connected ? 'live' : 'off'}</span>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 py-1.5 text-xs text-[#6b7280] uppercase tracking-wider">Sessions</div>
        {sessions.length === 0 && (
          <div className="px-4 py-3 text-xs text-[#6b7280]">No sessions yet.</div>
        )}
        {sessions.map((session) => {
          const status = getStatus(session)
          const isPinned = activePanes.includes(session.key)
          return (
            <div
              key={session.key}
              className={`mx-2 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer hover:bg-[#1e2330] group transition-colors ${isPinned ? 'bg-[#1e2330] border border-[#2a3142]' : ''}`}
              onClick={() => {
                // Find first empty pane or overwrite pane 0
                const emptyPane = activePanes.findIndex((p, i) => i < paneCount && !p)
                pinToPane(emptyPane >= 0 ? emptyPane : 0, session.key)
              }}
            >
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColors[status] }} />
                <span className="text-sm text-white truncate flex-1">{session.label || session.key}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 ml-3.5">
                <span className="text-xs" style={{ color: statusColors[status] }}>{statusLabels[status]}</span>
                {session.cost != null && (
                  <span className="text-xs text-[#6b7280]">· ${session.cost.toFixed(3)}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a3142] px-3 py-3 flex items-center gap-2">
        <button
          onClick={onSettingsClick}
          className="text-xs text-[#6b7280] hover:text-white transition-colors"
        >
          ⚙ Settings
        </button>
      </div>
    </aside>
  )
}
