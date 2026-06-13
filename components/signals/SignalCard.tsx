'use client'

/**
 * Card view for a single trade signal.
 *
 * Compact layout — the dashboard renders these in a horizontal scroll row,
 * so we keep the footprint small and put the action ("Paper Trade") front
 * and centre. Clicking it opens the `TradeModal`.
 */

import { useState } from 'react'

import { TradeModal } from './TradeModal'
import { cn, formatCurrency } from '@/lib/utils'
import type { TradeSignal } from '@/lib/signals'

interface SignalCardProps {
  signal: TradeSignal
}

export function SignalCard({ signal }: SignalCardProps) {
  const [open, setOpen] = useState(false)

  const yes = signal.recommendedOutcome === 'YES'
  const edgeLabel = `${signal.edgePct >= 0 ? '+' : ''}${signal.edgePct.toFixed(1)}%`

  return (
    <>
      <article className="flex h-full min-w-[280px] max-w-[320px] flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900/70 p-4 shadow-sm transition hover:border-gray-700 hover:bg-gray-900/90">
        <header className="flex items-center justify-between gap-2">
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
          <ConfidenceBadge confidence={signal.confidence} />
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

export default SignalCard
