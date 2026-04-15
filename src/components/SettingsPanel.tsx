import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { useLabelStore, useSessionStore } from '../store/gatewayStore'
import { usePushNotifications } from '../hooks/usePushNotifications'

const API = import.meta.env.VITE_API_URL || ''

function Toggle({ value, onChange, label, description }: { value: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[#2a3142]">
      <div>
        <div className="text-sm text-white font-medium">{label}</div>
        {description && <div className="text-xs text-[#6b7280] mt-0.5">{description}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        type="button"
        className={`relative inline-flex shrink-0 ml-4 h-5 w-10 items-center rounded-full transition-colors focus:outline-none ${value ? 'bg-[#6366f1]' : 'bg-[#2a3142]'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${value ? 'translate-x-5' : 'translate-x-1'}`}
        />
      </button>
    </div>
  )
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { getToken } = useAuth()
  const { labels, setLabel } = useLabelStore()
  const { sessions } = useSessionStore()
  const { status: pushStatus, subscribe: pushSubscribe, unsubscribe: pushUnsubscribe } = usePushNotifications(getToken)

  // Load settings from localStorage
  const [autoRename, setAutoRename] = useState(() =>
    localStorage.getItem('octis-auto-rename') !== 'false'
  )
  const [noiseHidden, setNoiseHidden] = useState(() =>
    localStorage.getItem('octis-noise-hidden') !== 'false'
  )
  const [showHeartbeatSessions, setShowHeartbeatSessions] = useState(() =>
    localStorage.getItem('octis-show-heartbeat-sessions') === 'true'
  )
  const [showCronSessions, setShowCronSessions] = useState(() =>
    localStorage.getItem('octis-show-cron-sessions') === 'true'
  )
  const [showAgentSessions, setShowAgentSessions] = useState(() =>
    localStorage.getItem('octis-show-agent-sessions') === 'true'
  )

  const [renaming, setRenaming] = useState(false)
  const [renameStatus, setRenameStatus] = useState('')

  const save = (key: string, val: boolean) => localStorage.setItem(key, String(val))

  const handleRenameAll = async () => {
    setRenaming(true)
    setRenameStatus('Fetching labels from DB…')
    try {
      const res = await fetch(`${API}/api/session-labels`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      // Match against loaded sessions
      let count = 0
      const dataMap = data as Record<string, string>
      sessions.forEach(s => {
        const uuid = s.id || s.sessionId
        const gKey = s.key
        if (uuid && dataMap[uuid]) {
          setLabel(gKey, dataMap[uuid])
          setLabel(uuid, dataMap[uuid])
          count++
        }
      })
      // Also store all by UUID for future matching
      Object.entries(data as Record<string, string>).forEach(([uuid, label]) => {
        if (!labels[uuid]) setLabel(uuid, label)
      })
      setRenameStatus(`✅ Applied ${count} labels (${Object.keys(data).length} total in DB)`)
    } catch (e) {
      setRenameStatus(`❌ Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRenaming(false)
    }
  }

  const handleClearLabels = () => {
    if (confirm('Clear all saved labels? Sessions will show their gateway keys until re-renamed.')) {
      localStorage.removeItem('octis-labels')
      window.location.reload()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl w-full max-w-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3142]">
          <div className="flex items-center gap-2">
            <span className="text-xl">🐙</span>
            <span className="text-base font-semibold text-white">Octis Settings</span>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white text-sm px-2 py-1 rounded hover:bg-[#2a3142] transition-colors">✕</button>
        </div>

        <div className="px-5 py-4 overflow-y-auto max-h-[70vh]">

          {/* Display */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-1">Display</div>
          <Toggle
            value={noiseHidden}
            onChange={v => { setNoiseHidden(v); save('octis-noise-hidden', v) }}
            label="Hide tool calls & system messages"
            description="Show only chat messages in panes (chat only mode)"
          />
          <Toggle
            value={!showHeartbeatSessions}
            onChange={v => { setShowHeartbeatSessions(!v); save('octis-show-heartbeat-sessions', !v) }}
            label="Hide heartbeat sessions in sidebar"
            description="Filter out periodic health-check sessions"
          />
          <Toggle
            value={!showCronSessions}
            onChange={v => { setShowCronSessions(!v); save('octis-show-cron-sessions', !v) }}
            label="Hide cron/scheduled sessions in sidebar"
            description="Filter out automated scheduled tasks"
          />
          <Toggle
            value={!showAgentSessions}
            onChange={v => { setShowAgentSessions(!v); save('octis-show-agent-sessions', !v) }}
            label="Hide agent-spawned sessions in sidebar"
            description="Filter out sub-agent and ACP harness sessions (spawned by Byte)"
          />

          {/* Sessions */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Session Names</div>
          <Toggle
            value={autoRename}
            onChange={v => { setAutoRename(v); save('octis-auto-rename', v) }}
            label="Auto-rename sessions"
            description="Automatically use first message as session name"
          />

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleRenameAll}
              disabled={renaming}
              className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 text-white text-sm rounded-lg py-2 font-medium transition-colors"
            >
              {renaming ? 'Renaming…' : '🏷️ Rename all sessions from DB'}
            </button>
            <button
              onClick={handleClearLabels}
              className="px-3 bg-[#2a3142] hover:bg-[#3a4152] text-[#6b7280] text-sm rounded-lg py-2 transition-colors"
              title="Clear saved labels"
            >
              🗑️
            </button>
          </div>
          {renameStatus && (
            <div className="mt-2 text-xs text-[#6b7280] bg-[#0f1117] rounded-lg px-3 py-2">{renameStatus}</div>
          )}

          {/* Notifications */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Notifications</div>
          <div className="flex items-center justify-between py-3 border-b border-[#2a3142]">
            <div>
              <div className="text-sm text-white font-medium">Push notifications</div>
              <div className="text-xs text-[#6b7280] mt-0.5">
                {pushStatus === 'subscribed' && 'Active — Byte will ping you when input is needed'}
                {pushStatus === 'unsubscribed' && 'Off — enable to get pinged on mobile'}
                {pushStatus === 'denied' && 'Blocked in browser — update site permissions to enable'}
                {pushStatus === 'unsupported' && 'Not supported in this browser'}
                {pushStatus === 'loading' && 'Checking…'}
              </div>
            </div>
            {(pushStatus === 'subscribed' || pushStatus === 'unsubscribed') && (
              <button
                onClick={pushStatus === 'subscribed' ? pushUnsubscribe : pushSubscribe}
                className={`ml-4 shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  pushStatus === 'subscribed'
                    ? 'bg-[#2a3142] text-[#6b7280] hover:bg-[#3a4152]'
                    : 'bg-[#6366f1] text-white hover:bg-[#818cf8]'
                }`}
              >
                {pushStatus === 'subscribed' ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>

          {/* Gateway */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">Gateway</div>
          <div className="bg-[#0f1117] rounded-lg px-3 py-2 text-xs text-[#6b7280] font-mono">
            {localStorage.getItem('octis-gateway') ? JSON.parse(localStorage.getItem('octis-gateway') || '{}').gatewayUrl : 'Not configured'}
          </div>

          {/* About */}
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3 mt-5">About</div>
          <div className="text-xs text-[#4b5563]">
            Octis — AI command center<br />
            Built for OpenClaw · <a href="https://github.com/octis-app/octis" className="text-[#6366f1] hover:underline" target="_blank" rel="noopener noreferrer">github.com/octis-app/octis</a>
          </div>
        </div>
      </div>
    </div>
  )
}
