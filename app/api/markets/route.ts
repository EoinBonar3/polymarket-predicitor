/**
 * GET /api/markets
 *
 * Server-side proxy to the Polymarket Gamma `/events` endpoint. The browser
 * never talks to Polymarket directly — partly because of CORS, but also so we
 * have a single place to:
 *   - normalise the upstream payload into our internal `Market` shape, and
 *   - swap in mock data / caching / rate limiting later without touching UI.
 *
 * Query params (all optional):
 *   - category: string  → filter results by event category (case-insensitive)
 *   - limit:    number  → upstream `limit` (default 50, max 200)
 *   - offset:   number  → upstream `offset` (default 0)
 *   - sort:     'volume_24hr' | 'liquidity' | 'newest' | 'ending_soon'
 */

import { NextResponse } from 'next/server'

import type {
  ApiError,
  ApiResponse,
  GammaEvent,
  GammaMarket,
  Market,
  MarketsQuery,
} from '@/lib/types'

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com'

/** Re-validate this proxy at most once per 30 s on the server. */
export const revalidate = 30

// Run on the Node.js runtime (default). Explicit so future readers know.
export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const ALLOWED_SORTS: ReadonlyArray<NonNullable<MarketsQuery['sort']>> = [
  'volume_24hr',
  'liquidity',
  'newest',
  'ending_soon',
]

function parseQuery(url: URL): MarketsQuery {
  const params = url.searchParams

  const rawLimit = params.get('limit')
  const rawOffset = params.get('offset')
  const rawSort = params.get('sort')
  const rawCategory = params.get('category')

  const limit =
    rawLimit !== null && Number.isFinite(Number(rawLimit))
      ? Math.min(Math.max(Number(rawLimit), 1), 200)
      : 50

  const offset =
    rawOffset !== null && Number.isFinite(Number(rawOffset))
      ? Math.max(Number(rawOffset), 0)
      : 0

  const sort =
    rawSort && (ALLOWED_SORTS as readonly string[]).includes(rawSort)
      ? (rawSort as MarketsQuery['sort'])
      : 'volume_24hr'

  return {
    category: rawCategory?.trim() || undefined,
    limit,
    offset,
    sort,
  }
}

// ---------------------------------------------------------------------------
// Mapping: Gamma → internal `Market`
// ---------------------------------------------------------------------------

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}

function parseOutcomePrices(raw: GammaMarket['outcomePrices']): number[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map((p) => toNumber(p))
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((p) => toNumber(p))
  } catch {
    // Fall through to empty.
  }
  return []
}

function parseOutcomes(raw: GammaMarket['outcomes']): string[] {
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

/**
 * Best-effort YES/NO price extraction. Polymarket binary markets return
 * `outcomes: ["Yes", "No"]` and `outcomePrices: ["0.73", "0.27"]`. We respect
 * the order given but fall back to `lastTradePrice` for YES if needed.
 */
function extractYesNoPrices(raw: GammaMarket): { yes: number; no: number } {
  const outcomes = parseOutcomes(raw.outcomes).map((o) => o.toLowerCase())
  const prices = parseOutcomePrices(raw.outcomePrices)

  let yes = NaN
  let no = NaN

  if (outcomes.length === prices.length && outcomes.length >= 2) {
    const yesIdx = outcomes.findIndex((o) => o === 'yes')
    const noIdx = outcomes.findIndex((o) => o === 'no')
    if (yesIdx !== -1) yes = prices[yesIdx]
    if (noIdx !== -1) no = prices[noIdx]
  } else if (prices.length === 2) {
    yes = prices[0]
    no = prices[1]
  }

  if (!Number.isFinite(yes)) yes = toNumber(raw.lastTradePrice, 0.5)
  if (!Number.isFinite(no)) no = Math.max(0, Math.min(1, 1 - yes))

  return { yes, no }
}

function normaliseResolvedOutcome(value: unknown): 'YES' | 'NO' | null {
  if (typeof value !== 'string') return null
  const v = value.toLowerCase()
  if (v === 'yes') return 'YES'
  if (v === 'no') return 'NO'
  return null
}

function mapGammaMarket(event: GammaEvent, raw: GammaMarket): Market {
  const { yes, no } = extractYesNoPrices(raw)

  const volume24h = toNumber(
    raw.volume24hr ?? event.volume24hr ?? raw.volumeNum,
    0,
  )
  const liquidity = toNumber(raw.liquidityNum ?? raw.liquidity ?? event.liquidity, 0)

  return {
    id: String(raw.id),
    slug: raw.slug ?? event.slug ?? String(raw.id),
    title: raw.question ?? event.title ?? 'Untitled market',
    category: raw.category ?? event.category ?? 'Uncategorised',
    endDate: raw.endDateIso ?? raw.endDate ?? event.endDate ?? '',
    yesPrice: yes,
    noPrice: no,
    volume24h,
    liquidity,
    resolvedOutcome: raw.resolved ? normaliseResolvedOutcome(raw.resolvedOutcome) : null,
  }
}

function mapGammaResponse(events: GammaEvent[]): Market[] {
  const markets: Market[] = []
  for (const event of events) {
    if (!event?.markets) continue
    for (const m of event.markets) {
      if (!m?.id) continue
      markets.push(mapGammaMarket(event, m))
    }
  }
  return markets
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function buildUpstreamUrl(query: MarketsQuery): string {
  const url = new URL('/events', GAMMA_BASE_URL)
  url.searchParams.set('active', 'true')
  url.searchParams.set('closed', 'false')
  url.searchParams.set('limit', String(query.limit ?? 50))
  url.searchParams.set('offset', String(query.offset ?? 0))

  switch (query.sort) {
    case 'liquidity':
      url.searchParams.set('order', 'liquidity')
      break
    case 'newest':
      url.searchParams.set('order', 'startDate')
      url.searchParams.set('ascending', 'false')
      break
    case 'ending_soon':
      url.searchParams.set('order', 'endDate')
      url.searchParams.set('ascending', 'true')
      break
    case 'volume_24hr':
    default:
      url.searchParams.set('order', 'volume_24hr')
      break
  }

  if (query.category) {
    url.searchParams.set('tag', query.category)
  }

  return url.toString()
}

function jsonError(message: string, status: number, details?: unknown) {
  const body: ApiError = {
    error: message,
    status,
    details: details instanceof Error ? details.message : details ? String(details) : undefined,
  }
  return NextResponse.json(body, { status })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const query = parseQuery(url)

  const upstream = buildUpstreamUrl(query)

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
      next: { revalidate },
    })

    if (!response.ok) {
      return jsonError(
        `Upstream Polymarket request failed (${response.status})`,
        response.status === 429 ? 429 : 502,
        await response.text().catch(() => undefined),
      )
    }

    const raw = (await response.json()) as GammaEvent[] | { events?: GammaEvent[] }
    const events: GammaEvent[] = Array.isArray(raw) ? raw : raw.events ?? []
    let markets = mapGammaResponse(events)

    // Client-side category filter as a safety net — Gamma's `tag` param is
    // sometimes inexact, so we double-filter here to honour the user's intent.
    if (query.category) {
      const needle = query.category.toLowerCase()
      markets = markets.filter((m) => m.category.toLowerCase().includes(needle))
    }

    const body: ApiResponse<Market[]> = {
      data: markets,
      count: markets.length,
      fetchedAt: new Date().toISOString(),
    }

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    })
  } catch (error) {
    return jsonError('Failed to fetch markets', 500, error)
  }
}
