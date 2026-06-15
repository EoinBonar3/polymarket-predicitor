'use client'

/**
 * Card view for a single trade signal.
 *
 * Two visual modes:
 *
 *   - `signalSource === 'odds_api'`: ourProbability came from bookmaker
 *     consensus. Replace the structural mini-bars with a clean 3-row
 *     "Bookmaker / Polymarket / Gap" block since the structural
 *     decomposition is meaningless for these signals.
 *
 *   - `signalSource === 'structural'` (or undefined for legacy signals):
 *     show the existing liquidity / time / volume mini-bars.
 */

import { useState } from 'react'

import { TradeModal } from './TradeModal'
import { cn, formatCurrency } from '@/lib/utils'
import type {
  ProbabilityBreakdown,
  TradeSignal,
} from '@/lib/types'

interface SignalCardProps {
  signal: TradeSignal
}

export function SignalCard({ signal }: SignalCardProps) {
  const [open, setOpen] = useState(false)

  const yes = signal.recommendedOutcome === 'YES'
  const edgeLabel = `${signal.edgePct >= 0 ? '+' : ''}${signal.edgePct.toFixed(1)}%`
  const isOddsApi = signal.signalSource === 'odds_api'
  // Warn the user when a structural signal sits in the 0–20% / 80–100%
  // band — the blender shrinks toward 50/50 regardless of actual event
  // probability, so the "edge" it reports is mostly noise. We DO NOT
  // suppress these signals here (the price-floor filter in
  // `lib/signals.ts` only kicks in at <10% / >90%); we just label them.
  // odds_api signals are exempt — bookmaker consensus carries real
  // information at the extremes.
  const isLowInfo =
    !isOddsApi &&
    (signal.marketPrice < 0.20 || signal.marketPrice > 0.80)

  return (
    <>
      <article className="flex h-full min-w-[280px] max-w-[320px] flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900/70 p-4 shadow-sm transition hover:border-gray-700 hover:bg-gray-900/90">
        <header className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                yes
                  ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30'
                  : 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  yes ? 'bg-emerald-400' : 'bg-rose-400',
                )}
              />
              Buy {signal.recommendedOutcome}
            </span>
            {isOddsApi ? <SourceBadge /> : null}
          </div>
          <div className="flex items-center gap-1.5">
            {isLowInfo ? <LowInfoBadge /> : null}
            <ConfidenceBadge confidence={signal.confidence} />
          </div>
        </header>

        <h4 className="line-clamp-2 text-sm font-semibold leading-snug text-gray-50">
          {signal.title}
        </h4>

        <dl className="grid grid-cols-2 gap-2 text-[11px] text-gray-400">
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Edge</dt>
            <dd
              className={cn(
                'text-sm font-semibold',
                signal.edgePct >= 0 ? 'text-emerald-300' : 'text-rose-300',
              )}
            >
              {edgeLabel}
            </dd>
          </div>
          <div className="text-right">
            <dt className="uppercase tracking-wide text-gray-500">Stake</dt>
            <dd className="text-sm font-semibold text-gray-100">
              {formatCurrency(signal.suggestedStake)}
            </dd>
          </div>
        </dl>

        {isOddsApi ? (
          <OddsApiBreakdown signal={signal} />
        ) : signal.probabilityBreakdown ? (
          <ProbabilityBreakdownBars
            breakdown={signal.probabilityBreakdown}
            marketPrice={signal.marketPrice}
          />
        ) : null}

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-auto rounded-md border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-200 transition hover:bg-emerald-500/25 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
        >
          Paper Trade
        </button>
      </article>

      <TradeModal
        signal={signal}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

function SourceBadge() {
  return (
    <span
      title="Probability sourced from bookmaker consensus via The Odds API"
      className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300 ring-1 ring-emerald-400/30"
    >
      Bookmaker
    </span>
  )
}

/**
 * Warning badge for structural signals on extreme-priced markets (<20%
 * or >80% on the recommended side). The structural blender's shrinkage
 * toward 50/50 has no event-specific information, so any reported edge
 * in this band is dominated by noise rather than mispricing. Sits next
 * to the confidence badge in the card header.
 */
function LowInfoBadge() {
  return (
    <span
      role="img"
      aria-label="Low-information structural signal"
      title="Structural signals on extreme-priced markets have low predictive value. The blender shrinks toward 50/50 regardless of actual event probability."
      className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-400/40"
    >
      <span aria-hidden>⚠</span>
      Low Info
    </span>
  )
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: TradeSignal['confidence']
}) {
  const tones: Record<TradeSignal['confidence'], string> = {
    high: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30',
    medium: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
    low: 'bg-gray-700/30 text-gray-300 ring-gray-500/30',
  }
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1',
        tones[confidence],
      )}
    >
      {confidence}
    </span>
  )
}

/**
 * Odds-API replacement for the structural mini-bars.
 *
 * Three rows: bookmaker consensus, Polymarket implied probability for
 * the matched outcome, and the gap (in percentage points). The numbers
 * tell the whole story — no charts needed.
 */
function OddsApiBreakdown({ signal }: { signal: TradeSignal }) {
  const ourPct = (signal.ourProbability * 100).toFixed(1)
  const marketPct = (signal.marketPrice * 100).toFixed(1)
  const gap = signal.ourProbability - signal.marketPrice
  const gapPp = (gap * 100).toFixed(1)
  const gapSign = gap >= 0 ? '+' : ''
  const bookmakerHint =
    signal.bookmakerCount != null && signal.bookmakerCount > 0
      ? `Averaged across ${signal.bookmakerCount} bookmaker${signal.bookmakerCount === 1 ? '' : 's'}`
      : 'Vig-removed bookmaker consensus'

  return (
    <div
      className="flex flex-col gap-1 border-t border-gray-800/80 pt-2"
      aria-label="Bookmaker comparison"
      title={bookmakerHint}
    >
      <ComparisonRow label="Bookmaker" value={`${ourPct}%`} tone="neutral" />
      <ComparisonRow label="Polymarket" value={`${marketPct}%`} tone="muted" />
      <ComparisonRow
        label="Gap"
        value={`${gapSign}${gapPp}pp`}
        tone={gap >= 0 ? 'positive' : 'negative'}
      />
    </div>
  )
}

function ComparisonRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'neutral' | 'muted' | 'positive' | 'negative'
}) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="uppercase tracking-wide text-gray-500">{label}</span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          tone === 'neutral' && 'text-gray-100',
          tone === 'muted' && 'text-gray-400',
          tone === 'positive' && 'text-emerald-300',
          tone === 'negative' && 'text-rose-300',
        )}
      >
        {value}
      </span>
    </div>
  )
}

interface ProbabilityBreakdownBarsProps {
  breakdown: ProbabilityBreakdown
  marketPrice: number
}

/**
 * Three-row mini bar chart of "how much did each underlying signal pull
 * the probability away from the raw market price?" — the bar width is the
 * weighted absolute deviation `wᵢ · |signalPᵢ - marketPrice|`, normalised so
 * the largest contributor fills the row.
 */
function ProbabilityBreakdownBars({
  breakdown,
  marketPrice,
}: ProbabilityBreakdownBarsProps) {
  const { volumeSpike, priceMomentum, staleMarket, weights } = breakdown

  const rows = [
    {
      key: 'volumeSpike' as const,
      label: 'Vol spike',
      contribution: weights.volumeSpike * Math.abs(volumeSpike - marketPrice),
      barClass: 'bg-amber-400/70',
    },
    {
      key: 'priceMomentum' as const,
      label: 'Momentum',
      contribution: weights.priceMomentum * Math.abs(priceMomentum - marketPrice),
      barClass: 'bg-violet-400/70',
    },
    {
      key: 'staleMarket' as const,
      label: 'Stale',
      contribution: weights.staleMarket * Math.abs(staleMarket - marketPrice),
      barClass: 'bg-sky-400/70',
    },
  ]

  const max = Math.max(...rows.map((r) => r.contribution), 0)

  return (
    <div
      className="flex flex-col gap-1 border-t border-gray-800/80 pt-2"
      aria-label="Probability signal contributions"
    >
      <span className="text-[10px] uppercase tracking-wide text-gray-500">
        Signal mix
      </span>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const pct = max > 0 ? (row.contribution / max) * 100 : 0
          return (
            <li key={row.key} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
                {row.label}
              </span>
              <span
                className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-gray-800"
                aria-hidden
              >
                <span
                  className={cn('absolute inset-y-0 left-0 rounded-full', row.barClass)}
                  style={{ width: `${pct.toFixed(1)}%` }}
                />
              </span>
              <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-gray-400">
                {(row.contribution * 100).toFixed(1)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default SignalCard
