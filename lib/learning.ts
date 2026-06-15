/**
 * Closed-loop learning layer — turns resolved bet history into corrections the
 * signal engine applies to FUTURE bets. Three layers, all derived from the
 * same resolved-position history and all degrading to "no change" at cold
 * start:
 *
 *   Layer 1 — per-signal reliability multipliers
 *     For each structural signal (volume-spike / momentum / stale) we compare
 *     the edge it CLAIMED (ourProbability − price) against the edge that
 *     actually materialised (outcome − price), across every resolved bet where
 *     that signal fired. The ratio (shrunk toward 1 by sample count) becomes a
 *     multiplier on that signal's nudge in `lib/probability.ts`. A signal that
 *     never delivered → multiplier → 0 → its nudge vanishes → it's effectively
 *     retired. One that under-claimed → multiplier > 1 (capped).
 *
 *   Layer 2 — global confidence-scaled Kelly
 *     Across all resolved structural bets, if we won a smaller fraction than we
 *     predicted (overconfident), we shrink the Kelly fraction by that ratio —
 *     automatic fractional Kelly that tightens exactly as much as the data says
 *     we're miscalibrated.
 *
 *   Layer 3 — per-signal & per-combo win rates (diagnostic)
 *     Win rate + Wilson CI for each individual signal and for each combination
 *     that fired, so you can SEE which signals carry edge and which are dead
 *     weight (this is what Layer 1 acts on automatically).
 *
 * Attribution caveat: a bet where two signals fired counts toward BOTH signals'
 * reliability — this is correlational, not a causal decomposition. The combo
 * table (Layer 3) isolates single-signal bets so you can sanity-check.
 *
 * Pure functions only — fed `closedPositions` from the bankroll store, which
 * carry the signal metadata captured at bet time (`store/bankroll.ts`).
 */

import type { Position, TradeSignalSource } from './types'
import type { SignalReliability } from './probability'
import { clamp, wilsonInterval } from './utils'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Resolved bets required before any layer leaves its cold-start default. */
export const MIN_ACTIVE_SAMPLES = 20

/**
 * Pseudo-count for the per-signal reliability shrinkage. A signal needs ~this
 * many bets before its realised ratio outweighs the neutral 1.0 prior.
 */
export const RELIABILITY_PRIOR = 10

/** Cap on a single signal's nudge multiplier — never amplify a nudge >1.5×. */
export const MAX_RELIABILITY = 1.5

/** Never shrink Kelly below this fraction of full, however miscalibrated. */
export const MIN_KELLY_MULTIPLIER = 0.25

/** Below this much claimed edge a signal carries no usable ratio signal. */
const CLAIMED_EDGE_EPSILON = 1e-6

const SIGNAL_KEYS = ['volumeSpike', 'priceMomentum', 'staleMarket'] as const
type SignalKey = (typeof SIGNAL_KEYS)[number]

const SIGNAL_LABELS: Record<SignalKey, string> = {
  volumeSpike: 'Volume spike',
  priceMomentum: 'Price momentum',
  staleMarket: 'Stale market',
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface SignalWinStats {
  key: SignalKey
  label: string
  bets: number
  wins: number
  winRate: number
  /** Wilson 95% CI on the win rate. */
  lower: number
  upper: number
  /** Mean edge the signal claimed (ourProbability − price). */
  claimedEdge: number
  /** Mean edge that materialised (outcome − price). */
  realizedEdge: number
  /** The shrunk multiplier fed back into the nudge (Layer 1). */
  reliability: number
  /** True once `bets >= MIN_ACTIVE_SAMPLES` and reliability is near zero. */
  retired: boolean
}

export interface ComboWinStats {
  label: string
  bets: number
  wins: number
  winRate: number
  lower: number
  upper: number
}

export interface LearnedModel {
  /** Layer 1 — per-signal nudge multipliers, ready to pass to probability.ts. */
  reliability: SignalReliability
  /** Layer 2 — global Kelly fraction multiplier in [MIN_KELLY_MULTIPLIER, 1]. */
  kellyMultiplier: number
  /** Layer 3 — per-signal diagnostics. */
  signalStats: SignalWinStats[]
  /** Layer 3 — per-combination diagnostics (single + multi-signal). */
  comboStats: ComboWinStats[]
  /** Mean (predicted − actual) across structural bets. +ve = overconfident. */
  overconfidence: number
  brierScore: number
  /** Resolved structural bets feeding the model. */
  totalSamples: number
  /** True once the model has enough data to leave cold-start defaults. */
  active: boolean
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Position → resolved-bet extraction
// ---------------------------------------------------------------------------

interface ResolvedBet {
  /** Probability we assigned to the side we bet. */
  predicted: number
  /** Entry price of the side we bet. */
  price: number
  outcome: 0 | 1
  source: TradeSignalSource
  active: { volumeSpike: boolean; priceMomentum: boolean; staleMarket: boolean } | null
  signalCount: number | null
}

/** Fallback when a (legacy) position never recorded its `signalSource`. */
const ODDS_API_EDGE_PROXY = 0.08

function resolvedBetsFrom(positions: Position[]): ResolvedBet[] {
  const bets: ResolvedBet[] = []
  for (const p of positions) {
    if (p.status !== 'won' && p.status !== 'lost') continue
    if (!Number.isFinite(p.price)) continue

    const edge = Number.isFinite(p.signalEdge) ? p.signalEdge : 0
    const predicted = clamp(
      Number.isFinite(p.ourProbability ?? NaN) ? (p.ourProbability as number) : p.price + edge,
      0.01,
      0.99,
    )
    const source: TradeSignalSource =
      p.signalSource === 'odds_api' || p.signalSource === 'structural'
        ? p.signalSource
        : Math.abs(edge) > ODDS_API_EDGE_PROXY
          ? 'odds_api'
          : 'structural'

    bets.push({
      predicted,
      price: p.price,
      outcome: p.status === 'won' ? 1 : 0,
      source,
      active: p.activeSignals ?? null,
      signalCount: p.signalCount ?? null,
    })
  }
  return bets
}

// ---------------------------------------------------------------------------
// Layer 1 — per-signal reliability
// ---------------------------------------------------------------------------

function signalStatsFor(key: SignalKey, structural: ResolvedBet[]): SignalWinStats {
  const members = structural.filter((b) => b.active?.[key])
  const bets = members.length
  const wins = members.reduce((acc, b) => acc + b.outcome, 0)
  const winRate = bets > 0 ? wins / bets : 0
  const { lower, upper } = wilsonInterval(wins, bets)

  const sumClaimed = members.reduce((acc, b) => acc + (b.predicted - b.price), 0)
  const sumRealized = members.reduce((acc, b) => acc + (b.outcome - b.price), 0)
  const claimedEdge = bets > 0 ? sumClaimed / bets : 0
  const realizedEdge = bets > 0 ? sumRealized / bets : 0

  // Ratio of realised to claimed edge, clamped non-negative (a signal that
  // points the wrong way is retired, not inverted), then shrunk toward 1.0 by
  // the prior so sparse signals stay near their default weight.
  const ratio =
    Math.abs(sumClaimed) > CLAIMED_EDGE_EPSILON
      ? Math.max(0, sumRealized / sumClaimed)
      : 1
  const shrunk = (bets * ratio + RELIABILITY_PRIOR * 1) / (bets + RELIABILITY_PRIOR)
  const reliability = clamp(shrunk, 0, MAX_RELIABILITY)

  return {
    key,
    label: SIGNAL_LABELS[key],
    bets,
    wins,
    winRate,
    lower,
    upper,
    claimedEdge,
    realizedEdge,
    reliability,
    retired: bets >= MIN_ACTIVE_SAMPLES && reliability < 0.1,
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — combination win rates
// ---------------------------------------------------------------------------

function comboLabel(active: ResolvedBet['active']): string {
  if (!active) return 'Unattributed'
  const parts = SIGNAL_KEYS.filter((k) => active[k]).map((k) => SIGNAL_LABELS[k])
  if (parts.length === 0) return 'Unattributed'
  if (parts.length === 1) return `${parts[0]} only`
  return parts.join(' + ')
}

function comboStatsFrom(structural: ResolvedBet[]): ComboWinStats[] {
  const groups = new Map<string, ResolvedBet[]>()
  for (const b of structural) {
    if (!b.active) continue
    const label = comboLabel(b.active)
    const arr = groups.get(label) ?? []
    arr.push(b)
    groups.set(label, arr)
  }

  const stats: ComboWinStats[] = []
  for (const [label, members] of groups) {
    const bets = members.length
    const wins = members.reduce((acc, b) => acc + b.outcome, 0)
    const { lower, upper } = wilsonInterval(wins, bets)
    stats.push({ label, bets, wins, winRate: bets > 0 ? wins / bets : 0, lower, upper })
  }
  return stats.sort((a, b) => b.bets - a.bets)
}

// ---------------------------------------------------------------------------
// Layer 2 + aggregate metrics
// ---------------------------------------------------------------------------

function brierFrom(bets: ResolvedBet[]): number {
  if (bets.length === 0) return 0.25
  const sum = bets.reduce((acc, b) => {
    const d = b.predicted - b.outcome
    return acc + d * d
  }, 0)
  return sum / bets.length
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

export function buildLearnedModel(positions: Position[]): LearnedModel {
  const bets = resolvedBetsFrom(positions)
  const structural = bets.filter((b) => b.source === 'structural')
  const totalSamples = structural.length
  const active = totalSamples >= MIN_ACTIVE_SAMPLES

  const signalStats = SIGNAL_KEYS.map((k) => signalStatsFor(k, structural))

  // Cold start: hand back neutral defaults so the engine is untouched.
  const reliability: SignalReliability = active
    ? {
        volumeSpike: signalStats[0].reliability,
        priceMomentum: signalStats[1].reliability,
        staleMarket: signalStats[2].reliability,
      }
    : { volumeSpike: 1, priceMomentum: 1, staleMarket: 1 }

  const meanPredicted =
    totalSamples > 0
      ? structural.reduce((acc, b) => acc + b.predicted, 0) / totalSamples
      : 0
  const actualWinRate =
    totalSamples > 0
      ? structural.reduce((acc, b) => acc + b.outcome, 0) / totalSamples
      : 0
  const overconfidence = meanPredicted - actualWinRate

  // Layer 2: shrink Kelly by the ratio of realised to predicted win rate when
  // overconfident; never amplify (cap at 1) and never collapse (floor).
  const kellyMultiplier =
    active && meanPredicted > 0
      ? clamp(actualWinRate / meanPredicted, MIN_KELLY_MULTIPLIER, 1)
      : 1

  return {
    reliability,
    kellyMultiplier,
    signalStats,
    comboStats: comboStatsFrom(structural),
    overconfidence,
    brierScore: brierFrom(structural),
    totalSamples,
    active,
    generatedAt: new Date().toISOString(),
  }
}
