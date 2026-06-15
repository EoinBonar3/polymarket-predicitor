'use client'

/**
 * Card view for a single Polymarket market.
 *
 * Renders the question, a YES/NO probability bar, key liquidity/volume
 * stats, and a time-to-expiry countdown. The companion `MarketCardSkeleton`
 * preserves the same layout so the dashboard grid doesn't reflow while
 * data is loading.
 */

import Link from 'next/link'

import { clamp, cn, formatPercent, formatTimeUntilExpiry, formatVolume } from '@/lib/utils'
import type { Market } from '@/lib/types'

interface MarketCardProps {
  market: Market
}

export function MarketCard({ market }: MarketCardProps) {
  const yes = clamp(Number.isFinite(market.yesPrice) ? market.yesPrice : 0.5, 0, 1)
  const no = clamp(Number.isFinite(market.noPrice) ? market.noPrice : 1 - yes, 0, 1)

  const yesPct = yes * 100
  const noPct = no * 100
  const yesFavoured = yes >= no

  return (
    // The link wraps the whole card so the entire surface is clickable. The
    // dashboard grid passes us a single grid cell, so `block h-full` makes the
    // anchor fill the cell — keeping the card's existing layout unchanged.
    // No interactive children inside the article, so no event-stopPropagation
    // dance is needed yet; if that changes, add `e.stopPropagation()` to the
    // child handler rather than swapping this wrapper for a div+onClick.
    <Link
      href={`/market/${market.slug}`}
      className="block h-full rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
      aria-label={`Open market: ${market.title}`}
    >
      <article className="group flex h-full flex-col gap-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5 shadow-sm transition hover:border-gray-700 hover:bg-gray-900/80">
        <header className="flex items-start justify-between gap-3">
          <span className="inline-flex items-center rounded-full border border-gray-700/80 bg-gray-800/60 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-300">
            {market.category || 'Uncategorised'}
          </span>
          <span
            className={cn(
              'text-xs font-medium',
              timeBadgeTone(market.endDate),
            )}
          >
            {formatTimeUntilExpiry(market.endDate)}
          </span>
        </header>

        <h3 className="text-base font-semibold leading-snug text-gray-50 line-clamp-3">
          {market.title}
        </h3>

        <div className="mt-auto space-y-3">
          <div className="flex items-center justify-between text-xs font-medium">
            <span className={cn('flex items-center gap-1.5', yesFavoured ? 'text-emerald-400' : 'text-gray-400')}>
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
              YES {formatPercent(yes)}
            </span>
            <span className={cn('flex items-center gap-1.5', !yesFavoured ? 'text-rose-400' : 'text-gray-400')}>
              NO {formatPercent(no)}
              <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden />
            </span>
          </div>

          <div
            role="img"
            aria-label={`Implied probabilities: YES ${formatPercent(yes)}, NO ${formatPercent(no)}`}
            className="flex h-2 w-full overflow-hidden rounded-full bg-gray-800"
          >
            <div
              className="h-full bg-emerald-500/90 transition-[width]"
              style={{ width: `${yesPct}%` }}
            />
            <div
              className="h-full bg-rose-500/90 transition-[width]"
              style={{ width: `${noPct}%` }}
            />
          </div>

          <dl className="flex items-center justify-between gap-2 pt-1 text-[11px] text-gray-400">
            <div className="flex flex-col">
              <dt className="uppercase tracking-wide text-gray-500">24h Vol</dt>
              <dd className="text-sm font-semibold text-gray-100">
                {formatVolume(market.volume24h)}
              </dd>
            </div>
            <div className="flex flex-col items-end">
              <dt className="uppercase tracking-wide text-gray-500">Liquidity</dt>
              <dd className="text-sm font-semibold text-gray-100">
                {formatVolume(market.liquidity)}
              </dd>
            </div>
          </dl>
        </div>
      </article>
    </Link>
  )
}

function timeBadgeTone(endDate: string): string {
  if (!endDate) return 'text-gray-400'
  const ms = new Date(endDate).getTime() - Date.now()
  if (ms <= 0) return 'text-gray-500'
  const day = 24 * 60 * 60 * 1000
  if (ms < day) return 'text-amber-400'
  if (ms < 3 * day) return 'text-amber-300/80'
  return 'text-gray-400'
}

export function MarketCardSkeleton() {
  return (
    <div
      aria-hidden
      className="flex h-full animate-pulse flex-col gap-4 rounded-xl border border-gray-800 bg-gray-900/60 p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="h-5 w-20 rounded-full bg-gray-800" />
        <div className="h-4 w-16 rounded bg-gray-800" />
      </div>

      <div className="space-y-2">
        <div className="h-4 w-11/12 rounded bg-gray-800" />
        <div className="h-4 w-9/12 rounded bg-gray-800" />
        <div className="h-4 w-7/12 rounded bg-gray-800" />
      </div>

      <div className="mt-auto space-y-3">
        <div className="flex items-center justify-between">
          <div className="h-3 w-16 rounded bg-gray-800" />
          <div className="h-3 w-16 rounded bg-gray-800" />
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
          <div className="h-full w-1/2 bg-gray-700" />
        </div>
        <div className="flex items-center justify-between pt-1">
          <div className="space-y-1">
            <div className="h-2.5 w-12 rounded bg-gray-800" />
            <div className="h-4 w-14 rounded bg-gray-800" />
          </div>
          <div className="space-y-1 text-right">
            <div className="ml-auto h-2.5 w-14 rounded bg-gray-800" />
            <div className="ml-auto h-4 w-16 rounded bg-gray-800" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default MarketCard
