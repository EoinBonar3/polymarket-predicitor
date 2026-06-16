/**
 * Core domain types for the Polymarket Edge Finder & Paper Trading Simulator.
 *
 * These interfaces are the single source of truth for the entire app — every
 * API route, hook, store, and component must consume these shapes verbatim.
 */

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

export interface Market {
  id: string
  slug: string
  title: string
  category: string
  endDate: string
  yesPrice: number
  noPrice: number
  volume24h: number
  liquidity: number
  resolvedOutcome: 'YES' | 'NO' | null
  priceHistory?: PricePoint[]
  /** Hourly volume buckets used by the volume-spike signal. */
  volumeHistory?: VolumePoint[]
  /**
   * Non-generic YES label when outcomes aren't "Yes"/"No" (e.g. team-name
   * sports markets). Falls back to `title` in the Path A matcher.
   */
  yesOutcomeText?: string
}

export interface PricePoint {
  timestamp: number
  price: number
}

export interface VolumePoint {
  timestamp: number
  /** Total traded volume in this hour (USDC). */
  volume: number
  /**
   * Net volume on the YES side (positive) vs NO side (negative) in this
   * hour. When omitted the spike signal infers direction from price lean.
   */
  yesNetVolume?: number
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalType = 'odds_gap' | 'volume_spike' | 'price_move'
export type SignalConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type Outcome = 'YES' | 'NO'

export interface Signal {
  marketId: string
  marketTitle: string
  type: SignalType
  ourProbability: number
  marketPrice: number
  edge: number
  kellyFraction: number
  suggestedStake: number
  confidence: SignalConfidence
  outcome: Outcome
  externalSource?: string
  createdAt: string
}

/**
 * Per-signal probability estimates used to build a `TradeSignal`'s `ourProbability`.
 *
 * Each of `volumeSpike` / `priceMomentum` / `staleMarket` is the standalone
 * ourP implied if only that signal fired (±4pp nudge from market price).
 * `blended` is the gated composite actually fed to the Kelly engine.
 */
export interface ProbabilityBreakdown {
  volumeSpike: number
  priceMomentum: number
  staleMarket: number
  blended: number
  weights: {
    volumeSpike: number
    priceMomentum: number
    staleMarket: number
  }
  activeSignals?: {
    volumeSpike: boolean
    priceMomentum: boolean
    staleMarket: boolean
  }
}

// ---------------------------------------------------------------------------
// Trade signals (bet recommendations produced by `lib/signals.ts`)
// ---------------------------------------------------------------------------

/**
 * Confidence bucket for `TradeSignal`s, derived from the absolute edge %.
 *
 * Intentionally distinct from the upstream `SignalConfidence` above (which
 * uses 'HIGH' | 'MEDIUM' | 'LOW' on the legacy `Signal` shape) — the
 * Kelly-driven trade engine has its own thresholds defined in
 * `lib/signals.ts` and uses lowercase variants for the UI badges.
 */
export type TradeSignalConfidence = 'high' | 'medium' | 'low'

/**
 * A bet recommendation surfaced on the dashboard / market detail pages.
 *
 * Lives here (rather than in `lib/signals.ts`) so the bankroll store can
 * accept a `TradeSignal` on `placeBet` for signals-log persistence without
 * pulling in the kelly / probability dependency graph.
 */
/**
 * Where did `ourProbability` come from?
 *   - 'odds_api'   → matched a sports event in The Odds API; `ourProbability`
 *                    is the vig-removed bookmaker consensus for the matched
 *                    outcome (much stronger than the structural blender).
 *   - 'kalshi'     → matched a Kalshi market for the same event (Gemini-
 *                    confirmed); `ourProbability` is Kalshi's YES price,
 *                    aligned to the Polymarket YES outcome.
 *   - 'structural' → no external match; `ourProbability` came from the
 *                    liquidity / time / volume blender in `lib/probability.ts`.
 */
export type TradeSignalSource = 'odds_api' | 'kalshi' | 'structural' | 'manifold'

/** Confidence bucket emitted by the `lib/marketMatcher` fuzzy matcher. */
export type TradeSignalMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Tier label for Odds API (Path A) sports matches — set by `lib/marketMatcher`. */
export type TradeSignalSportType = 'SPORTS_HIGH_CONF' | 'SPORTS_MED_CONF'

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
  confidence: TradeSignalConfidence
  /**
   * Per-signal breakdown of the blended `ourProbability`. Optional because
   * `TradeSignal`s constructed by older callers / fixtures may not carry it,
   * AND because odds-api-sourced signals don't have a structural breakdown.
   */
  probabilityBreakdown?: ProbabilityBreakdown
  /**
   * Source of `ourProbability`. Optional / defaults to `'structural'` so the
   * existing `buildSignals` output (which doesn't set this field) is treated
   * as structural without code changes there.
   */
  signalSource?: TradeSignalSource
  /** Fuzzy-match confidence — only present when `signalSource === 'odds_api'`. */
  matchConfidence?: TradeSignalMatchConfidence
  /** Bookmaker count that contributed to the consensus — odds_api only. */
  bookmakerCount?: number
  /** Path A tier — only present when `signalSource === 'odds_api'`. */
  signalType?: TradeSignalSportType
  /** How many structural signals fired (1, 2, or 3) — structural signals only. */
  signalCount?: number
  /** Strength bucket: weak=1 signal, moderate=2, strong=3 — structural only. */
  signalStrength?: 'weak' | 'moderate' | 'strong'
}

// ---------------------------------------------------------------------------
// Positions / Portfolio
// ---------------------------------------------------------------------------

export type PositionStatus = 'open' | 'won' | 'lost'

export interface Position {
  id: string
  marketId: string
  marketTitle: string
  outcome: Outcome
  stake: number
  price: number
  shares: number
  potentialPayout: number
  signalEdge: number
  ourProbability?: number
  status: PositionStatus
  placedAt: string
  resolvedAt?: string
  profit?: number
  /**
   * Signal provenance captured at bet time, used by the closed-loop learner
   * (`lib/learning.ts`) to attribute realised performance back to the signals
   * that produced the bet. All optional — older positions / odds-api bets may
   * not carry them, and the learner treats absence as "no attribution".
   */
  signalSource?: TradeSignalSource
  /** How many structural signals fired (1, 2, or 3) — structural bets only. */
  signalCount?: number
  signalStrength?: 'weak' | 'moderate' | 'strong'
  /** Which of the three structural signals fired for this bet. */
  activeSignals?: {
    volumeSpike: boolean
    priceMomentum: boolean
    staleMarket: boolean
  }
}

export interface BankrollHistoryPoint {
  timestamp: string
  balance: number
}

export interface BankrollStats {
  balance: number
  startingBalance: number
  totalStaked: number
  totalProfit: number
  openPositions: number
  closedPositions: number
  winRate: number
  roi: number
  bankrollHistory: BankrollHistoryPoint[]
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/** Standard envelope returned by our internal `/api/*` proxy routes. */
export interface ApiResponse<T> {
  data: T
  count?: number
  fetchedAt: string
}

/** Standard error shape returned by our internal `/api/*` proxy routes. */
export interface ApiError {
  error: string
  status: number
  details?: string
}

/** Optional query params accepted by `/api/markets`. */
export interface MarketsQuery {
  category?: string
  limit?: number
  offset?: number
  sort?: 'volume_24hr' | 'liquidity' | 'newest' | 'ending_soon'
}

// ---------------------------------------------------------------------------
// Raw Polymarket Gamma response shapes (only fields we actually rely on)
// ---------------------------------------------------------------------------

/**
 * A single market nested inside a Gamma `event`. The Gamma API returns far
 * more fields than this — we narrow to the ones the app uses so unexpected
 * upstream changes fail loudly at the mapping layer rather than silently.
 */
export interface GammaMarket {
  id: string
  question?: string
  slug?: string
  conditionId?: string
  clobTokenIds?: string | string[]
  endDate?: string
  endDateIso?: string
  category?: string
  volume24hr?: number | string
  volumeNum?: number | string
  liquidityNum?: number | string
  liquidity?: number | string
  outcomes?: string | string[]
  outcomePrices?: string | string[]
  lastTradePrice?: number | string
  bestBid?: number | string
  bestAsk?: number | string
  closed?: boolean
  active?: boolean
  archived?: boolean
  resolved?: boolean
  resolvedOutcome?: string | null
  /**
   * UMA oracle settlement status. Gamma does NOT expose `resolved`/
   * `resolvedOutcome` — a settled market is `closed: true` with
   * `umaResolutionStatus: "resolved"` and the winning leg priced 1 in
   * `outcomePrices`. These are the fields the resolver actually reads.
   */
  umaResolutionStatus?: string
  automaticallyResolved?: boolean
}

export interface GammaEvent {
  id: string
  slug?: string
  title?: string
  category?: string
  endDate?: string
  volume24hr?: number | string
  liquidity?: number | string
  markets?: GammaMarket[]
}
