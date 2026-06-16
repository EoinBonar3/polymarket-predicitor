/**
 * Parse a Polymarket question into a structured crypto price target.
 *
 * Conservative by design (mirrors the sports matcher's philosophy): parse
 * confidently or return `null`. A wrong parse silently corrupts the estimate,
 * so we'd rather skip a market than mis-read it. Every parse carries a
 * `resolutionMatchConfidence` so downstream sizing can discount fuzzy reads.
 *
 * Examples it handles:
 *   "Will Bitcoin reach $150,000 in February?"      → BTC touch above 150000
 *   "Will Bitcoin hit $100k in 2024?"               → BTC touch above 100000
 *   "Will ETH be above $4,000 on January 1?"        → ETH expiry above 4000
 *   "Will Bitcoin dip to $50,000 by March?"         → BTC touch below 50000
 */

import { digitalAboveProbability, touchProbability } from './probability'

export type CryptoAsset = 'BTC' | 'ETH' | 'SOL'
export type TargetDirection = 'above' | 'below'
export type TargetBarrier = 'touch' | 'expiry'

export interface CryptoTarget {
  asset: CryptoAsset
  strike: number
  direction: TargetDirection
  barrier: TargetBarrier
  /** Resolution date — from `market.endDate`. */
  expiry: string
  /** 0..1 — how cleanly the question parsed. */
  resolutionMatchConfidence: number
  raw: string
}

const ASSET_PATTERNS: Array<[RegExp, CryptoAsset]> = [
  [/\b(bitcoin|btc)\b/i, 'BTC'],
  [/\b(ethereum|ether|eth)\b/i, 'ETH'],
  [/\b(solana|sol)\b/i, 'SOL'],
]

const TOUCH_WORDS = /\b(reach|reaches|hit|hits|touch|touches|surpass|surpasses|cross|crosses|exceed|exceeds|dip|dips|fall|falls|drop|drops|all[-\s]?time\s+high|ath|by\b)/i
const EXPIRY_WORDS = /\b(be\s+(above|below)|close\s+(above|below)|end\s+of|on\s+\w+\s+\d|at\s+(expiry|expiration)|settle|finish)/i
const BELOW_WORDS = /\b(below|under|beneath|dip|dips|fall|falls|drop|drops|less\s+than|lower\s+than)\b/i

/**
 * Pull the strike out of the question. Requires a `$` prefix or a `k`/`m`
 * suffix so we never mistake a year ("2025") or a day ("the 7th") for a price.
 * Picks the largest qualifying number (strikes dominate any stray figure).
 */
function parseStrike(text: string): number | null {
  const matches = [...text.matchAll(/\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?([kKmM])?|\b([0-9][0-9,]*(?:\.[0-9]+)?)\s?([kKmM])\b/g)]
  let best: number | null = null
  for (const m of matches) {
    const numRaw = m[1] ?? m[3]
    const suffix = (m[2] ?? m[4] ?? '').toLowerCase()
    if (!numRaw) continue
    let n = Number(numRaw.replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    if (suffix === 'k') n *= 1_000
    else if (suffix === 'm') n *= 1_000_000
    if (best === null || n > best) best = n
  }
  return best
}

export function parseCryptoTarget(
  market: { title: string; endDate: string },
): CryptoTarget | null {
  const title = market?.title
  if (!title || !market.endDate) return null

  let asset: CryptoAsset | null = null
  for (const [re, a] of ASSET_PATTERNS) {
    if (re.test(title)) {
      asset = a
      break
    }
  }
  if (!asset) return null

  const strike = parseStrike(title)
  if (strike === null || strike <= 0) return null

  const direction: TargetDirection = BELOW_WORDS.test(title) ? 'below' : 'above'

  // Barrier: "reach/hit/by" ⇒ touch (resolves the instant it prints);
  // "be above … on <date>" ⇒ expiry. Default to touch for the common
  // "reach $X" phrasing, with reduced confidence when neither cue is present.
  const hasTouch = TOUCH_WORDS.test(title)
  const hasExpiry = EXPIRY_WORDS.test(title)
  let barrier: TargetBarrier
  let resolutionMatchConfidence: number
  if (hasTouch && !hasExpiry) {
    barrier = 'touch'
    resolutionMatchConfidence = 0.9
  } else if (hasExpiry && !hasTouch) {
    barrier = 'expiry'
    resolutionMatchConfidence = 0.9
  } else if (hasTouch && hasExpiry) {
    // "by" + "on <date>" can both fire; lean touch (the YES condition is the
    // barrier print) but discount for the ambiguity.
    barrier = 'touch'
    resolutionMatchConfidence = 0.6
  } else {
    barrier = 'touch'
    resolutionMatchConfidence = 0.5
  }

  return {
    asset,
    strike,
    direction,
    barrier,
    expiry: market.endDate,
    resolutionMatchConfidence,
    raw: title,
  }
}

/**
 * Probability that the target's YES resolves, given spot `S`, years-to-expiry
 * `T`, and annualised vol `sigma` (decimal). Combines the two probability
 * models with the direction and an "already happened" guard for touch markets.
 */
export function cryptoEventProbability(
  target: Pick<CryptoTarget, 'strike' | 'direction' | 'barrier'>,
  S: number,
  T: number,
  sigma: number,
  r = 0,
): number {
  const { strike: K, direction, barrier } = target
  if (barrier === 'touch') {
    if (direction === 'above' && S >= K) return 1
    if (direction === 'below' && S <= K) return 1
    return touchProbability(S, K, T, sigma, r)
  }
  const pAbove = digitalAboveProbability(S, K, T, sigma, r)
  return direction === 'above' ? pAbove : 1 - pAbove
}
