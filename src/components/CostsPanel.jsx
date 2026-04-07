import { useEffect, useState } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

const DEFAULT_API = import.meta.env.VITE_API_URL || 'http://34.152.7.106:3747'
const DAILY_LIMIT = 15

// SVG line chart for daily spend
function SpendLineChart({ daily }) {
  if (!daily || daily.length < 2) return null

  const WIDTH = 600
  const HEIGHT = 120
  const PAD = { top: 12, right: 16, bottom: 28, left: 40 }
  const W = WIDTH - PAD.left - PAD.right
  const H = HEIGHT - PAD.top - PAD.bottom

  // Sort oldest → newest
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date))
  const maxVal = Math.max(...sorted.map(d => d.total_cost_usd), DAILY_LIMIT) * 1.1

  const x = (i) => (i / (sorted.length - 1)) * W
  const y = (v) => H - (v / maxVal) * H

  const points = sorted.map((d, i) => `${x(i)},${y(d.total_cost_usd)}`).join(' ')
  const limitY = y(DAILY_LIMIT)

  // Area fill path
  const areaPath = `M ${sorted.map((d, i) => `${x(i)},${y(d.total_cost_usd)}`).join(' L ')} L ${x(sorted.length - 1)},${H} L 0,${H} Z`

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="w-full"
      style={{ height: HEIGHT }}
    >
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {/* Limit line */}
        <line x1={0} y1={limitY} x2={W} y2={limitY} stroke="#ef4444" strokeWidth="1" strokeDasharray="4 3" opacity="0.5" />
        <text x={W + 2} y={limitY + 3} fill="#ef4444" fontSize="9" opacity="0.7">${DAILY_LIMIT}</text>

        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(pct => {
          const val = maxVal * pct
          const yy = y(val)
          return (
            <g key={pct}>
              <line x1={0} y1={yy} x2={W} y2={yy} stroke="#2a3142" strokeWidth="1" />
              <text x={-4} y={yy + 3} fill="#4b5563" fontSize="9" textAnchor="end">${val.toFixed(val < 1 ? 2 : 0)}</text>
            </g>
          )
        })}

        {/* Area fill */}
        <path d={areaPath} fill="url(#areaGrad)" />

        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke="#6366f1"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Data points + labels */}
        {sorted.map((d, i) => {
          const cx = x(i)
          const cy = y(d.total_cost_usd)
          const over = d.total_cost_usd > DAILY_LIMIT
          return (
            <g key={d.date}>
              <circle cx={cx} cy={cy} r="3" fill={over ? '#ef4444' : '#6366f1'} stroke="#0f1117" strokeWidth="1.5" />
              {/* Date label */}
              <text
                x={cx}
                y={H + 14}
                fill="#4b5563"
                fontSize="9"
                textAnchor="middle"
              >
                {d.date.slice(5)} {/* MM-DD */}
              </text>
              {/* Tooltip value on hover via title */}
              <title>{d.date}: ${d.total_cost_usd.toFixed(2)} · {d.session_count} sessions</title>
              {/* Invisible hit target */}
              <circle cx={cx} cy={cy} r="10" fill="transparent" />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

function Bar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-1.5 bg-[#2a3142] rounded-full overflow-hidden">
      <div className="h-full bg-[#6366f1] rounded-full transition-all" style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function CostsPanel() {
  const { apiUrl } = useGatewayStore()
  const API = apiUrl || DEFAULT_API
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

  useEffect(() => { load() }, [API])

  if (loading) return <div className="p-6 text-[#6b7280] text-sm">Loading costs…</div>
  if (error) return <div className="p-6 text-red-400 text-sm">Error: {error}</div>

  const maxSessionCost = Math.max(...(data.sessions?.map(s => s.cost) || [0]))
  const weekTotal = data.daily?.reduce((s, d) => s + d.total_cost_usd, 0) ?? 0
  const avgPerDay = data.daily?.length > 0 ? weekTotal / data.daily.length : 0

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
          <div className="text-2xl font-bold text-white">${weekTotal.toFixed(2)}</div>
          <div className="text-xs text-[#6b7280] mt-1">{data.daily?.length} days tracked</div>
        </div>

        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Avg / Day</div>
          <div className={`text-2xl font-bold ${avgPerDay > DAILY_LIMIT ? 'text-red-400' : 'text-white'}`}>
            ${avgPerDay.toFixed(2)}
          </div>
          <div className="text-xs text-[#6b7280] mt-1">7-day rolling</div>
        </div>
      </div>

      {/* Daily line chart */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider">Daily Spend (7 days)</div>
          <div className="text-xs text-[#4b5563]">— $15 limit</div>
        </div>
        <SpendLineChart daily={data.daily} />
        {/* Summary table below chart */}
        <div className="mt-3 space-y-1">
          {[...( data.daily || [])].sort((a, b) => b.date.localeCompare(a.date)).map(d => (
            <div key={d.date} className="flex items-center gap-3 text-xs">
              <span className="text-[#6b7280] w-20 shrink-0">{d.date}</span>
              <span className={`w-14 text-right font-medium ${d.total_cost_usd > DAILY_LIMIT ? 'text-red-400' : 'text-white'}`}>
                ${d.total_cost_usd.toFixed(2)}
              </span>
              <span className="text-[#4b5563] text-[10px]">{d.session_count} sessions · {(d.input_tokens/1000).toFixed(0)}k in / {(d.output_tokens/1000).toFixed(0)}k out</span>
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
