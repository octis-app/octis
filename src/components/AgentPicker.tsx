import { useEffect, useState } from 'react'
import { authFetch } from '../lib/authFetch'

const API = (import.meta as any).env?.VITE_API_URL || ''

export interface Agent {
  id: string
  name: string
  emoji: string
  description: string
  visibleInPicker?: boolean
  model?: string
  isPrimary?: boolean
}

interface AgentPickerProps {
  mainAgentId: string
  onSelect: (agentId: string) => void
  onClose: () => void
}

export function AgentPicker({ mainAgentId, onSelect, onClose }: AgentPickerProps) {
  const [agents, setAgents] = useState<Agent[]>([])

  useEffect(() => {
    authFetch(`${API}/api/agents`)
      .then((r) => r.json())
      .then((d: { agents?: Agent[] }) => setAgents(d.agents || []))
      .catch(() =>
        setAgents([{ id: mainAgentId, name: 'Byte', emoji: '🦞', description: 'Default' }])
      )
  }, [mainAgentId])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-[#1e2333] border border-[#2a3142] rounded-xl shadow-2xl w-72 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[#2a3142]">
          <div className="text-sm font-medium text-[#e8eaf0]">Choose agent</div>
          <div className="text-xs text-[#6b7280] mt-0.5">Which agent handles this session?</div>
        </div>
        <div className="p-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-[#2a3142] transition-colors flex items-center gap-3"
            >
              <span className="text-xl leading-none">{agent.emoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-[#e8eaf0] flex items-center gap-1.5">
                  {agent.name}
                  {agent.id === mainAgentId && (
                    <span className="text-[9px] bg-[#6366f1]/20 text-[#818cf8] px-1.5 py-0.5 rounded font-medium">
                      default
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#6b7280]">{agent.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
