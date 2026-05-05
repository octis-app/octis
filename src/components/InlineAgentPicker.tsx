import { Agent } from './AgentPicker'

interface InlineAgentPickerProps {
  agents: Agent[]
  selectedId: string
  onSelect: (agentId: string) => void
  onClose: () => void
}

export default function InlineAgentPicker({ agents, selectedId, onSelect, onClose }: InlineAgentPickerProps) {
  const visible = agents.filter(a => a.visibleInPicker !== false)
  
  // Automatically select the agent if only one is visible
  if (visible.length === 1 && agents.length > 1) {
    onSelect(visible[0].id)
    return null
  }
  
  return (
    <div className="flex items-center gap-2 p-2 bg-[#1e2333] border border-[#2a3142] rounded-xl overflow-x-auto shrink-0">
      {visible.map(agent => (
        <button
          key={agent.id}
          onClick={() => onSelect(agent.id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
            agent.id === selectedId
              ? 'bg-[#6366f1] text-white'
              : 'bg-[#2a3142] text-[#9ca3af] hover:bg-[#3a4152] hover:text-white'
          }`}
        >
          <span>{agent.emoji}</span>
          <span>{agent.name.slice(0, 8)}</span>
        </button>
      ))}
      <button
        onClick={onClose}
        className="ml-auto text-xs text-[#4b5563] hover:text-white px-2 shrink-0 transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}