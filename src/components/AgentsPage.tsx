import { useState, useEffect } from 'react'
import { authFetch } from '../lib/authFetch'
import { Agent } from './AgentPicker'

const API = (import.meta as any).env?.VITE_API_URL || ''

interface AgentWithMeta extends Agent {
  model: string
  isPrimary: boolean
  visibleInPicker: boolean
  soul: string
}

interface AgentsConfig {
  agents: AgentWithMeta[]
  renameAgentId: string
}

interface AgentsPageProps {
  onStartSession?: () => void
}

export default function AgentsPage({ onStartSession }: AgentsPageProps) {
  const [config, setConfig] = useState<AgentsConfig>({ agents: [], renameAgentId: 'fast' })
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editState, setEditState] = useState<Record<string, Partial<AgentWithMeta>>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    authFetch(`${API}/api/agents`)
      .then(r => r.json())
      .then(d => {
        setConfig({ agents: d.agents || [], renameAgentId: d.renameAgentId || 'fast' })
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const togglePicker = async (id: string, current: boolean) => {
    await authFetch(`${API}/api/agents/${id}/meta`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibleInPicker: !current }),
    })
    load()
  }

  const setRenameAgent = async (id: string) => {
    await authFetch(`${API}/api/agents-config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renameAgentId: id }),
    })
    setConfig(c => ({ ...c, renameAgentId: id }))
    showToast(`✨ Rename agent set to ${config.agents.find(a => a.id === id)?.name || id}`)
  }

  const saveAgent = async (id: string) => {
    const patch = editState[id]
    if (!patch || Object.keys(patch).length === 0) { setExpandedId(null); return }
    setSavingId(id)
    try {
      await authFetch(`${API}/api/agents/${id}/meta`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      setEditState(s => { const n = {...s}; delete n[id]; return n })
      load()
      showToast('✅ Saved')
      if (patch.model) showToast('✅ Saved — restart gateway to apply model change')
    } catch { showToast('❌ Save failed') }
    setSavingId(null)
    setExpandedId(null)
  }

  const updateEdit = (id: string, field: string, value: string | boolean) => {
    setEditState(s => ({ ...s, [id]: { ...s[id], [field]: value } }))
  }

  if (loading) return <div className="p-8 text-[#6b7280] text-sm">Loading agents…</div>

  return (
    <div className="flex-1 overflow-y-auto bg-[#0f1117] p-6 relative">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#1e2333] border border-[#2a3142] text-[#e8eaf0] text-sm px-4 py-2.5 rounded-xl shadow-lg z-50 pointer-events-none">
          {toast}
        </div>
      )}

      {/* Page header */}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-white">🤖 Agents</h2>
        <p className="text-[#6b7280] text-sm mt-1">Configure agents, set picker visibility, and manage rename behaviour</p>
      </div>

      {/* ── Rename agent picker ─────────────────────────────────────── */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-2xl p-5 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-white font-semibold text-sm mb-0.5">✨ Auto-rename agent</div>
            <div className="text-[#6b7280] text-xs">Used for the ✨ quick-rename button on sessions. Pick a fast, cheap model — speed matters more than quality here.</div>
          </div>
          <select
            value={config.renameAgentId}
            onChange={e => setRenameAgent(e.target.value)}
            className="bg-[#2a3142] border border-[#3a4152] text-[#e8eaf0] text-sm rounded-lg px-3 py-1.5 outline-none focus:border-[#6366f1] ml-4 shrink-0"
          >
            {config.agents.map(a => (
              <option key={a.id} value={a.id}>{a.emoji} {a.name} — {a.model}</option>
            ))}
          </select>
        </div>
        {/* Show the selected agent's model as a hint */}
        {(() => {
          const ra = config.agents.find(a => a.id === config.renameAgentId)
          return ra ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-lg">{ra.emoji}</span>
              <span className="text-[#9ca3af] text-xs">{ra.name} · <span className="bg-[#1e2333] px-1.5 py-0.5 rounded text-[#6b7280]">{ra.model}</span></span>
              {(ra.id === 'fast' || ra.id === 'light' || ra.id === 'bulk') && (
                <span className="text-[9px] bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded-full">recommended</span>
              )}
            </div>
          ) : null
        })()}
      </div>

      {/* ── Agent cards ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        {config.agents.map(agent => {
          const isExpanded = expandedId === agent.id
          const edit = editState[agent.id] || {}
          const displayName = (edit.name as string) ?? agent.name
          const displayModel = (edit.model as string) ?? agent.model
          const displayDesc = (edit.description as string) ?? agent.description
          const displaySoul = (edit.soul as string) ?? agent.soul

          return (
            <div key={agent.id} className="bg-[#181c24] border border-[#2a3142] rounded-2xl overflow-hidden">
              {/* Card header row — always visible */}
              <div className="flex items-center gap-3 p-4">
                <span className="text-2xl w-10 text-center shrink-0">{agent.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-semibold text-sm">{agent.name}</span>
                    {agent.isPrimary && <span className="text-[9px] bg-[#6366f1]/20 text-[#818cf8] px-1.5 py-0.5 rounded-full">primary</span>}
                    {agent.id === config.renameAgentId && <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1.5 py-0.5 rounded-full">✨ rename</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="bg-[#1e2333] text-[#6b7280] text-[10px] px-1.5 py-0.5 rounded">{agent.model}</span>
                    {agent.description && <span className="text-[#4b5563] text-xs truncate">{agent.description}</span>}
                  </div>
                </div>

                {/* Right-side controls */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Picker visibility toggle */}
                  <button
                    onClick={() => togglePicker(agent.id, agent.visibleInPicker)}
                    title={agent.visibleInPicker ? 'Visible in picker — click to hide' : 'Hidden from picker — click to show'}
                    className={`text-xs px-2 py-1 rounded-lg transition-colors ${agent.visibleInPicker ? 'bg-[#6366f1]/20 text-[#818cf8] hover:bg-[#6366f1]/30' : 'bg-[#2a3142] text-[#4b5563] hover:text-[#6b7280]'}`}
                  >
                    {agent.visibleInPicker ? '● in picker' : '○ hidden'}
                  </button>

                  {/* Configure toggle */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : agent.id)}
                    className="text-xs text-[#6b7280] hover:text-white px-2 py-1 rounded-lg hover:bg-[#2a3142] transition-colors"
                  >
                    {isExpanded ? 'Close ▲' : '⚙ Config ▼'}
                  </button>
                </div>
              </div>

              {/* Expanded config panel */}
              {isExpanded && (
                <div className="border-t border-[#2a3142] p-4 space-y-4 bg-[#0f1117]">
                  {/* Name + Emoji row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#6b7280] mb-1">Display name</label>
                      <input
                        value={displayName}
                        onChange={e => updateEdit(agent.id, 'name', e.target.value)}
                        className="w-full bg-[#1e2333] border border-[#2a3142] focus:border-[#6366f1] text-[#e8eaf0] text-sm rounded-lg px-3 py-2 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6b7280] mb-1">Emoji</label>
                      <input
                        value={(edit.emoji as string) ?? agent.emoji}
                        onChange={e => updateEdit(agent.id, 'emoji', e.target.value)}
                        className="w-full bg-[#1e2333] border border-[#2a3142] focus:border-[#6366f1] text-[#e8eaf0] text-sm rounded-lg px-3 py-2 outline-none"
                      />
                    </div>
                  </div>

                  {/* Model */}
                  <div>
                    <label className="block text-xs text-[#6b7280] mb-1">
                      Model
                      <span className="ml-2 text-[#4b5563] font-normal">— restart gateway to apply changes</span>
                    </label>
                    <input
                      value={displayModel}
                      onChange={e => updateEdit(agent.id, 'model', e.target.value)}
                      placeholder="e.g. anthropic/claude-haiku-4-5"
                      className="w-full bg-[#1e2333] border border-[#2a3142] focus:border-[#6366f1] text-[#e8eaf0] text-sm rounded-lg px-3 py-2 outline-none font-mono"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-xs text-[#6b7280] mb-1">Description / role</label>
                    <input
                      value={displayDesc}
                      onChange={e => updateEdit(agent.id, 'description', e.target.value)}
                      className="w-full bg-[#1e2333] border border-[#2a3142] focus:border-[#6366f1] text-[#e8eaf0] text-sm rounded-lg px-3 py-2 outline-none"
                    />
                  </div>

                  {/* Soul / System prompt */}
                  <div>
                    <label className="block text-xs text-[#6b7280] mb-1">
                      Soul / System prompt
                      <span className="ml-2 text-[#4b5563] font-normal">— persona and instructions for this agent</span>
                    </label>
                    <textarea
                      value={displaySoul}
                      onChange={e => updateEdit(agent.id, 'soul', e.target.value)}
                      rows={5}
                      placeholder="Describe this agent's persona, tone, and specialties..."
                      className="w-full bg-[#1e2333] border border-[#2a3142] focus:border-[#6366f1] text-[#e8eaf0] text-sm rounded-lg px-3 py-2 outline-none resize-y"
                    />
                  </div>

                  {/* Save / Cancel */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => saveAgent(agent.id)}
                      disabled={savingId === agent.id}
                      className="bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 text-white text-sm px-4 py-2 rounded-lg transition-colors font-medium"
                    >
                      {savingId === agent.id ? 'Saving…' : 'Save changes'}
                    </button>
                    <button
                      onClick={() => { setEditState(s => { const n = {...s}; delete n[agent.id]; return n }); setExpandedId(null) }}
                      className="text-sm text-[#6b7280] hover:text-white px-4 py-2 rounded-lg hover:bg-[#2a3142] transition-colors"
                    >
                      Cancel
                    </button>
                    <div className="ml-auto text-[10px] text-[#3a4152]">id: {agent.id}</div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}