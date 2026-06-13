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

const FIVE_MINUTES = 5 * 60 * 1000

export const marketsQueryKey = (query?: MarketsQuery) =>
  ['markets', query ?? {}] as const

export function useMarkets(
  query?: MarketsQuery,
): UseQueryResult<Market[], Error> {
  return useQuery<Market[], Error>({
    queryKey: marketsQueryKey(query),
    queryFn: ({ signal }) => fetchActiveMarkets(query, signal),
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: false,
  })
}
