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
import { useBankrollStore } from '@/store/bankroll'

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

  // Rehydrate the persisted bankroll store after the first client render.
  // The store is created with `skipHydration: true` so SSR and the initial
  // client render use the same empty defaults; we then pull the saved
  // state out of `localStorage` (or the safe in-memory fallback) once it's
  // safe to do so.
  useEffect(() => {
    void useBankrollStore.persist.rehydrate()
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
