/**
 * Fuzzy matcher: Polymarket market title → Odds API event.
 *
 * This is the single most error-prone piece of the integration — a false
 * positive (wrong event matched) silently corrupts the Kelly sizing for
 * that market with a bookmaker probability that has nothing to do with
 * the actual question being asked.
 *
 * Strategy:
 *   1. Score each candidate event against the market title using a few
 *      cheap heuristics (substring presence, both-teams bonus, time
 *      proximity).
 *   2. Tiered acceptance:
 *        ≥ 85  → high confidence (full Kelly, SPORTS_HIGH_CONF)
 *        65–84 → medium confidence (half Kelly, SPORTS_MED_CONF) only if
 *                the matched team appears in the market's YES outcome text
 *        < 65  → reject (fall back to structural blender)
 *      All tiers still require an unambiguous YES→home/away/draw mapping.
 *      Futures / title markets are always rejected regardless of score.
 */

import { getConsensusForEvent, type BookmakerConsensus, type OddsApiEvent } from './oddsApi'
import { expectedValue, kellyFraction, suggestedStake } from './kelly'
import { MIN_SUGGESTED_STAKE, SIGNAL_BANKROLL } from './signals'
import type {
  Market,
  Outcome,
  TradeSignal,
  TradeSignalConfidence,
  TradeSignalMatchConfidence,
  TradeSignalSportType,
} from './types'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MatchResult {
  event: OddsApiEvent
  consensus: BookmakerConsensus
  matchedOutcome: 'home' | 'away' | 'draw'
  matchConfidence: TradeSignalMatchConfidence
  signalType: TradeSignalSportType
  /** 1 for high-confidence tier; 0.5 for medium-confidence half-Kelly sizing. */
  kellyStakeMultiplier: number
  ourProbability: number
}

interface MatchCandidate {
  event: OddsApiEvent
  score: number
}

function logMatchCandidates(
  market: Market,
  candidates: MatchCandidate[],
  outcome: string,
): void {
  const top3 = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => ({
      score: c.score,
      home: c.event.home_team,
      away: c.event.away_team,
      sport: c.event.sport_key,
      commence: c.event.commence_time,
    }))

  console.info('[marketMatcher]', {
    marketId: market.id,
    title: market.title,
    outcome,
    candidateCount: candidates.length,
    topCandidates: top3,
  })
}

/**
 * Try to match a Polymarket market against a list of Odds API events.
 * Returns the best match if it passes the tiered score gates, otherwise `null`.
 *
 * Pure function — same inputs always produce the same output, no I/O.
 */
export function matchMarketToEvent(
  market: Market,
  events: OddsApiEvent[],
): MatchResult | null {
  if (!market?.title || !Array.isArray(events) || events.length === 0) {
    console.info('[marketMatcher]', {
      marketId: market?.id,
      title: market?.title,
      outcome: 'Skipped — no market title or no Odds API events loaded',
      topCandidates: [],
    })
    return null
  }

  const title = market.title.toLowerCase()
  const marketEndMs = new Date(market.endDate).getTime()
  const nowMs = Date.now()

  // Hard reject: futures / season-long / championship markets must NEVER
  // match h2h game odds. Bookmakers price single-game money lines very
  // differently from championship futures, so a "Will the Knicks win the
  // 2026 NBA Finals?" question matched to a single Knicks regular-season
  // game produces a nonsense edge of tens of points. Better to fall
  // through to the structural blender than to ship a phantom signal.
  if (FUTURES_TITLE_PATTERN.test(title)) {
    logMatchCandidates(
      market,
      [],
      'Sports match rejected — futures/title market',
    )
    return null
  }

  let bestScore = 0
  let bestEvent: OddsApiEvent | null = null
  const candidates: MatchCandidate[] = []

  for (const event of events) {
    if (!event?.home_team || !event?.away_team) continue

    const eventStartMs = new Date(event.commence_time).getTime()
    // Required: the match must kick off before the Polymarket market
    // resolves, otherwise the market is asking about something different.
    if (
      Number.isFinite(eventStartMs) &&
      Number.isFinite(marketEndMs) &&
      eventStartMs > marketEndMs
    ) {
      continue
    }

    // Required: the event must finish "close" to the market's resolution
    // date. Game-level Polymarkets resolve within hours of the game; if
    // we'd have to wait > MAX_EVENT_TO_MARKET_END_MS for the market to
    // close after the event ends, the market is almost certainly asking
    // about something bigger than this single fixture (a series, a
    // season, a tournament outcome). FUTURES_TITLE_PATTERN catches the
    // obvious cases above; this guard catches the rest.
    if (
      Number.isFinite(eventStartMs) &&
      Number.isFinite(marketEndMs) &&
      marketEndMs - eventStartMs > MAX_EVENT_TO_MARKET_END_MS
    ) {
      continue
    }

    const score = scoreEvent(title, event, eventStartMs - nowMs)
    candidates.push({ event, score })
    if (score > bestScore) {
      bestScore = score
      bestEvent = event
    }
  }

  if (!bestEvent || bestScore < SCORE_THRESHOLD_TIER2) {
    logMatchCandidates(
      market,
      candidates,
      candidates.length === 0
        ? 'No sports events matched this title or date window'
        : `Sports match score too low (score: ${bestScore})`,
    )
    return null
  }

  const matchedOutcome = determineMatchedOutcome(title, bestEvent)
  if (!matchedOutcome) {
    logMatchCandidates(
      market,
      candidates,
      `Found ${bestEvent.home_team} vs ${bestEvent.away_team} (score ${bestScore}) but can't tell which team the YES outcome refers to`,
    )
    return null
  }

  const consensus = getConsensusForEvent(bestEvent)
  if (consensus.bookmakerCount === 0) {
    logMatchCandidates(
      market,
      candidates,
      `Matched ${bestEvent.home_team} vs ${bestEvent.away_team} but no bookmakers quoted odds for it`,
    )
    return null
  }

  let ourProbability: number
  if (matchedOutcome === 'home') ourProbability = consensus.homeWinProbability
  else if (matchedOutcome === 'away') ourProbability = consensus.awayWinProbability
  else {
    if (consensus.drawProbability == null) {
      logMatchCandidates(
        market,
        candidates,
        `Market asks about a draw but bookmakers didn't quote draw odds for ${bestEvent.home_team} vs ${bestEvent.away_team}`,
      )
      return null
    }
    ourProbability = consensus.drawProbability
  }

  if (!Number.isFinite(ourProbability) || ourProbability <= 0 || ourProbability >= 1) {
    logMatchCandidates(
      market,
      candidates,
      `Bookmaker probability (${ourProbability}) is invalid for ${bestEvent.home_team} vs ${bestEvent.away_team}`,
    )
    return null
  }

  let signalType: TradeSignalSportType
  let matchConfidence: TradeSignalMatchConfidence
  let kellyStakeMultiplier: number

  if (bestScore >= SCORE_THRESHOLD_TIER1) {
    signalType = 'SPORTS_HIGH_CONF'
    matchConfidence = 'HIGH'
    kellyStakeMultiplier = 1
  } else {
    if (!matchedTeamInYesOutcomeText(market, bestEvent, matchedOutcome)) {
      logMatchCandidates(
        market,
        candidates,
        `Medium-confidence match (score ${bestScore}) rejected — matched team not found in YES outcome text`,
      )
      return null
    }
    signalType = 'SPORTS_MED_CONF'
    matchConfidence = 'MEDIUM'
    kellyStakeMultiplier = 0.5
  }

  logMatchCandidates(
    market,
    candidates,
    `Matched to ${bestEvent.home_team} vs ${bestEvent.away_team} — ${matchedOutcome} at ${(ourProbability * 100).toFixed(1)}% (score ${bestScore}/100, ${signalType})`,
  )

  return {
    event: bestEvent,
    consensus,
    matchedOutcome,
    matchConfidence,
    signalType,
    kellyStakeMultiplier,
    ourProbability,
  }
}

/**
 * Build a fully-populated `TradeSignal` from a successful match.
 *
 * Mirrors `lib/signals.ts::signalForMarket` but feeds bookmaker
 * `ourProbability` into the Kelly engine instead of the structural
 * blender. The YES side of the Polymarket binary is always assumed to
 * correspond to `match.matchedOutcome` — i.e. the question is "will
 * <matched team> win?". If the matched outcome has no positive Kelly,
 * we evaluate the NO side too (e.g. "Will Liverpool NOT win?").
 */
export function buildOddsTradeSignal(
  market: Market,
  match: MatchResult,
): TradeSignal | null {
  const yesPrice = market.yesPrice
  if (!Number.isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) return null
  const noPrice =
    Number.isFinite(market.noPrice) && market.noPrice > 0 && market.noPrice < 1
      ? market.noPrice
      : 1 - yesPrice

  const ourPyes = match.ourProbability
  const ourPno = 1 - ourPyes

  const yesSide = evaluateSide('YES', ourPyes, yesPrice, SIGNAL_BANKROLL)
  const noSide = evaluateSide('NO', ourPno, noPrice, SIGNAL_BANKROLL)
  const best = pickBest(yesSide, noSide)
  if (!best || best.kelly <= 0) return null

  const stakeMultiplier = match.kellyStakeMultiplier
  const adjustedStake = Math.round(best.stake * stakeMultiplier * 100) / 100
  const adjustedKelly = best.kelly * stakeMultiplier
  const adjustedEv = Math.round(best.evGbp * stakeMultiplier * 100) / 100

  if (adjustedStake < MIN_SUGGESTED_STAKE) return null

  const edgePct = (best.ourP - best.marketPrice) * 100

  return {
    marketId: market.id,
    title: market.title,
    slug: market.slug,
    recommendedOutcome: best.outcome,
    marketPrice: best.marketPrice,
    ourProbability: best.ourP,
    edgePct,
    kellyFraction: adjustedKelly,
    suggestedStake: adjustedStake,
    expectedValue: adjustedEv,
    confidence: bucketSignalConfidence(edgePct),
    signalSource: 'odds_api',
    matchConfidence: match.matchConfidence,
    bookmakerCount: match.consensus.bookmakerCount,
    signalType: match.signalType,
  }
}

// ---------------------------------------------------------------------------
// Internals — scoring
// ---------------------------------------------------------------------------

/** Tier 1 — high confidence: full Kelly, SPORTS_HIGH_CONF. */
const SCORE_THRESHOLD_TIER1 = 85
/** Tier 2 — medium confidence: half Kelly, SPORTS_MED_CONF (inclusive). */
const SCORE_THRESHOLD_TIER2 = 65

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Max allowable gap between a candidate event's kickoff and the
 * Polymarket market's resolution date. 7 days covers weekend slates,
 * series finishers, and "win this week" parlays, while still rejecting
 * the futures markets (which resolve months after any single fixture).
 */
const MAX_EVENT_TO_MARKET_END_MS = 7 * DAY_MS

/**
 * Title keywords that mark a market as a futures / season / tournament
 * outcome rather than a single fixture. These must NEVER match against
 * The Odds API's h2h game lines.
 *
 *   - championship, season, winner, title, trophy, league winner
 *   - plus finals, cup, mvp, super bowl, world series, etc.
 *
 * Be aggressive here — false negatives only mean we fall back to the
 * structural blender (cheap), while false positives ship a phantom signal
 * to the user (expensive).
 */
const FUTURES_TITLE_PATTERN =
  /\b(champion(ship)?|season|winner|title|trophy|league\s+winner|finals?|cup|mvp|super\s*bowl|world\s*series|stanley\s*cup|win\s+the\s+(division|conference|league|tournament))\b/

function scoreEvent(
  titleLower: string,
  event: OddsApiEvent,
  timeUntilEventMs: number,
): number {
  let score = 0

  const home = scoreTeamPresence(event.home_team, titleLower)
  const away = scoreTeamPresence(event.away_team, titleLower)
  score += home.score
  score += away.score

  // Both-teams bonus — only fires if BOTH teams meaningfully appeared.
  if (home.present && away.present) score += 30

  // Time proximity. "Within 2 days" is the stronger signal and supersedes
  // "within 7 days" — they don't stack.
  if (Number.isFinite(timeUntilEventMs) && timeUntilEventMs >= 0) {
    const days = timeUntilEventMs / DAY_MS
    if (days <= 2) score += 20
    else if (days <= 7) score += 10
  }

  return score
}

/**
 * Score how well a single team name appears in the title.
 *   - Full lowercased team name is a substring  → 40
 *   - Otherwise any ≥ 5-char word from the team → 20
 *   - Else                                       → 0
 *
 * The ≥5-char filter avoids matching generic geographic words like "new",
 * "york", "city" that would otherwise blow up the false-positive rate.
 */
function scoreTeamPresence(
  team: string,
  titleLower: string,
): { score: number; present: boolean } {
  if (!team) return { score: 0, present: false }
  const teamLower = team.toLowerCase()
  if (titleLower.includes(teamLower)) return { score: 40, present: true }

  const words = teamLower.split(/\s+/).filter((w) => w.length >= 5)
  for (const w of words) {
    if (titleLower.includes(w)) return { score: 20, present: true }
  }
  return { score: 0, present: false }
}

function yesOutcomeTextForMarket(market: Market): string {
  return (market.yesOutcomeText ?? market.title).toLowerCase()
}

/**
 * Tier 2 guard: the matched team (or draw/tie) must appear in the YES
 * outcome text — not just score well against the event list.
 */
function matchedTeamInYesOutcomeText(
  market: Market,
  event: OddsApiEvent,
  matchedOutcome: 'home' | 'away' | 'draw',
): boolean {
  const yesText = yesOutcomeTextForMarket(market)

  if (matchedOutcome === 'draw') {
    return /\b(draw|tie)\b/.test(yesText)
  }

  const team =
    matchedOutcome === 'home' ? event.home_team : event.away_team
  if (!team) return false

  const teamLower = team.toLowerCase()
  if (yesText.includes(teamLower)) return true

  const words = teamLower.split(/\s+/).filter((w) => w.length >= 5)
  return words.some((w) => yesText.includes(w))
}

// ---------------------------------------------------------------------------
// Internals — outcome resolution
// ---------------------------------------------------------------------------

/**
 * Which side of the Odds API event does the Polymarket YES outcome map to?
 *
 * The rules are deliberately conservative — we'd rather miss a match
 * (and fall back to the structural blender) than guess wrong.
 *
 *   1. Title mentions a draw/tie?               → 'draw'
 *   2. Only one team mentioned?                 → that team's side
 *   3. Both teams mentioned + "will X win"/"X to win/beat" pattern?
 *                                               → that team's side
 *   4. Both teams mentioned with no clear subject? → null (ambiguous)
 */
function determineMatchedOutcome(
  titleLower: string,
  event: OddsApiEvent,
): 'home' | 'away' | 'draw' | null {
  if (/\b(draw|tie)\b/.test(titleLower)) return 'draw'

  const homeLower = event.home_team.toLowerCase()
  const awayLower = event.away_team.toLowerCase()

  const homeIdx = titleLower.indexOf(homeLower)
  const awayIdx = titleLower.indexOf(awayLower)

  if (homeIdx === -1 && awayIdx === -1) return null
  if (homeIdx !== -1 && awayIdx === -1) return 'home'
  if (homeIdx === -1 && awayIdx !== -1) return 'away'

  // Both teams appear by full substring — disambiguate via verb cues.
  const homeWill = isSubject(titleLower, homeLower)
  const awayWill = isSubject(titleLower, awayLower)
  if (homeWill && !awayWill) return 'home'
  if (awayWill && !homeWill) return 'away'

  // Genuinely ambiguous ("Lakers vs Celtics: who wins?"). Don't guess.
  return null
}

const VERB_CUES = '(win|wins|beat|beats|to\\s+win|to\\s+beat)'

/**
 * Treat `team` as the subject of the market question if it sits next to
 * a clear verb cue — either "Will <team> [verb]" or "<team> to win/beat".
 */
function isSubject(titleLower: string, teamLower: string): boolean {
  const escaped = teamLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const willPattern = new RegExp(`\\bwill\\b[^.?!]*?\\b${escaped}\\b[^.?!]*?\\b${VERB_CUES}\\b`)
  if (willPattern.test(titleLower)) return true

  const toPattern = new RegExp(`\\b${escaped}\\b\\s+to\\s+(win|beat)\\b`)
  return toPattern.test(titleLower)
}

// ---------------------------------------------------------------------------
// Internals — signal construction (mirrors lib/signals.ts privates)
// ---------------------------------------------------------------------------

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
