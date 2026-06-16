/**
 * Backtest data layer — all point-in-time, no look-ahead.
 *
 * Reconstructs, for a resolved Polymarket crypto market, everything needed to
 * ask "what would the model have said at time t, and was it right?":
 *
 *   - resolved crypto markets + outcomes        ← Polymarket Gamma (closed=true)
 *   - spot price as of t                         ← Binance daily klines
 *   - implied vol as of t                        ← Deribit DVOL index history
 *   - realised vol as of t                       ← Binance klines (trailing 30d)
 *   - Polymarket's own YES price as of t         ← Polymarket CLOB price history
 *
 * Every series is sampled with `at-or-before t`, so a snapshot at time t only
 * ever sees data that existed at t. The resolution outcome is the only future
 * information used, and only as the label.
 */

import { parseCryptoTarget, type CryptoAsset, type CryptoTarget } from '../sources/cryptoMarket'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ResolvedCryptoMarket {
  question: string
  createdAtMs: number
  endDateMs: number
  yesToken: string | null
  target: CryptoTarget
  outcome: 0 | 1
}

export interface TimePoint {
  t: number // ms
  v: number
}

const BINANCE_SYMBOL: Record<CryptoAsset, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`)
  return (await res.json()) as T
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

interface GammaClosedMarket {
  question?: string
  endDate?: string
  createdAt?: string
  closed?: boolean
  outcomePrices?: unknown
  clobTokenIds?: unknown
}

/**
 * Pull resolved crypto price-target markets from Gamma. Walks closed markets
 * (highest-volume first), keeps the ones that parse as a crypto target on a
 * supported asset and have a clean YES/NO resolution.
 */
export async function fetchResolvedCryptoMarkets(maxPages = 12): Promise<ResolvedCryptoMarket[]> {
  const out: ResolvedCryptoMarket[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=100&offset=${page * 100}&order=volumeNum&ascending=false`
    const batch = await getJson<GammaClosedMarket[]>(url)
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const m of batch) {
      if (!m.question || !m.endDate || !m.createdAt) continue
      const target = parseCryptoTarget({ title: m.question, endDate: m.endDate })
      if (!target) continue
      const outcome = outcomeFrom(m.outcomePrices)
      if (outcome === null) continue

      const tokens = parseJsonArray(m.clobTokenIds)
      out.push({
        question: m.question,
        createdAtMs: new Date(m.createdAt).getTime(),
        endDateMs: new Date(m.endDate).getTime(),
        yesToken: tokens[0] ?? null,
        target,
        outcome,
      })
    }
  }
  return out
}

/** Daily closes for an asset over [startMs, endMs], ascending. */
export async function fetchDailyCloses(asset: CryptoAsset, startMs: number, endMs: number): Promise<TimePoint[]> {
  const symbol = BINANCE_SYMBOL[asset]
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${Math.floor(startMs)}&endTime=${Math.floor(endMs)}&limit=1000`
  const rows = await getJson<unknown[][]>(url)
  return rows.map((r) => ({ t: Number(r[0]), v: Number(r[4]) })).filter((p) => Number.isFinite(p.v))
}

/** Deribit DVOL (30-day implied vol index) history, decimal, ascending. */
export async function fetchImpliedVol(asset: CryptoAsset, startMs: number, endMs: number): Promise<TimePoint[]> {
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&start_timestamp=${Math.floor(startMs)}&end_timestamp=${Math.floor(endMs)}&resolution=86400`
  const body = await getJson<{ result?: { data?: number[][] } }>(url)
  const data = body.result?.data ?? []
  return data.map((r) => ({ t: Number(r[0]), v: Number(r[4]) / 100 })).filter((p) => Number.isFinite(p.v))
}

/** Polymarket YES price history for a CLOB token, ascending (seconds → ms). */
export async function fetchPmHistory(token: string): Promise<TimePoint[]> {
  const url = `https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=1440`
  try {
    const body = await getJson<{ history?: Array<{ t: number; p: number }> }>(url)
    return (body.history ?? []).map((h) => ({ t: h.t * 1000, v: h.p })).filter((p) => Number.isFinite(p.v))
  } catch {
    return []
  }
}

/** Latest value at or before `ts`, or null if the series starts after `ts`. */
export function valueAtOrBefore(series: TimePoint[], ts: number): number | null {
  let best: number | null = null
  for (const p of series) {
    if (p.t <= ts) best = p.v
    else break
  }
  return best
}

/**
 * Annualised realised vol from the daily closes in the `window` days ending at
 * `ts` (inclusive). Returns null when there aren't enough points.
 */
export function realisedVolAt(closes: TimePoint[], ts: number, windowDays = 30): number | null {
  const from = ts - windowDays * DAY_MS
  const slice = closes.filter((p) => p.t <= ts && p.t >= from).map((p) => p.v)
  if (slice.length < 5) return null
  const rets: number[] = []
  for (let i = 1; i < slice.length; i += 1) rets.push(Math.log(slice[i] / slice[i - 1]))
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(365)
}
