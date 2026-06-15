/**
 * Structural probability engine — 3-signal composite model.
 *
 * `computeStructuralSignal(market)` evaluates three independent gates:
 *   1. Volume spike anomaly (hourly volume vs 7-day median)
 *   2. Price momentum (4h YES move > 3pp)
 *   3. Stale market (near expiry, mid-priced, low volume, no recent trade)
 *
 * ourP is produced when ≥1 signal fires. Each active directional signal
 * nudges yesPrice by a per-signal weight (volume-spike ±5pp, momentum ±4pp,
 * stale ±3pp); stale markets without a forced direction nudge toward the
 * side closest to 50%. More agreeing signals → larger nudge → higher edge.
 */

import type { Market, Outcome, PricePoint, ProbabilityBreakdown, VolumePoint } from './types'

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const SPIKE_LOOKBACK_DAYS = 7
const SPIKE_MEDIAN_MULTIPLIER = 3
const SPIKE_PRICE_STABILITY_HOURS = 6
const SPIKE_PRICE_STABILITY_PP = 0.015

const MOMENTUM_LOOKBACK_HOURS = 4
const MOMENTUM_THRESHOLD_PP = 0.03
const MOMENTUM_MIN_DAYS_TO_EXPIRY = 5

const STALE_MAX_DAYS_TO_EXPIRY = 7
const STALE_PRICE_FLOOR = 0.2
const STALE_PRICE_CEIL = 0.8
const STALE_DAILY_LOOKBACK_DAYS = 30
const STALE_LAST_CHANGE_HOURS = 12

const MIN_ACTIVE_SIGNALS = 1

// Per-signal nudge weights (pp toward each signal's lean). Volume-spike is the
// strongest structural signal (sudden conviction with stable price), momentum
// is mid, stale is the weakest. The total nudge is the sum of whichever signals
// fire — so two agreeing signals naturally produce a larger edge and rank higher.
const VOLUME_SPIKE_NUDGE_PP = 0.05
const MOMENTUM_NUDGE_PP = 0.04
const STALE_NUDGE_PP = 0.03

const OUR_P_FLOOR = 0.05
const OUR_P_CEIL = 0.95

/** Display weights for the UI contribution bars (equal thirds). */
export const STRUCTURAL_SIGNAL_WEIGHTS = {
  volumeSpike: 1 / 3,
  priceMomentum: 1 / 3,
  staleMarket: 1 / 3,
} as const

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export interface StructuralSignalState {
  active: boolean
  direction: Outcome | null
}

export interface StructuralSignalResult {
  ourP: number | null
  gatePassed: boolean
  activeSignalCount: number
  /** How many structural signals fired (0, 1, 2, or 3). */
  signalCount: number
  /** Strength bucket derived from `signalCount`; null when nothing fired. */
  signalStrength: 'weak' | 'moderate' | 'strong' | null
  rejectionReason: string | null
  signals: {
    volumeSpike: StructuralSignalState
    priceMomentum: StructuralSignalState
    staleMarket: StructuralSignalState
  }
  breakdown: ProbabilityBreakdown | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampOurP(p: number): number {
  if (!Number.isFinite(p)) return 0.5
  if (p < OUR_P_FLOOR) return OUR_P_FLOOR
  if (p > OUR_P_CEIL) return OUR_P_CEIL
  return p
}

function safeYesPrice(market: Market): number {
  const yes = market.yesPrice
  if (!Number.isFinite(yes) || yes <= 0 || yes >= 1) return 0.5
  return yes
}

function daysToExpiry(market: Market): number | null {
  const end = new Date(market.endDate).getTime()
  if (!Number.isFinite(end)) return null
  return (end - Date.now()) / DAY_MS
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

function sortedHistory<T extends { timestamp: number }>(points: T[] | undefined): T[] {
  if (!Array.isArray(points) || points.length === 0) return []
  return [...points].sort((a, b) => a.timestamp - b.timestamp)
}

function priceAtOrBefore(history: PricePoint[], targetMs: number, fallback: number): number {
  const sorted = sortedHistory(history)
  if (sorted.length === 0) return fallback

  let best = sorted[0]
  for (const point of sorted) {
    if (point.timestamp <= targetMs) best = point
    else break
  }
  return Number.isFinite(best.price) ? best.price : fallback
}

function priceMovePp(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return to - from
}

function hoursSinceLastPriceChange(history: PricePoint[], currentPrice: number): number | null {
  const sorted = sortedHistory(history)
  if (sorted.length === 0) return null

  const epsilon = 0.0005
  let lastChangeMs = sorted[0].timestamp

  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.abs(sorted[i].price - sorted[i - 1].price) > epsilon) {
      lastChangeMs = sorted[i].timestamp
    }
  }

  if (Math.abs(sorted[sorted.length - 1].price - currentPrice) > epsilon) {
    lastChangeMs = Date.now()
  }

  return (Date.now() - lastChangeMs) / HOUR_MS
}

function dailyVolumesFromHourly(history: VolumePoint[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const point of history) {
    const dayKey = new Date(point.timestamp).toISOString().slice(0, 10)
    totals.set(dayKey, (totals.get(dayKey) ?? 0) + Math.max(0, point.volume))
  }
  return totals
}

function averageDailyVolume(history: VolumePoint[], lookbackDays: number): number | null {
  const totals = dailyVolumesFromHourly(history)
  if (totals.size === 0) return null

  const dayKeys = [...totals.keys()].sort().slice(-lookbackDays)
  if (dayKeys.length === 0) return null

  const sum = dayKeys.reduce((acc, key) => acc + (totals.get(key) ?? 0), 0)
  return sum / dayKeys.length
}

function closestSideToFifty(yes: number): Outcome {
  const no = 1 - yes
  return Math.abs(yes - 0.5) <= Math.abs(no - 0.5) ? 'YES' : 'NO'
}

function inferVolumeDirection(
  yes: number,
  latestHour: VolumePoint | null,
): Outcome {
  if (latestHour?.yesNetVolume != null) {
    if (latestHour.yesNetVolume > 0) return 'YES'
    if (latestHour.yesNetVolume < 0) return 'NO'
  }
  return yes >= 0.5 ? 'YES' : 'NO'
}

function nudgeFromDirection(yes: number, direction: Outcome, magnitudePp: number): number {
  return direction === 'YES' ? yes + magnitudePp : yes - magnitudePp
}

function standaloneSignalP(
  yes: number,
  state: StructuralSignalState,
  magnitudePp: number,
): number {
  if (!state.active) return yes
  const direction = state.direction ?? closestSideToFifty(yes)
  return clampOurP(nudgeFromDirection(yes, direction, magnitudePp))
}

function strengthFromCount(count: number): 'weak' | 'moderate' | 'strong' | null {
  if (count >= 3) return 'strong'
  if (count === 2) return 'moderate'
  if (count === 1) return 'weak'
  return null
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

function evaluateVolumeSpikeSignal(market: Market, yes: number): StructuralSignalState {
  const history = sortedHistory(market.volumeHistory)
  if (history.length === 0) {
    return { active: false, direction: null }
  }

  const lookbackMs = SPIKE_LOOKBACK_DAYS * DAY_MS
  const cutoff = Date.now() - lookbackMs
  const baselinePoints = history.filter((p) => p.timestamp >= cutoff && p.timestamp < Date.now() - HOUR_MS)

  const currentHourStart = Date.now() - HOUR_MS
  const currentHourPoint =
    [...history].reverse().find((p) => p.timestamp >= currentHourStart) ?? history[history.length - 1]
  const currentHourVolume = Math.max(0, currentHourPoint?.volume ?? 0)

  const hourlyVolumes = baselinePoints.map((p) => Math.max(0, p.volume))
  if (hourlyVolumes.length === 0 || currentHourVolume <= 0) {
    return { active: false, direction: null }
  }

  const medianHourly = median(hourlyVolumes)
  const spikeThreshold = medianHourly * SPIKE_MEDIAN_MULTIPLIER
  if (currentHourVolume <= spikeThreshold) {
    return { active: false, direction: null }
  }

  const priceHistory = sortedHistory(market.priceHistory)
  const priceNow = yes
  const priceSixHoursAgo = priceAtOrBefore(
    priceHistory,
    Date.now() - SPIKE_PRICE_STABILITY_HOURS * HOUR_MS,
    priceNow,
  )
  const movePp = Math.abs(priceMovePp(priceSixHoursAgo, priceNow))
  if (movePp > SPIKE_PRICE_STABILITY_PP) {
    return { active: false, direction: null }
  }

  return {
    active: true,
    direction: inferVolumeDirection(yes, currentHourPoint),
  }
}

function evaluatePriceMomentumSignal(market: Market, yes: number): StructuralSignalState {
  const daysLeft = daysToExpiry(market)
  if (daysLeft !== null && daysLeft < MOMENTUM_MIN_DAYS_TO_EXPIRY) {
    return { active: false, direction: null }
  }

  const priceHistory = sortedHistory(market.priceHistory)
  if (priceHistory.length === 0) {
    return { active: false, direction: null }
  }

  const priceNow = yes
  const priceFourHoursAgo = priceAtOrBefore(
    priceHistory,
    Date.now() - MOMENTUM_LOOKBACK_HOURS * HOUR_MS,
    priceNow,
  )
  const movePp = priceMovePp(priceFourHoursAgo, priceNow)

  if (Math.abs(movePp) <= MOMENTUM_THRESHOLD_PP) {
    return { active: false, direction: null }
  }

  return {
    active: true,
    direction: movePp > 0 ? 'YES' : 'NO',
  }
}

function evaluateStaleMarketSignal(market: Market, yes: number): StructuralSignalState {
  const daysLeft = daysToExpiry(market)
  if (daysLeft === null || daysLeft > STALE_MAX_DAYS_TO_EXPIRY) {
    return { active: false, direction: null }
  }

  if (yes < STALE_PRICE_FLOOR || yes > STALE_PRICE_CEIL) {
    return { active: false, direction: null }
  }

  const volumeHistory = sortedHistory(market.volumeHistory)
  const avgDaily = averageDailyVolume(volumeHistory, STALE_DAILY_LOOKBACK_DAYS)
  if (avgDaily === null || market.volume24h >= avgDaily) {
    return { active: false, direction: null }
  }

  const hoursSinceChange = hoursSinceLastPriceChange(
    sortedHistory(market.priceHistory),
    yes,
  )
  if (hoursSinceChange === null || hoursSinceChange <= STALE_LAST_CHANGE_HOURS) {
    return { active: false, direction: null }
  }

  return {
    active: true,
    direction: null,
  }
}

// ---------------------------------------------------------------------------
// Composite gate + ourP
// ---------------------------------------------------------------------------

function buildBreakdown(
  yes: number,
  signals: StructuralSignalResult['signals'],
  ourP: number,
): ProbabilityBreakdown {
  return {
    volumeSpike: standaloneSignalP(yes, signals.volumeSpike, VOLUME_SPIKE_NUDGE_PP),
    priceMomentum: standaloneSignalP(yes, signals.priceMomentum, MOMENTUM_NUDGE_PP),
    staleMarket: standaloneSignalP(yes, signals.staleMarket, STALE_NUDGE_PP),
    blended: ourP,
    weights: { ...STRUCTURAL_SIGNAL_WEIGHTS },
    activeSignals: {
      volumeSpike: signals.volumeSpike.active,
      priceMomentum: signals.priceMomentum.active,
      staleMarket: signals.staleMarket.active,
    },
  }
}

function computeOurP(yes: number, signals: StructuralSignalResult['signals']): number {
  let ourP = yes

  const applyNudge = (state: StructuralSignalState, magnitudePp: number) => {
    if (!state.active) return
    const direction = state.direction ?? closestSideToFifty(yes)
    ourP = nudgeFromDirection(ourP, direction, magnitudePp)
  }

  applyNudge(signals.volumeSpike, VOLUME_SPIKE_NUDGE_PP)
  applyNudge(signals.priceMomentum, MOMENTUM_NUDGE_PP)
  applyNudge(signals.staleMarket, STALE_NUDGE_PP)

  return clampOurP(ourP)
}

/**
 * Evaluate the 3-signal structural model for a market.
 *
 * Returns `ourP: null` only when no signal fires (gate failure).
 */
export function computeStructuralSignal(market: Market): StructuralSignalResult {
  const yes = safeYesPrice(market)

  const signals = {
    volumeSpike: evaluateVolumeSpikeSignal(market, yes),
    priceMomentum: evaluatePriceMomentumSignal(market, yes),
    staleMarket: evaluateStaleMarketSignal(market, yes),
  }

  const activeSignalCount = [
    signals.volumeSpike.active,
    signals.priceMomentum.active,
    signals.staleMarket.active,
  ].filter(Boolean).length

  if (activeSignalCount < MIN_ACTIVE_SIGNALS) {
    return {
      ourP: null,
      gatePassed: false,
      activeSignalCount,
      signalCount: activeSignalCount,
      signalStrength: strengthFromCount(activeSignalCount),
      rejectionReason: `Insufficient signal consensus — only ${activeSignalCount}/3 signals active`,
      signals,
      breakdown: null,
    }
  }

  const ourP = computeOurP(yes, signals)

  return {
    ourP,
    gatePassed: true,
    activeSignalCount,
    signalCount: activeSignalCount,
    signalStrength: strengthFromCount(activeSignalCount),
    rejectionReason: null,
    signals,
    breakdown: buildBreakdown(yes, signals, ourP),
  }
}
