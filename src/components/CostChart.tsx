import { useState } from 'react'

interface DayCost {
  date: string
  total_cost_usd: number
  session_count: number
}

interface Props {
  data: DayCost[]
  maDays?: number // moving average window (default 3)
}

const W = 560
const H = 180
const PAD = { top: 12, right: 16, bottom: 36, left: 44 }
const CHART_W = W - PAD.left - PAD.right
const CHART_H = H - PAD.top - PAD.bottom

function movingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null
    const slice = values.slice(i - window + 1, i + 1)
    return slice.reduce((s, v) => s + v, 0) / window
  })
}

export default function CostChart({ data, maDays = 3 }: Props) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; day: DayCost; ma: number | null } | null>(null)

  if (!data || data.length === 0) return null

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date))
  const values = sorted.map((d) => d.total_cost_usd)
  const maValues = movingAverage(values, maDays)

  const maxVal = Math.max(...values, ...maValues.filter(Boolean) as number[], 0.01)
  // Round up to a nice number for Y axis
  const yMax = Math.ceil(maxVal * 1.2 * 100) / 100

  // Format currency with appropriate precision based on magnitude
  const fmtCost = (val: number) => {
    if (val >= 1000) return '$' + val.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (val >= 10) return '$' + val.toFixed(2)
    return '$' + val.toFixed(3)
  }

  const xScale = (i: number) => (i / (sorted.length - 1)) * CHART_W
  const yScale = (v: number) => CHART_H - (v / yMax) * CHART_H

  const barWidth = Math.max(8, (CHART_W / sorted.length) * 0.55)

  // Y axis ticks
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax]

  // MA line path
  const maPoints = maValues
    .map((v, i) => (v !== null ? `${xScale(i)},${yScale(v)}` : null))
    .filter(Boolean)
  const maPath = maPoints.length > 1
    ? 'M ' + maPoints.join(' L ')
    : null

  // Short date labels — handle both YYYY-MM-DD and full ISO strings
  const parseDate = (dateStr: string) => {
    const ymd = dateStr.slice(0, 10) // always grab YYYY-MM-DD prefix
    return new Date(ymd + 'T12:00:00Z')
  }
  const fmtDate = (dateStr: string) => {
    return parseDate(dateStr).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="relative select-none">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: H }}
        onMouseLeave={() => setTooltip(null)}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* Grid lines + Y axis labels */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={0} y1={yScale(tick)}
                x2={CHART_W} y2={yScale(tick)}
                stroke="#2a3142" strokeWidth={1}
              />
              <text
                x={-6} y={yScale(tick)}
                textAnchor="end" dominantBaseline="middle"
                fontSize={9} fill="#6b7280"
              >
                {fmtCost(tick)}
              </text>
            </g>
          ))}

          {/* Bars */}
          {sorted.map((day, i) => {
            const bx = xScale(i) - barWidth / 2
            const bh = (day.total_cost_usd / yMax) * CHART_H
            const by = CHART_H - bh
            const isHovered = tooltip?.day.date === day.date
            return (
              <rect
                key={day.date}
                x={bx} y={by}
                width={barWidth} height={Math.max(bh, 1)}
                rx={3}
                fill={isHovered ? '#818cf8' : '#6366f1'}
                opacity={isHovered ? 1 : 0.75}
                className="transition-all duration-75"
                onMouseEnter={(e) => {
                  const svgRect = (e.currentTarget.closest('svg') as SVGSVGElement).getBoundingClientRect()
                  setTooltip({
                    x: (xScale(i) / W) * svgRect.width + svgRect.left,
                    y: svgRect.top,
                    day,
                    ma: maValues[i],
                  })
                }}
              />
            )
          })}

          {/* Moving average line */}
          {maPath && (
            <>
              <path
                d={maPath}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity={0.9}
              />
              {/* MA dots */}
              {maValues.map((v, i) =>
                v !== null ? (
                  <circle
                    key={i}
                    cx={xScale(i)} cy={yScale(v)}
                    r={3}
                    fill="#f59e0b"
                    stroke="#181c24"
                    strokeWidth={1.5}
                    opacity={0.9}
                  />
                ) : null
              )}
            </>
          )}

          {/* X axis labels — thin out for long ranges */}
          {sorted.map((day, i) => {
            const step = sorted.length > 20 ? 7 : sorted.length > 10 ? 5 : 1
            if (i % step !== 0 && i !== sorted.length - 1) return null
            return (
              <text
                key={day.date}
                x={xScale(i)} y={CHART_H + 14}
                textAnchor="middle"
                fontSize={9} fill="#6b7280"
              >
                {fmtDate(day.date)}
              </text>
            )
          })}

          {/* X axis baseline */}
          <line
            x1={0} y1={CHART_H}
            x2={CHART_W} y2={CHART_H}
            stroke="#2a3142" strokeWidth={1}
          />
        </g>
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-1 px-1">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-[#6366f1] opacity-75" />
          <span className="text-xs text-[#6b7280]">Daily spend</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-0.5 bg-[#f59e0b] rounded-full" />
          <span className="text-xs text-[#6b7280]">{maDays}-day avg</span>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-[#1e2330] border border-[#2a3142] rounded-lg px-3 py-2 shadow-xl text-xs"
          style={{ left: tooltip.x + 12, top: tooltip.y + PAD.top + 8 }}
        >
          <div className="text-[#9ca3af] mb-1 font-medium">
            {parseDate(tooltip.day.date).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm bg-[#6366f1]" />
            <span className="text-white font-semibold">{fmtCost(tooltip.day.total_cost_usd)}</span>
            <span className="text-[#6b7280]">· {tooltip.day.session_count} sessions</span>
          </div>
          {tooltip.ma !== null && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-2 h-0.5 bg-[#f59e0b] rounded-full" />
              <span className="text-[#f59e0b]">{fmtCost(tooltip.ma)}</span>
              <span className="text-[#6b7280]">{maDays}-day avg</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
