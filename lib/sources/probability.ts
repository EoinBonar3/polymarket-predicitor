/**
 * Risk-neutral probability math for crypto price-target markets.
 *
 * Pure functions, no I/O. Two models, both standard Black-Scholes / GBM:
 *
 *   - `digitalAboveProbability` — P(S_T > K) at a fixed expiry T. The
 *     risk-neutral probability the spot finishes above the strike. Used for
 *     "above $X on <date>" markets.
 *
 *   - `touchProbability` — P(the path touches barrier B at any time before T).
 *     The first-passage probability for GBM, via the reflection principle.
 *     Used for "reach / hit $X by <date>" markets, which resolve YES the
 *     instant the barrier prints, not only at expiry.
 *
 * Caveat baked into every caller's `confidence`: these are *risk-neutral*
 * probabilities. They embed the vol risk premium, so they are a biased (but
 * cheap, model-grounded, and independent) estimate of the real-world
 * probability. The backtest measures how large that bias is in practice.
 */

/** Abramowitz & Stegun 7.1.26 — |error| < 1.5e-7. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x)
  return x >= 0 ? y : -y
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return NaN
  if (p < 0) return 0
  if (p > 1) return 1
  return p
}

/**
 * P(S_T > K) under risk-neutral GBM. `sigma` is annualised vol (decimal, e.g.
 * 0.65 for 65%); `T` is years to expiry; `r` the carry/rate (≈0 for crypto).
 */
export function digitalAboveProbability(
  S: number,
  K: number,
  T: number,
  sigma: number,
  r = 0,
): number {
  if (!(S > 0) || !(K > 0)) return NaN
  if (T <= 0) return S > K ? 1 : 0
  if (sigma <= 0) return S * Math.exp(r * T) > K ? 1 : 0
  const d2 = (Math.log(S / K) + (r - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
  return clamp01(normCdf(d2))
}

/**
 * P(the GBM path starting at S touches barrier B at some t ≤ T).
 *
 * Handles both an up-barrier (B > S) and a down-barrier (B < S) via the
 * first-passage / reflection formula for arithmetic Brownian motion with drift
 * ν = r − σ²/2 in log-space (a = ln(B/S)):
 *
 *   up:   N((νT − a)/σ√T) + e^{2νa/σ²} N((−νT − a)/σ√T)
 *   down: N((a − νT)/σ√T) + e^{2νa/σ²} N(( a + νT)/σ√T)
 */
export function touchProbability(
  S: number,
  B: number,
  T: number,
  sigma: number,
  r = 0,
): number {
  if (!(S > 0) || !(B > 0)) return NaN
  if (T <= 0) return S === B ? 1 : 0
  if (sigma <= 0) {
    const fwd = S * Math.exp(r * T)
    return B > S ? (fwd >= B ? 1 : 0) : fwd <= B ? 1 : 0
  }
  const nu = r - 0.5 * sigma * sigma
  const a = Math.log(B / S)
  const s = sigma * Math.sqrt(T)
  const expTerm = Math.exp((2 * nu * a) / (sigma * sigma))

  if (B > S) {
    return clamp01(normCdf((nu * T - a) / s) + expTerm * normCdf((-nu * T - a) / s))
  }
  return clamp01(normCdf((a - nu * T) / s) + expTerm * normCdf((a + nu * T) / s))
}
