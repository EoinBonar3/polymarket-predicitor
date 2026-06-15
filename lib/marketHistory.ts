/**
 * Fetches and caches hourly price + volume history for feed markets.
 *
 * Price: CLOB `/prices-history` (YES token ID).
 * Volume: Gamma `/markets/{id}/trades` with Data API fallback when Gamma 404s.
 */

import type { GammaMarket, Market, PricePoint, VolumePoint } from './types'

const CLOB_BASE_URL = 'https://clob.polymarket.com'
const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com'
const DATA_API_BASE_URL = 'https://data-api.polymarket.com'

const CACHE_TTL_MS = 5 * 60 * 1000
const PRICE_LOOKBACK_MS = 48 * 60 * 60 * 1000
const VOLUME_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const RATE_LIMIT_RETRY_MS = 500

export interface MarketHistorySource {
  conditionId?: string
  yesTokenId?: string
}

interface CachedHistory {
  priceHistory: PricePoint[]
  volumeHistory: VolumePoint[]
  expiresAt: number
}

interface GammaTrade {
  timestamp?: number
  size?: number | string
  price?: number | string
  outcome?: string
}

const historyCache = new Map<string, CachedHistory>()

/**
 * Fallback YES-token-id lookup cache (conditionId → token id). In-memory
 * only, 5-minute TTL ({@link CACHE_TTL_MS}), so repeated feed refreshes don't
 * re-hit the CLOB `/markets/{conditionId}` endpoint for the same market.
 */
const tokenIdCache = new Map<string, { tokenId: string; expiresAt: number }>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

function parseTokenIds(raw: GammaMarket['clobTokenIds']): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // Fall through.
  }
  return []
}

export function historySourceFromGamma(raw: GammaMarket): MarketHistorySource {
  const tokenIds = parseTokenIds(raw.clobTokenIds)
  return {
    conditionId: raw.conditionId,
    yesTokenId: tokenIds[0],
  }
}

export function buildHistorySourceByMarketId(
  sources: Iterable<{ marketId: string; source: MarketHistorySource }>,
): Map<string, MarketHistorySource> {
  const map = new Map<string, MarketHistorySource>()
  for (const { marketId, source } of sources) {
    map.set(marketId, source)
  }
  return map
}

function getCached(marketId: string): CachedHistory | null {
  const entry = historyCache.get(marketId)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    historyCache.delete(marketId)
    return null
  }
  return entry
}

function setCache(
  marketId: string,
  priceHistory: PricePoint[],
  volumeHistory: VolumePoint[],
): void {
  historyCache.set(marketId, {
    priceHistory,
    volumeHistory,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

async function fetchWithRetry(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 429) {
        if (attempt === 0) {
          await sleep(RATE_LIMIT_RETRY_MS)
          continue
        }
        return null
      }
      return response
    } catch {
      return null
    }
  }
  return null
}

function hourStartMs(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS
}

function parsePriceHistory(
  raw: unknown,
  lookbackMs: number,
): PricePoint[] {
  const cutoff = Date.now() - lookbackMs
  const history = (raw as { history?: Array<{ t?: number; p?: number }> })?.history
  if (!Array.isArray(history)) return []

  const points: PricePoint[] = []
  for (const point of history) {
    const tsSec = toNumber(point.t, NaN)
    const price = toNumber(point.p, NaN)
    if (!Number.isFinite(tsSec) || !Number.isFinite(price)) continue
    const timestamp = tsSec * 1000
    if (timestamp < cutoff) continue
    points.push({ timestamp, price })
  }

  return points.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Fallback: resolve a market's YES token id from its `conditionId` via the
 * CLOB `/markets/{conditionId}` endpoint, for markets whose Gamma payload
 * carried no `clobTokenIds`. Cached in-memory for {@link CACHE_TTL_MS}.
 * Never throws — returns `undefined` on any failure.
 */
async function fetchTokenIdFromConditionId(
  conditionId: string,
): Promise<string | undefined> {
  if (!conditionId) return undefined

  const cached = tokenIdCache.get(conditionId)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tokenId
  }

  const url = `${CLOB_BASE_URL}/markets/${encodeURIComponent(conditionId)}`
  const response = await fetchWithRetry(url)
  if (!response?.ok) return undefined

  try {
    const raw = (await response.json()) as {
      tokens?: Array<{ token_id?: string }>
    }
    const tokenId = raw.tokens?.[0]?.token_id
    if (typeof tokenId === 'string' && tokenId !== '') {
      tokenIdCache.set(conditionId, {
        tokenId,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })
      return tokenId
    }
    return undefined
  } catch {
    return undefined
  }
}

async function fetchPriceHistory(yesTokenId: string | undefined): Promise<PricePoint[]> {
  if (!yesTokenId) return []

  const endTs = Math.floor(Date.now() / 1000)
  const startTs = endTs - Math.floor(PRICE_LOOKBACK_MS / 1000)
  const url = new URL('/prices-history', CLOB_BASE_URL)
  url.searchParams.set('market', yesTokenId)
  url.searchParams.set('startTs', String(startTs))
  url.searchParams.set('endTs', String(endTs))
  url.searchParams.set('fidelity', '60')

  const response = await fetchWithRetry(url.toString())
  if (!response?.ok) return []

  try {
    const raw = await response.json()
    return parsePriceHistory(raw, PRICE_LOOKBACK_MS)
  } catch {
    return []
  }
}

function buildVolumeHistory(trades: GammaTrade[]): VolumePoint[] {
  const cutoff = Date.now() - VOLUME_LOOKBACK_MS
  const buckets = new Map<number, { volume: number; yesNetVolume: number }>()

  for (const trade of trades) {
    const tsSec = toNumber(trade.timestamp, NaN)
    const size = toNumber(trade.size, 0)
    const price = toNumber(trade.price, 0)
    if (!Number.isFinite(tsSec) || size <= 0 || price <= 0) continue

    const timestamp = tsSec * 1000
    if (timestamp < cutoff) continue

    const bucketTs = hourStartMs(timestamp)
    const dollarVolume = size * price
    const bucket = buckets.get(bucketTs) ?? { volume: 0, yesNetVolume: 0 }
    bucket.volume += dollarVolume

    const outcome = typeof trade.outcome === 'string' ? trade.outcome.toLowerCase() : ''
    if (outcome === 'yes') bucket.yesNetVolume += dollarVolume
    else if (outcome === 'no') bucket.yesNetVolume -= dollarVolume

    buckets.set(bucketTs, bucket)
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, data]) => ({
      timestamp,
      volume: data.volume,
      yesNetVolume: data.yesNetVolume,
    }))
}

async function fetchTradesFromGamma(marketId: string): Promise<GammaTrade[] | null> {
  const url = `${GAMMA_BASE_URL}/markets/${encodeURIComponent(marketId)}/trades?limit=500`
  const response = await fetchWithRetry(url)
  if (!response) return null
  if (response.status === 404) return null
  if (!response.ok) return []

  try {
    const raw = await response.json()
    return Array.isArray(raw) ? (raw as GammaTrade[]) : []
  } catch {
    return []
  }
}

async function fetchTradesFromDataApi(conditionId: string): Promise<GammaTrade[]> {
  const url = new URL('/trades', DATA_API_BASE_URL)
  url.searchParams.set('market', conditionId)
  url.searchParams.set('limit', '500')

  const response = await fetchWithRetry(url.toString())
  if (!response?.ok) return []

  try {
    const raw = await response.json()
    return Array.isArray(raw) ? (raw as GammaTrade[]) : []
  } catch {
    return []
  }
}

async function fetchVolumeHistory(
  marketId: string,
  conditionId: string | undefined,
): Promise<VolumePoint[]> {
  let trades = await fetchTradesFromGamma(marketId)
  if (trades === null) {
    // Gamma 404'd — only the Data API fallback remains, and it needs a
    // conditionId. Guard here so we never issue a `?market=undefined` request.
    if (!conditionId) return []
    trades = await fetchTradesFromDataApi(conditionId)
  }
  if (!trades || trades.length === 0) return []
  return buildVolumeHistory(trades)
}

export async function fetchHistoryForMarket(
  market: Market,
  source: MarketHistorySource | undefined,
): Promise<{ priceHistory: PricePoint[]; volumeHistory: VolumePoint[] }> {
  const cached = getCached(market.id)
  if (cached) {
    return {
      priceHistory: cached.priceHistory,
      volumeHistory: cached.volumeHistory,
    }
  }

  const [priceHistory, volumeHistory] = await Promise.all([
    fetchPriceHistory(source?.yesTokenId),
    fetchVolumeHistory(market.id, source?.conditionId),
  ])

  setCache(market.id, priceHistory, volumeHistory)
  return { priceHistory, volumeHistory }
}

export async function fetchInBatches<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  batchSize = 10,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    await Promise.allSettled(batch.map((item) => worker(item)))
  }
}

let loggedFirstMarketHistoryDebug = false

async function logFirstMarketHistory(
  market: Market,
  source: MarketHistorySource | undefined,
  priceHistory: PricePoint[],
  volumeHistory: VolumePoint[],
): Promise<void> {
  if (loggedFirstMarketHistoryDebug) return
  loggedFirstMarketHistoryDebug = true

  console.log('[api/markets] history sample (first market):', {
    title: market.title,
    marketId: market.id,
    yesTokenId: source?.yesTokenId ?? null,
    conditionId: source?.conditionId ?? null,
    priceHistoryLength: priceHistory.length,
    volumeHistoryLength: volumeHistory.length,
  })

  if (priceHistory.length === 0 && source?.yesTokenId) {
    const endTs = Math.floor(Date.now() / 1000)
    const startTs = endTs - Math.floor(PRICE_LOOKBACK_MS / 1000)
    const url = new URL('/prices-history', CLOB_BASE_URL)
    url.searchParams.set('market', source.yesTokenId)
    url.searchParams.set('startTs', String(startTs))
    url.searchParams.set('endTs', String(endTs))
    url.searchParams.set('fidelity', '60')

    const response = await fetchWithRetry(url.toString())
    const rawText = response ? await response.text().catch(() => '') : ''
    console.log('[api/markets] empty priceHistory — raw CLOB response:', {
      marketId: market.id,
      status: response?.status ?? 'fetch_failed',
      body: rawText.slice(0, 500),
    })
  }
}

export async function enrichMarketsWithHistory(
  markets: Market[],
  sourcesByMarketId: Map<string, MarketHistorySource>,
): Promise<Market[]> {
  loggedFirstMarketHistoryDebug = false

  await fetchInBatches(markets, async (market) => {
    const source = sourcesByMarketId.get(market.id)

    // Fallback: if Gamma gave us no CLOB token id but we do have a
    // conditionId, resolve the YES token from the CLOB `/markets` endpoint
    // before giving up on price history.
    if (source && !source.yesTokenId && source.conditionId) {
      const fallbackTokenId = await fetchTokenIdFromConditionId(source.conditionId)
      if (fallbackTokenId) {
        source.yesTokenId = fallbackTokenId
      }
    }

    // Temporary debug logs — remove once history population is confirmed.
    console.log(
      `[history] market ${market.id}: yesTokenId=${source?.yesTokenId}, conditionId=${source?.conditionId}`,
    )

    const { priceHistory, volumeHistory } = await fetchHistoryForMarket(market, source)
    market.priceHistory = priceHistory
    market.volumeHistory = volumeHistory
    await logFirstMarketHistory(market, source, priceHistory, volumeHistory)

    console.log(
      `[history] market ${market.id}: priceHistory.length=${market.priceHistory?.length ?? 0}, volumeHistory.length=${market.volumeHistory?.length ?? 0}`,
    )
  })

  return markets
}
