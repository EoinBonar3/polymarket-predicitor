/**
 * Kalshi cross-market source — orchestration.
 *
 *   Polymarket market → lexical top-K Kalshi candidates → LLM confirm
 *   (same event + YES alignment) → SourceEstimate using Kalshi's probability.
 *
 * Two acceptance paths:
 *   - LLM (Gemini key set): the real path. Confirms same-event + resolution
 *     match + YES alignment, carries the model's confidence through.
 *   - No key: emits NOTHING tradeable by default. Live scanning proved lexical
 *     similarity can't separate "win the nomination" from "run for the
 *     nomination" (0.84 similar, wildly different events) — so a lexical-only
 *     signal is a false-positive machine. The high-overlap path survives only
 *     behind an explicit `allowLexicalOnly` escape hatch for experimentation.
 */

import { topCandidates } from '../matching/textMatch'
import { isGeminiAvailable, matchEvent, type MatchCandidate } from '../llm/groq'
import { expectedValue, kellyFraction, suggestedStake } from '../kelly'
import { MIN_SUGGESTED_STAKE, SIGNAL_BANKROLL } from '../signals'
import type { Market, Outcome, TradeSignal, TradeSignalConfidence } from '../types'
import type { KalshiMarket } from './kalshiApi'
import type { SourceEstimate } from './types'

export interface KalshiSourceOptions {
  /** Use the Gemini matcher. Defaults to whether a key is configured. */
  useLlm?: boolean
  /** How many lexical candidates to consider / hand to the LLM. */
  candidateCount?: number
  /** Minimum lexical similarity to be considered a candidate at all. */
  minLexicalScore?: number
  /** No-LLM path: minimum lexical score to accept a match outright. */
  lexicalAcceptScore?: number
  /** LLM path: minimum model confidence to accept a match. */
  llmMinConfidence?: number
  /**
   * Escape hatch: allow tradeable estimates from lexical matching alone (no
   * LLM). OFF by default and strongly discouraged — lexical similarity can't
   * verify resolution criteria, so this produces confident false positives.
   */
  allowLexicalOnly?: boolean
  /**
   * Maximum days between a PM market's end date and a Kalshi market's close
   * time for them to be considered as potential matches. Defaults to 21 days.
   * Markets further apart than this can't be the same event and are dropped
   * before the LLM ever sees them, saving tokens.
   */
  maxDateDeltaDays?: number
}

export interface KalshiMatchDebug {
  matchedBy: 'llm' | 'lexical' | null
  ticker: string | null
  question: string | null
  lexicalScore: number
  reason: string
}

export interface KalshiSource {
  estimate(market: { id?: string; title: string; endDate?: string }): Promise<SourceEstimate | null>
  /** Same as `estimate` but always returns why it matched / didn't (for scans). */
  evaluate(market: { id?: string; title: string; endDate?: string }): Promise<{ estimate: SourceEstimate | null; debug: KalshiMatchDebug }>
}

/** Liquidity confidence multiplier — thin Kalshi books are less trustworthy. */
function volumeFactor(volume: number): number {
  if (volume >= 5000) return 1
  if (volume <= 100) return 0.5
  return 0.5 + (0.5 * (volume - 100)) / (5000 - 100)
}

export function createKalshiSource(markets: KalshiMarket[], opts: KalshiSourceOptions = {}): KalshiSource {
  const useLlm = opts.useLlm ?? isGeminiAvailable()
  const candidateCount = opts.candidateCount ?? 5
  const minLexicalScore = opts.minLexicalScore ?? 0.12
  const lexicalAcceptScore = opts.lexicalAcceptScore ?? 0.55
  const llmMinConfidence = opts.llmMinConfidence ?? 0.7
  const allowLexicalOnly = opts.allowLexicalOnly ?? false
  const maxDateDeltaMs = (opts.maxDateDeltaDays ?? 21) * 24 * 3600 * 1000

  const byTicker = new Map(markets.map((m) => [m.ticker, m]))

  async function evaluate(market: { id?: string; title: string; endDate?: string }) {
    // Drop Kalshi markets whose close date is too far from the PM market's end
    // date — they can't be the same event. Fail-open when either date is absent.
    let pool = markets
    if (market.endDate) {
      const pmEnd = new Date(market.endDate).getTime()
      if (Number.isFinite(pmEnd)) {
        pool = markets.filter((m) => {
          if (!m.closeTime) return true
          const kClose = new Date(m.closeTime).getTime()
          return Number.isFinite(kClose) && Math.abs(kClose - pmEnd) <= maxDateDeltaMs
        })
      }
    }
    const candidates = topCandidates(market.title, pool, (m) => m.question, candidateCount, minLexicalScore)
    if (candidates.length === 0) {
      return { estimate: null, debug: debug(null, null, 0, 'no lexical candidates') }
    }
    const top = candidates[0]

    if (useLlm) {
      const matchCandidates: MatchCandidate[] = candidates.map((c) => ({
        id: c.candidate.ticker,
        question: c.candidate.question,
        rules: c.candidate.rules,
      }))
      const result = await matchEvent({ id: market.id, question: market.title, endDate: market.endDate }, matchCandidates)
      if (!result || !result.isSameEvent || result.matchId == null) {
        return { estimate: null, debug: debug('llm', null, top.score, result ? 'LLM: not the same event' : 'LLM unavailable/failed') }
      }
      if (result.confidence < llmMinConfidence) {
        return { estimate: null, debug: debug('llm', result.matchId, top.score, `LLM confidence ${result.confidence.toFixed(2)} < ${llmMinConfidence}`) }
      }
      const km = byTicker.get(result.matchId)
      if (!km) return { estimate: null, debug: debug('llm', result.matchId, top.score, 'matched ticker not found') }

      // Use the executable entry price (ask to buy YES, 1-bid to buy NO) so edge
      // reflects what you'd actually pay crossing the spread, not just the midpoint.
      const ourP = result.yesAligned
        ? (km.yesAsk > 0 ? km.yesAsk : km.yesProbability)
        : (km.yesBid > 0 ? 1 - km.yesBid : 1 - km.yesProbability)
      const estimate: SourceEstimate = {
        source: 'kalshi',
        ourP,
        confidence: Math.max(0, Math.min(1, result.confidence * volumeFactor(km.volume))),
        resolutionMatchConfidence: result.confidence,
        reference: {
          ticker: km.ticker,
          question: km.question,
          kalshiMid: km.yesProbability,
          kalshiAsk: km.yesAsk,
          kalshiBid: km.yesBid,
          yesAligned: result.yesAligned,
          volume: km.volume,
          lexicalScore: Number(top.score.toFixed(3)),
          matchedBy: 'llm',
          caveats: result.resolutionCaveats.slice(0, 200),
        },
      }
      return { estimate, debug: debug('llm', km.ticker, top.score, 'LLM confirmed') }
    }

    // No LLM: emit nothing tradeable unless explicitly opted in — lexical
    // overlap alone can't tell "win" from "run for".
    if (!allowLexicalOnly) {
      return { estimate: null, debug: debug('lexical', top.candidate.ticker, top.score, 'no LLM — set GEMINI_API_KEY to confirm matches') }
    }
    // Escape hatch: accept only very-high lexical overlap, low confidence.
    if (top.score < lexicalAcceptScore) {
      return { estimate: null, debug: debug('lexical', top.candidate.ticker, top.score, `lexical ${top.score.toFixed(2)} < ${lexicalAcceptScore} (needs LLM to confirm)`) }
    }
    const km = top.candidate
    const estimate: SourceEstimate = {
      source: 'kalshi',
      ourP: km.yesAsk > 0 ? km.yesAsk : km.yesProbability,
      confidence: Math.min(0.5, top.score) * volumeFactor(km.volume),
      resolutionMatchConfidence: Math.min(0.5, top.score),
      reference: {
        ticker: km.ticker,
        question: km.question,
        kalshiMid: km.yesProbability,
        kalshiAsk: km.yesAsk,
        kalshiBid: km.yesBid,
        yesAligned: true,
        volume: km.volume,
        lexicalScore: Number(top.score.toFixed(3)),
        matchedBy: 'lexical',
        caveats: 'YES alignment unverified (no LLM) — assumes same direction',
      },
    }
    return { estimate, debug: debug('lexical', km.ticker, top.score, 'lexical accept') }
  }

  return {
    evaluate,
    estimate: async (market) => (await evaluate(market)).estimate,
  }
}

function debug(
  matchedBy: 'llm' | 'lexical' | null,
  ticker: string | null,
  lexicalScore: number,
  reason: string,
): KalshiMatchDebug {
  return { matchedBy, ticker, question: null, lexicalScore, reason }
}

// ---------------------------------------------------------------------------
// TradeSignal construction (mirrors `buildOddsTradeSignal` in marketMatcher.ts)
// ---------------------------------------------------------------------------

interface SideEvaluation {
  outcome: Outcome
  ourP: number
  marketPrice: number
  kelly: number
  stake: number
  evGbp: number
}

function evaluateSide(outcome: Outcome, ourP: number, marketPrice: number, bankroll: number): SideEvaluation {
  const kelly = kellyFraction(ourP, marketPrice)
  const stake = suggestedStake(bankroll, kelly)
  const evPerPound = expectedValue(ourP, marketPrice)
  const evGbp = Math.round(evPerPound * stake * 100) / 100
  return { outcome, ourP, marketPrice, kelly, stake, evGbp }
}

function pickBest(a: SideEvaluation, b: SideEvaluation): SideEvaluation | null {
  if (a.kelly <= 0 && b.kelly <= 0) return null
  if (a.kelly <= 0) return b
  if (b.kelly <= 0) return a
  return a.evGbp >= b.evGbp ? a : b
}

function bucketSignalConfidence(edgePct: number): TradeSignalConfidence {
  const abs = Math.abs(edgePct)
  if (abs >= 7) return 'high'
  if (abs >= 4) return 'medium'
  return 'low'
}

/**
 * Build a `TradeSignal` from a Gemini-confirmed Kalshi `SourceEstimate`.
 * Mirrors `buildOddsTradeSignal` — feeds Kalshi's YES probability (already
 * aligned to the Polymarket YES outcome) into the Kelly engine.
 */
export function buildKalshiTradeSignal(market: Market, estimate: SourceEstimate): TradeSignal | null {
  const yesPrice = market.yesPrice
  if (!Number.isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) return null
  const noPrice =
    Number.isFinite(market.noPrice) && market.noPrice > 0 && market.noPrice < 1
      ? market.noPrice
      : 1 - yesPrice

  const ourPyes = estimate.ourP
  const ourPno = 1 - ourPyes

  const yesSide = evaluateSide('YES', ourPyes, yesPrice, SIGNAL_BANKROLL)
  const noSide = evaluateSide('NO', ourPno, noPrice, SIGNAL_BANKROLL)
  const best = pickBest(yesSide, noSide)
  if (!best || best.kelly <= 0) return null
  if (best.stake < MIN_SUGGESTED_STAKE) return null

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
    confidence: bucketSignalConfidence(edgePct),
    signalSource: 'kalshi',
  }
}
