'use client'

/**
 * Performance — equity curve, account-level stats, and closed-trade history.
 *
 * Everything on this page is derived from the in-memory Zustand bankroll
 * store. The equity curve plots `bankrollHistory` (cash balance after each
 * placeBet / closeBet event), and the stats / history table summarise the
 * realised side of the account (closedPositions).
 */

import { useMemo } from 'react'
import Link from 'next/link'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { cn, formatCurrency, formatPercent, formatProfit } from '@/lib/utils'
import { useBankrollStore, type BankrollPosition } from '@/store/bankroll'
import type { BankrollHistoryPoint, Outcome } from '@/lib/types'
import { buildCalibrationData } from '@/lib/calibration'
import { buildLearnedModel, type LearnedModel } from '@/lib/learning'
import { CalibrationChart } from '@/components/charts/CalibrationChart'
import { CalibrationStats } from '@/components/charts/CalibrationStats'

interface EquityPoint {
  timestamp: string
  label: string
  balance: number
}

interface ClosedStats {
  totalTrades: number
  totalClosed: number
  wins: number
  losses: number
  winRate: number
  totalPnL: number
  totalReturnPct: number
  totalStaked: number
  avgStake: number
  bestWin: number
  worstLoss: number
}

export default function PerformancePage() {
  const startingBalance = useBankrollStore((s) => s.startingBalance)
  const balance = useBankrollStore((s) => s.balance)
  const openPositions = useBankrollStore((s) => s.openPositions)
  const closedPositions = useBankrollStore((s) => s.closedPositions)
  const bankrollHistory = useBankrollStore((s) => s.bankrollHistory)

  const equityData = useMemo(() => toEquityData(bankrollHistory), [bankrollHistory])
  const stats = useMemo(
    () => computeStats(closedPositions, openPositions, balance, startingBalance),
    [closedPositions, openPositions, balance, startingBalance],
  )
  const yDomain = useMemo(() => computeYDomain(equityData, startingBalance), [
    equityData,
    startingBalance,
  ])
  // Calibration analytics only depend on the closed-trade history — recompute
  // when (and only when) that list changes.
  const calibrationData = useMemo(
    () => buildCalibrationData(closedPositions),
    [closedPositions],
  )
  // What the closed-loop learner has derived from resolved bets — the same
  // model that's live in the signal engine via `useOddsSignals`.
  const learning = useMemo(
    () => buildLearnedModel(closedPositions),
    [closedPositions],
  )

  const hasActivity = closedPositions.length > 0 || openPositions.length > 0

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Performance
        </h1>
        <p className="text-sm text-gray-400">
          Equity curve, realised P&L, and a log of every closed paper trade.
        </p>
      </header>

      {!hasActivity ? (
        <EmptyState />
      ) : (
        <>
          <EquityCurve
            data={equityData}
            startingBalance={startingBalance}
            yDomain={yDomain}
          />
          <StatsRow stats={stats} />
          <ClosedPositionsTable rows={closedPositions} />
          <CalibrationSection data={calibrationData} />
          <LearningSection learning={learning} />
        </>
      )}
    </div>
  )
}

function CalibrationSection({
  data,
}: {
  data: ReturnType<typeof buildCalibrationData>
}) {
  return (
    <section aria-labelledby="signal-calibration" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="signal-calibration"
          className="text-lg font-semibold tracking-tight text-white"
        >
          Signal calibration
          <span className="ml-2 text-sm font-normal text-gray-500">
            {data.totalResolved} resolved
          </span>
        </h2>
        <p className="hidden text-xs text-gray-500 sm:block">
          Are our probability estimates honest? — predicted vs. actual.
        </p>
      </div>
      <CalibrationStats data={data} />
      <CalibrationChart data={data} />
    </section>
  )
}

function LearningSection({ learning }: { learning: LearnedModel }) {
  const { active, totalSamples, overconfidence, kellyMultiplier, signalStats, comboStats } =
    learning
  const samplesUntilActive = Math.max(0, 20 - totalSamples)

  const biasPp = Math.abs(overconfidence) * 100
  const biasLabel =
    biasPp < 0.5
      ? 'Well calibrated'
      : overconfidence > 0
        ? `Overconfident by ${biasPp.toFixed(1)}pp`
        : `Underconfident by ${biasPp.toFixed(1)}pp`

  return (
    <section aria-labelledby="model-learning" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="model-learning"
          className="text-lg font-semibold tracking-tight text-white"
        >
          What the model has learned
          <span className="ml-2 text-sm font-normal text-gray-500">
            {totalSamples} structural bets resolved
          </span>
        </h2>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1',
            active
              ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
              : 'bg-gray-700/30 text-gray-300 ring-gray-500/30',
          )}
        >
          {active ? 'Live' : 'Learning'}
        </span>
      </div>

      {!active ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 sm:p-6">
          <p className="text-sm text-gray-400">
            The signal engine is still using its default weights. Once{' '}
            <strong className="text-gray-200">{samplesUntilActive}</strong> more
            structural bet{samplesUntilActive === 1 ? '' : 's'} resolve, it
            starts (1) shrinking each signal&apos;s influence toward what it has
            actually predicted, (2) scaling Kelly down if it&apos;s been
            overconfident, and (3) flagging signals that carry no edge. The
            tables below preview those numbers as data accrues.
          </p>
        </div>
      ) : null}

      <section
        aria-label="Learning summary"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        <StatCard
          label="Kelly sizing"
          value={`${Math.round(kellyMultiplier * 100)}%`}
          hint={kellyMultiplier < 1 ? 'shrunk for overconfidence' : 'full Kelly'}
          tone={kellyMultiplier < 1 ? 'negative' : 'positive'}
        />
        <StatCard
          label="Calibration"
          value={biasLabel}
          hint={`Brier ${learning.brierScore.toFixed(3)}`}
          tone={biasPp < 0.5 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Live"
          value={active ? 'Yes' : 'No'}
          hint={active ? 'corrections applied' : `needs ${samplesUntilActive} more`}
          tone={active ? 'positive' : 'neutral'}
        />
      </section>

      <div className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900/40">
        <table className="min-w-full divide-y divide-gray-800 text-sm">
          <thead className="bg-gray-900/60 text-left text-[11px] uppercase tracking-wider text-gray-400">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Signal</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Bets</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Win rate</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Claimed → Realised edge</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Weight ×</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 text-gray-200">
            {signalStats.map((s) => (
              <tr key={s.key}>
                <td className="px-4 py-3 font-medium text-gray-100">
                  {s.label}
                  {s.retired ? (
                    <span className="ml-2 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300 ring-1 ring-rose-400/30">
                      retired
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                  {s.bets}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {s.bets > 0 ? formatPercent(s.winRate) : '—'}
                  {s.bets > 0 ? (
                    <span className="ml-1 text-[10px] text-gray-500">
                      ±{Math.round(((s.upper - s.lower) / 2) * 100)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                  {s.bets > 0
                    ? `${(s.claimedEdge * 100).toFixed(1)} → ${(s.realizedEdge * 100).toFixed(1)}pp`
                    : '—'}
                </td>
                <td
                  className={cn(
                    'px-4 py-3 text-right font-semibold tabular-nums',
                    s.reliability < 0.9 && 'text-rose-300',
                    s.reliability > 1.1 && 'text-emerald-300',
                    s.reliability >= 0.9 && s.reliability <= 1.1 && 'text-gray-300',
                  )}
                >
                  {s.reliability.toFixed(2)}×
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {comboStats.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900/40">
          <table className="min-w-full divide-y divide-gray-800 text-sm">
            <thead className="bg-gray-900/60 text-left text-[11px] uppercase tracking-wider text-gray-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Combination that fired</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Bets</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Win rate (95% CI)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-200">
              {comboStats.map((c) => (
                <tr key={c.label}>
                  <td className="px-4 py-3 text-gray-100">{c.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                    {c.bets}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatPercent(c.winRate)}
                    <span className="ml-1 text-[10px] text-gray-500">
                      ({Math.round(c.lower * 100)}–{Math.round(c.upper * 100)})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-[11px] text-gray-500">
        Weight × scales each signal&apos;s nudge by realised ÷ claimed edge
        (shrunk toward 1 by sample count); a signal stuck near 0 is retired.
        Kelly sizing shrinks globally when wins lag predictions. A bet that fired
        multiple signals counts toward each — the combination table isolates the
        single-signal cases.
      </p>
    </section>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-6 py-20 text-center">
      <p className="text-base font-medium text-gray-200">No trading history yet</p>
      <p className="max-w-md text-sm text-gray-400">
        Place a paper trade from the{' '}
        <Link
          href="/dashboard"
          className="text-emerald-300 underline-offset-2 hover:underline"
        >
          dashboard
        </Link>{' '}
        and the equity curve, stats, and closed-trade log will start filling
        in here.
      </p>
    </div>
  )
}

function EquityCurve({
  data,
  startingBalance,
  yDomain,
}: {
  data: EquityPoint[]
  startingBalance: number
  yDomain: [number, number]
}) {
  return (
    <section
      aria-label="Equity curve"
      className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 sm:p-6"
    >
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          Equity curve
        </h2>
        <p className="text-xs text-gray-500">
          Cash balance after each trade · dashed line = starting bankroll
        </p>
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
          >
            <defs>
              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />

            <XAxis
              dataKey="label"
              stroke="#6b7280"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={{ stroke: '#1f2937' }}
              minTickGap={24}
            />

            <YAxis
              stroke="#6b7280"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={{ stroke: '#1f2937' }}
              domain={yDomain}
              tickFormatter={(v: number) => formatCurrency(v)}
              width={72}
            />

            <Tooltip
              cursor={{ stroke: '#374151', strokeDasharray: '3 3' }}
              contentStyle={{
                backgroundColor: '#030712',
                border: '1px solid #1f2937',
                borderRadius: 8,
                color: '#f3f4f6',
                fontSize: 12,
              }}
              labelStyle={{ color: '#9ca3af' }}
              formatter={(value) => {
                // Recharts' Formatter sees ValueType | undefined (string | number
                // | array | undefined). We're charting `balance: number` so coerce
                // through Number() and fall back to 0 for the impossible cases.
                const raw = Array.isArray(value) ? value[0] : value
                const n = Number(raw)
                return [formatCurrency(Number.isFinite(n) ? n : 0), 'Balance']
              }}
              labelFormatter={(label, payload) => {
                // `label` is typed as ReactNode here; we only fall back to it
                // when the data point is missing a real timestamp.
                const first = payload?.[0]
                const ts =
                  first && typeof first === 'object' && 'payload' in first
                    ? (first.payload as { timestamp?: unknown } | undefined)?.timestamp
                    : undefined
                if (typeof ts !== 'string') return label
                const d = new Date(ts)
                if (Number.isNaN(d.getTime())) return label
                return d.toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }}
            />

            <ReferenceLine
              y={startingBalance}
              stroke="#6b7280"
              strokeDasharray="4 4"
              strokeWidth={1}
            />

            <Area
              type="monotone"
              dataKey="balance"
              stroke="#34d399"
              strokeWidth={2}
              fill="url(#equityFill)"
              isAnimationActive={false}
              dot={data.length <= 12 ? { r: 2, fill: '#34d399' } : false}
              activeDot={{ r: 4, fill: '#34d399', stroke: '#022c22' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

function StatsRow({ stats }: { stats: ClosedStats }) {
  const returnTone =
    stats.totalPnL > 0 ? 'positive' : stats.totalPnL < 0 ? 'negative' : 'neutral'

  return (
    <section
      aria-label="Performance stats"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      <StatCard
        label="Total Return"
        value={formatProfit(stats.totalPnL)}
        hint={`${stats.totalReturnPct >= 0 ? '+' : ''}${(stats.totalReturnPct * 100).toFixed(2)}%`}
        tone={returnTone}
      />
      <StatCard
        label="Win Rate"
        value={formatPercent(stats.winRate, 0)}
        hint={`${stats.wins}W · ${stats.losses}L`}
      />
      <StatCard
        label="Total Trades"
        value={String(stats.totalTrades)}
        hint={`${stats.totalClosed} closed`}
      />
      <StatCard
        label="Avg Stake"
        value={formatCurrency(stats.avgStake)}
        hint={`${formatCurrency(stats.totalStaked)} total`}
      />
      <StatCard
        label="Best Win"
        value={formatProfit(stats.bestWin)}
        tone={stats.bestWin > 0 ? 'positive' : 'neutral'}
      />
      <StatCard
        label="Worst Loss"
        value={formatProfit(stats.worstLoss)}
        tone={stats.worstLoss < 0 ? 'negative' : 'neutral'}
      />
    </section>
  )
}

function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          tone === 'positive' && 'text-emerald-300',
          tone === 'negative' && 'text-rose-300',
          tone === 'neutral' && 'text-white',
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p>
      ) : null}
    </div>
  )
}

function ClosedPositionsTable({ rows }: { rows: BankrollPosition[] }) {
  return (
    <section aria-labelledby="closed-positions" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="closed-positions"
          className="text-lg font-semibold tracking-tight text-white"
        >
          Closed positions
          <span className="ml-2 text-sm font-normal text-gray-500">
            {rows.length}
          </span>
        </h2>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-4 py-10 text-center text-sm text-gray-400">
          No closed trades yet — resolve a position from the{' '}
          <Link
            href="/portfolio"
            className="text-emerald-300 underline-offset-2 hover:underline"
          >
            portfolio
          </Link>{' '}
          page to see it here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800 bg-gray-900/40">
          <table className="min-w-full divide-y divide-gray-800 text-sm">
            <thead className="bg-gray-900/60 text-left text-[11px] uppercase tracking-wider text-gray-400">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Market
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Outcome
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Stake
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Entry
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Result
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  P&L
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-200">
              {rows.map((p) => (
                <tr key={p.id} className="transition hover:bg-gray-900/60">
                  <td className="px-4 py-3">
                    <span
                      className="line-clamp-2 max-w-md font-medium text-gray-100"
                      title={p.marketTitle}
                    >
                      {p.marketTitle}
                    </span>
                    {p.resolvedAt ? (
                      <span className="mt-0.5 block text-[11px] text-gray-500">
                        {new Date(p.resolvedAt).toLocaleString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeBadge outcome={p.outcome} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCurrency(p.stake)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                    {formatPercent(p.price)}
                  </td>
                  <td className="px-4 py-3">
                    <ResultBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span
                      className={cn(
                        'font-semibold',
                        (p.profit ?? 0) > 0 && 'text-emerald-300',
                        (p.profit ?? 0) < 0 && 'text-rose-300',
                        (p.profit ?? 0) === 0 && 'text-gray-300',
                      )}
                    >
                      {formatProfit(p.profit ?? 0)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const yes = outcome === 'YES'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1',
        yes
          ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
          : 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
      )}
    >
      {outcome}
    </span>
  )
}

function ResultBadge({ status }: { status: BankrollPosition['status'] }) {
  if (status === 'won') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-200 ring-1 ring-emerald-400/30">
        Win
      </span>
    )
  }
  if (status === 'lost') {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-200 ring-1 ring-rose-400/30">
        Loss
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-700/30 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-300 ring-1 ring-gray-500/30">
      Open
    </span>
  )
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

function toEquityData(history: BankrollHistoryPoint[]): EquityPoint[] {
  return history.map((point) => ({
    timestamp: point.timestamp,
    label: formatHHmm(point.timestamp),
    balance: point.balance,
  }))
}

function formatHHmm(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function computeYDomain(
  data: EquityPoint[],
  startingBalance: number,
): [number, number] {
  if (data.length === 0) {
    return [startingBalance * 0.9, startingBalance * 1.1]
  }
  let min = Infinity
  let max = -Infinity
  for (const p of data) {
    if (p.balance < min) min = p.balance
    if (p.balance > max) max = p.balance
  }
  min = Math.min(min, startingBalance)
  max = Math.max(max, startingBalance)
  const range = Math.max(max - min, startingBalance * 0.1, 1)
  const pad = range * 0.15
  return [Math.max(0, min - pad), max + pad]
}

function computeStats(
  closed: BankrollPosition[],
  open: BankrollPosition[],
  cashBalance: number,
  startingBalance: number,
): ClosedStats {
  const totalTrades = closed.length + open.length
  const totalClosed = closed.length
  const wins = closed.filter((p) => p.status === 'won').length
  const losses = closed.filter((p) => p.status === 'lost').length
  const winRate = totalClosed > 0 ? wins / totalClosed : 0

  // Realised return = cash − starting. Open positions are intentionally
  // excluded so the headline number lines up with the equity curve.
  const totalPnL = Math.round((cashBalance - startingBalance) * 100) / 100
  const totalReturnPct =
    startingBalance > 0 ? (cashBalance - startingBalance) / startingBalance : 0

  const allStakes = [...closed, ...open].map((p) => p.stake)
  const totalStaked = round2(allStakes.reduce((s, n) => s + n, 0))
  const avgStake = allStakes.length > 0 ? round2(totalStaked / allStakes.length) : 0

  const profits = closed.map((p) => p.profit ?? 0)
  const bestWin = profits.length > 0 ? Math.max(...profits) : 0
  const worstLoss = profits.length > 0 ? Math.min(...profits) : 0

  return {
    totalTrades,
    totalClosed,
    wins,
    losses,
    winRate,
    totalPnL,
    totalReturnPct,
    totalStaked,
    avgStake,
    bestWin: round2(bestWin),
    worstLoss: round2(worstLoss),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
