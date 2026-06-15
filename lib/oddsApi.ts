/**
 * The Odds API — types, vig-removed consensus probabilities, and the
 * client-side fetch helpers that talk to our own `/api/odds/*` proxy.
 *
 * Components / hooks must NEVER call `api.the-odds-api.com` directly:
 *   - the API key only exists on the server,
 *   - the proxy adds Next.js fetch caching (5 min for events, 1 hour for
 *     the sports list),
 *   - the proxy forwards quota headers so we can track free-tier usage.
 *
 * Quota tracking lives in `useOddsQuotaStore` — a tiny Zustand store
 * updated by every fetch helper. The dashboard subscribes to it for the
 * "{n} requests remaining" chip without any prop drilling.
 */

import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of Odds API sport keys we'll ever ask the proxy to fetch.
 *
 * Ordered by Polymarket coverage (most → least). The `/sports` proxy
 * intersects this with currently-active sports and returns them in this
 * order, which is also the order `useOddsSignals` consumes — so EPL and
 * NFL are always fetched first when the quota is tight.
 */
export const POLYMARKET_RELEVANT_SPORTS = [
  'soccer_epl',
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_uefa_champs_league',
  'soccer_uefa_europa_league',
  'soccer_usa_mls',
  'americanfootball_ncaaf',
  'basketball_ncaab',
] as const

export type PolymarketRelevantSport = (typeof POLYMARKET_RELEVANT_SPORTS)[number]

/** Sports where a draw is a legitimate third outcome (vs a US-style 1v1). */
const DRAW_POSSIBLE_SPORT_PREFIXES = ['soccer_']

/** Upstream base URL — referenced from the proxy routes too. */
export const ODDS_API_BASE_URL = 'https://api.the-odds-api.com'

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface OddsApiOutcome {
  name: string
  price: number
}

export interface OddsApiMarket {
  key: string
  outcomes: OddsApiOutcome[]
}

export interface OddsApiBookmaker {
  key: string
  title: string
  markets: OddsApiMarket[]
}

export interface OddsApiEvent {
  id: string
  sport_key: string
  sport_title: string
  commence_time: string
  home_team: string
  away_team: string
  bookmakers: OddsApiBookmaker[]
}

// ---------------------------------------------------------------------------
// Vig-free consensus
// ---------------------------------------------------------------------------

export interface BookmakerConsensus {
  eventId: string
  homeTeam: string
  awayTeam: string
  commenceTime: string
  homeWinProbability: number
  awayWinProbability: number
  drawProbability: number | null
  bookmakerCount: number
  sport: string
}

/**
 * Decimal odds → raw implied probability.
 *
 * Decimal odds of 2.50 implies a 40% probability (1 / 2.50). Returns 0
 * for non-positive or non-finite input.
 */
export function decimalToImpliedProbability(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 0) return 0
  return 1 / decimal
}

/**
 * Strip the bookmaker margin (overround) from a probability vector.
 *
 * Bookmaker quoted probabilities always sum to > 100% — the excess is the
 * vig / profit margin. Normalising by the sum gives the true implied
 * probability of each outcome.
 *
 *   [0.55, 0.40, 0.15]  (sum = 1.10)
 *   → [0.50, 0.364, 0.136]
 */
export function removeVig(probabilities: number[]): number[] {
  const total = probabilities.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0)
  if (total <= 0) return probabilities.map(() => 0)
  return probabilities.map((p) => (Number.isFinite(p) ? p / total : 0))
}

function sportAllowsDraw(sportKey: string): boolean {
  return DRAW_POSSIBLE_SPORT_PREFIXES.some((prefix) => sportKey.startsWith(prefix))
}

/**
 * Average the vig-removed implied probabilities across every bookmaker
 * that quoted this event. Bookmakers without a usable h2h market are
 * silently skipped (they don't contribute to `bookmakerCount`).
 */
export function getConsensusForEvent(event: OddsApiEvent): BookmakerConsensus {
  const allowsDraw = sportAllowsDraw(event.sport_key)

  let homeSum = 0
  let awaySum = 0
  let drawSum = 0
  let count = 0

  for (const bookmaker of event.bookmakers ?? []) {
    const h2h = bookmaker.markets?.find((m) => m.key === 'h2h')
    if (!h2h || !Array.isArray(h2h.outcomes) || h2h.outcomes.length < 2) continue

    // Map outcomes by name so we never rely on Odds API's array ordering.
    const byName = new Map<string, number>()
    for (const outcome of h2h.outcomes) {
      if (!outcome?.name) continue
      byName.set(outcome.name, decimalToImpliedProbability(outcome.price))
    }

    const homeRaw = byName.get(event.home_team) ?? 0
    const awayRaw = byName.get(event.away_team) ?? 0
    const drawRaw = allowsDraw ? byName.get('Draw') ?? 0 : 0

    if (homeRaw <= 0 || awayRaw <= 0) continue
    if (allowsDraw && drawRaw <= 0) continue

    const probs = allowsDraw
      ? removeVig([homeRaw, awayRaw, drawRaw])
      : removeVig([homeRaw, awayRaw])

    const [home, away, draw] = probs
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue

    homeSum += home
    awaySum += away
    if (allowsDraw && Number.isFinite(draw)) drawSum += draw
    count += 1
  }

  if (count === 0) {
    return {
      eventId: event.id,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
      homeWinProbability: 0,
      awayWinProbability: 0,
      drawProbability: allowsDraw ? 0 : null,
      bookmakerCount: 0,
      sport: event.sport_key,
    }
  }

  return {
    eventId: event.id,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    commenceTime: event.commence_time,
    homeWinProbability: homeSum / count,
    awayWinProbability: awaySum / count,
    drawProbability: allowsDraw ? drawSum / count : null,
    bookmakerCount: count,
    sport: event.sport_key,
  }
}

// ---------------------------------------------------------------------------
// Quota store
// ---------------------------------------------------------------------------

interface OddsQuotaState {
  remaining: number | null
  used: number | null
  lastUpdated: number | null
  ingest: (response: Response) => void
}

/**
 * Side-channel Zustand store fed by every `fetchActiveSports` /
 * `fetchSportsOdds` call. Keeping it module-scoped instead of returning
 * quota from the fetch helpers lets us preserve the spec'd
 * `Promise<string[]>` / `Promise<OddsApiEvent[]>` signatures unchanged.
 *
 * `useOddsSignals` reads `remaining` to disable the manual "Refresh
 * signals" button when the monthly quota drops below `QUOTA_HARD_FLOOR`.
 */
export const useOddsQuotaStore = create<OddsQuotaState>((set) => ({
  remaining: null,
  used: null,
  lastUpdated: null,
  ingest: (response) => {
    const remainingRaw = response.headers.get('x-requests-remaining')
    const usedRaw = response.headers.get('x-requests-used')
    const remaining = remainingRaw ? Number(remainingRaw) : NaN
    const used = usedRaw ? Number(usedRaw) : NaN
    set({
      remaining: Number.isFinite(remaining) ? remaining : null,
      used: Number.isFinite(used) ? used : null,
      lastUpdated: Date.now(),
    })
  },
}))

// ---------------------------------------------------------------------------
// Client fetch helpers — both go through our own /api/odds/* proxy
// ---------------------------------------------------------------------------

class OddsApiClientError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OddsApiClientError'
    this.status = status
  }
}

export { OddsApiClientError }

interface SportsProxyBody {
  sports?: string[]
  quotaRemaining?: number | null
  quotaUsed?: number | null
  error?: string
}

interface EventsProxyBody {
  events?: OddsApiEvent[]
  quotaRemaining?: number | null
  quotaUsed?: number | null
  error?: string
}

async function fetchProxy<T>(path: string, signal?: AbortSignal): Promise<{ response: Response; body: T }> {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  })
  useOddsQuotaStore.getState().ingest(response)

  let body: T | undefined
  try {
    body = (await response.json()) as T
  } catch {
    // empty body — leave undefined
  }

  if (!response.ok) {
    const err = (body as unknown as { error?: string } | undefined)?.error
    throw new OddsApiClientError(
      err ?? `Request failed (${response.status})`,
      response.status,
    )
  }
  return { response, body: body as T }
}

/**
 * Fetch the intersection of currently-active Odds API sports and the
 * Polymarket-relevant allow-list. Returns the keys in priority order
 * (EPL → NFL → NBA → ...). Returns `[]` if the proxy reports the key is
 * not configured, so callers can degrade to structural-only gracefully.
 */
export async function fetchActiveSports(signal?: AbortSignal): Promise<string[]> {
  try {
    const { body } = await fetchProxy<SportsProxyBody>('/api/odds/sports', signal)
    return body.sports ?? []
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    if (err instanceof Error && err.name === 'AbortError') throw err
    if (err instanceof OddsApiClientError && err.status === 503) {
      // Key not configured — silently empty so the app keeps working in
      // pure-structural mode.
      return []
    }
    console.error('[oddsApi] fetchActiveSports failed:', err)
    return []
  }
}

/**
 * Fetch every upcoming event for a single sport. Returns `[]` on any
 * error so the caller can keep going with other sports.
 */
export async function fetchSportsOdds(
  sportKey: string,
  signal?: AbortSignal,
): Promise<OddsApiEvent[]> {
  if (!sportKey) return []
  try {
    const { body } = await fetchProxy<EventsProxyBody>(
      `/api/odds/events?sport=${encodeURIComponent(sportKey)}`,
      signal,
    )
    return body.events ?? []
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    if (err instanceof Error && err.name === 'AbortError') throw err
    if (err instanceof OddsApiClientError && err.status === 503) {
      return []
    }
    console.error(`[oddsApi] fetchSportsOdds(${sportKey}) failed:`, err)
    return []
  }
}
