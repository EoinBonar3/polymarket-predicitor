/**
 * GET /api/cron/auto-bet
 *
 * Vercel Cron entry point for fully-automated paper trading.
 *
 * IMPORTANT (Phase 0 change): this cron now bets ONLY on *anchored* signals —
 * markets matched to an independent external reference. The three structural
 * signals (volume spike / momentum / stale) are heuristics with no external
 * reference point, so auto-betting them was feeding the closed-loop learner a
 * training set of pure noise. They are no longer placed here. (They still
 * exist for manual inspection on the dashboard and are logged as features;
 * they're just not auto-traded.)
 *
 * Two anchors feed auto-betting:
 *   - `odds_api`: markets matched to The Odds API's vig-removed bookmaker
 *     consensus (`lib/marketMatcher.ts`).
 *   - `kalshi` (Phase 2): markets matched to a Kalshi market for the same
 *     event, confirmed by Gemini (`lib/sources/kalshi.ts`). Gated on
 *     `isSameEvent` (LLM-confirmed match), resolution-match confidence
 *     ≥ `KALSHI_MIN_RESOLUTION_CONFIDENCE`, and a raw edge of at least
 *     `KALSHI_MIN_EDGE_PP` between Kalshi's YES price and Polymarket's.
 *
 * On each run we:
 *   1. Pull the current market feed from our own `/api/markets` proxy.
 *   2. Fetch sports odds from our own `/api/odds/*` proxy — quota-guarded, so
 *      the cron auto-stops before it can exhaust the free-tier budget.
 *   3. Match markets to events (`lib/marketMatcher.ts`) → anchored `TradeSignal`s.
 *   4. Fetch Kalshi markets and run the Gemini-gated cross-market matcher
 *      (`lib/sources/kalshi.ts`) → anchored `TradeSignal`s.
 *   5. Place up to `MAX_BETS_PER_RUN` paper bets (highest-EV first), writing
 *      straight to Supabase the same way `store/bankroll.ts`'s `placeBet` does.
 *
 * Each bet's `signal_source` records the *signal's* real source (`odds_api`
 * or `kalshi`) so the per-source learner (`lib/learning.ts`) attributes
 * realised performance correctly — both anchors accumulate calibration data
 * in the same per-source tables, no separate wiring needed.
 *
 * Auth: requires header `x-cron-secret` to match `process.env.CRON_SECRET`.
 */

import { NextResponse } from 'next/server'

import { SIGNAL_BANKROLL, MIN_SUGGESTED_STAKE } from '@/lib/signals'
import { buildOddsTradeSignal, matchMarketToEvent } from '@/lib/marketMatcher'
import { buildKalshiTradeSignal, createKalshiSource } from '@/lib/sources/kalshi'
import { fetchKalshiMarkets, type KalshiMarket } from '@/lib/sources/kalshiApi'
import { buildLearnedModel, correctionForSource } from '@/lib/learning'
import type { OddsApiEvent } from '@/lib/oddsApi'
import { supabase } from '@/lib/supabase'
import { fetchAllData } from '@/lib/supabaseSync'
import { generateId } from '@/lib/utils'
import type { ApiResponse, Market, TradeSignal } from '@/lib/types'

export const runtime = 'nodejs'

/** Minimum raw edge (percentage points) for an Odds-API anchored signal to be auto-traded. */
const AUTO_BET_MIN_EDGE_PP = 4

/**
 * Minimum raw edge (percentage points) between Kalshi's YES price and
 * Polymarket's for a Kalshi-anchored signal to be auto-traded.
 */
const KALSHI_MIN_EDGE_PP = 6

/**
 * Minimum Gemini resolution-match confidence (`SourceEstimate.resolutionMatchConfidence`)
 * for a Kalshi match to be trusted for auto-betting. Higher than
 * `createKalshiSource`'s default `llmMinConfidence` (0.7) — auto-betting
 * demands more certainty than surfacing a signal on the dashboard.
 */
const KALSHI_MIN_RESOLUTION_CONFIDENCE = 0.85

/** Max Polymarket markets evaluated against Kalshi per run — bounds Gemini calls. */
const MAX_KALSHI_MARKETS_PER_RUN = 20

/** Max number of paper bets placed per cron run. */
const MAX_BETS_PER_RUN = 3

/**
 * Max sports fetched per run. Each sport burns at most one Odds API credit
 * (the `/api/odds/events` proxy caches 5 min, so back-to-back runs inside that
 * window are free). Kept low because the free tier is 500 requests/month and
 * the manual dashboard competes for the same budget.
 */
const MAX_SPORTS_PER_RUN = 3

/**
 * If the Odds API reports fewer than this many requests remaining, the cron
 * skips odds fetching entirely (and therefore places nothing) rather than
 * eat into the headroom the manual dashboard needs. The safety valve that
 * stops an over-frequent cron schedule from exhausting the monthly quota.
 */
const ODDS_QUOTA_FLOOR = 50

/** Only anchored (external-reference) signals are ever auto-traded. */
function isAutoBetCandidate(signal: TradeSignal): boolean {
  if (signal.signalSource === 'odds_api') {
    return Math.abs(signal.edgePct) >= AUTO_BET_MIN_EDGE_PP
  }
  if (signal.signalSource === 'kalshi') {
    return Math.abs(signal.edgePct) >= KALSHI_MIN_EDGE_PP
  }
  return false
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

/**
 * Fetch sports odds via our own quota-forwarding proxy. Returns `[]` (so the
 * cron places nothing) whenever the key is unconfigured, the quota is below
 * `ODDS_QUOTA_FLOOR`, or any upstream call fails — anchored-or-nothing.
 */
async function fetchOddsEvents(request: Request): Promise<OddsApiEvent[]> {
  const sportsUrl = new URL('/api/odds/sports', request.url)
  const sportsRes = await fetch(sportsUrl, { headers: { Accept: 'application/json' } })
  if (!sportsRes.ok) {
    console.warn(`[cron/auto-bet] odds sports fetch failed (${sportsRes.status}) — skipping odds`)
    return []
  }

  let remaining = Number(sportsRes.headers.get('x-requests-remaining'))
  if (Number.isFinite(remaining) && remaining < ODDS_QUOTA_FLOOR) {
    console.warn(
      `[cron/auto-bet] odds quota low (${remaining} < ${ODDS_QUOTA_FLOOR}) — skipping odds this run`,
    )
    return []
  }

  const sportsBody = (await sportsRes.json()) as { sports?: string[] }
  const sports = (sportsBody.sports ?? []).slice(0, MAX_SPORTS_PER_RUN)

  const events: OddsApiEvent[] = []
  for (const sport of sports) {
    if (Number.isFinite(remaining) && remaining < ODDS_QUOTA_FLOOR) {
      console.warn(`[cron/auto-bet] odds quota dipped below floor mid-run — stopping at ${events.length} events`)
      break
    }
    const eventsUrl = new URL(`/api/odds/events?sport=${encodeURIComponent(sport)}`, request.url)
    const eventsRes = await fetch(eventsUrl, { headers: { Accept: 'application/json' } })
    if (!eventsRes.ok) {
      console.warn(`[cron/auto-bet] odds events fetch failed for ${sport} (${eventsRes.status})`)
      continue
    }
    const headerRemaining = Number(eventsRes.headers.get('x-requests-remaining'))
    if (Number.isFinite(headerRemaining)) remaining = headerRemaining
    const eventsBody = (await eventsRes.json()) as { events?: OddsApiEvent[] }
    events.push(...(eventsBody.events ?? []))
  }

  return events
}

/** Match every market against the fetched events; anchored signals only, EV desc. */
function buildAnchoredSignals(markets: Market[], events: OddsApiEvent[]): TradeSignal[] {
  if (events.length === 0) return []
  const signals: TradeSignal[] = []
  for (const market of markets) {
    const match = matchMarketToEvent(market, events)
    if (!match) continue
    const signal = buildOddsTradeSignal(market, match)
    if (!signal) continue
    signals.push(signal)
  }
  signals.sort((a, b) => b.expectedValue - a.expectedValue)
  return signals
}

/**
 * Fetch liquid, non-sports Kalshi markets for cross-market matching. Returns
 * `[]` on any upstream failure — Kalshi is a "nice to have" anchor, never
 * worth failing the whole cron run over.
 */
async function fetchKalshiMarketsForCron(): Promise<KalshiMarket[]> {
  try {
    return await fetchKalshiMarkets({ maxPages: 4, minVolume: 100 })
  } catch (error) {
    console.warn(
      `[cron/auto-bet] kalshi markets fetch failed: ${error instanceof Error ? error.message : error}`,
    )
    return []
  }
}

/**
 * Run the Gemini-gated Kalshi matcher over (at most `MAX_KALSHI_MARKETS_PER_RUN`)
 * markets. Only LLM-confirmed same-event matches with resolution-match
 * confidence ≥ `KALSHI_MIN_RESOLUTION_CONFIDENCE` and a raw edge ≥
 * `KALSHI_MIN_EDGE_PP` produce a `TradeSignal`. EV desc.
 */
async function buildKalshiSignals(markets: Market[], kalshiMarkets: KalshiMarket[]): Promise<TradeSignal[]> {
  if (kalshiMarkets.length === 0) return []

  const source = createKalshiSource(kalshiMarkets)
  const signals: TradeSignal[] = []

  for (const market of markets.slice(0, MAX_KALSHI_MARKETS_PER_RUN)) {
    const { estimate, debug } = await source.evaluate({
      id: market.id,
      title: market.title,
      endDate: market.endDate,
    })
    if (!estimate) continue
    // Only the LLM path confirms `isSameEvent` — the lexical fallback is off
    // by default and isn't trustworthy enough for auto-betting regardless.
    if (debug.matchedBy !== 'llm') continue
    if (estimate.resolutionMatchConfidence < KALSHI_MIN_RESOLUTION_CONFIDENCE) continue
    if (Math.abs(estimate.ourP - market.yesPrice) * 100 < KALSHI_MIN_EDGE_PP) continue

    const signal = buildKalshiTradeSignal(market, estimate)
    if (!signal) continue
    signals.push(signal)
  }

  signals.sort((a, b) => b.expectedValue - a.expectedValue)
  return signals
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
  source: string
}

/**
 * Place a single auto bet: insert the `positions` row (tagged with the
 * signal's real `signal_source`) and a fresh `bankroll_snapshots` row,
 * mirroring `placeBet` in `store/bankroll.ts`.
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
    // The signal's *real* source (`odds_api` or `kalshi`) so the per-source
    // learner attributes it correctly. Reads from the signal so future
    // anchors (deribit, …) flow through unchanged.
    signal_source: signal.signalSource ?? 'odds_api',
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
    source: signal.signalSource ?? 'odds_api',
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
    const events = await fetchOddsEvents(request)
    const oddsSignals = buildAnchoredSignals(markets, events)

    const kalshiMarkets = await fetchKalshiMarketsForCron()
    const kalshiSignals = await buildKalshiSignals(markets, kalshiMarkets)

    const signals = [...oddsSignals, ...kalshiSignals].sort(
      (a, b) => b.expectedValue - a.expectedValue,
    )
    const eligible = signals.filter(isAutoBetCandidate)

    // Closed-loop correction: learn from resolved bets, then steer FUTURE
    // stakes. Disabled sources (realised edge ≤ 0 over a real sample) are
    // dropped entirely; overconfident sources have their stake shrunk by the
    // per-source Kelly multiplier (`lib/learning.ts`). Applied BEFORE the
    // per-run cap so a disabled source frees its slot for the next-best signal.
    const learned = await fetchAllData()
    const model = buildLearnedModel(learned?.positions ?? [])

    const appliedCorrections: Array<{
      source: string
      enabled: boolean
      kellyMultiplier: number
      samples: number
      reason: string
    }> = []
    const seenSources = new Set<string>()
    const corrected: TradeSignal[] = []

    for (const signal of eligible) {
      const source = signal.signalSource ?? 'odds_api'
      const correction = correctionForSource(model, source)
      if (!seenSources.has(source)) {
        seenSources.add(source)
        appliedCorrections.push({
          source,
          enabled: correction.enabled,
          kellyMultiplier: correction.kellyMultiplier,
          samples: correction.samples,
          reason: correction.reason,
        })
      }
      if (!correction.enabled) continue
      const scaledStake = Math.round(signal.suggestedStake * correction.kellyMultiplier * 100) / 100
      if (scaledStake < MIN_SUGGESTED_STAKE) continue
      corrected.push({ ...signal, suggestedStake: scaledStake })
    }

    const candidates = corrected.slice(0, MAX_BETS_PER_RUN)

    const placed: PlacedBet[] = []
    let balance = await fetchCurrentBalance()

    for (const signal of candidates) {
      console.log(
        `[cron/auto-bet] candidate marketId=${signal.marketId} source=${signal.signalSource} ` +
          `edgePct=${signal.edgePct} stake=${signal.suggestedStake} balance=${balance}`,
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
      evaluatedMarkets: markets.length,
      oddsEvents: events.length,
      oddsSignals: oddsSignals.length,
      kalshiMarkets: kalshiMarkets.length,
      kalshiSignals: kalshiSignals.length,
      anchoredSignals: signals.length,
      eligible: eligible.length,
      candidates: candidates.length,
      placed,
      learner: {
        active: model.active,
        totalSamples: model.totalSamples,
        corrections: appliedCorrections,
      },
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
