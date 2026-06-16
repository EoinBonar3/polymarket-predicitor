/**
 * General Polymarket backtest — point-in-time, no look-ahead.
 *
 * Unlike the crypto harness (which scores an external options-vol MODEL against
 * resolved markets), this asks a more basic, honest question about the venue
 * itself: **is the Polymarket crowd calibrated, and is there a favorite-longshot
 * bias?** For a sample of resolved markets it snapshots the market's own YES
 * price `leadDays` before resolution (the crowd's point-in-time forecast) and
 * scores it against the eventual outcome.
 *
 *   - Calibration: when the crowd says 70%, does it resolve YES ~70%? (Brier,
 *     log-loss, per-bucket predicted-vs-actual — reuses `lib/calibration.ts`.)
 *   - Favorite-longshot bias: are longshots systematically overpriced and
 *     favorites underpriced? (the classic prediction-market anomaly)
 *   - A flat "bet the favorite" strategy P&L, to see if the bias is tradeable.
 *
 * Every input is sampled `at-or-before` the snapshot via `valueAtOrBefore`, so a
 * snapshot only ever sees prices that existed at that time. The resolution is
 * the only future information used, and only as the label. Pure report — writes
 * nothing to the live paper-trading tables.
 */

import {
  buildBuckets,
  calculateBrierScore,
  calculateLogLoss,
  type CalibrationInput,
} from '../calibration'
import { fetchPmHistory, valueAtOrBefore } from './marketData'

const DAY_MS = 24 * 60 * 60 * 1000

export interface PmBacktestOptions {
  /** Gamma pages of closed markets to walk (100 markets/page). */
  maxPages?: number
  /** Hard cap on markets actually scored (bounds CLOB history calls). */
  maxMarkets?: number
  /** Drop markets below this resolved volume (focuses on liquid books). */
  minVolume?: number
  /** Days before resolution at which to snapshot the crowd's price. */
  leadDays?: number
  /** Flat stake for the favorite strategy P&L. */
  stake?: number
  log?: (msg: string) => void
}

export interface BacktestSample {
  question: string
  predicted: number
  outcome: 0 | 1
  snapshotMs: number
}

export interface CalibrationRow {
  label: string
  predicted: number
  actual: number
  n: number
  /** actual − predicted. Negative = the crowd overpriced this bucket. */
  gap: number
}

export interface PmBacktestReport {
  leadDays: number
  coverage: { parsed: number; withHistory: number; samples: number }
  baseRate: number
  /** Brier of the crowd's price (lower = better; predicting base rate = baseline). */
  brierMarket: number
  brierBaseline: number
  logLossMarket: number
  buckets: CalibrationRow[]
  /** Mean (actual − predicted) for longshot (<40%) vs favorite (>60%) buckets. */
  longshotBias: { longshotGap: number; favoriteGap: number }
  /** Flat-stake "bet the favored side of every market" strategy. */
  favoriteStrategy: {
    n: number
    winRate: number
    roi: number
    startBankroll: number
    finalBankroll: number
  }
  examples: BacktestSample[]
}

// ---------------------------------------------------------------------------
// Gamma fetch (general resolved markets — not crypto-specific)
// ---------------------------------------------------------------------------

interface GammaClosedMarket {
  question?: string
  endDate?: string
  createdAt?: string
  closed?: boolean
  outcomePrices?: unknown
  clobTokenIds?: unknown
  volumeNum?: number | string
}

interface ResolvedMarket {
  question: string
  createdAtMs: number
  endDateMs: number
  yesToken: string | null
  outcome: 0 | 1
  volume: number
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw)
      if (Array.isArray(p)) return p.map(String)
    } catch {
      /* ignore */
    }
  }
  return []
}

/** YES=1 / NO=0 from a closed market's terminal outcome prices, else null. */
function outcomeFrom(outcomePrices: unknown): 0 | 1 | null {
  const prices = parseJsonArray(outcomePrices).map(Number)
  if (prices.length < 2 || !prices.every(Number.isFinite)) return null
  if (prices[0] >= 0.99 && prices[1] <= 0.01) return 1
  if (prices[1] >= 0.99 && prices[0] <= 0.01) return 0
  return null
}

async function fetchResolvedMarkets(maxPages: number, minVolume: number): Promise<ResolvedMarket[]> {
  const out: ResolvedMarket[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=${page * 100}&order=volumeNum&ascending=false`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) break
    const batch = (await res.json()) as GammaClosedMarket[]
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const m of batch) {
      if (!m.question || !m.endDate || !m.createdAt) continue
      const volume = Number(m.volumeNum) || 0
      if (volume < minVolume) continue
      const outcome = outcomeFrom(m.outcomePrices)
      if (outcome === null) continue
      const tokens = parseJsonArray(m.clobTokenIds)
      out.push({
        question: m.question,
        createdAtMs: new Date(m.createdAt).getTime(),
        endDateMs: new Date(m.endDate).getTime(),
        yesToken: tokens[0] ?? null,
        outcome,
        volume,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------

export async function runPmBacktest(opts: PmBacktestOptions = {}): Promise<PmBacktestReport> {
  const maxPages = opts.maxPages ?? 8
  const maxMarkets = opts.maxMarkets ?? 150
  const minVolume = opts.minVolume ?? 20_000
  const leadDays = opts.leadDays ?? 7
  const stake = opts.stake ?? 10
  const log = opts.log ?? (() => {})

  log(`Fetching resolved markets (≥ $${minVolume.toLocaleString()} volume)…`)
  let markets = await fetchResolvedMarkets(maxPages, minVolume)
  log(`Parsed ${markets.length} resolved markets with clean YES/NO outcomes.`)
  markets = markets.filter((m) => m.yesToken).slice(0, maxMarkets)

  const samples: BacktestSample[] = []
  let withHistory = 0

  for (let i = 0; i < markets.length; i += 1) {
    const m = markets[i]
    if (i > 0 && i % 25 === 0) log(`  …priced ${i}/${markets.length} markets (${samples.length} samples)`)

    const history = await fetchPmHistory(m.yesToken as string)
    if (history.length === 0) continue
    withHistory += 1

    // Snapshot the crowd's YES price `leadDays` before resolution. Require the
    // market to have existed at that point and to have a price at-or-before it.
    const snapshotMs = m.endDateMs - leadDays * DAY_MS
    if (snapshotMs < m.createdAtMs) continue
    const predicted = valueAtOrBefore(history, snapshotMs)
    if (predicted === null || !(predicted > 0 && predicted < 1)) continue

    samples.push({ question: m.question, predicted, outcome: m.outcome, snapshotMs })
  }

  return buildReport(samples, { leadDays, stake, parsed: markets.length, withHistory })
}

function buildReport(
  samples: BacktestSample[],
  ctx: { leadDays: number; stake: number; parsed: number; withHistory: number },
): PmBacktestReport {
  const inputs: CalibrationInput[] = samples.map((s) => ({
    ourProbability: s.predicted,
    outcome: s.outcome,
    signalSource: 'structural',
  }))

  const baseRate = samples.length ? samples.reduce((a, s) => a + s.outcome, 0) / samples.length : 0
  // Brier of always predicting the base rate — the "no skill" baseline.
  const brierBaseline = baseRate * (1 - baseRate)

  const buckets: CalibrationRow[] = buildBuckets(inputs)
    .filter((b) => b.totalBets > 0)
    .map((b) => ({
      label: b.bucketLabel,
      predicted: b.predictedProbability,
      actual: b.actualWinRate,
      n: b.totalBets,
      gap: b.actualWinRate - b.predictedProbability,
    }))

  const longshots = buckets.filter((b) => b.predicted < 0.4)
  const favorites = buckets.filter((b) => b.predicted > 0.6)
  const meanGap = (rows: CalibrationRow[]) =>
    rows.length ? rows.reduce((a, b) => a + b.gap, 0) / rows.length : 0

  // Flat-stake strategy: bet the favored side (price > 0.5) of every market.
  // If favorites are underpriced (the longshot-bias prediction), this is +EV.
  const startBankroll = 1000
  let bankroll = startBankroll
  let bets = 0
  let wins = 0
  for (const s of samples) {
    const betYes = s.predicted > 0.5
    const entry = betYes ? s.predicted : 1 - s.predicted
    if (!(entry > 0.5 && entry < 1)) continue // skip toss-ups
    const won = betYes ? s.outcome === 1 : s.outcome === 0
    bankroll += won ? ctx.stake * (1 / entry - 1) : -ctx.stake
    bets += 1
    if (won) wins += 1
  }

  return {
    leadDays: ctx.leadDays,
    coverage: { parsed: ctx.parsed, withHistory: ctx.withHistory, samples: samples.length },
    baseRate,
    brierMarket: calculateBrierScore(inputs),
    brierBaseline: Math.round(brierBaseline * 10000) / 10000,
    logLossMarket: calculateLogLoss(inputs),
    buckets,
    longshotBias: { longshotGap: meanGap(longshots), favoriteGap: meanGap(favorites) },
    favoriteStrategy: {
      n: bets,
      winRate: bets ? wins / bets : 0,
      roi: bets ? (bankroll - startBankroll) / (bets * ctx.stake) : 0,
      startBankroll,
      finalBankroll: Math.round(bankroll * 100) / 100,
    },
    examples: samples.slice(0, 10),
  }
}
