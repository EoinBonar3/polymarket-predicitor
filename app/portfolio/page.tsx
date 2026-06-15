'use client'

/**
 * Portfolio — the paper-trading account view.
 *
 * Reads bankroll state straight from the Zustand store and joins each open
 * position against the live markets list (via `useMarkets`) so we can show
 * mark-to-market price and unrealised P&L.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'

import { useMarkets } from '@/hooks/useMarkets'
import { cn, formatCurrency, formatPercent, formatProfit } from '@/lib/utils'
import { useBankrollStore, type BankrollPosition } from '@/store/bankroll'
import type { Market, Outcome } from '@/lib/types'

interface MarkedPosition {
  position: BankrollPosition
  currentPrice: number | null
  currentValue: number
  unrealisedPnL: number
  unrealisedPnLPct: number
}

export default function PortfolioPage() {
  const balance = useBankrollStore((s) => s.balance)
  const startingBalance = useBankrollStore((s) => s.startingBalance)
  const openPositions = useBankrollStore((s) => s.openPositions)
  const closedPositions = useBankrollStore((s) => s.closedPositions)
  const resetBankroll = useBankrollStore((s) => s.resetBankroll)

  const { data: markets } = useMarkets()
  const marketsById = useMemo(() => indexById(markets ?? []), [markets])

  const marked = useMemo(
    () => openPositions.map((p) => markPosition(p, marketsById.get(p.marketId))),
    [openPositions, marketsById],
  )

  const portfolioValue = useMemo(
    () =>
      Math.round(
        (balance + marked.reduce((sum, m) => sum + m.currentValue, 0)) * 100,
      ) / 100,
    [balance, marked],
  )

  const totalPnL = Math.round((portfolioValue - startingBalance) * 100) / 100
  const totalTrades = openPositions.length + closedPositions.length

  function onReset() {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        'Reset bankroll? This will clear all open and closed positions and restore your starting balance.',
      )
      if (!ok) return
    }
    resetBankroll()
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Portfolio
          </h1>
          <p className="text-sm text-gray-400">
            Paper-traded positions, mark-to-market against live Polymarket
            prices.
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="self-start rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20 sm:self-auto"
        >
          Reset bankroll
        </button>
      </header>

      <BankrollSummary
        balance={balance}
        startingBalance={startingBalance}
        portfolioValue={portfolioValue}
        totalPnL={totalPnL}
        totalTrades={totalTrades}
      />

      <section aria-labelledby="open-positions" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2
            id="open-positions"
            className="text-lg font-semibold tracking-tight text-white"
          >
            Open positions
            <span className="ml-2 text-sm font-normal text-gray-500">
              {marked.length}
            </span>
          </h2>
        </div>

        {marked.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-4 py-12 text-center">
            <p className="text-sm font-medium text-gray-200">
              No open positions yet
            </p>
            <p className="mt-1 text-sm text-gray-400">
              Head to the{' '}
              <Link
                href="/dashboard"
                className="text-emerald-300 underline-offset-2 hover:underline"
              >
                dashboard
              </Link>{' '}
              and place your first paper trade from a signal.
            </p>
          </div>
        ) : (
          <PositionsTable rows={marked} />
        )}
      </section>
    </div>
  )
}

function BankrollSummary({
  balance,
  startingBalance,
  portfolioValue,
  totalPnL,
  totalTrades,
}: {
  balance: number
  startingBalance: number
  portfolioValue: number
  totalPnL: number
  totalTrades: number
}) {
  const pnlPct = startingBalance > 0 ? totalPnL / startingBalance : 0

  return (
    <section
      aria-label="Bankroll summary"
      className="grid grid-cols-2 gap-3 rounded-xl border border-gray-800 bg-gray-900/60 p-4 sm:grid-cols-4"
    >
      <SummaryStat label="Starting" value={formatCurrency(startingBalance)} />
      <SummaryStat
        label="Cash"
        value={formatCurrency(balance)}
        hint="Available to bet"
      />
      <SummaryStat
        label="Portfolio value"
        value={formatCurrency(portfolioValue)}
        hint="Cash + mark-to-market"
      />
      <SummaryStat
        label="Total P&L"
        value={formatProfit(totalPnL)}
        hint={`${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}% · ${totalTrades} trade${totalTrades === 1 ? '' : 's'}`}
        tone={totalPnL > 0 ? 'positive' : totalPnL < 0 ? 'negative' : 'neutral'}
      />
    </section>
  )
}

function SummaryStat({
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
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'positive' && 'text-emerald-300',
          tone === 'negative' && 'text-rose-300',
          tone === 'neutral' && 'text-white',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p> : null}
    </div>
  )
}

function PositionsTable({ rows }: { rows: MarkedPosition[] }) {
  return (
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
            <th scope="col" className="px-4 py-3 font-medium text-right">
              Current
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              P&L
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              Resolve as
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800 text-gray-200">
          {rows.map((row) => (
            <PositionRow key={row.position.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PositionRow({ row }: { row: MarkedPosition }) {
  const { position, currentPrice, unrealisedPnL, unrealisedPnLPct } = row
  const closeBet = useBankrollStore((s) => s.closeBet)
  const [resolveAs, setResolveAs] = useState<Outcome>(position.outcome)

  const wouldWin = resolveAs === position.outcome
  const projectedProfit = wouldWin
    ? Math.round((position.potentialPayout - position.stake) * 100) / 100
    : -position.stake

  function onClose() {
    closeBet(position.id, resolveAs)
  }

  return (
    <tr className="transition hover:bg-gray-900/60">
      <td className="px-4 py-3">
        <Link
          // `BankrollPosition` carries the upstream `slug` alongside `marketId`
          // (see `store/bankroll.ts`) — the detail route is slug-based, so we
          // use that. Falls back to the dashboard for legacy positions saved
          // before the slug was tracked.
          href={position.slug ? `/market/${position.slug}` : '/dashboard'}
          className="line-clamp-2 max-w-md font-medium text-gray-100 hover:text-emerald-300"
          title={position.marketTitle}
        >
          {position.marketTitle}
        </Link>
      </td>
      <td className="px-4 py-3">
        <OutcomeBadge outcome={position.outcome} />
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatCurrency(position.stake)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-gray-400">
        {formatPercent(position.price)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {currentPrice == null ? (
          <span className="text-gray-500">—</span>
        ) : (
          formatPercent(currentPrice)
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <span
          className={cn(
            'font-semibold',
            unrealisedPnL > 0 && 'text-emerald-300',
            unrealisedPnL < 0 && 'text-rose-300',
            unrealisedPnL === 0 && 'text-gray-300',
          )}
        >
          {formatProfit(unrealisedPnL)}
        </span>
        <span className="ml-1 text-[11px] text-gray-500">
          ({unrealisedPnLPct >= 0 ? '+' : ''}
          {(unrealisedPnLPct * 100).toFixed(1)}%)
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <ResolveToggle value={resolveAs} onChange={setResolveAs} />
          <button
            type="button"
            onClick={onClose}
            title={`Close as ${resolveAs}: ${wouldWin ? '+' : ''}${formatCurrency(projectedProfit)}`}
            className={cn(
              'whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition',
              wouldWin
                ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
                : 'border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
            )}
          >
            Close
          </button>
        </div>
      </td>
    </tr>
  )
}

function ResolveToggle({
  value,
  onChange,
}: {
  value: Outcome
  onChange: (next: Outcome) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Resolve as outcome"
      className="inline-flex overflow-hidden rounded-md border border-gray-700 bg-gray-900/80 text-[11px] font-semibold"
    >
      {(['YES', 'NO'] as const).map((o) => {
        const active = value === o
        const yes = o === 'YES'
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o)}
            className={cn(
              'px-2.5 py-1 transition',
              active && yes && 'bg-emerald-500/20 text-emerald-200',
              active && !yes && 'bg-rose-500/20 text-rose-200',
              !active && 'text-gray-400 hover:text-gray-200',
            )}
          >
            {o}
          </button>
        )
      })}
    </div>
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

function indexById(markets: Market[]): Map<string, Market> {
  const map = new Map<string, Market>()
  for (const m of markets) map.set(m.id, m)
  return map
}

function markPosition(
  position: BankrollPosition,
  market: Market | undefined,
): MarkedPosition {
  const livePrice =
    market == null
      ? null
      : position.outcome === 'YES'
        ? market.yesPrice
        : market.noPrice

  // Fall back to entry price when the market isn't in the current cache —
  // showing a fake "current" would be more misleading than just hiding it.
  const refPrice =
    livePrice != null && Number.isFinite(livePrice) && livePrice > 0
      ? livePrice
      : position.price

  const currentValue = Math.round(position.shares * refPrice * 100) / 100
  const unrealisedPnL = Math.round((currentValue - position.stake) * 100) / 100
  const unrealisedPnLPct =
    position.stake > 0 ? unrealisedPnL / position.stake : 0

  return {
    position,
    currentPrice: livePrice ?? null,
    currentValue,
    unrealisedPnL,
    unrealisedPnLPct,
  }
}
