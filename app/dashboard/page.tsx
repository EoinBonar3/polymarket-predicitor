'use client'

/**
 * Dashboard — the markets grid landing page.
 *
 * Fetches active markets via `useMarkets`, then lets the user filter by
 * category and sort by volume / liquidity / time-to-expiry without making
 * extra network requests (filtering happens client-side over the cached
 * dataset).
 */

import { useMemo, useState } from 'react'

import { MarketCard, MarketCardSkeleton } from '@/components/markets/MarketCard'
import {
  ALL_CATEGORIES,
  MarketFilters,
  type SortKey,
} from '@/components/markets/MarketFilters'
import { SignalCard } from '@/components/signals/SignalCard'
import { useMarkets } from '@/hooks/useMarkets'
import { buildSignals, type TradeSignal } from '@/lib/signals'
import { timeUntilExpiry } from '@/lib/utils'
import type { Market } from '@/lib/types'

const MAX_SIGNALS = 12
const SIGNAL_SKELETON_COUNT = 4
const SKELETON_COUNT = 8

export default function DashboardPage() {
  const [category, setCategory] = useState<string>(ALL_CATEGORIES)
  const [sort, setSort] = useState<SortKey>('volume_24hr')

  const { data, isLoading, isError, error, refetch, isFetching } = useMarkets()

  const filteredAndSorted = useMemo(
    () => sortMarkets(filterMarkets(data ?? [], category), sort),
    [data, category, sort],
  )

  const signals = useMemo(
    () => buildSignals(data ?? []).slice(0, MAX_SIGNALS),
    [data],
  )

  return (
    <div className="space-y-6">
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
      >
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border border-amber-300/60 text-[11px] font-bold text-amber-200"
        >
          !
        </span>
        <p className="leading-relaxed">
          This is a paper trading simulator for educational purposes only. Not
          financial advice.
        </p>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Active Markets
        </h1>
        <p className="text-sm text-gray-400">
          Live Polymarket prediction markets, updated every 5 minutes.
          {isFetching && !isLoading ? (
            <span className="ml-2 text-emerald-300/80">Refreshing…</span>
          ) : null}
        </p>
      </header>

      <SignalsSection
        signals={signals}
        isLoading={isLoading}
        hasMarkets={(data ?? []).length > 0}
      />

      <MarketFilters
        markets={data ?? []}
        category={category}
        sort={sort}
        onCategoryChange={setCategory}
        onSortChange={setSort}
      />

      {isLoading ? (
        <MarketGrid>
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <MarketCardSkeleton key={i} />
          ))}
        </MarketGrid>
      ) : isError ? (
        <ErrorState
          message={error?.message ?? 'Failed to load markets.'}
          onRetry={() => refetch()}
        />
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState category={category} />
      ) : (
        <MarketGrid>
          {filteredAndSorted.map((m) => (
            <MarketCard key={m.id} market={m} />
          ))}
        </MarketGrid>
      )}
    </div>
  )
}

function SignalsSection({
  signals,
  isLoading,
  hasMarkets,
}: {
  signals: TradeSignal[]
  isLoading: boolean
  hasMarkets: boolean
}) {
  return (
    <section aria-labelledby="signals-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="signals-heading"
          className="text-lg font-semibold tracking-tight text-white"
        >
          Signals
        </h2>
        <p className="text-xs text-gray-500">
          Ranked by expected value · Kelly-sized for a £1,000 bankroll
        </p>
      </div>

      {isLoading ? (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {Array.from({ length: SIGNAL_SKELETON_COUNT }).map((_, i) => (
            <SignalCardSkeleton key={i} />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-4 py-6 text-center text-sm text-gray-400">
          {hasMarkets
            ? 'No edges meet the threshold right now. Check back after the next refresh.'
            : 'Waiting for live market data…'}
        </div>
      ) : (
        <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2">
          {signals.map((signal) => (
            <div key={signal.marketId} className="snap-start">
              <SignalCard signal={signal} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SignalCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-[178px] min-w-[280px] max-w-[320px] animate-pulse flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900/60 p-4"
    >
      <div className="flex items-center justify-between">
        <div className="h-4 w-20 rounded-full bg-gray-800" />
        <div className="h-3 w-12 rounded-full bg-gray-800" />
      </div>
      <div className="space-y-2">
        <div className="h-3.5 w-11/12 rounded bg-gray-800" />
        <div className="h-3.5 w-8/12 rounded bg-gray-800" />
      </div>
      <div className="mt-auto flex items-end justify-between">
        <div className="space-y-1">
          <div className="h-2.5 w-10 rounded bg-gray-800" />
          <div className="h-4 w-12 rounded bg-gray-800" />
        </div>
        <div className="space-y-1 text-right">
          <div className="ml-auto h-2.5 w-12 rounded bg-gray-800" />
          <div className="ml-auto h-4 w-14 rounded bg-gray-800" />
        </div>
      </div>
      <div className="h-8 rounded-md bg-gray-800" />
    </div>
  )
}

function MarketGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  )
}

function EmptyState({ category }: { category: string }) {
  const isFiltered = category && category !== ALL_CATEGORIES
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-6 py-16 text-center">
      <p className="text-base font-medium text-gray-200">No markets found</p>
      <p className="max-w-md text-sm text-gray-400">
        {isFiltered
          ? `Nothing matches the "${category}" category right now. Try clearing the filter.`
          : 'Polymarket returned no active markets. This is usually transient — try refreshing in a minute.'}
      </p>
    </div>
  )
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 px-6 py-16 text-center">
      <p className="text-base font-medium text-rose-200">
        Couldn&apos;t load markets
      </p>
      <p className="max-w-md text-sm text-rose-200/70">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-md border border-rose-400/40 bg-rose-500/10 px-4 py-1.5 text-sm font-medium text-rose-100 transition hover:bg-rose-500/20"
      >
        Retry
      </button>
    </div>
  )
}

function filterMarkets(markets: Market[], category: string): Market[] {
  if (!category || category === ALL_CATEGORIES) return markets
  return markets.filter((m) => m.category === category)
}

function sortMarkets(markets: Market[], sort: SortKey): Market[] {
  const sorted = [...markets]
  switch (sort) {
    case 'liquidity':
      sorted.sort((a, b) => b.liquidity - a.liquidity)
      break
    case 'ending_soon':
      sorted.sort((a, b) => {
        const aMs = timeUntilExpiry(a.endDate)
        const bMs = timeUntilExpiry(b.endDate)
        const aValid = Number.isFinite(aMs) && aMs > 0
        const bValid = Number.isFinite(bMs) && bMs > 0
        if (aValid && !bValid) return -1
        if (!aValid && bValid) return 1
        return aMs - bMs
      })
      break
    case 'volume_24hr':
    default:
      sorted.sort((a, b) => b.volume24h - a.volume24h)
      break
  }
  return sorted
}
