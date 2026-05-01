import { useEffect, useState } from 'react'
import { useLabelStore } from '../store/gatewayStore'
import CostChart from './CostChart'

const API = (import.meta.env.VITE_API_URL as string) || ''

interface SessionCost {
  session_key: string
  session_label?: string
  sender_name?: string
  cost: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  last_activity?: string
}

interface DayCost {
  date: string
  total_cost_usd: number
  session_count: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
}

interface CostsData {
  today: number
  yesterday: number
  todayInputTokens: number
  todayOutputTokens: number
  todayCacheWriteTokens: number
  todayCacheReadTokens: number
  todaySessionCount: number
  lastSync: string | null
  sessions: SessionCost[]
  todaySessions: SessionCost[]
  daily: DayCost[]
}

// Anthropic pricing (per million tokens)
const CACHE_WRITE_RATE = 3.75 / 1_000_000
const CACHE_READ_RATE = 0.30 / 1_000_000

function computeOverhead(cacheWrite: number, cacheRead: number): number {
  return (cacheWrite * CACHE_WRITE_RATE) + (cacheRead * CACHE_READ_RATE)
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-1.5 bg-[#2a3142] rounded-full overflow-hidden">
      <div
        className="h-full bg-[#6366f1] rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// Format raw session key into something readable
function formatSessionKey(key: string): string {
  let k = key.replace(/^agent:[^:]+:/, '')
  if (k.startsWith('slack:direct:')) {
    const parts = k.split(':')
    const ts = parts[parts.length - 1]
    const date = ts ? new Date(parseFloat(ts) * 1000).toLocaleDateString('en-CA') : ''
    return `Slack DM${date ? ' · ' + date : ''}`
  }
  if (k.startsWith('slack:channel:')) {
    const parts = k.split(':')
    const ts = parts[parts.length - 1]
    const date = ts ? new Date(parseFloat(ts) * 1000).toLocaleDateString('en-CA') : ''
    return `Slack Thread${date ? ' · ' + date : ''}`
  }
  const sessionMatch = k.match(/^session-(\d{10,})$/)
  if (sessionMatch) {
    const date = new Date(parseInt(sessionMatch[1])).toLocaleDateString('en-CA')
    return `Webchat · ${date}`
  }
  if (k === 'main' || k.includes('heartbeat') || k.includes('cron')) return 'Background'
  return k
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function timeAgo(ts: string | null): string {
  if (!ts) return 'Never'
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function CostsPanel() {
  const { labels } = useLabelStore()
  const [data, setData] = useState<CostsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await fetch(`${API}/api/costs?days=30`, { credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const fresh = await r.json() as CostsData
      setData(fresh)
      setLastFetch(new Date())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // Initial load
  useEffect(() => {
    void load()
  }, [])

  // Auto-refresh every 60 seconds (silent)
  useEffect(() => {
    const interval = setInterval(() => {
      void load(true)
    }, 60_000)
    return () => clearInterval(interval)
  }, [])

  if (loading && !data) return <div className="p-6 text-[#6b7280] text-sm">Loading costs…</div>
  if (error && !data)
    return (
      <div className="p-6 space-y-3">
        <div className="text-red-400 text-sm">Error: {error}</div>
        <button 
          onClick={() => load()} 
          className="px-3 py-1.5 bg-[#6366f1] text-white text-sm rounded-lg hover:bg-[#5558e3]"
        >
          Retry
        </button>
      </div>
    )
  if (!data) return null
  if ((data as unknown as { disabled?: boolean }).disabled) return (
    <div className="p-6 text-[#6b7280] text-sm">
      Cost tracking not configured. Add <code className="bg-[#1a1d2e] px-1 rounded">COSTS_DB_URL</code> to enable.
    </div>
  )

  const maxSessionCost = Math.max(...(data.sessions?.map((s) => s.cost) || [0]), 0.001)
  const maxTodaySessionCost = Math.max(...(data.todaySessions?.map((s) => s.cost) || [0]), 0.001)

  const todayOverhead = computeOverhead(data.todayCacheWriteTokens ?? 0, data.todayCacheReadTokens ?? 0)
  const todayCompute = Math.max(0, data.today - todayOverhead)
  const todayOverheadPct = data.today > 0 ? Math.round((todayOverhead / data.today) * 100) : 0

  // Calculate stats
  const todayDelta = data.yesterday > 0
    ? ((data.today - data.yesterday) / data.yesterday) * 100
    : null
  const sortedDays = [...(data.daily ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const last7Days = sortedDays.slice(-7)
  const weekTotal = last7Days.reduce((s, d) => s + d.total_cost_usd, 0)
  const avgPerDay = last7Days.length > 0 ? weekTotal / last7Days.length : 0
  const totalTokens = data.todayInputTokens + data.todayOutputTokens
  const avgCostPerSession = data.todaySessionCount > 0 ? data.today / data.todaySessionCount : null
  const avgTokensPerSession = data.todaySessionCount > 0 ? Math.round(totalTokens / data.todaySessionCount) : null

  // Data freshness warning
  const syncAge = data.lastSync ? Date.now() - new Date(data.lastSync).getTime() : null
  const isStale = syncAge !== null && syncAge > 30 * 60 * 1000 // 30 min

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Freshness indicator */}
      <div className="flex items-center justify-between text-xs">
        <div className="text-[#6b7280]">
          Last updated: {lastFetch ? timeAgo(lastFetch.toISOString()) : 'Never'}
          {loading && <span className="ml-2">⟳ Refreshing…</span>}
        </div>
        {isStale && (
          <div className="text-amber-400 flex items-center gap-1">
            <span>⚠</span>
            <span>Data may be stale (last sync: {timeAgo(data.lastSync)})</span>
          </div>
        )}
        <button 
          onClick={() => load()} 
          className="text-[#6366f1] hover:text-[#5558e3]"
          disabled={loading}
        >
          Refresh now
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-4 gap-3">
        {/* Today + delta vs yesterday */}
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Today</div>
          <div className="text-2xl font-bold text-white">${data.today.toFixed(2)}</div>
          {todayDelta !== null && (
            <div className={`text-xs mt-1 font-medium flex items-center gap-1 ${todayDelta > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              <span>{todayDelta > 0 ? '↑' : '↓'}</span>
              <span>{Math.abs(todayDelta).toFixed(0)}% vs yesterday</span>
            </div>
          )}
          {todayDelta === null && (
            <div className="text-xs text-[#6b7280] mt-1">No comparison</div>
          )}
        </div>

        {/* Sessions today */}
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Sessions</div>
          <div className="text-2xl font-bold text-white">{data.todaySessionCount}</div>
          {avgCostPerSession !== null && (
            <div className="text-xs text-[#6b7280] mt-1">
              ${avgCostPerSession.toFixed(3)} avg
            </div>
          )}
        </div>

        {/* Tokens today */}
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">Tokens</div>
          <div className="text-2xl font-bold text-white">{formatTokens(totalTokens)}</div>
          <div className="text-xs text-[#6b7280] mt-1 flex items-center gap-2">
            <span>↑ {formatTokens(data.todayInputTokens)}</span>
            <span>↓ {formatTokens(data.todayOutputTokens)}</span>
          </div>
        </div>

        {/* Cache overhead */}
        {todayOverhead > 0 && (
          <div className="col-span-4 bg-[#181c24] border border-[#2a3142] rounded-xl p-3">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="text-[#6b7280] uppercase tracking-wider">Cost breakdown</span>
              <span className="text-[#6b7280]">
                Compute <span className="text-white font-mono">${todayCompute.toFixed(3)}</span>
                <span className="mx-2 text-[#3a4152]">|</span>
                Cache overhead <span className="text-amber-400 font-mono">${todayOverhead.toFixed(3)}</span>
                <span className="ml-1 text-[#6b7280]">({todayOverheadPct}%)</span>
              </span>
            </div>
            <div className="h-1.5 bg-[#2a3142] rounded-full overflow-hidden flex">
              <div className="h-full bg-[#6366f1] rounded-l-full transition-all" style={{ width: `${100 - todayOverheadPct}%` }} />
              <div className="h-full bg-amber-500 rounded-r-full transition-all" style={{ width: `${todayOverheadPct}%` }} />
            </div>
          </div>
        )}

        {/* 7-day average */}
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-1">7-Day Avg</div>
          <div className="text-2xl font-bold text-white">
            {avgPerDay > 0 ? `$${avgPerDay.toFixed(2)}` : '—'}
          </div>
          <div className="text-xs text-[#6b7280] mt-1">
            ${weekTotal.toFixed(2)} total
          </div>
        </div>
      </div>

      {/* Daily chart */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
        <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">
          Daily Spend (Last 30 Days)
        </div>
        <CostChart data={data.daily ?? []} maDays={7} />
      </div>

      {/* Today's top sessions */}
      {data.todaySessions && data.todaySessions.length > 0 && (
        <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
          <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">
            Top Sessions — Today
          </div>
          <div className="space-y-3">
            {data.todaySessions.map((s) => {
              const label = labels[s.session_key] || s.session_label || formatSessionKey(s.session_key)
              const tokensStr = `${formatTokens(s.input_tokens + s.output_tokens)} tok`
              const sessionOverhead = computeOverhead(s.cache_write_tokens ?? 0, s.cache_read_tokens ?? 0)
              const sessionCompute = Math.max(0, s.cost - sessionOverhead)
              const hasCache = (s.cache_write_tokens ?? 0) + (s.cache_read_tokens ?? 0) > 0
              return (
              <div key={s.session_key}>
                <div className="flex items-center gap-2 mb-1">
                  <div className="text-sm text-white truncate flex-1" title={s.session_key}>
                    {label}
                  </div>
                  <div className="text-xs text-[#6b7280]">{tokensStr}</div>
                  <div className="text-xs text-white font-medium w-14 text-right">
                    ${s.cost.toFixed(3)}
                  </div>
                </div>
                <Bar value={s.cost} max={maxTodaySessionCost} />
                {hasCache && (
                  <div className="text-[10px] text-[#6b7280] mt-0.5 font-mono">
                    Compute <span className="text-[#a5b4fc]">${sessionCompute.toFixed(3)}</span>
                    <span className="mx-1 text-[#3a4152]">·</span>
                    Cache <span className="text-amber-400">${sessionOverhead.toFixed(3)}</span>
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </div>
      )}

      {/* Top sessions — 30 days */}
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-4">
        <div className="text-xs text-[#6b7280] uppercase tracking-wider mb-3">
          Top Sessions — Last 30 Days
        </div>
        <div className="space-y-3">
          {data.sessions?.slice(0, 20).map((s) => {
            const label = labels[s.session_key] || s.session_label || formatSessionKey(s.session_key)
            const tokensStr = `${formatTokens(s.input_tokens + s.output_tokens)} tok`
            const sessionOverhead = computeOverhead(s.cache_write_tokens ?? 0, s.cache_read_tokens ?? 0)
            const sessionCompute = Math.max(0, s.cost - sessionOverhead)
            const hasCache = (s.cache_write_tokens ?? 0) + (s.cache_read_tokens ?? 0) > 0
            return (
            <div key={s.session_key}>
              <div className="flex items-center gap-2 mb-1">
                <div className="text-sm text-white truncate flex-1" title={s.session_key}>
                  {label}
                </div>
                <div className="text-xs text-[#6b7280]">{tokensStr}</div>
                <div className="text-xs text-white font-medium w-14 text-right">
                  ${s.cost.toFixed(3)}
                </div>
              </div>
              <Bar value={s.cost} max={maxSessionCost} />
              {hasCache && (
                <div className="text-[10px] text-[#6b7280] mt-0.5 font-mono">
                  Compute <span className="text-[#a5b4fc]">${sessionCompute.toFixed(3)}</span>
                  <span className="mx-1 text-[#3a4152]">·</span>
                  Cache <span className="text-amber-400">${sessionOverhead.toFixed(3)}</span>
                </div>
              )}
            </div>
          )
          })}
        </div>
      </div>
    </div>
  )
}
