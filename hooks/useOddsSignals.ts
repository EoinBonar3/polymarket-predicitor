'use client'

/**
 * Combined sports-bookmaker + structural signal feed — MANUAL-REFRESH mode.
 *
 * Why "manual": the Odds API free tier is 500 requests/month. Auto-polling
 * (the previous 5-minute interval × 5 sports) burns 60 requests/hour and
 * blows the budget in ~8 hours of dashboard time. This hook is now
 * fire-once-then-stay-quiet:
 *
 *   1. Load the list of currently-active, Polymarket-relevant sports
 *      (cached forever in memory + localStorage; never auto-refreshed).
 *   2. Fetch h2h odds for each of those sports SEQUENTIALLY (also cached
 *      forever in memory + localStorage; never auto-refreshed).
 *   3. For every Polymarket market, try the fuzzy matcher in
 *      `lib/marketMatcher.ts`. Hits become odds-api signals; misses fall
 *      through to the existing structural blender in `lib/signals.ts`.
 *   4. Merge and sort by edge.
 *
 * The dashboard surfaces a "Refresh signals" button that calls `refresh()`
 * to explicitly invalidate the events cache. Each click costs N upstream
 * requests where N = the number of allowed sports (currently 5).
 *
 * The very first dashboard visit (when localStorage is empty) DOES fire an
 * auto-fetch so the page isn't blank — but every subsequent visit (same
 * browser, same machine) is served from the persisted cache for free.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  fetchActiveSports,
  fetchSportsOdds,
  useOddsQuotaStore,
  type OddsApiEvent,
} from '@/lib/oddsApi'
import { buildOddsTradeSignal, matchMarketToEvent } from '@/lib/marketMatcher'
import { buildSignals } from '@/lib/signals'
import { buildLearnedModel } from '@/lib/learning'
import { useBankrollStore } from '@/store/bankroll'
import type { Market, TradeSignal } from '@/lib/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on how many sports we'll fetch per refresh cycle. Each
 * sport burns one Odds API request, so each "Refresh signals" click costs
 * AT MOST this many credits. Keep it low — the free tier is 500/month.
 */
const MAX_SPORTS_PER_REFRESH = 5

/**
 * Below this quota threshold, the refresh button is hard-disabled. Picked
 * to leave some headroom for end-of-month sanity / debugging.
 */
export const QUOTA_HARD_FLOOR = 5

const SPORTS_CACHE_KEY = 'polymarket-predictor:odds-sports-cache'
const EVENTS_CACHE_KEY = 'polymarket-predictor:odds-events-cache'

// ---------------------------------------------------------------------------
// localStorage cache (SSR-safe, try/catch everywhere — persistence is a
// nice-to-have, not a hard requirement)
// ---------------------------------------------------------------------------

interface CachedSports {
  sports: string[]
  updatedAt: number
}

interface CachedEvents {
  events: OddsApiEvent[]
  updatedAt: number
}

function loadCachedSports(): CachedSports | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SPORTS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedSports>
    if (
      !parsed ||
      !Array.isArray(parsed.sports) ||
      !parsed.sports.every((s) => typeof s === 'string') ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null
    }
    return { sports: parsed.sports, updatedAt: parsed.updatedAt }
  } catch {
    return null
  }
}

function saveCachedSports(sports: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      SPORTS_CACHE_KEY,
      JSON.stringify({ sports, updatedAt: Date.now() } satisfies CachedSports),
    )
  } catch {
    // Quota / private-mode — silently degrade. Cache is best-effort.
  }
}

function loadCachedEvents(): CachedEvents | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(EVENTS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedEvents>
    if (
      !parsed ||
      !Array.isArray(parsed.events) ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null
    }
    return { events: parsed.events as OddsApiEvent[], updatedAt: parsed.updatedAt }
  } catch {
    return null
  }
}

function saveCachedEvents(events: OddsApiEvent[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      EVENTS_CACHE_KEY,
      JSON.stringify({ events, updatedAt: Date.now() } satisfies CachedEvents),
    )
  } catch {
    // Same as above.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UseOddsSignalsResult {
  oddsSignals: TradeSignal[]
  /** True only during the very first auto-fetch on a cache-empty mount. */
  isLoading: boolean
  /** True any time an upstream request is in flight (incl. manual refresh). */
  isFetching: boolean
  /** Quota-remaining from the last upstream response, null until we've seen one. */
  quotaRemaining: number | null
  /** ms-since-epoch timestamp of the last successful events fetch, null if never. */
  lastUpdatedAt: number | null
  /**
   * Explicit refetch. Burns one upstream request per sport in the active
   * list. Refuses to fire if `quotaRemaining` is below `QUOTA_HARD_FLOOR`
   * or if there's already a fetch in flight.
   */
  refresh: () => void
  /** False when the refresh button should be hard-disabled. */
  canRefresh: boolean
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

export function useOddsSignals(markets: Market[]): UseOddsSignalsResult {
  // We only read localStorage once per mount. Subsequent updates flow
  // through queryClient.setQueryData inside the queryFns so the cache
  // and React state stay in sync without re-reading from storage.
  //
  // useState-with-initializer (rather than useMemo) so the read happens
  // exactly once even under Strict Mode double-render.
  const [seededSports] = useState<CachedSports | null>(() => loadCachedSports())
  const [seededEvents] = useState<CachedEvents | null>(() => loadCachedEvents())

  // -------------------------------------------------------------------------
  // 1. Sports list — fetched once per browser, cached forever.
  // -------------------------------------------------------------------------
  const sportsQuery = useQuery({
    queryKey: ['odds', 'sports'],
    queryFn: async ({ signal }) => {
      const sports = await fetchActiveSports(signal)
      saveCachedSports(sports)
      return sports
    },
    // Persist data forever — only refetch when `refresh()` is called.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    initialData: seededSports?.sports,
    initialDataUpdatedAt: seededSports?.updatedAt,
  })

  const sportsToFetch = useMemo(() => {
    const active = sportsQuery.data ?? []
    return active.slice(0, MAX_SPORTS_PER_REFRESH)
  }, [sportsQuery.data])

  const sportsKey = sportsToFetch.join(',')

  // -------------------------------------------------------------------------
  // 2. Events — one big query that loops through sports SEQUENTIALLY.
  // -------------------------------------------------------------------------
  const eventsQuery = useQuery({
    queryKey: ['odds', 'events', sportsKey],
    queryFn: async ({ signal }) => {
      const events: OddsApiEvent[] = []
      for (const sport of sportsToFetch) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        const batch = await fetchSportsOdds(sport, signal)
        events.push(...batch)
      }
      saveCachedEvents(events)
      return events
    },
    enabled: sportsToFetch.length > 0,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
    initialData: seededEvents?.events,
    initialDataUpdatedAt: seededEvents?.updatedAt,
  })

  // -------------------------------------------------------------------------
  // First-visit auto-fetch: if there's no persisted events cache at all,
  // fire ONCE so the dashboard isn't blank on a brand-new install. Every
  // subsequent visit on the same browser uses the persisted cache.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (seededEvents != null) return
    if (sportsToFetch.length === 0) return
    if (eventsQuery.isFetching || eventsQuery.data != null) return
    void eventsQuery.refetch()
    // We intentionally depend only on the fact that the events query is
    // ready to fire — we never want this effect to re-run for any other
    // reason (otherwise it'd fire after every manual refresh too).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sportsToFetch.length, seededEvents])

  // -------------------------------------------------------------------------
  // 3 + 4. Match every market against the fetched events; structural
  //        fallback for misses; merge and sort.
  // -------------------------------------------------------------------------
  const events = eventsQuery.data ?? []

  // Closed-loop learning: rebuild the calibration model from resolved paper
  // trades whenever that history changes. The structural fallback below feeds
  // it into `buildSignals` so future bets are sized / chosen against the
  // calibrated probability rather than the raw structural nudges. Stays
  // identity until enough bets have resolved (see `lib/learning.ts`).
  const closedPositions = useBankrollStore((s) => s.closedPositions)
  const learnedModel = useMemo(
    () => buildLearnedModel(closedPositions),
    [closedPositions],
  )

  const oddsSignals = useMemo(() => {
    if (markets.length === 0) return []

    const matched: TradeSignal[] = []
    const matchedIds = new Set<string>()

    if (events.length > 0) {
      for (const market of markets) {
        const result = matchMarketToEvent(market, events)
        if (!result) continue
        const signal = buildOddsTradeSignal(market, result)
        if (!signal) continue
        matched.push(signal)
        matchedIds.add(market.id)
      }
    }

    // Structural fallback for everything we didn't match. We tag each
    // structural signal so `lib/supabaseSync.ts::syncLogSignal` can persist
    // the correct `signal_source` without inspecting the structural
    // pipeline's internals.
    const unmatched = markets.filter((m) => !matchedIds.has(m.id))
    const structural: TradeSignal[] = buildSignals(unmatched, {
      calibration: learnedModel,
    }).map((s) => ({
      ...s,
      signalSource: 'structural' as const,
    }))

    return [...matched, ...structural].sort((a, b) => b.edgePct - a.edgePct)
  }, [markets, events, learnedModel])

  const quotaRemaining = useOddsQuotaStore((s) => s.remaining)

  const lastUpdatedAt = useMemo(() => {
    // Prefer the live query's `dataUpdatedAt` once it's set, fall back to
    // the persisted timestamp.
    if (eventsQuery.dataUpdatedAt > 0) return eventsQuery.dataUpdatedAt
    return seededEvents?.updatedAt ?? null
  }, [eventsQuery.dataUpdatedAt, seededEvents])

  const isFetching = sportsQuery.isFetching || eventsQuery.isFetching

  const canRefresh =
    !isFetching &&
    (quotaRemaining == null || quotaRemaining >= QUOTA_HARD_FLOOR)

  const refresh = useCallback(() => {
    if (!canRefresh) return
    // Explicit refetch bypasses `staleTime: Infinity`. Do NOT pair with
    // `invalidateQueries` — that cancels the in-flight fetch and the
    // subsequent refetch rejects with AbortError.
    void eventsQuery.refetch().catch((err: unknown) => {
      if (isAbortError(err)) return
      console.error('[useOddsSignals] refresh failed:', err)
    })
  }, [canRefresh, eventsQuery])

  return {
    oddsSignals,
    // Initial load: spinner shows only when we have no cached data at all
    // and a fetch is in flight. After that, `isFetching` takes over for
    // refresh feedback.
    isLoading:
      seededEvents == null && (sportsQuery.isLoading || eventsQuery.isLoading),
    isFetching,
    quotaRemaining,
    lastUpdatedAt,
    refresh,
    canRefresh,
  }
}
