import { useEffect, useState } from 'react'

const API = import.meta.env.VITE_API_URL || ''

function Bar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-1.5 bg-[#2a3142] rounded-full overflow-hidden">
      <div className="h-full bg-[#6366f1] rounded-full transition-all" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function CostsPanel() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const r = await fetch(`${API}/api/costs`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(await r.json())
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading costs…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error} — is the Octis API server running?</div>

  const maxSessionCost = Math.max(...(data.sessions?.map(s => s.cost) || [0]))
  const maxDailyCost = Math.max(...(data.daily?.map(d => d.total_cost_usd) || [0]))
  const DAILY_LIMIT = 15

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Today summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Today</div>
          <div className={`text-2xl font-bold ${data.today > DAILY_LIMIT ? 'text-red-400' : 'text-white'}`}>
            ${data.today.toFixed(2)}
          </div>
          {data.today > DAILY_LIMIT && (
            <div className="text-xs text-red-400 mt-1">⚠️ Over $15 limit</div>
          )}
          <div className="mt-2">
            <Bar value={data.today} max={DAILY_LIMIT} />
            <div className="text-xs text-[#6b7280] mt-1">${DAILY_LIMIT} daily limit</div>
          </div>
        </div>

        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">This Week</div>
          <div className="text-2xl font-bold text-white">
            ${data.daily?.reduce((s, d) => s + d.total_cost_usd, 0).toFixed(2)}
          </div>
          <div className="text-xs text-[#6b7280] mt-1">{data.daily?.length} days tracked</div>
        </div>

        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Avg / Day</div>
          <div className="text-2xl font-bold text-white">
            ${data.daily?.length > 0
              ? (data.daily.reduce((s, d) => s + d.total_cost_usd, 0) / data.daily.length).toFixed(2)
              : '—'}
          </div>
          <div className="text-xs text-[#6b7280] mt-1">7-day rolling</div>
        </div>
      </div>

      {/* Daily chart */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
        <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">Daily Spend (7 days)</div>
        <div className="space-y-2">
          {data.daily?.map(d => (
            <div key={d.date} className="flex items-center gap-3">
              <div className="text-xs text-[#6b7280] w-20 shrink-0">{d.date ? new Date(d.date).toLocaleDateString('en-CA') : ''}</div>
              <div className="flex-1">
                <Bar value={d.total_cost_usd} max={Math.max(maxDailyCost, DAILY_LIMIT)} />
              </div>
              <div className={`text-xs w-14 text-right ${d.total_cost_usd > DAILY_LIMIT ? 'text-red-400' : 'text-white'}`}>
                ${d.total_cost_usd.toFixed(2)}
              </div>
              <div className="text-xs text-[#6b7280] w-20 text-right">{d.session_count} sess</div>
            </div>
          ))}
        </div>
      </div>

      {/* Top sessions */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
        <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">Top Sessions (7 days)</div>
        <div className="space-y-3">
          {data.sessions?.slice(0, 20).map(s => (
            <div key={s.session_key}>
              <div className="flex items-center gap-2 mb-1">
                <div className="text-sm text-white truncate flex-1">{s.session_label || s.session_key}</div>
                <div className="text-xs text-[#6b7280]">{s.sender_name}</div>
                <div className="text-xs text-white font-medium w-14 text-right">${s.cost.toFixed(3)}</div>
              </div>
              <Bar value={s.cost} max={maxSessionCost} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
