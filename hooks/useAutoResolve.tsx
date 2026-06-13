'use client'

/**
 * Auto-resolve open positions.
 *
 * Polls the resolved-markets endpoint every 60 s and closes any open
 * position whose upstream Polymarket market has settled to YES or NO.
 * When a position is auto-closed we push a small toast so the user knows
 * something changed in the background.
 *
 * Spec note: this is the Phase 4 "auto-close" workflow. We poll the
 * dedicated `/api/resolve` route via `fetchResolvedMarkets` (which already
 * exists in `lib/polymarket.ts`) rather than `/api/markets`, because the
 * markets proxy only returns *active* markets — a market that has just
 * resolved drops out of that response entirely. The dedicated route is
 * the only place we can observe `resolvedOutcome: 'YES' | 'NO'`.
 *
 * Both the `useAutoResolve` hook and the `<Toaster />` component are
 * exported from this file so the toast queue can be co-located with the
 * single feature that produces it — no extra files / no toast library.
 *
 * NOTE: this file uses the `.tsx` extension because the exported
 * `<Toaster />` component contains JSX.
 */

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'

import { fetchResolvedMarkets } from '@/lib/polymarket'
import { cn, formatProfit } from '@/lib/utils'
import { useBankrollStore } from '@/store/bankroll'

export const AUTO_RESOLVE_INTERVAL_MS = 60 * 1000
export const TOAST_DURATION_MS = 3 * 1000

// ---------------------------------------------------------------------------
// Toast store
// ---------------------------------------------------------------------------

type ToastOutcome = 'win' | 'loss'

interface AutoResolveToast {
  id: string
  title: string
  outcome: ToastOutcome
  profit: number
}

interface ToastState {
  toasts: AutoResolveToast[]
  push: (toast: AutoResolveToast) => void
  dismiss: (id: string) => void
}

const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) =>
    set((state) => {
      // Dedupe by id so a flickering query result can't stack duplicates.
      if (state.toasts.some((t) => t.id === toast.id)) return state
      return { toasts: [...state.toasts, toast] }
    }),
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAutoResolve() {
  const openPositions = useBankrollStore((s) => s.openPositions)
  const closeBet = useBankrollStore((s) => s.closeBet)
  const pushToast = useToastStore((s) => s.push)

  const { data: resolved } = useQuery({
    queryKey: ['markets', 'resolved'],
    queryFn: ({ signal }) => fetchResolvedMarkets(signal),
    refetchInterval: AUTO_RESOLVE_INTERVAL_MS,
    staleTime: AUTO_RESOLVE_INTERVAL_MS,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled: openPositions.length > 0,
  })

  useEffect(() => {
    if (!resolved || resolved.length === 0) return
    if (openPositions.length === 0) return

    const resolvedById = new Map(resolved.map((m) => [m.id, m]))

    for (const position of openPositions) {
      const market = resolvedById.get(position.marketId)
      if (!market || !market.resolvedOutcome) continue

      const closed = closeBet(position.id, market.resolvedOutcome)
      if (!closed) continue

      pushToast({
        id: `${position.id}:${market.resolvedOutcome}`,
        title: position.marketTitle,
        outcome: closed.status === 'won' ? 'win' : 'loss',
        profit: closed.profit ?? 0,
      })
    }
  }, [resolved, openPositions, closeBet, pushToast])
}

// ---------------------------------------------------------------------------
// Toaster UI
// ---------------------------------------------------------------------------

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2 sm:bottom-6 sm:right-6"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastItem({ toast }: { toast: AutoResolveToast }) {
  const dismiss = useToastStore((s) => s.dismiss)

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [toast.id, dismiss])

  const isWin = toast.outcome === 'win'
  const headline = isWin ? 'WIN' : 'LOSS'

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto overflow-hidden rounded-lg border px-3 py-2.5 text-sm shadow-xl backdrop-blur-sm',
        'animate-in fade-in slide-in-from-right-4',
        isWin
          ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-50'
          : 'border-rose-400/40 bg-rose-500/15 text-rose-50',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide">
          Position auto-closed — {headline}
        </p>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1',
            isWin
              ? 'bg-emerald-500/20 text-emerald-100 ring-emerald-300/40'
              : 'bg-rose-500/20 text-rose-100 ring-rose-300/40',
          )}
        >
          {formatProfit(toast.profit)}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] text-gray-100/90" title={toast.title}>
        {toast.title}
      </p>
    </div>
  )
}

export default useAutoResolve
