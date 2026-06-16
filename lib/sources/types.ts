/**
 * Shared contract for external probability sources.
 *
 * Every anchored source (Deribit options, Kalshi, Metaculus, …) produces a
 * `SourceEstimate` for a Polymarket market: an independent probability that the
 * market's YES resolves, plus the confidence and the diagnostics behind it.
 * The signal engine compares `ourP` against the market price to find edge.
 *
 * This is the forward-looking interface the Phase 0 plan deferred to here — it
 * lands now with its first real consumer, the Deribit crypto source.
 */

export type SourceName = 'deribit' | 'odds_api' | 'kalshi' | 'metaculus' | 'manifold' | 'gemini'

export interface SourceEstimate {
  source: SourceName
  /** Independent probability that the market's YES outcome resolves true. */
  ourP: number
  /**
   * How much to trust this estimate, 0..1. Folds together model assumptions
   * (e.g. risk-neutral vs real-world basis) and how cleanly we matched the
   * market to the reference. Used later to weight a multi-source posterior.
   */
  confidence: number
  /**
   * How sure we are that the Polymarket question and the reference describe
   * the *same* event with the *same* resolution criteria. Low values mean the
   * estimate may be precise but pointed at the wrong question — the silent
   * killer. 0..1.
   */
  resolutionMatchConfidence: number
  /** Free-form diagnostics for logging / debugging (spot, strike, iv, T, …). */
  reference: Record<string, number | string | boolean>
}
