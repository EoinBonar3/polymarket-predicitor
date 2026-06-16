/**
 * Supabase client singleton.
 *
 * `supabase` is intentionally nullable: if the env vars aren't set (e.g. a
 * fresh local dev clone with no Supabase project yet) we want the rest of
 * the app to keep working against `localStorage` only. Every caller in
 * `lib/supabaseSync.ts` checks `if (!supabase) return …` and silently
 * no-ops when the client is null.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// Eager singleton used by Next.js app routes (env vars are set before modules load there).
export const supabase = url && key ? createClient(url, key) : null

// Lazy getter for scripts that load .env.local manually after module init.
// TypeScript hoists all imports before the env-loading code runs, so the
// eager `supabase` above is always null in scripts. Use this instead.
// Return type matches `typeof supabase` exactly so callers type-check cleanly.
let _scriptClient: typeof supabase | undefined = undefined
export function getDb(): typeof supabase {
  if (_scriptClient !== undefined) return _scriptClient
  const u = process.env.NEXT_PUBLIC_SUPABASE_URL
  const k = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  _scriptClient = u && k ? createClient(u, k) : null
  if (!_scriptClient) console.error('[supabase] getDb: env vars not set — Supabase unavailable')
  return _scriptClient
}

// ---------------------------------------------------------------------------
// Row shapes — snake_case mirror of the Postgres tables we own.
// Kept here (not in `lib/types.ts`) so the rest of the app never sees the
// database column naming — it only ever deals with the domain types from
// `lib/types.ts` via the mappers in `lib/supabaseSync.ts`.
// ---------------------------------------------------------------------------

export type SupabasePosition = {
  id: string
  market_id: string
  market_title: string
  outcome: 'YES' | 'NO'
  stake: number
  price: number
  shares: number
  potential_payout: number
  signal_edge: number
  our_probability?: number
  status: 'open' | 'won' | 'lost'
  placed_at: string
  resolved_at: string | null
  profit: number | null
  market_slug: string | null
  // Signal provenance for the closed-loop learner (`lib/learning.ts`). All
  // nullable — odds-api / legacy bets may not carry the structural breakdown.
  // See the migration note at the top of `lib/supabaseSync.ts`.
  signal_source?: 'structural' | 'odds_api' | 'kalshi' | 'manifold' | null
  signal_count?: number | null
  signal_strength?: 'weak' | 'moderate' | 'strong' | null
  active_volume_spike?: boolean | null
  active_price_momentum?: boolean | null
  active_stale_market?: boolean | null
}

export type SupabaseBankrollSnapshot = {
  id: string
  balance: number
  snapshot_at: string
}
