/**
 * Signal engine — turns a list of `Market`s into a ranked list of trade ideas.
 *
 * Phase 2 uses a deliberately simple "our probability" model:
 *
 *   ourP = yesPrice + shrink * (0.5 - yesPrice)
 *
 * i.e. we shrink the market price slightly toward 50/50 (default shrink = 0.10).
 * The intuition: in practice, retail prediction markets tend to be a bit
 * over-confident at the extremes. This is a placeholder model — Phase 3
 * will swap in news/odds-based estimates without changing this file's
 * public surface.
 *
 * For each market we then:
 *   1. Pick the side that has positive edge under our `ourP` estimate.
 *   2. Size it with the Kelly criterion from `lib/kelly.ts`.
 *   3. Convert that to a £-stake against a £1,000 bankroll.
 *   4. Compute a £-EV and confidence bucket for ranking / display.
 *
 * Signals with no positive edge (Kelly fraction = 0) are filtered out.
 * The result is sorted by expected value (£) descending.
 */

import { expectedValue, kellyFraction, suggestedStake } from './kelly'
import type { Market, Outcome } from './types'

export const SIGNAL_BANKROLL = 1000
export const SIGNAL_SHRINK = 0.1
/** Minimum £-stake before we bother showing a signal. */
export const MIN_SUGGESTED_STAKE = 1

export type SignalConfidence = 'high' | 'medium' | 'low'

export interface TradeSignal {
  marketId: string
  title: string
  slug: string
  recommendedOutcome: Outcome
  marketPrice: number
  ourProbability: number
  edgePct: number
  kellyFraction: number
  suggestedStake: number
  expectedValue: number
  confidence: SignalConfidence
}

interface BuildSignalsOptions {
  bankroll?: number
  shrink?: number
  minStake?: number
}

/**
 * Compute trade signals for a list of markets, sorted by £-EV desc.
 */
export function buildSignals(
  markets: Market[],
  options: BuildSignalsOptions = {},
): TradeSignal[] {
  const bankroll = options.bankroll ?? SIGNAL_BANKROLL
  const shrink = options.shrink ?? SIGNAL_SHRINK
  const minStake = options.minStake ?? MIN_SUGGESTED_STAKE

  const signals: TradeSignal[] = []

  for (const market of markets) {
    const signal = signalForMarket(market, { bankroll, shrink })
    if (!signal) continue
    if (signal.suggestedStake < minStake) continue
    signals.push(signal)
  }

  // Sort by £-EV descending. EV per £ from `expectedValue()` already accounts
  // for Polymarket's flat 2% fee assumption, so multiplying by the £-stake
  // gives the proper expected profit per bet.
  signals.sort((a, b) => b.expectedValue - a.expectedValue)
  return signals
}

function signalForMarket(
  market: Market,
  { bankroll, shrink }: { bankroll: number; shrink: number },
): TradeSignal | null {
  const yes = market.yesPrice
  if (!Number.isFinite(yes) || yes <= 0 || yes >= 1) return null
  const no = Number.isFinite(market.noPrice) && market.noPrice > 0 && market.noPrice < 1
    ? market.noPrice
    : 1 - yes

  // Shrinkage-to-0.5 model. When yesPrice < 0.5, ourP_yes > yesPrice → YES has edge.
  // When yesPrice > 0.5, ourP_yes < yesPrice → NO has edge.
  const ourP = clampProbability(yes + shrink * (0.5 - yes))

  // Score YES and NO sides independently, take the side with the best Kelly.
  const yesSide = evaluateSide('YES', ourP, yes, bankroll)
  const noSide = evaluateSide('NO', 1 - ourP, no, bankroll)

  const best = pickBestSide(yesSide, noSide)
  if (!best || best.kelly <= 0) return null

  const edgePct = (best.ourP - best.marketPrice) * 100

  return {
    marketId: market.id,
    title: market.title,
    slug: market.slug,
    recommendedOutcome: best.outcome,
    marketPrice: best.marketPrice,
    ourProbability: best.ourP,
    edgePct,
    kellyFraction: best.kelly,
    suggestedStake: best.stake,
    expectedValue: best.evGbp,
    confidence: bucketConfidence(edgePct),
  }
}

interface SideEvaluation {
  outcome: Outcome
  ourP: number
  marketPrice: number
  kelly: number
  stake: number
  evGbp: number
}

function evaluateSide(
  outcome: Outcome,
  ourP: number,
  marketPrice: number,
  bankroll: number,
): SideEvaluation {
  const kelly = kellyFraction(ourP, marketPrice)
  const stake = suggestedStake(bankroll, kelly)
  const evPerPound = expectedValue(ourP, marketPrice)
  const evGbp = Math.round(evPerPound * stake * 100) / 100
  return { outcome, ourP, marketPrice, kelly, stake, evGbp }
}

function pickBestSide(
  a: SideEvaluation,
  b: SideEvaluation,
): SideEvaluation | null {
  if (a.kelly <= 0 && b.kelly <= 0) return null
  if (a.kelly <= 0) return b
  if (b.kelly <= 0) return a
  return a.evGbp >= b.evGbp ? a : b
}

function bucketConfidence(edgePct: number): SignalConfidence {
  const abs = Math.abs(edgePct)
  if (abs >= 7) return 'high'
  if (abs >= 4) return 'medium'
  return 'low'
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  if (p < 0.01) return 0.01
  if (p > 0.99) return 0.99
  return p
}
