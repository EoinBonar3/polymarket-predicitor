/**
 * GET /api/cron/auto-bet
 *
 * Vercel Cron entry point for fully-automated paper trading. On each run we:
 *   1. Pull the current market feed from our own `/api/markets` proxy.
 *   2. Run it through the existing signal engine (`buildSignals`).
 *   3. Keep only "high conviction" signals — edge ≥ 6pp AND at least 2 of
 *      the 3 structural signals agreeing.
 *   4. Place up to 3 paper bets (highest-EV first — `buildSignals` already
 *      sorts that way), writing straight to Supabase the same way
 *      `store/bankroll.ts`'s `placeBet` does.
 *
 * Bets placed here are tagged `signal_source: 'auto'` on the `positions` row
 * so they can be distinguished from manually-placed bets in the dashboard /
 * closed-loop learner queries.
 *
 * Auth: requires header `x-cron-secret` to match `process.env.CRON_SECRET`.
 */

import { NextResponse } from 'next/server'

import { buildSignals, SIGNAL_BANKROLL } from '@/lib/signals'
import { supabase } from '@/lib/supabase'
import { generateId } from '@/lib/utils'
import type { ApiResponse, Market, TradeSignal } from '@/lib/types'

export const runtime = 'nodejs'

/** Minimum raw edge (percentage points) for a signal to be auto-traded. */
const AUTO_BET_MIN_EDGE_PP = 3

/** Minimum number of agreeing structural signals for a signal to be auto-traded. */
const AUTO_BET_MIN_SIGNAL_COUNT = 1

/** Max number of paper bets placed per cron run. */
const MAX_BETS_PER_RUN = 3

function isAutoBetCandidate(signal: TradeSignal): boolean {
  const signalCount = signal.signalCount ?? 0
  return Math.abs(signal.edgePct) >= AUTO_BET_MIN_EDGE_PP && signalCount >= AUTO_BET_MIN_SIGNAL_COUNT
}

async function fetchMarkets(request: Request): Promise<Market[]> {
  const url = new URL('/api/markets', request.url)
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`/api/markets request failed (${response.status})`)
  }
  const body = (await response.json()) as ApiResponse<Market[]>
  return body.data
}

/** Latest bankroll balance from `bankroll_snapshots`, or the starting bankroll if none exist. */
async function fetchCurrentBalance(): Promise<number> {
  if (!supabase) return SIGNAL_BANKROLL

  const { data, error } = await supabase
    .from('bankroll_snapshots')
    .select('balance')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[cron/auto-bet] fetch balance failed:', error.message)
    return SIGNAL_BANKROLL
  }

  const balance = data ? Number((data as { balance: number | string }).balance) : SIGNAL_BANKROLL
  return Number.isFinite(balance) ? balance : SIGNAL_BANKROLL
}

interface PlacedBet {
  marketId: string
  title: string
  outcome: TradeSignal['recommendedOutcome']
  stake: number
  edgePct: number
}

/**
 * Place a single auto bet: insert the `positions` row (tagged
 * `signal_source: 'auto'`) and a fresh `bankroll_snapshots` row, mirroring
 * `placeBet` in `store/bankroll.ts`.
 */
async function placeAutoBet(signal: TradeSignal, balance: number): Promise<PlacedBet | null> {
  if (!supabase) return null

  const stake = signal.suggestedStake
  const price = signal.marketPrice

  if (!Number.isFinite(stake) || !Number.isFinite(price) || stake <= 0 || price <= 0 || price >= 1) {
    return null
  }
  if (stake > balance) return null

  const roundedStake = Math.round(stake * 100) / 100
  const shares = roundedStake / price
  const potentialPayout = Math.round(shares * 100) / 100
  const now = new Date().toISOString()
  const newBalance = Math.round((balance - roundedStake) * 100) / 100

  const activeSignals = signal.probabilityBreakdown?.activeSignals

  const { error: posErr } = await supabase.from('positions').insert({
    id: generateId('pos'),
    market_id: signal.marketId,
    market_title: signal.title,
    market_slug: signal.slug,
    outcome: signal.recommendedOutcome,
    stake: roundedStake,
    price,
    shares,
    potential_payout: potentialPayout,
    signal_edge: signal.edgePct / 100,
    our_probability: signal.ourProbability,
    status: 'open',
    placed_at: now,
    resolved_at: null,
    profit: null,
    signal_source: 'auto',
    signal_count: signal.signalCount ?? null,
    signal_strength: signal.signalStrength ?? null,
    active_volume_spike: activeSignals?.volumeSpike ?? null,
    active_price_momentum: activeSignals?.priceMomentum ?? null,
    active_stale_market: activeSignals?.staleMarket ?? null,
  })

  if (posErr) {
    console.error('[cron/auto-bet] insert position failed:', posErr.message)
    return null
  }

  const { error: snapErr } = await supabase
    .from('bankroll_snapshots')
    .insert({ balance: newBalance })

  if (snapErr) {
    console.error('[cron/auto-bet] insert snapshot failed:', snapErr.message)
  }

  return {
    marketId: signal.marketId,
    title: signal.title,
    outcome: signal.recommendedOutcome,
    stake: roundedStake,
    edgePct: signal.edgePct,
  }
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const provided = request.headers.get('x-cron-secret')

  if (!cronSecret || provided !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase is not configured', placed: [] },
      { status: 200 },
    )
  }

  try {
    const markets = await fetchMarkets(request)
    const signals = buildSignals(markets)
    const candidates = signals.filter(isAutoBetCandidate).slice(0, MAX_BETS_PER_RUN)

    const placed: PlacedBet[] = []
    let balance = await fetchCurrentBalance()

    for (const signal of candidates) {
      console.log(
        `[cron/auto-bet] candidate marketId=${signal.marketId} edgePct=${signal.edgePct} ` +
          `stake=${signal.suggestedStake} balance=${balance}`,
      )
      const bet = await placeAutoBet(signal, balance)
      if (!bet) {
        console.log(`[cron/auto-bet] skipped marketId=${signal.marketId} — placeAutoBet returned null`)
        continue
      }
      balance = Math.round((balance - bet.stake) * 100) / 100
      placed.push(bet)
    }

    return NextResponse.json({
      evaluatedSignals: signals.length,
      candidates: candidates.length,
      placed,
      fetchedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[cron/auto-bet] run failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Auto-bet run failed' },
      { status: 500 },
    )
  }
}
