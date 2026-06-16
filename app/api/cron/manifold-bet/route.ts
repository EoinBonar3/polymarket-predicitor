/**
 * GET /api/cron/manifold-bet
 *
 * Baseline paper-trading bettor for the standalone Manifold source.
 *
 * Unlike `/api/cron/auto-bet` (which only fires on anchored arb signals that
 * almost never clear their edge threshold), this places a flat-stake bet on the
 * FAVORED side of liquid, soon-resolving Manifold markets — the live version of
 * the favorite strategy from `scripts/backtest.ts`. It claims no edge
 * (our_probability = the market price), so it's an honest "trust the crowd"
 * baseline. Its purpose is volume: enough resolving bets to light up the
 * dashboard equity curve, the calibration charts, and the per-source learner.
 *
 * No LLM, no Odds API — only Manifold's free public API + Supabase. Bets are
 * tagged `signal_source = 'manifold'` so the learner scores them separately
 * (`lib/learning.ts`), and the resolve cron settles them via Manifold's API.
 *
 * Auth: requires header `x-cron-secret` to match `process.env.CRON_SECRET`.
 */

import { NextResponse } from 'next/server'

import { fetchManifoldMarkets, type ManifoldMarket } from '@/lib/sources/manifoldApi'
import { SIGNAL_BANKROLL } from '@/lib/signals'
import { supabase } from '@/lib/supabase'
import { generateId } from '@/lib/utils'

export const runtime = 'nodejs'

/** Flat paper stake per Manifold bet. */
const STAKE = 10
/** Max bets placed per run (bounds bankroll drain). */
const MAX_BETS_PER_RUN = 5
/** Only bet markets closing within this many days, so they resolve during the demo. */
const MAX_CLOSE_DAYS = 45
/** Skip markets already decided (favored side too cheap/dear to be informative). */
const PRICE_FLOOR = 0.05
const PRICE_CEIL = 0.95

const DAY_MS = 24 * 60 * 60 * 1000

async function fetchCurrentBalance(): Promise<number> {
  if (!supabase) return SIGNAL_BANKROLL
  const { data, error } = await supabase
    .from('bankroll_snapshots')
    .select('balance')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[cron/manifold-bet] fetch balance failed:', error.message)
    return SIGNAL_BANKROLL
  }
  const balance = data ? Number((data as { balance: number | string }).balance) : SIGNAL_BANKROLL
  return Number.isFinite(balance) ? balance : SIGNAL_BANKROLL
}

/** Manifold market ids we've already bet (any status) — never bet the same one twice. */
async function fetchAlreadyBetIds(): Promise<Set<string>> {
  if (!supabase) return new Set()
  const { data, error } = await supabase.from('positions').select('market_id').eq('signal_source', 'manifold')
  if (error) {
    console.error('[cron/manifold-bet] fetch existing failed:', error.message)
    return new Set()
  }
  return new Set((data ?? []).map((r) => String((r as { market_id: string }).market_id)))
}

interface PlacedBet {
  marketId: string
  title: string
  outcome: 'YES' | 'NO'
  price: number
  stake: number
}

async function placeBet(m: ManifoldMarket, balance: number): Promise<PlacedBet | null> {
  if (!supabase) return null

  // Bet the favored side; entry price is that side's probability. ourProbability
  // = price ⇒ zero claimed edge (a deliberate "trust the crowd" baseline).
  const betYes = m.yesProbability >= 0.5
  const price = betYes ? m.yesProbability : 1 - m.yesProbability
  const outcome: 'YES' | 'NO' = betYes ? 'YES' : 'NO'
  if (!(price > 0 && price < 1) || STAKE > balance) return null

  const shares = STAKE / price
  const potentialPayout = Math.round(shares * 100) / 100
  const now = new Date().toISOString()

  const { error } = await supabase.from('positions').insert({
    id: generateId('pos'),
    market_id: m.id,
    market_title: m.question,
    market_slug: m.slug,
    outcome,
    stake: STAKE,
    price,
    shares,
    potential_payout: potentialPayout,
    signal_edge: 0,
    our_probability: price,
    status: 'open',
    placed_at: now,
    resolved_at: null,
    profit: null,
    signal_source: 'manifold',
  })
  if (error) {
    console.error('[cron/manifold-bet] insert position failed:', error.message)
    return null
  }

  const newBalance = Math.round((balance - STAKE) * 100) / 100
  const { error: snapErr } = await supabase.from('bankroll_snapshots').insert({ balance: newBalance })
  if (snapErr) console.error('[cron/manifold-bet] insert snapshot failed:', snapErr.message)

  return { marketId: m.id, title: m.question, outcome, price, stake: STAKE }
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured', placed: [] }, { status: 200 })
  }

  try {
    const markets = await fetchManifoldMarkets({ sort: 'score', limit: 250 })
    const alreadyBet = await fetchAlreadyBetIds()
    const cutoff = Date.now() + MAX_CLOSE_DAYS * DAY_MS

    // Soonest-closing first, liquid, not-yet-decided, not already bet.
    const candidates = markets
      .filter(
        (m) =>
          !alreadyBet.has(m.id) &&
          m.yesProbability >= PRICE_FLOOR &&
          m.yesProbability <= PRICE_CEIL &&
          new Date(m.closeTime).getTime() <= cutoff,
      )
      .sort((a, b) => new Date(a.closeTime).getTime() - new Date(b.closeTime).getTime())

    const placed: PlacedBet[] = []
    let balance = await fetchCurrentBalance()

    for (const m of candidates) {
      if (placed.length >= MAX_BETS_PER_RUN) break
      const bet = await placeBet(m, balance)
      if (!bet) continue
      balance = Math.round((balance - bet.stake) * 100) / 100
      placed.push(bet)
    }

    return NextResponse.json({
      universe: markets.length,
      eligible: candidates.length,
      placed,
      balance,
      fetchedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[cron/manifold-bet] run failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Manifold-bet run failed' },
      { status: 500 },
    )
  }
}
