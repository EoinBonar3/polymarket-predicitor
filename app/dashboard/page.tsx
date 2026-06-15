'use client'

/**
 * Dashboard — the markets grid landing page.
 *
 * Fetches active markets via `useMarkets`, then runs them through
 * `useOddsSignals` which:
 *   - matches each market against current Odds API bookmaker odds, and
 *   - falls back to the structural blender (`lib/signals.ts::buildSignals`)
 *     for anything that didn't match an event.
 *
 * Odds API fetches are MANUAL — the hook auto-fetches once on the first
 * cache-cold visit, then never again unless the user clicks the
 * "Refresh signals" button. The bookmaker odds, sports list, and
 * `lastUpdatedAt` timestamp all persist in localStorage so reopening the
 * dashboard later (or after a hard refresh) costs zero credits. See
 * `hooks/useOddsSignals.ts` for the rationale and budget math.
 *
 * The signals row shows a small "Odds API: {n} remaining" chip and a
 * warning banner when the monthly quota gets tight.
 */

import { useEffect, useMemo, useState } from 'react'

import { MarketCard, MarketCardSkeleton } from '@/components/markets/MarketCard'
import {
  ALL_CATEGORIES,
  MarketFilters,
  type SortKey,
} from '@/components/markets/MarketFilters'
import { SignalCard } from '@/components/signals/SignalCard'
import { useMarkets } from '@/hooks/useMarkets'
import { QUOTA_HARD_FLOOR, useOddsSignals } from '@/hooks/useOddsSignals'
import { buildSignals, type SignalDebugEvaluation } from '@/lib/signals'
import { cn, formatRelativeTime, timeUntilExpiry } from '@/lib/utils'
import type { Market, TradeSignal } from '@/lib/types'

/** Quota level below which we surface an inline warning banner. */
const QUOTA_WARNING_THRESHOLD = 50

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

  const {
    oddsSignals,
    isLoading: signalsLoading,
    isFetching: signalsFetching,
    quotaRemaining,
    lastUpdatedAt,
    refresh: refreshSignals,
    canRefresh,
  } = useOddsSignals(data ?? [])
  const signals = useMemo(
    () => oddsSignals.slice(0, MAX_SIGNALS),
    [oddsSignals],
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
        markets={data ?? []}
        isLoading={isLoading || signalsLoading}
        isFetching={signalsFetching}
        hasMarkets={(data ?? []).length > 0}
        quotaRemaining={quotaRemaining}
        lastUpdatedAt={lastUpdatedAt}
        onRefresh={refreshSignals}
        canRefresh={canRefresh}
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
  markets,
  isLoading,
  isFetching,
  hasMarkets,
  quotaRemaining,
  lastUpdatedAt,
  onRefresh,
  canRefresh,
}: {
  signals: TradeSignal[]
  markets: Market[]
  isLoading: boolean
  isFetching: boolean
  hasMarkets: boolean
  quotaRemaining: number | null
  lastUpdatedAt: number | null
  onRefresh: () => void
  canRefresh: boolean
}) {
  // Defer rendering anything that depends on localStorage-seeded state
  // until after the first client commit. `useOddsSignals` reads cached
  // events synchronously in a `useState` initializer, which makes
  // `lastUpdatedAt` null on the server but populated during the very
  // first client render — that produces a "<span> not on server, but on
  // client" structural hydration mismatch that `suppressHydrationWarning`
  // can't fix (it only covers text-content drift, not element existence).
  const [hydrated, setHydrated] = useState(false)
  const [debugMode, setDebugMode] = useState(false)
  const [marketPipelineDebug, setMarketPipelineDebug] = useState<{
    mappedBeforeFilter: number
    activeAfterFilter: number
    filteredCount: number
  } | null>(null)

  useEffect(() => {
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!debugMode) return
    let cancelled = false
    void fetch('/api/markets')
      .then(async (res) => {
        const body = (await res.json()) as {
          debug?: {
            mappedBeforeFilter: number
            activeAfterFilter: number
            filteredCount: number
          }
        }
        if (cancelled) return
        const fromBody = body.debug
        const fromHeaders = {
          mappedBeforeFilter: Number(res.headers.get('X-Markets-Mapped-Count')),
          activeAfterFilter: Number(res.headers.get('X-Markets-Active-Count')),
          filteredCount: Number(res.headers.get('X-Markets-Filtered-Count')),
        }
        setMarketPipelineDebug(
          fromBody ??
            (Number.isFinite(fromHeaders.activeAfterFilter)
              ? fromHeaders
              : null),
        )
      })
      .catch((err) => console.error('[dashboard] market debug fetch failed:', err))
    return () => {
      cancelled = true
    }
  }, [debugMode, markets.length])

  const structuralDebug = useMemo(() => {
    if (!debugMode || markets.length === 0) return []
    return buildSignals(markets, { debug: true })
  }, [debugMode, markets])

  const qualifiedCount = useMemo(
    () => structuralDebug.filter((row) => row.qualified).length,
    [structuralDebug],
  )

  return (
    <section aria-labelledby="signals-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2
            id="signals-heading"
            className="text-lg font-semibold tracking-tight text-white"
          >
            Signals
          </h2>
          <p className="text-xs text-gray-500">
            Ranked by EV · refreshes only when you press the button
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hydrated && lastUpdatedAt != null ? (
            <span className="text-[11px] text-gray-500" suppressHydrationWarning>
              Updated {formatRelativeTime(lastUpdatedAt)}
            </span>
          ) : null}
          <DebugModeToggle
            enabled={hydrated && debugMode}
            onChange={setDebugMode}
          />
          <RefreshButton
            onClick={onRefresh}
            isFetching={hydrated && isFetching}
            canRefresh={!hydrated || canRefresh}
            quotaRemaining={hydrated ? quotaRemaining : null}
          />
          {hydrated && quotaRemaining != null ? (
            <QuotaChip remaining={quotaRemaining} />
          ) : null}
        </div>
      </div>

      {hydrated && debugMode ? (
        <SignalDebugPanel
          marketPipelineDebug={marketPipelineDebug}
          evaluations={structuralDebug}
          qualifiedCount={qualifiedCount}
          feedCount={markets.length}
        />
      ) : null}

      {hydrated &&
      quotaRemaining != null &&
      quotaRemaining < QUOTA_WARNING_THRESHOLD ? (
        <QuotaWarningBanner remaining={quotaRemaining} />
      ) : null}

      {isLoading ? (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {Array.from({ length: SIGNAL_SKELETON_COUNT }).map((_, i) => (
            <SignalCardSkeleton key={i} />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 bg-gray-900/40 px-4 py-6 text-center text-sm text-gray-400">
          {hasMarkets
            ? 'No edges meet the threshold right now. Press "Refresh signals" to fetch fresh bookmaker odds.'
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

function DebugModeToggle({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      title="Show structural signal pipeline rejections (console logs matcher + blender too)"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide transition',
        enabled
          ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
          : 'border-gray-700 bg-gray-900/60 text-gray-400 hover:border-gray-600 hover:text-gray-200',
      )}
    >
      Debug Mode
    </button>
  )
}

function SignalDebugPanel({
  marketPipelineDebug,
  evaluations,
  qualifiedCount,
  feedCount,
}: {
  marketPipelineDebug: {
    mappedBeforeFilter: number
    activeAfterFilter: number
    filteredCount: number
  } | null
  evaluations: SignalDebugEvaluation[]
  qualifiedCount: number
  feedCount: number
}) {
  const rejectionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of evaluations) {
      if (row.qualified || !row.rejectionCategory) continue
      counts.set(
        row.rejectionCategory,
        (counts.get(row.rejectionCategory) ?? 0) + 1,
      )
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [evaluations])

  return (
    <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-violet-100">
          Signal pipeline debug
        </h3>
        <p className="text-[11px] text-violet-200/70">
          Path B (structural) · check Console for Path A matcher + blender logs
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
        <DebugStat
          label="API mapped (pre-filter)"
          value={marketPipelineDebug?.mappedBeforeFilter ?? '—'}
        />
        <DebugStat
          label="API active (post-filter)"
          value={marketPipelineDebug?.activeAfterFilter ?? '—'}
        />
        <DebugStat label="Client feed" value={feedCount} />
        <DebugStat
          label="Structural qualified"
          value={`${qualifiedCount} / ${evaluations.length}`}
        />
      </dl>

      {rejectionCounts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {rejectionCounts.map(([reason, count]) => (
            <span
              key={reason}
              className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-200"
            >
              {reason}: {count}
            </span>
          ))}
        </div>
      ) : null}

      <div className="max-h-96 overflow-auto rounded-lg border border-violet-500/20">
        <table className="min-w-full divide-y divide-violet-500/20 text-left text-[11px]">
          <thead className="sticky top-0 bg-gray-950/95 text-[10px] uppercase tracking-wider text-violet-200/80">
            <tr>
              <th className="px-2 py-2 font-medium">Market</th>
              <th className="px-2 py-2 font-medium">YES</th>
              <th className="px-2 py-2 font-medium">ourP</th>
              <th className="px-2 py-2 font-medium">Edge</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Why rejected</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-violet-500/10 text-gray-200">
            {evaluations.map((row) => (
              <tr
                key={row.marketId}
                className={cn(
                  row.qualified ? 'bg-emerald-500/5' : 'bg-transparent',
                )}
              >
                <td className="max-w-[200px] px-2 py-1.5">
                  <span className="line-clamp-2" title={row.title}>
                    {row.title}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                  {(row.yesPrice * 100).toFixed(1)}%
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                  {row.ourProbability != null
                    ? `${(row.ourProbability * 100).toFixed(1)}%`
                    : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                  {row.edgePct != null
                    ? `${row.edgePct >= 0 ? '+' : ''}${row.edgePct.toFixed(1)}%`
                    : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {row.qualified ? (
                    <span className="text-emerald-300">qualified</span>
                  ) : (
                    <span className="text-rose-300/90">rejected</span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {row.qualified ? (
                    <span className="text-gray-500">—</span>
                  ) : (
                    <div className="space-y-0.5">
                      {row.rejectionCategory ? (
                        <span className="font-medium text-violet-200/90">
                          {row.rejectionCategory}
                        </span>
                      ) : null}
                      <p className="text-gray-400 leading-snug">
                        {row.rejectionReason ?? '—'}
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DebugStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-violet-500/20 bg-gray-950/40 px-2 py-1.5">
      <dt className="text-violet-200/60">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-violet-100">
        {value}
      </dd>
    </div>
  )
}

function RefreshButton({
  onClick,
  isFetching,
  canRefresh,
  quotaRemaining,
}: {
  onClick: () => void
  isFetching: boolean
  canRefresh: boolean
  quotaRemaining: number | null
}) {
  const disabled = !canRefresh || isFetching
  // Tooltip changes based on WHY the button is disabled — quota or in-flight.
  const title =
    quotaRemaining != null && quotaRemaining < QUOTA_HARD_FLOOR
      ? `Odds API quota too low (${quotaRemaining} left). Wait for next month's reset.`
      : isFetching
        ? 'Fetching fresh bookmaker odds…'
        : 'Fetch fresh bookmaker odds. Costs ~5 Odds API credits per click.'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide transition',
        disabled
          ? 'cursor-not-allowed border-gray-800 bg-gray-900/60 text-gray-500'
          : 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 focus:outline-none focus:ring-2 focus:ring-emerald-400/40',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-3 w-3 rounded-full border-2 border-current border-r-transparent',
          isFetching ? 'animate-spin' : 'opacity-60',
        )}
      />
      {isFetching ? 'Refreshing…' : 'Refresh signals'}
    </button>
  )
}

function QuotaChip({ remaining }: { remaining: number }) {
  // Green > 200 (plenty), amber 50–200 (running low), red < 50 (critical).
  const tone =
    remaining > 200
      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
      : remaining >= QUOTA_WARNING_THRESHOLD
        ? 'border-amber-400/40 bg-amber-500/10 text-amber-200'
        : 'border-rose-400/40 bg-rose-500/10 text-rose-200'

  return (
    <span
      title="The Odds API monthly quota remaining"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide tabular-nums',
        tone,
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      Odds API: {remaining} remaining
    </span>
  )
}

function QuotaWarningBanner({ remaining }: { remaining: number }) {
  const critical = remaining < QUOTA_HARD_FLOOR
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]',
        critical
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-100',
      )}
    >
      <span aria-hidden className="mt-0.5 text-xs">⚠</span>
      <p>
        {critical ? (
          <>
            Odds API quota almost exhausted — only <strong>{remaining}</strong>{' '}
            credits left this month. Refresh is disabled until the monthly
            reset. Structural signals will continue to work.
          </>
        ) : (
          <>
            Only <strong>{remaining}</strong> Odds API credits left this month.
            Each refresh burns ~5 credits — use sparingly.
          </>
        )}
      </p>
    </div>
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
