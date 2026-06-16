/**
 * Crypto backtest harness — the Phase 1 keystone.
 *
 * For every resolved Polymarket crypto price-target market, it snapshots the
 * model at several horizons before resolution and scores it against the truth:
 *
 *   - Is the options/vol-implied probability well calibrated? (model Brier)
 *   - Does it beat Polymarket's own price? (market Brier, and the edge test)
 *   - When the model and the market disagree by ≥ threshold, does betting the
 *     model's side actually make money? (the only question that matters)
 *
 * All inputs are point-in-time (see `marketData.ts`); the outcome is the label.
 */

import { cryptoEventProbability, type CryptoAsset } from '../sources/cryptoMarket'
import {
  fetchDailyCloses,
  fetchImpliedVol,
  fetchPmHistory,
  fetchResolvedCryptoMarkets,
  realisedVolAt,
  valueAtOrBefore,
  type ResolvedCryptoMarket,
  type TimePoint,
} from './marketData'

const DAY_MS = 24 * 60 * 60 * 1000
const YEAR_MS = 365 * DAY_MS

export interface BacktestOptions {
  maxPages?: number
  maxMarkets?: number
  horizonsDays?: number[]
  edgeThreshold?: number
  log?: (msg: string) => void
}

interface Sample {
  question: string
  asset: CryptoAsset
  barrier: string
  horizonDays: number
  spot: number
  sigmaImplied: number | null
  sigmaRealised: number | null
  modelImplied: number | null
  modelRealised: number | null
  modelP: number | null // primary: implied-vol model, falls back to realised
  modelSource: 'implied' | 'realised' | null
  pmP: number | null
  outcome: 0 | 1
}

function brier(pairs: Array<{ p: number; o: number }>): number {
  if (pairs.length === 0) return NaN
  return pairs.reduce((a, b) => a + (b.p - b.o) ** 2, 0) / pairs.length
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface BacktestReport {
  coverage: {
    resolvedMarketsParsed: number
    marketsScored: number
    samples: number
    samplesWithImpliedVol: number
    samplesWithPmPrice: number
  }
  model: { samples: number; brier: number; brierRealised: number }
  market: { samples: number; brier: number }
  /** Edge on all ≥threshold disagreements. */
  edge: { threshold: number } & EdgeStats
  /** Edge restricted to contested markets (price 10–90%) — the bets that matter. */
  edgeContested: EdgeStats
  byHorizon: Array<{ horizonDays: number; samples: number; modelBrier: number; marketBrier: number }>
  byBarrier: Array<{ barrier: string; samples: number; modelBrier: number; marketBrier: number }>
  examples: Array<{
    question: string
    horizonDays: number
    modelP: number | null
    pmP: number | null
    outcome: 0 | 1
  }>
}

export interface EdgeStats {
  n: number
  hitRate: number
  avgProfitPerPound: number
  medianProfitPerPound: number
  avgClaimedEdge: number
  modelBrier: number
  marketBrier: number
}

export async function runCryptoBacktest(opts: BacktestOptions = {}): Promise<BacktestReport> {
  const horizons = opts.horizonsDays ?? [30, 14, 7]
  const edgeThreshold = opts.edgeThreshold ?? 0.08
  const log = opts.log ?? (() => {})

  log('Fetching resolved crypto markets from Gamma…')
  let markets = await fetchResolvedCryptoMarkets(opts.maxPages ?? 12)
  log(`Parsed ${markets.length} resolved crypto price-target markets.`)
  if (opts.maxMarkets) markets = markets.slice(0, opts.maxMarkets)

  // One spot + vol series per asset over the whole window, sampled in-memory.
  const assets = [...new Set(markets.map((m) => m.target.asset))]
  const minStart = Math.min(...markets.map((m) => m.createdAtMs)) - 40 * DAY_MS
  const maxEnd = Math.max(...markets.map((m) => m.endDateMs))

  const closes = new Map<CryptoAsset, TimePoint[]>()
  const impliedVol = new Map<CryptoAsset, TimePoint[]>()
  for (const a of assets) {
    log(`Fetching price + vol history for ${a}…`)
    closes.set(a, await fetchDailyCloses(a, minStart, maxEnd).catch(() => []))
    impliedVol.set(a, await fetchImpliedVol(a, minStart, maxEnd).catch(() => []))
  }

  const samples: Sample[] = []
  let marketsScored = 0

  for (const m of markets) {
    const assetCloses = closes.get(m.target.asset) ?? []
    const assetIv = impliedVol.get(m.target.asset) ?? []
    if (assetCloses.length === 0) continue

    const pmHistory = m.yesToken ? await fetchPmHistory(m.yesToken) : []
    let scoredAny = false

    for (const h of horizons) {
      const snapMs = m.endDateMs - h * DAY_MS
      if (snapMs < m.createdAtMs) continue

      const spot = valueAtOrBefore(assetCloses, snapMs)
      if (spot === null || !(spot > 0)) continue

      const T = (m.endDateMs - snapMs) / YEAR_MS
      const sigmaImplied = valueAtOrBefore(assetIv, snapMs)
      const sigmaRealised = realisedVolAt(assetCloses, snapMs)

      const modelImplied = sigmaImplied && sigmaImplied > 0 ? cryptoEventProbability(m.target, spot, T, sigmaImplied) : null
      const modelRealised = sigmaRealised && sigmaRealised > 0 ? cryptoEventProbability(m.target, spot, T, sigmaRealised) : null
      const modelP = modelImplied ?? modelRealised
      const modelSource = modelImplied != null ? 'implied' : modelRealised != null ? 'realised' : null

      const pmP = pmHistory.length ? valueAtOrBefore(pmHistory, snapMs) : null

      samples.push({
        question: m.question,
        asset: m.target.asset,
        barrier: m.target.barrier,
        horizonDays: h,
        spot,
        sigmaImplied,
        sigmaRealised,
        modelImplied,
        modelRealised,
        modelP,
        modelSource,
        pmP,
        outcome: m.outcome,
      })
      scoredAny = true
    }
    if (scoredAny) marketsScored += 1
  }

  // ---- Aggregate ----
  const withModel = samples.filter((s) => s.modelP != null)
  const modelPairs = withModel.map((s) => ({ p: s.modelP as number, o: s.outcome }))
  const realisedPairs = samples
    .filter((s) => s.modelRealised != null)
    .map((s) => ({ p: s.modelRealised as number, o: s.outcome }))
  const withPm = samples.filter((s) => s.pmP != null)
  const pmPairs = withPm.map((s) => ({ p: s.pmP as number, o: s.outcome }))

  // Edge test: bet the model's side whenever it disagrees with the market by
  // ≥ threshold, and measure realised P&L. `edgeStats` is reused for the full
  // set and for the "contested" subset (market price 10–90%), where longshot
  // payout asymmetry isn't masking whether there's real predictive edge.
  const edgeStats = (rows: Sample[]): EdgeStats => {
    const profits: number[] = []
    const claimed: number[] = []
    const mp: Array<{ p: number; o: number }> = []
    const kp: Array<{ p: number; o: number }> = []
    for (const s of rows) {
      const modelP = s.modelP as number
      const pmP = s.pmP as number
      const betYes = modelP > pmP
      const entry = betYes ? pmP : 1 - pmP
      if (!(entry > 0 && entry < 1)) continue
      const won = betYes ? s.outcome === 1 : s.outcome === 0
      profits.push((won ? 1 / entry : 0) - 1)
      claimed.push(Math.abs(modelP - pmP))
      mp.push({ p: modelP, o: s.outcome })
      kp.push({ p: pmP, o: s.outcome })
    }
    return {
      n: profits.length,
      hitRate: profits.length ? profits.filter((p) => p > 0).length / profits.length : NaN,
      avgProfitPerPound: mean(profits),
      medianProfitPerPound: median(profits),
      avgClaimedEdge: mean(claimed),
      modelBrier: brier(mp),
      marketBrier: brier(kp),
    }
  }

  const bettable = samples.filter(
    (s) => s.modelP != null && s.pmP != null && Math.abs((s.modelP as number) - (s.pmP as number)) >= edgeThreshold,
  )
  const contested = bettable.filter((s) => (s.pmP as number) >= 0.1 && (s.pmP as number) <= 0.9)
  const edgeAll = edgeStats(bettable)
  const edgeContested = edgeStats(contested)

  const byHorizon = horizons.map((h) => {
    const hs = samples.filter((s) => s.horizonDays === h)
    return {
      horizonDays: h,
      samples: hs.length,
      modelBrier: brier(hs.filter((s) => s.modelP != null).map((s) => ({ p: s.modelP as number, o: s.outcome }))),
      marketBrier: brier(hs.filter((s) => s.pmP != null).map((s) => ({ p: s.pmP as number, o: s.outcome }))),
    }
  })

  const byBarrier = ['touch', 'expiry'].map((b) => {
    const bs = samples.filter((s) => s.barrier === b)
    return {
      barrier: b,
      samples: bs.length,
      modelBrier: brier(bs.filter((s) => s.modelP != null).map((s) => ({ p: s.modelP as number, o: s.outcome }))),
      marketBrier: brier(bs.filter((s) => s.pmP != null).map((s) => ({ p: s.pmP as number, o: s.outcome }))),
    }
  })

  return {
    coverage: {
      resolvedMarketsParsed: markets.length,
      marketsScored,
      samples: samples.length,
      samplesWithImpliedVol: samples.filter((s) => s.sigmaImplied && s.sigmaImplied > 0).length,
      samplesWithPmPrice: withPm.length,
    },
    model: { samples: withModel.length, brier: brier(modelPairs), brierRealised: brier(realisedPairs) },
    market: { samples: withPm.length, brier: brier(pmPairs) },
    edge: { threshold: edgeThreshold, ...edgeAll },
    edgeContested,
    byHorizon,
    byBarrier,
    examples: samples.slice(0, 12).map((s) => ({
      question: s.question,
      horizonDays: s.horizonDays,
      modelP: s.modelP,
      pmP: s.pmP,
      outcome: s.outcome,
    })),
  }
}
