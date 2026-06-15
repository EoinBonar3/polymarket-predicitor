'use client'

/**
 * Calibration chart — predicted probability vs. actual win rate.
 *
 * Layers (z-order):
 *   1. Wilson 95% confidence-interval band (Area)
 *   2. Perfect-calibration y=x reference line (dashed)
 *   3. All signals (primary line + scaled dots, colour reflects bias)
 *   4. Bookmaker (odds_api) signals — only if any populated buckets
 *   5. Structural signals — only if any populated buckets
 */

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { CalibrationBucket, CalibrationData } from '@/lib/calibration'

// ---------------------------------------------------------------------------
// Colour tokens
// ---------------------------------------------------------------------------
//
// The performance page uses a hard-coded palette (no CSS custom properties),
// so we map the semantic colours requested by the spec onto the existing
// equity-curve hues for visual consistency.

const COLOR_PRIMARY = '#34d399' // emerald-400 — matches equity curve
const COLOR_SUCCESS = '#10b981' // emerald-500 — slightly deeper for bookmaker
const COLOR_DANGER = '#f43f5e' // rose-500 — overconfident dot
const COLOR_TEXT_MUTED = '#6b7280' // gray-500
const COLOR_TEXT_FAINT = '#374151' // gray-700
const COLOR_GRID = '#1f2937' // gray-800

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CalibrationChartProps {
  data: CalibrationData
  height?: number
}

interface BandRow {
  x: number
  band: [number, number]
}

interface LineRow {
  x: number
  predicted: number
  actual: number
  total: number
  wins: number
  lower: number
  upper: number
  label: string
  source: CalibrationBucket['signalSource']
}

// ---------------------------------------------------------------------------
// Dot renderer — radius scales with sample size, colour reflects bias
// ---------------------------------------------------------------------------

interface DotPayload {
  cx?: number
  cy?: number
  payload?: LineRow
}

function CalibrationDot(props: DotPayload) {
  const { cx, cy, payload } = props
  if (
    cx == null ||
    cy == null ||
    payload == null ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy)
  ) {
    return <g />
  }

  // Empty buckets sit at (midpoint, 0) — render an invisible dot rather than
  // a misleading filled circle.
  if (payload.total === 0) {
    return <g />
  }

  const radius = Math.min(12, 4 + payload.total * 0.5)
  // Underconfident (actual > predicted) is genuinely good news — green.
  // Overconfident (actual < predicted) is the failure mode we care about — red.
  const fill =
    payload.actual > payload.predicted
      ? COLOR_SUCCESS
      : payload.actual < payload.predicted
      ? COLOR_DANGER
      : COLOR_PRIMARY

  return (
    <circle
      cx={cx}
      cy={cy}
      r={radius}
      fill={fill}
      stroke="#030712"
      strokeWidth={1.5}
    />
  )
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

interface TooltipEntry {
  payload?: LineRow & { band?: [number, number] }
}

function CalibrationTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipEntry[]
}) {
  if (!active || !payload || payload.length === 0) return null

  // Prefer the "all signals" payload (the one with a positive `total`); fall
  // back to the first entry if nothing matches.
  const entry = payload.find((p) => p.payload && p.payload.total > 0) ?? payload[0]
  const row = entry?.payload
  if (!row) return null

  const predictedPct = (row.predicted * 100).toFixed(1)
  const actualPct = (row.actual * 100).toFixed(1)
  const lowerPct = (row.lower * 100).toFixed(1)
  const upperPct = (row.upper * 100).toFixed(1)
  const error = Math.abs(row.predicted - row.actual) * 100

  return (
    <div className="rounded-md border border-gray-800 bg-gray-950/95 px-3 py-2 text-xs text-gray-100 shadow-lg">
      <p className="font-semibold text-gray-50">{row.label}</p>
      {row.total === 0 ? (
        <p className="mt-1 text-gray-400">No bets in this bucket yet</p>
      ) : (
        <dl className="mt-1 space-y-0.5 tabular-nums">
          <Row label="Predicted" value={`${predictedPct}%`} />
          <Row label="Actual win rate" value={`${actualPct}%`} />
          <Row label="Sample size" value={`${row.total} bet${row.total === 1 ? '' : 's'}`} />
          <Row label="95% CI" value={`[${lowerPct}%, ${upperPct}%]`} />
          <Row
            label="Calibration error"
            value={`${error.toFixed(1)}%`}
            tone={error <= 5 ? 'positive' : error <= 10 ? 'neutral' : 'negative'}
          />
        </dl>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-300'
      : tone === 'negative'
      ? 'text-rose-300'
      : 'text-gray-100'
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className={`font-semibold ${toneClass}`}>{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main chart
// ---------------------------------------------------------------------------

function toLineRows(buckets: CalibrationBucket[]): LineRow[] {
  return buckets.map((b) => ({
    x: b.bucketMidpoint,
    predicted: b.predictedProbability,
    actual: b.actualWinRate,
    total: b.totalBets,
    wins: b.wins,
    lower: b.confidenceLower,
    upper: b.confidenceUpper,
    label: b.bucketLabel,
    source: b.signalSource,
  }))
}

function toBandRows(buckets: CalibrationBucket[]): Array<LineRow & BandRow> {
  return buckets.map((b) => ({
    x: b.bucketMidpoint,
    band: [b.confidenceLower, b.confidenceUpper] as [number, number],
    predicted: b.predictedProbability,
    actual: b.actualWinRate,
    total: b.totalBets,
    wins: b.wins,
    lower: b.confidenceLower,
    upper: b.confidenceUpper,
    label: b.bucketLabel,
    source: b.signalSource,
  }))
}

const PCT_TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1]
const formatPctTick = (v: number) => `${Math.round(v * 100)}%`

export function CalibrationChart({ data, height = 320 }: CalibrationChartProps) {
  const isEmpty = data.totalResolved < 5
  const remaining = Math.max(0, 5 - data.totalResolved)

  // Render only populated buckets — empty buckets have a Wilson CI of [0, 1]
  // (no information) and an actualWinRate of 0, both of which would distort
  // the visualisation if plotted.
  const allRows = toLineRows(data.allBuckets).filter((r) => r.total > 0)
  const bandRows = toBandRows(data.allBuckets).filter((r) => r.total > 0)
  const oddsRows = toLineRows(data.oddsBuckets).filter((r) => r.total > 0)
  const structuralRows = toLineRows(data.structuralBuckets).filter(
    (r) => r.total > 0,
  )

  const hasOdds = oddsRows.length > 0
  const hasStructural = structuralRows.length > 0

  return (
    <section
      aria-label="Signal calibration chart"
      className="relative rounded-xl border border-gray-800 bg-gray-900/50 p-4 sm:p-6"
    >
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-white">
          Predicted vs. actual win rate
        </h3>
        <p className="text-[11px] text-gray-500">
          Dots on the diagonal = perfectly calibrated · above = underconfident · below = overconfident
        </p>
      </div>

      <div
        className={`w-full ${isEmpty ? 'opacity-40 grayscale' : ''}`}
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 12, right: 24, bottom: 24, left: 8 }}>
            <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 3" />

            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 1]}
              ticks={PCT_TICKS}
              tickFormatter={formatPctTick}
              stroke={COLOR_TEXT_MUTED}
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={{ stroke: COLOR_GRID }}
              label={{
                value: 'Predicted probability',
                position: 'insideBottom',
                offset: -12,
                fill: '#9ca3af',
                fontSize: 11,
              }}
            />

            <YAxis
              type="number"
              domain={[0, 1]}
              ticks={PCT_TICKS}
              tickFormatter={formatPctTick}
              stroke={COLOR_TEXT_MUTED}
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={{ stroke: COLOR_GRID }}
              width={48}
              label={{
                value: 'Actual win rate',
                angle: -90,
                position: 'insideLeft',
                offset: 12,
                fill: '#9ca3af',
                fontSize: 11,
              }}
            />

            <Tooltip
              cursor={{ stroke: '#374151', strokeDasharray: '3 3' }}
              content={<CalibrationTooltip />}
              isAnimationActive={false}
            />

            {/* 1. Wilson confidence-interval band */}
            {!isEmpty ? (
              <Area
                data={bandRows}
                dataKey="band"
                type="monotone"
                stroke="none"
                fill={COLOR_PRIMARY}
                fillOpacity={0.1}
                isAnimationActive={false}
                activeDot={false}
                legendType="none"
              />
            ) : null}

            {/* 2. Perfect-calibration y=x reference line */}
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ]}
              stroke={COLOR_TEXT_FAINT}
              strokeDasharray="4 4"
              strokeWidth={1}
              ifOverflow="hidden"
              label={{
                value: 'Perfect calibration',
                position: 'insideTopRight',
                fill: COLOR_TEXT_MUTED,
                fontSize: 10,
              }}
            />

            {/* 3. All signals */}
            {!isEmpty ? (
              <Line
                data={allRows}
                dataKey="actual"
                type="monotone"
                stroke={COLOR_PRIMARY}
                strokeWidth={2}
                isAnimationActive={false}
                connectNulls={false}
                dot={<CalibrationDot />}
                activeDot={false}
                name="All signals"
              />
            ) : null}

            {/* 4. Bookmaker (odds_api) — only if any data */}
            {!isEmpty && hasOdds ? (
              <Line
                data={oddsRows}
                dataKey="actual"
                type="monotone"
                stroke={COLOR_SUCCESS}
                strokeWidth={2}
                strokeDasharray="6 4"
                isAnimationActive={false}
                connectNulls={false}
                dot={false}
                activeDot={false}
                name="Bookmaker signals"
              />
            ) : null}

            {/* 5. Structural — only if any data */}
            {!isEmpty && hasStructural ? (
              <Line
                data={structuralRows}
                dataKey="actual"
                type="monotone"
                stroke={COLOR_TEXT_MUTED}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                isAnimationActive={false}
                connectNulls={false}
                dot={false}
                activeDot={false}
                name="Structural signals"
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {isEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
          <p className="max-w-sm rounded-lg border border-gray-800 bg-gray-950/80 px-4 py-3 text-center text-sm text-gray-300">
            Calibration data builds automatically as bets resolve. Come back
            after {remaining} more resolved bet{remaining === 1 ? '' : 's'}.
          </p>
        </div>
      ) : (
        <Legend hasOdds={hasOdds} hasStructural={hasStructural} />
      )}
    </section>
  )
}

function Legend({
  hasOdds,
  hasStructural,
}: {
  hasOdds: boolean
  hasStructural: boolean
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400">
      <LegendSwatch color={COLOR_PRIMARY} label="All signals" />
      {hasOdds ? (
        <LegendSwatch color={COLOR_SUCCESS} dashed label="Bookmaker signals" />
      ) : null}
      {hasStructural ? (
        <LegendSwatch color={COLOR_TEXT_MUTED} dashed label="Structural signals" />
      ) : null}
      <LegendSwatch color={COLOR_TEXT_FAINT} dashed label="Perfect calibration" />
      <span className="ml-auto text-[10px] text-gray-500">
        Dot size = sample count · band = 95% Wilson CI
      </span>
    </div>
  )
}

function LegendSwatch({
  color,
  label,
  dashed = false,
}: {
  color: string
  label: string
  dashed?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0.5 w-5"
        style={{
          backgroundColor: dashed ? 'transparent' : color,
          borderTop: dashed ? `2px dashed ${color}` : undefined,
        }}
      />
      <span>{label}</span>
    </span>
  )
}

export default CalibrationChart
