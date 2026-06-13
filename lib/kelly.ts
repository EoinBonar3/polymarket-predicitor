/**
 * Kelly Criterion sizing for binary prediction-market bets.
 *
 * Given:
 *   p = our estimated probability that the outcome resolves YES (0..1)
 *   m = current market price for the same outcome (0..1)
 *
 * Decimal odds offered by the market are b + 1 = 1 / m, so the net-odds
 * payoff per £1 staked is:
 *
 *   b = (1 / m) - 1
 *
 * The Kelly fraction is then:
 *
 *   f* = (p (b + 1) - 1) / b
 *
 * which simplifies to the well-known form:
 *
 *   f* = (p - m) / (1 - m)        // (positive only when p > m, i.e. there's edge)
 *
 * We intentionally use the (p(b+1) - 1) / b form below so the code mirrors
 * the spec one-to-one.
 *
 * The result is clamped to [0, MAX_KELLY_FRACTION] — never bet a negative
 * fraction (no edge → no bet) and never stake more than 25 % of bankroll on
 * a single market, even if full Kelly says otherwise.
 */

import { clamp } from './utils'

/** Hard cap on the fraction of bankroll Kelly is allowed to suggest. */
export const MAX_KELLY_FRACTION = 0.25

/**
 * Compute the (capped) Kelly fraction for a single binary bet.
 *
 * @param ourProbability Our model's estimated probability of the outcome (0..1).
 * @param marketPrice    The current market price for the same outcome (0..1).
 * @returns A fraction in [0, {@link MAX_KELLY_FRACTION}]. Returns `0` whenever
 *          inputs are invalid or there is no positive edge.
 */
export function kellyFraction(ourProbability: number, marketPrice: number): number {
  if (
    !Number.isFinite(ourProbability) ||
    !Number.isFinite(marketPrice) ||
    ourProbability <= 0 ||
    ourProbability >= 1 ||
    marketPrice <= 0 ||
    marketPrice >= 1
  ) {
    return 0
  }

  if (ourProbability <= marketPrice) {
    return 0
  }

  const b = 1 / marketPrice - 1
  if (b <= 0) return 0

  const fStar = (ourProbability * (b + 1) - 1) / b

  return clamp(fStar, 0, MAX_KELLY_FRACTION)
}

/**
 * Convert a Kelly fraction into a concrete £-stake against a bankroll.
 *
 * Always rounded to the nearest penny and floored at zero.
 *
 * @param bankroll Current bankroll in £.
 * @param fraction A Kelly fraction in [0, 1] (will be clamped to
 *                 [0, {@link MAX_KELLY_FRACTION}]).
 * @returns Suggested stake in £, rounded to 2 dp.
 */
export function suggestedStake(bankroll: number, fraction: number): number {
  if (
    !Number.isFinite(bankroll) ||
    !Number.isFinite(fraction) ||
    bankroll <= 0 ||
    fraction <= 0
  ) {
    return 0
  }
  const safeFraction = clamp(fraction, 0, MAX_KELLY_FRACTION)
  const raw = bankroll * safeFraction
  return Math.max(0, Math.round(raw * 100) / 100)
}

/**
 * Expected value (per £1 staked) for a binary bet at the given probability
 * and market price, accounting for Polymarket's effective spread / fee.
 *
 * Per spec, we always subtract a flat 2 % fee from the EV calculation.
 *
 *   EV = (p * (1 - m) - (1 - p) * m) - fee
 *
 * @param ourProbability Our estimated probability (0..1).
 * @param marketPrice    Current market price for the outcome (0..1).
 * @param fee            Effective fee, default 0.02 (i.e. 2 %).
 */
export function expectedValue(
  ourProbability: number,
  marketPrice: number,
  fee = 0.02,
): number {
  if (
    !Number.isFinite(ourProbability) ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0 ||
    marketPrice >= 1
  ) {
    return 0
  }
  const grossEv = ourProbability * (1 - marketPrice) - (1 - ourProbability) * marketPrice
  return grossEv - fee
}

/**
 * Convenience: raw edge in probability points (no fee adjustment).
 *
 * Used for display on the signal cards — the EV-with-fee number is the one
 * that actually gates trading decisions, but humans like to see the raw gap.
 */
export function rawEdge(ourProbability: number, marketPrice: number): number {
  if (!Number.isFinite(ourProbability) || !Number.isFinite(marketPrice)) return 0
  return ourProbability - marketPrice
}
