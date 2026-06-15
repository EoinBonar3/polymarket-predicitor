/**

 * Signal engine — turns a list of `Market`s into a ranked list of trade ideas.

 *

 * The "our probability" estimate comes from the 3-signal structural model in
 * `lib/probability.ts` (`computeStructuralSignal`): volume spike, price
 * momentum, and stale-market gates. At least 1 of 3 must fire before ourP
 * is produced. Each `TradeSignal` carries the per-signal breakdown so the
 * UI can render contribution bars.

 *

 * For each market we then:

 *   1. Pick the side that has positive edge under our blended `ourP`.

 *   2. Size it with the Kelly criterion from `lib/kelly.ts`.

 *   3. Convert that to a £-stake against a £1,000 bankroll.

 *   4. Compute a £-EV and confidence bucket for ranking / display.

 *

 * Signals with no positive edge (Kelly fraction = 0) are filtered out.

 * The result is sorted by expected value (£) descending.

 */



import { expectedValue, kellyFraction, suggestedStake } from './kelly'

import { computeStructuralSignal } from './probability'

import type { LearnedModel } from './learning'

import { syncLogSuppression } from './supabaseSync'

import type {

  Market,

  Outcome,

  TradeSignal,

  TradeSignalConfidence,

} from './types'



// Re-export the moved types so existing callers (`@/lib/signals`) keep

// working — the canonical home of `TradeSignal` is now `lib/types.ts`.

export type { TradeSignal, TradeSignalConfidence } from './types'



export const SIGNAL_BANKROLL = 1000

/** Minimum £-stake before we bother showing a signal. */

export const MIN_SUGGESTED_STAKE = 1



/**

 * Structural signals on markets priced < 10% or > 90% YES are mostly

 * shrinkage noise: a 3% market gets pulled toward ~9% on principle alone

 * (the blender distrusts extreme prices) which manufactures phantom edge

 * with no event-specific information behind it. We drop those markets

 * here. Odds-API signals are NOT subject to this filter — bookmaker

 * consensus is a real prior even on lopsided fixtures.

 */

const STRUCTURAL_PRICE_FLOOR = 0.08

const STRUCTURAL_PRICE_CEIL = 0.92



/**

 * Minimum raw edge (probability points, e.g. 0.08 = 8 pp) for a

 * structural signal to be surfaced. Raised to 7 pp now that the structural

 * gate fires on a single signal: a lone weak nudge (e.g. stale = +3 pp) must

 * NOT clear the bar on its own, while a clear volume-spike/momentum lean — or

 * two agreeing signals — comfortably does.

 *

 * Odds-API signals retain the 5% threshold (enforced upstream in their

 * own pipeline) since bookmaker consensus is a much stronger prior.

 */

const STRUCTURAL_MIN_EDGE = 0.04



/** Per-market structural pipeline outcome when `buildSignals({ debug: true })`. */

export interface SignalDebugEvaluation {

  marketId: string

  title: string

  slug: string

  yesPrice: number

  noPrice: number

  qualified: boolean
  /** Short label for grouping in the debug UI (e.g. "Edge too small"). */
  rejectionCategory: string | null
  rejectionReason: string | null

  ourProbability?: number

  edgePct?: number

  kellyFraction?: number

  suggestedStake?: number

  expectedValue?: number

  recommendedOutcome?: Outcome

}



interface BuildSignalsOptions {

  bankroll?: number

  minStake?: number

  debug?: boolean

  /**
   * Learned calibration model (from resolved bet history). When supplied and
   * active, `ourProbability` is remapped through it before edge / Kelly so the
   * engine bets on calibrated belief, not the raw structural nudges. Omit (or
   * pass an inactive model) and the engine behaves exactly as before.
   */
  calibration?: LearnedModel

}



interface MarketEvaluation {
  rejectionCategory: string | null
  rejectionReason: string | null

  signal: TradeSignal | null

  yesPrice: number

  noPrice: number

  ourProbability?: number

  edgePct?: number

  kellyFraction?: number

  suggestedStake?: number

  expectedValue?: number

  recommendedOutcome?: Outcome

}



/**

 * Compute trade signals for a list of markets, sorted by £-EV desc.

 *

 * When `options.debug === true`, returns every evaluated market with a

 * `rejectionReason` instead of only qualified `TradeSignal`s.

 */

export function buildSignals(

  markets: Market[],

  options: BuildSignalsOptions & { debug: true },

): SignalDebugEvaluation[]

export function buildSignals(

  markets: Market[],

  options?: BuildSignalsOptions & { debug?: false },

): TradeSignal[]

export function buildSignals(

  markets: Market[],

  options: BuildSignalsOptions = {},

): TradeSignal[] | SignalDebugEvaluation[] {

  const bankroll = options.bankroll ?? SIGNAL_BANKROLL

  const minStake = options.minStake ?? MIN_SUGGESTED_STAKE

  const debug = options.debug === true



  if (debug) {

    const evaluations: SignalDebugEvaluation[] = []



    for (const market of markets) {

      const result = evaluateMarket(market, { bankroll, calibration: options.calibration })

      let rejectionCategory = result.rejectionCategory
      let rejectionReason = result.rejectionReason

      if (!rejectionReason && result.signal && result.signal.suggestedStake < minStake) {
        rejectionCategory = 'Stake too small'
        rejectionReason = `Suggested stake is only £${result.signal.suggestedStake.toFixed(2)} — below the £${minStake} minimum.`
      }

      const qualified = rejectionReason == null && result.signal != null

      evaluations.push({
        marketId: market.id,
        title: market.title,
        slug: market.slug,
        yesPrice: result.yesPrice,
        noPrice: result.noPrice,
        qualified,
        rejectionCategory: qualified ? null : rejectionCategory,
        rejectionReason: qualified ? null : rejectionReason,

        ourProbability: result.ourProbability,

        edgePct: result.edgePct,

        kellyFraction: result.kellyFraction,

        suggestedStake: result.suggestedStake,

        expectedValue: result.expectedValue,

        recommendedOutcome: result.recommendedOutcome,

      })

    }



    console.info(

      `[signals] debug evaluation: ${evaluations.length} markets, ` +

        `${evaluations.filter((e) => e.qualified).length} qualified`,

    )



    return evaluations

  }



  const signals: TradeSignal[] = []



  for (const market of markets) {

    const result = evaluateMarket(market, { bankroll, calibration: options.calibration })

    if (!result.signal) continue

    if (result.signal.suggestedStake < minStake) continue

    signals.push(result.signal)

  }



  // Sort by £-EV descending. EV per £ from `expectedValue()` already accounts

  // for Polymarket's flat 2% fee assumption, so multiplying by the £-stake

  // gives the proper expected profit per bet.

  signals.sort((a, b) => b.expectedValue - a.expectedValue)

  return signals

}



function pct(price: number): string {
  return `${(price * 100).toFixed(1)}%`
}

function evaluateMarket(
  market: Market,
  { bankroll, calibration }: { bankroll: number; calibration?: LearnedModel },
): MarketEvaluation {
  const yes = market.yesPrice
  const noRaw = market.noPrice

  if (!Number.isFinite(yes) || yes <= 0 || yes >= 1) {
    return {
      rejectionCategory: 'Invalid price',
      rejectionReason:
        'Market YES price is missing or stuck at 0% / 100% — nothing to trade on.',
      signal: null,
      yesPrice: yes,
      noPrice: noRaw,
    }
  }

  if (yes < STRUCTURAL_PRICE_FLOOR || yes > STRUCTURAL_PRICE_CEIL) {
    void syncLogSuppression(market, 'price_floor')
    return {
      rejectionCategory: 'Price too extreme',
      rejectionReason: `YES is ${pct(yes)} — structural signals only run between ${pct(STRUCTURAL_PRICE_FLOOR)} and ${pct(STRUCTURAL_PRICE_CEIL)}.`,
      signal: null,
      yesPrice: yes,
      noPrice: noRaw,
    }
  }

  const no =
    Number.isFinite(market.noPrice) && market.noPrice > 0 && market.noPrice < 1
      ? market.noPrice
      : 1 - yes

  // Layer 1: scale each signal's nudge by its learned reliability before the
  // probability is even formed, so `ourP` already reflects what each signal has
  // historically been worth (identity at cold start).
  const structural = computeStructuralSignal(market, {
    reliability: calibration?.reliability,
  })

  if (structural.ourP == null) {
    return {
      rejectionCategory: 'Insufficient signal consensus',
      rejectionReason: structural.rejectionReason,
      signal: null,
      yesPrice: yes,
      noPrice: noRaw,
    }
  }

  const ourP = structural.ourP
  const breakdown = structural.breakdown ?? undefined

  // Layer 2: confidence-scaled (fractional) Kelly — shrink the sizing globally
  // by how overconfident the model has historically been. 1 at cold start.
  const kellyMultiplier = calibration?.kellyMultiplier ?? 1

  const yesSide = evaluateSide('YES', ourP, yes, bankroll, kellyMultiplier)
  const noSide = evaluateSide('NO', 1 - ourP, no, bankroll, kellyMultiplier)

  const best = pickBestSide(yesSide, noSide)
  if (!best || best.kelly <= 0) {
    return {
      rejectionCategory: 'No edge',
      rejectionReason: `Model (${pct(ourP)}) roughly agrees with the market (YES ${pct(yes)}, NO ${pct(no)}) — no side looks underpriced.`,
      signal: null,
      yesPrice: yes,
      noPrice: no,
      ourProbability: ourP,
    }
  }

  const rawEdge = best.ourP - best.marketPrice

  if (Math.abs(rawEdge) < STRUCTURAL_MIN_EDGE) {
    const edgePp = Math.abs(rawEdge) * 100
    const minPp = STRUCTURAL_MIN_EDGE * 100
    return {
      rejectionCategory: 'Edge too small',
      rejectionReason: `Best side is ${best.outcome} with only ${edgePp.toFixed(1)}pp edge (model ${pct(best.ourP)} vs market ${pct(best.marketPrice)}) — need at least ${minPp.toFixed(0)}pp.`,
      signal: null,
      yesPrice: yes,
      noPrice: no,
      ourProbability: best.ourP,
      edgePct: rawEdge * 100,
      kellyFraction: best.kelly,
      suggestedStake: best.stake,
      expectedValue: best.evGbp,
      recommendedOutcome: best.outcome,
    }
  }

  const edgePct = rawEdge * 100

  const signal: TradeSignal = {
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
    probabilityBreakdown: breakdown,
    signalCount: structural.signalCount,
    signalStrength: structural.signalStrength ?? undefined,
  }

  return {
    rejectionCategory: null,
    rejectionReason: null,
    signal,
    yesPrice: yes,
    noPrice: no,
    ourProbability: best.ourP,
    edgePct,
    kellyFraction: best.kelly,
    suggestedStake: best.stake,
    expectedValue: best.evGbp,
    recommendedOutcome: best.outcome,
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

  kellyMultiplier = 1,

): SideEvaluation {

  // Full Kelly first, then the learned fractional-Kelly scalar (Layer 2).
  const kelly = kellyFraction(ourP, marketPrice) * kellyMultiplier

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



function bucketConfidence(edgePct: number): TradeSignalConfidence {

  const abs = Math.abs(edgePct)

  if (abs >= 7) return 'high'

  if (abs >= 4) return 'medium'

  return 'low'

}


