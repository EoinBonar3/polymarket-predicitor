'use client'

/**
 * React hook for the active markets list.
 *
 * Wraps `fetchActiveMarkets` in a TanStack Query so components get caching,
 * deduping, background refetching, and Suspense-friendly state for free.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { fetchActiveMarkets } from '@/lib/polymarket'
import type { Market, MarketsQuery } from '@/lib/types'
import { FIVE_MINUTES_MS } from '@/lib/utils'

export const marketsQueryKey = (query?: MarketsQuery) =>
  ['markets', query ?? {}] as const

export function useMarkets(
  query?: MarketsQuery,
): UseQueryResult<Market[], Error> {
  return useQuery<Market[], Error>({
    queryKey: marketsQueryKey(query),
    queryFn: ({ signal }) => fetchActiveMarkets(query, signal),
    staleTime: FIVE_MINUTES_MS,
    refetchInterval: FIVE_MINUTES_MS,
    refetchOnWindowFocus: false,
  })
}
