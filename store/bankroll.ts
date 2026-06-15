'use client'

/**
 * Bankroll / positions store (Zustand).
 *
 * Single source of truth for the paper-trading account:
 *   - cash balance + history series (for the Performance chart)
 *   - open positions (active bets)
 *   - closed positions (settled bets, with realised P&L)
 *
 * Persistence model (post-Supabase migration):
 *
 *   - `localStorage` (via the `persist` middleware below) remains the
 *     offline fallback — if the user opens the app with no network, or
 *     no Supabase env vars set, we still see their previous state.
 *   - Every mutating action ALSO fires a write-through call into
 *     `lib/supabaseSync.ts` (no `await`, never blocking). When Supabase
 *     is configured, Postgres is the durable source of truth and we
 *     hydrate from it on app load (`app/providers.tsx`).
 *
 * Rehydration is opt-in (`skipHydration: true`) and triggered from
 * `app/providers.tsx` after mount so the initial server render and the
 * first client render always agree.
 */

import { create } from 'zustand'
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from 'zustand/middleware'

import type {
  BankrollHistoryPoint,
  Outcome,
  Position,
  TradeSignal,
} from '@/lib/types'
import {
  resetAllData,
  syncCloseBet,
  syncLogSignal,
  syncPlaceBet,
} from '@/lib/supabaseSync'
import { generateId } from '@/lib/utils'

export const STARTING_BANKROLL = 1000
export const BANKROLL_STORAGE_KEY = 'polymarket-predictor:bankroll'

/**
 * Local position extension — we keep the upstream `slug` alongside the
 * canonical `Position` so the Portfolio view can deep-link back to the
 * market detail page without an extra lookup.
 */
export interface BankrollPosition extends Position {
  slug: string
}

interface PlaceBetInput {
  marketId: string
  slug: string
  title: string
  outcome: Outcome
  stake: number
  price: number
  signalEdge?: number
  ourProbability?: number
  /**
   * Optional — when present, the `TradeSignal` that triggered the bet is
   * logged to Supabase's `signals_log` table for downstream ML work. We
   * only ever log signals that were actually acted on (the dashboard
   * generates hundreds per poll, so wholesale logging would be noisy).
   */
  signal?: TradeSignal
}

interface BankrollState {
  balance: number
  startingBalance: number
  openPositions: BankrollPosition[]
  closedPositions: BankrollPosition[]
  bankrollHistory: BankrollHistoryPoint[]

  placeBet: (input: PlaceBetInput) => BankrollPosition | null
  closeBet: (positionId: string, resolvedOutcome: Outcome) => BankrollPosition | null
  resetBankroll: () => void
}

// ---------------------------------------------------------------------------
// Safe storage
// ---------------------------------------------------------------------------

/**
 * A `StateStorage` that prefers `localStorage` but falls back to a per-tab
 * in-memory map on any failure (SSR, sandboxed iframe, private mode, quota,
 * etc.). All exceptions are swallowed silently — persistence is a nicety,
 * not a hard requirement.
 */
function createSafeStorage(): StateStorage {
  const memory = new Map<string, string>()

  const canUseLocalStorage = (): boolean => {
    if (typeof window === 'undefined') return false
    try {
      const probe = '__pmp_probe__'
      window.localStorage.setItem(probe, probe)
      window.localStorage.removeItem(probe)
      return true
    } catch {
      return false
    }
  }

  return {
    getItem: (key) => {
      if (canUseLocalStorage()) {
        try {
          return window.localStorage.getItem(key)
        } catch {
          // fall through to memory
        }
      }
      return memory.get(key) ?? null
    },
    setItem: (key, value) => {
      if (canUseLocalStorage()) {
        try {
          window.localStorage.setItem(key, value)
          return
        } catch {
          // fall through to memory
        }
      }
      memory.set(key, value)
    },
    removeItem: (key) => {
      if (canUseLocalStorage()) {
        try {
          window.localStorage.removeItem(key)
        } catch {
          // fall through to memory
        }
      }
      memory.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBankrollStore = create<BankrollState>()(
  persist(
    (set, get) => ({
      balance: STARTING_BANKROLL,
      startingBalance: STARTING_BANKROLL,
      openPositions: [],
      closedPositions: [],
      // Initial history is intentionally empty (deterministic across server
      // and client renders). `placeBet` seeds the starting point lazily so
      // the equity curve still anchors at £STARTING_BANKROLL once the user
      // has any activity.
      bankrollHistory: [],

      placeBet: ({
        marketId,
        slug,
        title,
        outcome,
        stake,
        price,
        signalEdge = 0,
        ourProbability,
        signal,
      }) => {
        if (
          !Number.isFinite(stake) ||
          !Number.isFinite(price) ||
          stake <= 0 ||
          price <= 0 ||
          price >= 1
        ) {
          return null
        }

        const { balance, openPositions, bankrollHistory } = get()
        if (stake > balance) return null

        const roundedStake = Math.round(stake * 100) / 100
        const shares = roundedStake / price
        const potentialPayout = Math.round(shares * 100) / 100
        const now = new Date().toISOString()

        const position: BankrollPosition = {
          id: generateId('pos'),
          marketId,
          slug,
          marketTitle: title,
          outcome,
          stake: roundedStake,
          price,
          shares,
          potentialPayout,
          signalEdge,
          ourProbability,
          status: 'open',
          placedAt: now,
          // Signal provenance for the closed-loop learner. Captured from the
          // triggering `TradeSignal` so resolved bets can be attributed back to
          // the signals that produced them (`lib/learning.ts`).
          signalSource: signal?.signalSource,
          signalCount: signal?.signalCount,
          signalStrength: signal?.signalStrength,
          activeSignals: signal?.probabilityBreakdown?.activeSignals,
        }

        const newBalance = Math.round((balance - roundedStake) * 100) / 100

        // Seed a starting-balance point the first time we ever record
        // history, so the equity curve starts visually at £1,000 instead
        // of jumping straight to the post-trade balance.
        const seed: BankrollHistoryPoint[] =
          bankrollHistory.length === 0
            ? [
                {
                  timestamp: new Date(Date.now() - 1).toISOString(),
                  balance: STARTING_BANKROLL,
                },
              ]
            : []

        set({
          balance: newBalance,
          openPositions: [position, ...openPositions],
          bankrollHistory: [
            ...bankrollHistory,
            ...seed,
            { timestamp: now, balance: newBalance },
          ],
        })

        // Write-through to Supabase. Fire-and-forget: never await, never
        // block the UI, errors are swallowed inside `supabaseSync`.
        void syncPlaceBet(position, newBalance)
        if (signal) {
          void syncLogSignal(signal, position.id)
        }

        return position
      },

      closeBet: (positionId, resolvedOutcome) => {
        const { openPositions, closedPositions, balance, bankrollHistory } = get()
        const idx = openPositions.findIndex((p) => p.id === positionId)
        if (idx === -1) return null

        const position = openPositions[idx]
        const won = position.outcome === resolvedOutcome
        const payout = won ? position.potentialPayout : 0
        const profit = Math.round((payout - position.stake) * 100) / 100
        const now = new Date().toISOString()

        const closed: BankrollPosition = {
          ...position,
          status: won ? 'won' : 'lost',
          resolvedAt: now,
          profit,
        }

        const newBalance = Math.round((balance + payout) * 100) / 100
        const newOpen = openPositions.slice()
        newOpen.splice(idx, 1)

        set({
          balance: newBalance,
          openPositions: newOpen,
          closedPositions: [closed, ...closedPositions],
          bankrollHistory: [...bankrollHistory, { timestamp: now, balance: newBalance }],
        })

        void syncCloseBet(
          positionId,
          {
            status: closed.status === 'won' ? 'won' : 'lost',
            profit,
            resolvedAt: now,
          },
          newBalance,
        )

        return closed
      },

      resetBankroll: () => {
        set({
          balance: STARTING_BANKROLL,
          startingBalance: STARTING_BANKROLL,
          openPositions: [],
          closedPositions: [],
          bankrollHistory: [],
        })

        void resetAllData()
      },
    }),
    {
      name: BANKROLL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => createSafeStorage()),
      // `startingBalance` is intentionally NOT persisted — it should always
      // reset to the constant £1,000 on a fresh page load, even if a future
      // version of the app changes the default.
      partialize: (state) => ({
        balance: state.balance,
        openPositions: state.openPositions,
        closedPositions: state.closedPositions,
        bankrollHistory: state.bankrollHistory,
      }),
      // We rehydrate manually from `app/providers.tsx` after mount, so the
      // first client render uses the same default state as the SSR render
      // and React doesn't yell about a hydration mismatch.
      skipHydration: true,
    },
  ),
)
