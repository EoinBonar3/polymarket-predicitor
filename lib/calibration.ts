/**
 * Calibration analytics for the signal engine.
 *
 * "Calibration" answers: when we say a market has a 70% chance of resolving
 * YES, does it actually resolve YES ~70% of the time? Perfect calibration
 * means predicted probability == empirical win rate at every bucket.
 *
 * Pure functions only — no React, no Zustand, no Recharts. Consumed by
 * `components/charts/CalibrationChart.tsx` and `CalibrationStats.tsx`.
 */

import type { Position } from '@/lib/types'
import { clamp, wilsonInterval } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalibrationBucket {
  /** Human label for the bucket range, e.g. "60–80%". */
  bucketLabel: string
  /** Centre of the bucket range — used as the x-axis position on the chart. */
  bucketMidpoint: number
  /** Mean `ourProbability` of the inputs in this bucket (or midpoint if empty). */
  predictedProbability: number
  /** Empirical win rate (wins / totalBets), 0 when bucket is empty. */
  actualWinRate: number
  totalBets: number
  wins: number
  /** Wilson 95% CI lower bound on the win rate. */
  confidenceLower: number
  /** Wilson 95% CI upper bound on the win rate. */
  confidenceUpper: number
  /** 'mixed' if the bucket contains multiple sources, else the unique source. */
  signalSource: 'odds_api' | 'kalshi' | 'structural' | 'manifold' | 'mixed'
}

export interface CalibrationData {
  /** Five buckets covering all closed signals. Always length 5. */
  allBuckets: CalibrationBucket[]
  /** Five buckets, odds-API-sourced signals only. Always length 5. */
  oddsBuckets: CalibrationBucket[]
  /** Five buckets, structural signals only. Always length 5. */
  structuralBuckets: CalibrationBucket[]
  /** Mean squared error between predicted and outcome. Lower = better. */
  brierScore: number
  /** Log loss. Lower = better. Random baseline ≈ 0.693. */
  logLoss: number
  /** Mean |predicted - actual| across non-empty buckets. */
  meanCalibrationError: number
  /** Mean (predicted - actual) across non-empty buckets. +ve = overconfident. */
  overconfidenceBias: number
  /** Count of all closed positions feeding the analysis. */
  totalResolved: number
  /** Best-performing bucket with at least 5 bets, or null. */
  bestBucket: CalibrationBucket | null
}

export interface CalibrationInput {
  ourProbability: number
  outcome: 0 | 1
  signalSource: 'odds_api' | 'kalshi' | 'structural' | 'manifold'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Five evenly-spaced bucket boundaries. The final bucket is inclusive on the
 * right edge so a perfect 1.0 prediction (rare but possible) is captured.
 */
const BUCKET_EDGES: ReadonlyArray<[number, number]> = [
  [0.0, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1.0],
]

/**
 * Rough edge magnitude above which we assume the signal came from the Odds
 * API (vig-removed bookmaker consensus tends to disagree with Polymarket by
 * larger margins than the structural blender). Only used as a fallback when
 * `Position` doesn't carry an explicit `signal_source`.
 */
const ODDS_API_EDGE_PROXY = 0.08

// ---------------------------------------------------------------------------
// Position → CalibrationInput
// ---------------------------------------------------------------------------

/**
 * Shape we accept opportunistically — current `Position` doesn't expose
 * `signal_source`, but a future migration could add it, in which case we'd
 * prefer the real field over the magnitude proxy.
 */
type PositionWithMaybeSource = Position & {
  signal_source?: 'odds_api' | 'kalshi' | 'structural' | 'manifold'
  signalSource?: 'odds_api' | 'kalshi' | 'structural' | 'manifold'
}

function inferSignalSource(
  position: PositionWithMaybeSource,
): 'odds_api' | 'kalshi' | 'structural' | 'manifold' {
  const explicit = position.signal_source ?? position.signalSource
  if (
    explicit === 'odds_api' ||
    explicit === 'kalshi' ||
    explicit === 'structural' ||
    explicit === 'manifold'
  ) {
    return explicit
  }
  return Math.abs(position.signalEdge ?? 0) > ODDS_API_EDGE_PROXY
    ? 'odds_api'
    : 'structural'
}

/**
 * Convert closed positions into `(predictedProbability, outcome, source)`
 * triplets. Open / unresolved positions and positions with non-finite fields
 * are dropped.
 */
export function buildCalibrationInputs(positions: Position[]): CalibrationInput[] {
  const inputs: CalibrationInput[] = []
  for (const raw of positions) {
    if (raw.status !== 'won' && raw.status !== 'lost') continue
    const price = raw.price
    const edge = raw.signalEdge ?? 0
    if (!Number.isFinite(price) || !Number.isFinite(edge)) continue

    const ourProbability = clamp(price + edge, 0.01, 0.99)
    const outcome: 0 | 1 = raw.status === 'won' ? 1 : 0
    const signalSource = inferSignalSource(raw as PositionWithMaybeSource)

    inputs.push({ ourProbability, outcome, signalSource })
  }
  return inputs
}

// ---------------------------------------------------------------------------
// Bucket construction
// ---------------------------------------------------------------------------

function bucketIndexFor(p: number): number {
  // Bucket the final edge inclusively so p === 1 lands in [0.8, 1.0].
  if (p >= 1) return BUCKET_EDGES.length - 1
  if (p < 0) return 0
  for (let i = 0; i < BUCKET_EDGES.length; i += 1) {
    const [lo, hi] = BUCKET_EDGES[i]
    if (p >= lo && p < hi) return i
  }
  return BUCKET_EDGES.length - 1
}

function formatBucketLabel([lo, hi]: readonly [number, number]): string {
  return `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`
}

/**
 * Build the five-bucket calibration breakdown for the supplied inputs.
 *
 * Always returns exactly five buckets so the chart axes and tooltips have a
 * stable shape even when most buckets are empty.
 */
export function buildBuckets(
  inputs: CalibrationInput[],
  sourceFilter?: 'odds_api' | 'kalshi' | 'structural' | 'manifold',
): CalibrationBucket[] {
  const filtered = sourceFilter
    ? inputs.filter((i) => i.signalSource === sourceFilter)
    : inputs

  const grouped: CalibrationInput[][] = BUCKET_EDGES.map(() => [])
  for (const input of filtered) {
    grouped[bucketIndexFor(input.ourProbability)].push(input)
  }

  return BUCKET_EDGES.map((edges, idx) => {
    const members = grouped[idx]
    const midpoint = (edges[0] + edges[1]) / 2
    const totalBets = members.length
    const wins = members.reduce((sum, m) => sum + m.outcome, 0)
    const predictedProbability =
      totalBets > 0
        ? members.reduce((sum, m) => sum + m.ourProbability, 0) / totalBets
        : midpoint
    const actualWinRate = totalBets > 0 ? wins / totalBets : 0
    const { lower, upper } = wilsonInterval(wins, totalBets)

    let signalSource: CalibrationBucket['signalSource']
    if (totalBets === 0) {
      signalSource = sourceFilter ?? 'mixed'
    } else {
      const first = members[0].signalSource
      const uniform = members.every((m) => m.signalSource === first)
      signalSource = uniform ? first : 'mixed'
    }

    return {
      bucketLabel: formatBucketLabel(edges),
      bucketMidpoint: midpoint,
      predictedProbability,
      actualWinRate,
      totalBets,
      wins,
      confidenceLower: lower,
      confidenceUpper: upper,
      signalSource,
    }
  })
}

// ---------------------------------------------------------------------------
// Scoring metrics
// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Brier score — mean squared error between predicted probability and the
 * binary outcome. Range [0, 1], lower is better. A random guesser (p=0.5)
 * scores 0.25, which we return as the empty-input fallback.
 */
export function calculateBrierScore(inputs: CalibrationInput[]): number {
  if (inputs.length === 0) return 0.25
  const sum = inputs.reduce((acc, i) => {
    const diff = i.ourProbability - i.outcome
    return acc + diff * diff
  }, 0)
  return round4(sum / inputs.length)
}

/**
 * Log loss (a.k.a. binary cross-entropy). Penalises confident wrong
 * predictions much more than mild mistakes. Probabilities are clamped to
 * [0.001, 0.999] to avoid log(0).
 */
export function calculateLogLoss(inputs: CalibrationInput[]): number {
  if (inputs.length === 0) return round4(Math.log(2))
  const sum = inputs.reduce((acc, i) => {
    const p = clamp(i.ourProbability, 0.001, 0.999)
    return acc + (i.outcome * Math.log(p) + (1 - i.outcome) * Math.log(1 - p))
  }, 0)
  return round4(-sum / inputs.length)
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

function meanAbsCalibrationError(buckets: CalibrationBucket[]): number {
  const populated = buckets.filter((b) => b.totalBets > 0)
  if (populated.length === 0) return 0
  const sum = populated.reduce(
    (acc, b) => acc + Math.abs(b.predictedProbability - b.actualWinRate),
    0,
  )
  return sum / populated.length
}

function meanSignedCalibrationError(buckets: CalibrationBucket[]): number {
  const populated = buckets.filter((b) => b.totalBets > 0)
  if (populated.length === 0) return 0
  const sum = populated.reduce(
    (acc, b) => acc + (b.predictedProbability - b.actualWinRate),
    0,
  )
  return sum / populated.length
}

function pickBestBucket(buckets: CalibrationBucket[]): CalibrationBucket | null {
  let best: CalibrationBucket | null = null
  for (const b of buckets) {
    if (b.totalBets < 5) continue
    if (best === null || b.actualWinRate > best.actualWinRate) best = b
  }
  return best
}

/**
 * One-shot orchestrator — build everything the calibration UI needs from a
 * raw list of positions.
 */
export function buildCalibrationData(positions: Position[]): CalibrationData {
  const inputs = buildCalibrationInputs(positions)
  const allBuckets = buildBuckets(inputs)
  const oddsBuckets = buildBuckets(inputs, 'odds_api')
  const structuralBuckets = buildBuckets(inputs, 'structural')

  return {
    allBuckets,
    oddsBuckets,
    structuralBuckets,
    brierScore: calculateBrierScore(inputs),
    logLoss: calculateLogLoss(inputs),
    meanCalibrationError: meanAbsCalibrationError(allBuckets),
    overconfidenceBias: meanSignedCalibrationError(allBuckets),
    totalResolved: inputs.length,
    bestBucket: pickBestBucket(allBuckets),
  }
}
