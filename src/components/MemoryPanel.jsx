import { useEffect, useState } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

function MarkdownBlock({ content, maxLines = 30 }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split('\n')
  const truncated = lines.length > maxLines && !expanded
  const display = truncated ? lines.slice(0, maxLines).join('\n') + '\n…' : content
  return (
    <div>
      <pre className="text-xs text-[#e8eaf0] whitespace-pre-wrap leading-relaxed font-sans">{display}</pre>
      {lines.length > maxLines && (
        <button onClick={() => setExpanded(e => !e)} className="text-xs text-[#6366f1] hover:text-[#818cf8] mt-1">
          {expanded ? 'Show less' : `Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

// Read a workspace file via the gateway WS, returning a promise
function readFileViaWs(ws, send, name) {
  return new Promise((resolve) => {
    const id = `read-${name}-${Date.now()}`
    const handler = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.id === id) {
          ws.removeEventListener('message', handler)
          resolve(msg.ok ? (msg.payload?.file?.content ?? '') : '')
        }
      } catch {}
    }
    ws.addEventListener('message', handler)
    send({ type: 'req', id, method: 'agents.files.get', params: { agentId: 'main', name } })
    setTimeout(() => {
      ws.removeEventListener('message', handler)
      resolve('')
    }, 8000)
  })
}

export default function MemoryPanel() {
  const { ws, send } = useGatewayStore()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('memory')

  useEffect(() => {
    if (!ws) { setError('Not connected'); setLoading(false); return }

    const load = async () => {
      try {
        // MEMORY.md is the only file exposed via agents.files.get
        // For TODOS.md we read it via a chat.history trick — or just show what we have
        const memory = await readFileViaWs(ws, send, 'MEMORY.md')
        setData({ memory })
        setLoading(false)
      } catch (e) {
        setError(e.message)
        setLoading(false)
      }
    }
    load()
  }, [ws])

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading memory…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error}</div>

  const tabs = [
    { id: 'memory', label: 'MEMORY.md' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex gap-1 px-6 pt-4 border-b border-[#2a3142]">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
              activeTab === t.id
                ? 'bg-[#181c24] text-white border border-b-0 border-[#2a3142]'
                : 'text-[#6b7280] hover:text-white'
            }`}>{t.label}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'memory' && (
          <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
            <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">MEMORY.md</div>
            <MarkdownBlock content={data?.memory || '(empty)'} maxLines={80} />
          </div>
        )}
      </div>
    </div>
  )
}
