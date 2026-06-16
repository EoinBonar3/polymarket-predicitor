/**
 * Deribit crypto source — live orchestration.
 *
 * Given a Polymarket market, produce an independent `SourceEstimate` for its
 * YES outcome from the Deribit options surface:
 *
 *   parse target → fetch spot + option chain → IV at (strike, expiry) →
 *   risk-neutral event probability (digital or barrier-touch).
 *
 * Returns `null` for any market that isn't a parseable crypto price target on a
 * supported asset, or when the chain has no usable vol — anchored-or-nothing,
 * same as the sports matcher.
 */

import { cryptoEventProbability, parseCryptoTarget, type CryptoAsset } from './cryptoMarket'
import { getIndexPrice, getOptionChain, impliedVolAt, type DeribitAsset } from './deribitApi'
import type { SourceEstimate } from './types'

const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const SUPPORTED: ReadonlySet<CryptoAsset> = new Set<CryptoAsset>(['BTC', 'ETH', 'SOL'])

/**
 * In-process cache of spot + chain per asset. The chain is ~900 instruments
 * and barely moves minute to minute, so one fetch serves every market for that
 * asset in a single engine pass. TTL keeps it fresh across passes.
 */
const CHAIN_TTL_MS = 5 * 60 * 1000
const chainCache = new Map<DeribitAsset, { at: number; spot: number; chain: Awaited<ReturnType<typeof getOptionChain>> }>()

async function loadAsset(asset: DeribitAsset, signal?: AbortSignal) {
  const cached = chainCache.get(asset)
  if (cached && Date.now() - cached.at < CHAIN_TTL_MS) return cached
  const [spot, chain] = await Promise.all([getIndexPrice(asset, signal), getOptionChain(asset, signal)])
  const entry = { at: Date.now(), spot, chain }
  chainCache.set(asset, entry)
  return entry
}

/** Confidence in [0,1]: parse quality × an expiry-term-gap penalty. */
function confidenceFor(parseConf: number, targetExpiryMs: number, usedExpiryMs: number): number {
  const gapDays = Math.abs(targetExpiryMs - usedExpiryMs) / (24 * 60 * 60 * 1000)
  // No penalty within ~3 days; decays to ~0.5 by ~21 days of term mismatch.
  const termFactor = Math.max(0.4, 1 - Math.max(0, gapDays - 3) / 36)
  return Math.max(0, Math.min(1, parseConf * termFactor))
}

export async function estimateCryptoMarket(
  market: { title: string; endDate: string },
  signal?: AbortSignal,
): Promise<SourceEstimate | null> {
  const target = parseCryptoTarget(market)
  if (!target) return null
  if (!SUPPORTED.has(target.asset)) return null

  const expiryMs = new Date(target.expiry).getTime()
  if (!Number.isFinite(expiryMs)) return null
  const T = (expiryMs - Date.now()) / YEAR_MS
  if (T <= 0) return null

  const { spot, chain } = await loadAsset(target.asset as DeribitAsset, signal)
  const iv = await impliedVolAt(chain, expiryMs, target.strike, signal)
  if (!iv || !(iv.sigma > 0)) return null

  const ourP = cryptoEventProbability(target, spot, T, iv.sigma)
  if (!Number.isFinite(ourP)) return null

  return {
    source: 'deribit',
    ourP,
    confidence: confidenceFor(target.resolutionMatchConfidence, expiryMs, iv.usedExpiryMs),
    resolutionMatchConfidence: target.resolutionMatchConfidence,
    reference: {
      asset: target.asset,
      strike: target.strike,
      direction: target.direction,
      barrier: target.barrier,
      spot,
      sigma: Number(iv.sigma.toFixed(4)),
      yearsToExpiry: Number(T.toFixed(4)),
      model: target.barrier === 'touch' ? 'barrier-touch' : 'digital',
    },
  }
}
