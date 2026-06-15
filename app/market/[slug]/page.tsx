'use client'

/**
 * Market detail page — `/market/[slug]`.
 *
 * Loads a single market via `fetchMarketBySlug` (TanStack Query), derives a
 * one-off `TradeSignal` for it via `buildSignals([market])[0]`, and renders:
 *
 *   - Header (title, category, expiry countdown)
 *   - Big YES/NO odds split
 *   - Stats row (24h volume, liquidity, days to expiry)
 *   - Price-history chart container with a graceful empty state
 *     (`Market.priceHistory` is currently always empty — known gap)
 *   - Signal panel (full SignalCard) + a top-level "Place Bet" button
 *
 * Works on direct deeplinks because everything that touches the URL lives
 * inside a `useParams()`-driven client component.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'

import { MarketCardSkeleton } from '@/components/markets/MarketCard'
import { SignalCard } from '@/components/signals/SignalCard'
import { TradeModal } from '@/components/signals/TradeModal'
import { fetchMarketBySlug } from '@/lib/polymarket'
import { buildSignals, type TradeSignal } from '@/lib/signals'
import {
  cn,
  DAY_MS,
  FIVE_MINUTES_MS,
  formatCurrency,
  formatPercent,
  formatTimeUntilExpiry,
  formatVolume,
  timeUntilExpiry,
} from '@/lib/utils'
import type { Market } from '@/lib/types'

export default function MarketDetailPage() {
  const params = useParams<{ slug: string }>()
  const router = useRouter()
  const slug = typeof params?.slug === 'string' ? params.slug : ''

  const { data: market, isLoading, isError, error } = useQuery<Market | null, Error>({
    queryKey: ['market', slug],
    queryFn: ({ signal }) => fetchMarketBySlug(slug, signal),
    enabled: slug.length > 0,
    staleTime: FIVE_MINUTES_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  })

  const signal = useMemo<TradeSignal | undefined>(
    () => (market ? buildSignals([market])[0] : undefined),
    [market],
  )

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-gray-400 transition hover:bg-gray-800/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
      >
        <span aria-hidden>←</span> Back
      </button>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={error?.message ?? 'Failed to load market.'} />
      ) : !market ? (
        <NotFoundState slug={slug} />
      ) : (
        <LoadedView market={market} signal={signal} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loaded view
// ---------------------------------------------------------------------------

function LoadedView({
  market,
  signal,
}: {
  market: Market
  signal: TradeSignal | undefined
}) {
  const [tradeOpen, setTradeOpen] = useState(false)

  const yes = clampProb(market.yesPrice)
  const no = clampProb(
    Number.isFinite(market.noPrice) ? market.noPrice : 1 - yes,
  )

  return (
    <>
      <Header market={market} />
      <OddsSplit yes={yes} no={no} />
      <StatsRow market={market} />
      <PriceHistorySection priceHistory={market.priceHistory} />
      <SignalPanel
        signal={signal}
        onPlaceBet={() => setTradeOpen(true)}
      />

      {signal ? (
        <TradeModal
          signal={signal}
          open={tradeOpen}
          onClose={() => setTradeOpen(false)}
        />
      ) : null}
    </>
  )
}

function Header({ market }: { market: Market }) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-gray-700/80 bg-gray-800/60 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-300">
          {market.category || 'Uncategorised'}
        </span>
        <span className={cn('text-xs font-medium', timeBadgeTone(market.endDate))}>
          {formatTimeUntilExpiry(market.endDate)}
        </span>
        {market.resolvedOutcome ? (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1',
              market.resolvedOutcome === 'YES'
                ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30'
                : 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
            )}
          >
            Resolved {market.resolvedOutcome}
          </span>
        ) : null}
      </div>

      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-white sm:text-3xl">
        {market.title}
      </h1>
    </header>
  )
}

function OddsSplit({ yes, no }: { yes: number; no: number }) {
  return (
    <section
      aria-label="Current odds"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <OddsTile outcome="YES" probability={yes} />
      <OddsTile outcome="NO" probability={no} />
    </section>
  )
}

function OddsTile({
  outcome,
  probability,
}: {
  outcome: 'YES' | 'NO'
  probability: number
}) {
  const isYes = outcome === 'YES'
  return (
    <div
      className={cn(
        'rounded-xl border p-5',
        isYes
          ? 'border-emerald-400/30 bg-emerald-500/10'
          : 'border-rose-400/30 bg-rose-500/10',
      )}
    >
      <p
        className={cn(
          'text-xs font-semibold uppercase tracking-wider',
          isYes ? 'text-emerald-300/90' : 'text-rose-300/90',
        )}
      >
        {outcome}
      </p>
      <p
        className={cn(
          'mt-1 text-4xl font-bold tabular-nums tracking-tight',
          isYes ? 'text-emerald-200' : 'text-rose-200',
        )}
      >
        {formatPercent(probability, 1)}
      </p>
      <p className="mt-1 text-xs text-gray-400">
        Market price · {probability.toFixed(3)}
      </p>
    </div>
  )
}

function StatsRow({ market }: { market: Market }) {
  const ms = timeUntilExpiry(market.endDate)
  const daysLeft =
    Number.isFinite(ms) && ms > 0 ? Math.max(0, Math.ceil(ms / DAY_MS)) : 0

  return (
    <section
      aria-label="Market stats"
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
    >
      <Stat label="24h Volume" value={formatVolume(market.volume24h)} />
      <Stat label="Liquidity" value={formatCurrency(market.liquidity)} />
      <Stat
        label="Days to expiry"
        value={daysLeft > 0 ? String(daysLeft) : '—'}
        hint={daysLeft > 0 ? formatTimeUntilExpiry(market.endDate) : 'Expired'}
      />
    </section>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-white">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p>
      ) : null}
    </div>
  )
}

function PriceHistorySection({
  priceHistory,
}: {
  priceHistory: Market['priceHistory']
}) {
  const hasData = Array.isArray(priceHistory) && priceHistory.length > 1

  return (
    <section
      aria-labelledby="price-history-heading"
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h2
          id="price-history-heading"
          className="text-lg font-semibold tracking-tight text-white"
        >
          Price history
        </h2>
        <p className="text-xs text-gray-500">YES probability over time</p>
      </div>

      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-gray-800 bg-gray-900/30 px-6 text-center">
        {hasData ? (
          // Reserved for when the proxy starts populating `priceHistory` from
          // the CLOB endpoint — the empty path is the live one for now.
          <p className="text-sm text-gray-400">
            Chart rendering pending CLOB integration.
          </p>
        ) : (
          <p className="max-w-sm text-sm text-gray-500">
            Price history unavailable — no CLOB data in current API tier.
          </p>
        )}
      </div>
    </section>
  )
}

function SignalPanel({
  signal,
  onPlaceBet,
}: {
  signal: TradeSignal | undefined
  onPlaceBet: () => void
}) {
  return (
    <section aria-labelledby="signal-heading" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2
          id="signal-heading"
          className="text-lg font-semibold tracking-tight text-white"
        >
          Trade signal
        </h2>
        {signal ? (
          <p className="text-xs text-gray-500">
            Kelly-sized for a £1,000 bankroll
          </p>
        ) : null}
      </div>

      {signal ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <div className="flex-shrink-0">
            <SignalCard signal={signal} />
          </div>
          <div className="flex flex-1 flex-col justify-center rounded-xl border border-gray-800 bg-gray-900/40 p-5">
            <p className="text-sm text-gray-300">
              Our model gives this market a positive expected value of{' '}
              <span className="font-semibold text-emerald-300">
                {formatCurrency(signal.expectedValue)}
              </span>{' '}
              on a {formatCurrency(signal.suggestedStake)} stake. Click below
              to place a paper trade — the modal lets you override the stake
              before confirming.
            </p>
            <button
              type="button"
              onClick={onPlaceBet}
              className="mt-4 inline-flex items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-gray-950 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
            >
              Place Bet
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/30 px-4 py-6 text-center text-sm text-gray-500">
          No signal detected for this market — edge too small or liquidity
          too thin under the current model.
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Non-loaded states
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4">
        <MarketCardSkeleton />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            aria-hidden
            className="h-20 animate-pulse rounded-xl border border-gray-800 bg-gray-900/40"
          />
        ))}
      </div>
      <div
        aria-hidden
        className="h-64 animate-pulse rounded-xl border border-gray-800 bg-gray-900/40"
      />
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-6 py-16 text-center">
      <p className="text-base font-medium text-rose-200">
        Couldn&apos;t load this market
      </p>
      <p className="max-w-md text-sm text-rose-200/70">{message}</p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-md border border-rose-400/40 bg-rose-500/10 px-4 py-1.5 text-sm font-medium text-rose-100 transition hover:bg-rose-500/20"
      >
        Back to dashboard
      </Link>
    </div>
  )
}

function NotFoundState({ slug }: { slug: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-6 py-16 text-center">
      <p className="text-base font-medium text-gray-200">Market not found</p>
      <p className="max-w-md text-sm text-gray-400">
        {slug
          ? `No active or closed Polymarket market matches the slug "${slug}". It may have been removed upstream, or the link is mistyped.`
          : 'No market slug was provided.'}
      </p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-md border border-gray-700 bg-gray-800/60 px-4 py-1.5 text-sm font-medium text-gray-200 transition hover:border-gray-600 hover:text-white"
      >
        Back to dashboard
      </Link>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  if (p < 0) return 0
  if (p > 1) return 1
  return p
}

function timeBadgeTone(endDate: string): string {
  if (!endDate) return 'text-gray-400'
  const ms = new Date(endDate).getTime() - Date.now()
  if (ms <= 0) return 'text-gray-500'
  if (ms < DAY_MS) return 'text-amber-400'
  if (ms < 3 * DAY_MS) return 'text-amber-300/80'
  return 'text-gray-400'
}
