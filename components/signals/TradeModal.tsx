'use client'

/**
 * Paper-trade confirmation modal.
 *
 * Lets the user override the Kelly-suggested stake, flip between YES and NO,
 * and previews the prospective payout / P&L before committing. On confirm we
 * call `placeBet` on the Zustand store; nothing here ever talks to
 * Polymarket directly.
 */

import { useEffect, useMemo, useState } from 'react'

import { cn, formatCurrency, formatPercent } from '@/lib/utils'
import { useBankrollStore } from '@/store/bankroll'
import type { TradeSignal } from '@/lib/signals'
import type { Outcome } from '@/lib/types'

interface TradeModalProps {
  signal: TradeSignal
  open: boolean
  onClose: () => void
}

export function TradeModal({ signal, open, onClose }: TradeModalProps) {
  const balance = useBankrollStore((s) => s.balance)
  const placeBet = useBankrollStore((s) => s.placeBet)

  const [outcome, setOutcome] = useState<Outcome>(signal.recommendedOutcome)
  const [stakeInput, setStakeInput] = useState<string>(
    signal.suggestedStake > 0 ? signal.suggestedStake.toFixed(2) : '10.00',
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setOutcome(signal.recommendedOutcome)
      setStakeInput(signal.suggestedStake > 0 ? signal.suggestedStake.toFixed(2) : '10.00')
      setError(null)
      setSubmitting(false)
    }
  }, [open, signal])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const price = useMemo(() => {
    if (outcome === signal.recommendedOutcome) return signal.marketPrice
    return Math.max(0.01, Math.min(0.99, 1 - signal.marketPrice))
  }, [outcome, signal])

  const stake = useMemo(() => {
    const n = Number(stakeInput)
    return Number.isFinite(n) && n > 0 ? n : 0
  }, [stakeInput])

  const shares = stake > 0 && price > 0 ? stake / price : 0
  const potentialPayout = shares
  const potentialProfit = potentialPayout - stake

  if (!open) return null

  const canSubmit =
    stake > 0 &&
    stake <= balance &&
    price > 0 &&
    price < 1 &&
    !submitting

  function onSubmit() {
    setError(null)
    if (stake <= 0) {
      setError('Enter a stake greater than £0.')
      return
    }
    if (stake > balance) {
      setError(`Stake exceeds available balance (${formatCurrency(balance)}).`)
      return
    }

    setSubmitting(true)
    const result = placeBet({
      marketId: signal.marketId,
      slug: signal.slug,
      title: signal.title,
      outcome,
      stake,
      price,
      signalEdge: signal.edgePct / 100,
      // Pass the full TradeSignal so the store writes a matching row to
      // signals_log (structural / odds_api / etc). Without this, only
      // positions + bankroll_snapshots get persisted.
      signal,
    })
    if (!result) {
      setSubmitting(false)
      setError('Could not place bet — check your balance and try again.')
      return
    }
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm paper trade"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm transition"
      />

      <div className="relative w-full max-w-md rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-300/80">
              Paper Trade
            </p>
            <h3 className="mt-1 text-lg font-semibold leading-snug text-white">
              {signal.title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded p-1 text-gray-400 transition hover:bg-gray-800 hover:text-white"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
              Outcome
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-800 bg-gray-900/60 p-1">
              {(['YES', 'NO'] as const).map((o) => {
                const active = outcome === o
                const yes = o === 'YES'
                return (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setOutcome(o)}
                    className={cn(
                      'rounded-md px-3 py-2 text-sm font-semibold transition',
                      active && yes && 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40',
                      active && !yes && 'bg-rose-500/20 text-rose-200 ring-1 ring-rose-400/40',
                      !active && 'text-gray-300 hover:bg-gray-800',
                    )}
                  >
                    {o}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Price" value={formatPercent(price)} />
            <Stat
              label="Available"
              value={formatCurrency(balance)}
              tone="muted"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-400">
              Stake (£)
            </label>
            <div className="flex items-stretch gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-gray-500">
                  £
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  className="w-full rounded-md border border-gray-700 bg-gray-900 py-2 pl-7 pr-3 text-sm text-gray-100 outline-none transition focus:border-emerald-400/60 focus:ring-1 focus:ring-emerald-400/40"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  setStakeInput(
                    signal.suggestedStake > 0
                      ? signal.suggestedStake.toFixed(2)
                      : '10.00',
                  )
                }
                className="rounded-md border border-gray-700 bg-gray-900 px-3 text-xs font-medium text-gray-300 transition hover:border-gray-600 hover:text-white"
              >
                Kelly
              </button>
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              Kelly suggests {formatCurrency(signal.suggestedStake)} ·{' '}
              {(signal.kellyFraction * 100).toFixed(1)}% of bankroll
            </p>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-400">Shares</span>
              <span className="font-medium text-gray-100">{shares.toFixed(2)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-gray-400">If {outcome} wins</span>
              <span className="font-medium text-emerald-300">
                {formatCurrency(potentialPayout)} ({potentialProfit >= 0 ? '+' : ''}
                {formatCurrency(potentialProfit)})
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-gray-400">If {outcome} loses</span>
              <span className="font-medium text-rose-300">
                -{formatCurrency(stake)}
              </span>
            </div>
          </div>

          {error ? (
            <p className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={onSubmit}
              className={cn(
                'rounded-md px-4 py-2 text-sm font-semibold transition',
                canSubmit
                  ? 'bg-emerald-500 text-gray-950 hover:bg-emerald-400'
                  : 'cursor-not-allowed bg-gray-800 text-gray-500',
              )}
            >
              {submitting ? 'Placing…' : 'Confirm Trade'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'muted'
}) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-base font-semibold',
          tone === 'muted' ? 'text-gray-300' : 'text-white',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export default TradeModal
