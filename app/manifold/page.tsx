'use client'

/**
 * Manifold — standalone source browser.
 *
 * Lists liquid open binary Manifold markets via the `/api/manifold` proxy. This
 * is the third venue alongside Polymarket and Kalshi; the `manifold-bet` cron
 * paper-trades the favored side of these, and resolved bets show up on
 * /portfolio and /performance.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import type { ManifoldMarket } from '@/lib/sources/manifoldApi'

type Sort = 'score' | 'liquidity' | 'close-date'

const SORTS: ReadonlyArray<{ key: Sort; label: string }> = [
  { key: 'score', label: 'Popular' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'close-date', label: 'Closing soon' },
]

async function fetchManifold(sort: Sort): Promise<ManifoldMarket[]> {
  const res = await fetch(`/api/manifold?sort=${sort}&limit=80`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Failed to load Manifold markets (${res.status})`)
  const body = (await res.json()) as { data: ManifoldMarket[] }
  return body.data
}

export default function ManifoldPage() {
  const [sort, setSort] = useState<Sort>('score')
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['manifold', sort],
    queryFn: () => fetchManifold(sort),
    staleTime: 120_000,
  })

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Manifold</h1>
        <p className="text-sm text-gray-400">
          Liquid open binary markets from Manifold — the third venue.
          {isFetching && !isLoading ? <span className="ml-2 text-emerald-300/80">Refreshing…</span> : null}
        </p>
      </header>

      <div className="flex items-center gap-2">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSort(s.key)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-xs font-medium transition',
              sort === s.key
                ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                : 'border-gray-700 bg-gray-900/60 text-gray-400 hover:border-gray-600 hover:text-gray-200',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400">Loading markets…</p>
      ) : isError ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-6 text-sm text-rose-200">
          {error instanceof Error ? error.message : 'Failed to load Manifold markets.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-800">
          <table className="min-w-full divide-y divide-gray-800 text-left text-sm">
            <thead className="bg-gray-900/60 text-[11px] uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-3 py-2.5 font-medium">Market</th>
                <th className="px-3 py-2.5 font-medium tabular-nums">YES</th>
                <th className="px-3 py-2.5 font-medium tabular-nums">Volume</th>
                <th className="px-3 py-2.5 font-medium tabular-nums">Bettors</th>
                <th className="px-3 py-2.5 font-medium tabular-nums">Closes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70 text-gray-200">
              {(data ?? []).map((m) => {
                const days = Math.round((new Date(m.closeTime).getTime() - Date.now()) / 86_400_000)
                return (
                  <tr key={m.id} className="hover:bg-gray-900/40">
                    <td className="max-w-[420px] px-3 py-2.5">
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="line-clamp-2 text-gray-100 transition hover:text-emerald-300"
                        title={m.question}
                      >
                        {m.question}
                      </a>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">
                      <span className={cn(m.yesProbability >= 0.5 ? 'text-emerald-300' : 'text-rose-300')}>
                        {(m.yesProbability * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-gray-400">
                      {Math.round(m.volume).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-gray-400">{m.uniqueBettors}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-gray-400">{days}d</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
