/**
 * GET /api/cron/resolve
 *
 * Vercel Cron entry point that settles open paper-trading positions
 * server-side — the closed-loop counterpart to `/api/cron/auto-bet`.
 *
 * WHY THIS EXISTS: positions are placed server-side by the auto-bet cron, but
 * until now the ONLY thing that resolved them was a client-side React poller
 * (`hooks/useAutoResolve.tsx`) that runs only while a browser tab is open. So a
 * bet placed by the cron sat `open` forever unless a human loaded the dashboard
 * — which meant the closed-loop learner (`lib/learning.ts`) never received a
 * single resolved bet to learn from. This cron closes that gap: it does
 * server-side exactly what `useAutoResolve` does in the browser, so the
 * place → resolve → learn loop runs with no human in the loop.
 *
 * On each run we:
 *   1. Load every `open` position from Supabase.
 *   2. Fetch Polymarket markets that have settled to YES/NO via our own
 *      `/api/resolve` proxy.
 *   3. For each open position whose market has resolved, mark it won/lost,
 *      compute realised profit, and snapshot the new bankroll balance —
 *      mirroring `closeBet` in `store/bankroll.ts` exactly.
 *
 * Known limitation (shared with the client poller): `/api/resolve` returns
 * only the most recently-closed events, so a position whose market resolved
 * long ago and has scrolled out of that window won't be caught here. Good
 * enough for the recent-bet turnover this system produces; a per-market lookup
 * could close it fully later.
 *
 * Auth: requires header `x-cron-secret` to match `process.env.CRON_SECRET`.
 */

import { NextResponse } from 'next/server'

import { SIGNAL_BANKROLL } from '@/lib/signals'
import { fetchManifoldResolution } from '@/lib/sources/manifoldApi'
import { supabase } from '@/lib/supabase'
import type { ApiResponse, Market } from '@/lib/types'

export const runtime = 'nodejs'

interface OpenPositionRow {
  id: string
  market_id: string
  market_title: string
  outcome: 'YES' | 'NO'
  stake: number | string
  potential_payout: number | string
  signal_source: string | null
}

interface ResolvedBet {
  positionId: string
  marketId: string
  title: string
  status: 'won' | 'lost'
  profit: number
}

/** Open positions awaiting settlement, oldest first (resolve in placement order). */
async function fetchOpenPositions(): Promise<OpenPositionRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('positions')
    .select('id, market_id, market_title, outcome, stake, potential_payout, signal_source')
    .eq('status', 'open')
    .order('placed_at', { ascending: true })

  if (error) {
    console.error('[cron/resolve] fetch open positions failed:', error.message)
    return []
  }
  return (data ?? []) as OpenPositionRow[]
}

/**
 * Settled Polymarket markets (YES/NO outcomes only) via our own `/api/resolve`
 * proxy — the same endpoint the client poller uses. Returns `[]` on failure so
 * a flaky upstream just means "nothing to settle this run".
 */
async function fetchResolvedMarkets(request: Request): Promise<Market[]> {
  const url = new URL('/api/resolve', request.url)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    console.warn(`[cron/resolve] /api/resolve failed (${res.status}) — skipping run`)
    return []
  }
  const body = (await res.json()) as ApiResponse<Market[]>
  return body.data ?? []
}

/** Latest bankroll balance from `bankroll_snapshots`, or the starting bankroll if none. */
async function fetchCurrentBalance(): Promise<number> {
  if (!supabase) return SIGNAL_BANKROLL
  const { data, error } = await supabase
    .from('bankroll_snapshots')
    .select('balance')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[cron/resolve] fetch balance failed:', error.message)
    return SIGNAL_BANKROLL
  }
  const balance = data ? Number((data as { balance: number | string }).balance) : SIGNAL_BANKROLL
  return Number.isFinite(balance) ? balance : SIGNAL_BANKROLL
}

/**
 * Settle a single position: flip its row to won/lost with realised profit and
 * snapshot the post-resolution balance. Returns the resolved bet, or null on
 * a DB error (so a single bad row doesn't abort the whole run). Profit/balance
 * math mirrors `closeBet` in `store/bankroll.ts` exactly.
 */
async function settlePosition(
  pos: OpenPositionRow,
  resolvedOutcome: 'YES' | 'NO',
  balance: number,
): Promise<{ bet: ResolvedBet; newBalance: number } | null> {
  if (!supabase) return null

  const stake = Number(pos.stake)
  const potentialPayout = Number(pos.potential_payout)
  if (!Number.isFinite(stake) || !Number.isFinite(potentialPayout)) return null

  const won = pos.outcome === resolvedOutcome
  const payout = won ? potentialPayout : 0
  const profit = Math.round((payout - stake) * 100) / 100
  const now = new Date().toISOString()

  const { error: posErr } = await supabase
    .from('positions')
    .update({ status: won ? 'won' : 'lost', profit, resolved_at: now })
    .eq('id', pos.id)
    .eq('status', 'open') // guard against a double-settle race with the client poller

  if (posErr) {
    console.error(`[cron/resolve] update position ${pos.id} failed:`, posErr.message)
    return null
  }

  const newBalance = Math.round((balance + payout) * 100) / 100
  const { error: snapErr } = await supabase.from('bankroll_snapshots').insert({ balance: newBalance })
  if (snapErr) {
    console.error('[cron/resolve] insert snapshot failed:', snapErr.message)
  }

  return {
    bet: { positionId: pos.id, marketId: pos.market_id, title: pos.market_title, status: won ? 'won' : 'lost', profit },
    newBalance,
  }
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const provided = request.headers.get('x-cron-secret')

  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured', resolved: [] }, { status: 200 })
  }

  try {
    const openPositions = await fetchOpenPositions()
    if (openPositions.length === 0) {
      return NextResponse.json({ openPositions: 0, resolvedMarkets: 0, resolved: [], fetchedAt: new Date().toISOString() })
    }

    // Split by source: Polymarket positions settle via the /api/resolve feed
    // (matched by market id); Manifold positions settle via Manifold's own API
    // (looked up per market). Different id namespaces never collide.
    const manifoldOpen = openPositions.filter((p) => p.signal_source === 'manifold')
    const polymarketOpen = openPositions.filter((p) => p.signal_source !== 'manifold')

    const resolved: ResolvedBet[] = []
    let balance = await fetchCurrentBalance()
    let resolvedMarketsSeen = 0

    // ── Polymarket path ──────────────────────────────────────────────────────
    if (polymarketOpen.length > 0) {
      const resolvedMarkets = await fetchResolvedMarkets(request)
      const outcomeByMarketId = new Map<string, 'YES' | 'NO'>()
      for (const m of resolvedMarkets) {
        if (m.resolvedOutcome === 'YES' || m.resolvedOutcome === 'NO') {
          outcomeByMarketId.set(m.id, m.resolvedOutcome)
        }
      }
      resolvedMarketsSeen = outcomeByMarketId.size

      for (const pos of polymarketOpen) {
        const outcome = outcomeByMarketId.get(pos.market_id)
        if (!outcome) continue
        const result = await settlePosition(pos, outcome, balance)
        if (!result) continue
        balance = result.newBalance
        resolved.push(result.bet)
      }
    }

    // ── Manifold path ────────────────────────────────────────────────────────
    for (const pos of manifoldOpen) {
      const outcome = await fetchManifoldResolution(pos.market_id)
      if (!outcome) continue
      const result = await settlePosition(pos, outcome, balance)
      if (!result) continue
      balance = result.newBalance
      resolved.push(result.bet)
    }

    return NextResponse.json({
      openPositions: openPositions.length,
      polymarketOpen: polymarketOpen.length,
      manifoldOpen: manifoldOpen.length,
      resolvedMarkets: resolvedMarketsSeen,
      settled: resolved.length,
      resolved,
      balance,
      fetchedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[cron/resolve] run failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Resolve run failed' },
      { status: 500 },
    )
  }
}
