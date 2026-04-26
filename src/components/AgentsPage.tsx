import { useState, useEffect } from 'react'
import { authFetch } from '../lib/authFetch'
import { Agent } from './AgentPicker'

const API = (import.meta as any).env?.VITE_API_URL || ''

interface AgentWithMeta extends Agent {
  model: string
  isPrimary: boolean
}

interface AgentsPageProps {
  onStartSession?: () => void
}

export default function AgentsPage({ onStartSession }: AgentsPageProps) {
  const [agents, setAgents] = useState<AgentWithMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingEmoji, setEditingEmoji] = useState<string | null>(null)
  const [editingDesc, setEditingDesc] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    authFetch(`${API}/api/agents`)
      .then(r => r.json())
      .then(d => { setAgents(d.agents || []); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const patchMeta = async (id: string, patch: { emoji?: string; description?: string }) => {
    await authFetch(`${API}/api/agents/${id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    load()
  }

  const startSession = async (agent: AgentWithMeta) => {
    try {
      const res = await authFetch(`${API}/api/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id }),
      })
      const data = await res.json()
      if (data.sessionKey || data.key) {
        showToast(`✦ Session started with ${agent.emoji} ${agent.name}`)
        onStartSession?.()
      } else {
        showToast('Failed to start session')
      }
    } catch {
      showToast('Failed to start session')
    }
  }

  if (loading) return <div className="p-8 text-[#6b7280] text-sm">Loading agents…</div>
  if (error) return <div className="p-8 text-red-400 text-sm">Error: {error}</div>

  return (
    <div className="flex-1 overflow-y-auto bg-[#0f1117] p-6 relative">
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#1e2333] border border-[#2a3142] text-[#e8eaf0] text-sm px-4 py-2.5 rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-white">🤖 Agents</h2>
        <p className="text-[#6b7280] text-sm mt-1">Active AI agents — click emoji or description to configure</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(agent => (
          <div key={agent.id} className="bg-[#181c24] border border-[#2a3142] rounded-2xl p-5 flex flex-col group">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                {editingEmoji === agent.id ? (
                  <input
                    autoFocus
                    defaultValue={agent.emoji}
                    className="w-12 h-12 text-2xl text-center bg-[#2a3142] rounded-xl outline-none border border-[#6366f1]"
                    onBlur={e => { patchMeta(agent.id, { emoji: e.target.value }); setEditingEmoji(null) }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                ) : (
                  <button
                    onClick={() => setEditingEmoji(agent.id)}
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl bg-[#1e2333] hover:bg-[#2a3142] transition-colors"
                    title="Click to change emoji"
                  >
                    {agent.emoji}
                  </button>
                )}
                <div>
                  <div className="text-white font-semibold text-base flex items-center gap-2">
                    {agent.name}
                    {agent.isPrimary && (
                      <span className="text-[9px] bg-[#6366f1]/20 text-[#818cf8] px-1.5 py-0.5 rounded-full font-medium">
                        primary
                      </span>
                    )}
                  </div>
                  <span className="bg-[#1e2333] text-[#9ca3af] text-xs px-2 py-0.5 rounded-lg inline-block mt-1">
                    {agent.model}
                  </span>
                </div>
              </div>
            </div>
            {editingDesc === agent.id ? (
              <textarea
                autoFocus
                defaultValue={agent.description}
                rows={2}
                className="text-sm bg-[#2a3142] text-[#e8eaf0] rounded-lg px-2 py-1.5 outline-none border border-[#6366f1] resize-none mb-3"
                onBlur={e => { patchMeta(agent.id, { description: e.target.value }); setEditingDesc(null) }}
              />
            ) : (
              <p
                className="text-[#6b7280] text-sm mb-3 cursor-pointer hover:text-[#9ca3af] transition-colors min-h-[1.5rem]"
                onClick={() => setEditingDesc(agent.id)}
                title="Click to edit description"
              >
                {agent.description || <span className="italic text-[#4b5563]">Click to add description</span>}
              </p>
            )}
            <div className="mt-auto">
              <button
                onClick={() => startSession(agent)}
                className="w-full bg-[#6366f1] hover:bg-[#818cf8] text-white text-sm px-4 py-2 rounded-lg transition-colors font-medium"
              >
                ✦ Start session
              </button>
            </div>
          </div>
        ))}
      </div>
      {agents.length === 0 && (
        <div className="text-center py-16 text-[#4b5563]">
          <div className="text-4xl mb-3">🤖</div>
          <div className="text-sm">No agents configured</div>
        </div>
      )}
    </div>
  )
}