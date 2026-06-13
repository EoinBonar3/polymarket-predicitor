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
}

export interface PricePoint {
  timestamp: number
  price: number
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
  status: PositionStatus
  placedAt: string
  resolvedAt?: string
  profit?: number
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
