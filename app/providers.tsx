'use client'

/**
 * Client-only providers tree.
 *
 * Keeping this in its own file lets `app/layout.tsx` remain a Server
 * Component while still wiring up:
 *   - TanStack Query (data fetching / caching),
 *   - the auto-resolve poller (closes settled positions in the background),
 *   - the toaster that surfaces those auto-closes to the user, and
 *   - the deferred rehydration of the persisted Zustand bankroll store
 *     (avoids server/client hydration mismatches).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

import { Toaster, useAutoResolve } from '@/hooks/useAutoResolve'
import { fetchAllData } from '@/lib/supabaseSync'
import { STARTING_BANKROLL, useBankrollStore } from '@/store/bankroll'

interface ProvidersProps {
  children: ReactNode
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )

  // Hydrate the bankroll store after the first client render.
  //
  // Order of preference:
  //   1. Supabase, if it's configured AND has at least one position row —
  //      Postgres is the durable source of truth once the user has any
  //      history there.
  //   2. localStorage (via the persist middleware), as an offline fallback.
  //
  // Either path keeps SSR / first-client-render identical because the
  // store is created with `skipHydration: true` and we only mutate state
  // here inside `useEffect`, never during render.
  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      const remoteData = await fetchAllData()
      if (cancelled) return

      if (remoteData && remoteData.positions.length > 0) {
        const openPositions = remoteData.positions.filter(
          (p) => p.status === 'open',
        )
        const closedPositions = remoteData.positions.filter(
          (p) => p.status !== 'open',
        )

        // Cash balance is the most recent snapshot. We fall back to the
        // starting bankroll if no snapshots exist (theoretically only
        // possible if positions were inserted out-of-band without a
        // matching snapshot row).
        const lastSnapshot =
          remoteData.bankrollHistory[remoteData.bankrollHistory.length - 1]
        const balance = lastSnapshot
          ? lastSnapshot.balance
          : STARTING_BANKROLL

        useBankrollStore.setState({
          openPositions,
          closedPositions,
          bankrollHistory: remoteData.bankrollHistory,
          balance,
        })
      } else {
        // No Supabase data (env unset, table empty, or fetch failed) —
        // pull the last known state out of localStorage.
        void useBankrollStore.persist.rehydrate()
      }
    }

    void hydrate()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <AutoResolveMounter>{children}</AutoResolveMounter>
      <Toaster />
    </QueryClientProvider>
  )
}

/**
 * The auto-resolve poller is a hook, so it needs a component to live in.
 * Mounting it just inside the QueryClientProvider gives it access to the
 * shared cache, and rendering `{children}` straight through keeps the
 * render tree identical to the pre-Phase-4 layout.
 */
function AutoResolveMounter({ children }: { children: ReactNode }) {
  useAutoResolve()
  return <>{children}</>
}

export default Providers
