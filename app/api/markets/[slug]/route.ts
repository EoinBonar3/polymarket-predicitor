/**
 * GET /api/markets/[slug]
 *
 * Server-side proxy for a single Polymarket market (active or closed),
 * looked up by event/market slug. The browser never talks to Gamma
 * directly — see `app/api/markets/route.ts` for the same rationale.
 *
 * Strategy:
 *   1. Hit Gamma `/events?slug={slug}&active=true` first (most detail pages
 *      are visited while the market is still live).
 *   2. If that comes back empty, retry with `closed=true` so users can
 *      still load the post-mortem of a settled market.
 *   3. Map all returned events → flat market list, then pick the market
 *      whose own slug matches the input (falling back to the first market
 *      if Gamma only echoed an event-level match).
 *
 * The `GammaEvent → Market` mapper is intentionally duplicated from the
 * sibling `app/api/markets/route.ts` per existing convention — the two
 * routes are kept self-contained so they can evolve independently.
 */

import { NextResponse } from 'next/server'

import type {
  ApiError,
  ApiResponse,
  GammaEvent,
  GammaMarket,
  Market,
} from '@/lib/types'

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com'

/** Re-validate this proxy at most once per 60 s on the server. */
export const revalidate = 60

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// Gamma → internal `Market` mapper (verbatim copy from /api/markets/route.ts;
// the two route files intentionally don't share helpers — see file header).
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
    // fall through
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
    // fall through
  }
  return []
}

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
// Upstream lookup
// ---------------------------------------------------------------------------

interface UpstreamResult {
  markets: Market[]
  status: number
}

async function fetchUpstream(
  slug: string,
  variant: 'active' | 'closed',
): Promise<UpstreamResult> {
  const url = new URL('/events', GAMMA_BASE_URL)
  url.searchParams.set('slug', slug)
  if (variant === 'active') {
    url.searchParams.set('active', 'true')
  } else {
    url.searchParams.set('closed', 'true')
  }

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    next: { revalidate, tags: ['markets', `market:${slug}`] },
  })

  if (!response.ok) {
    return { markets: [], status: response.status }
  }

  const raw = (await response.json()) as GammaEvent[] | { events?: GammaEvent[] }
  const events: GammaEvent[] = Array.isArray(raw) ? raw : (raw.events ?? [])
  return { markets: mapGammaResponse(events), status: response.status }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function jsonError(message: string, status: number, details?: unknown) {
  const body: ApiError = {
    error: message,
    status,
    details:
      details instanceof Error
        ? details.message
        : details
          ? String(details)
          : undefined,
  }
  return NextResponse.json(body, { status })
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await context.params
  const slug = typeof rawSlug === 'string' ? rawSlug.trim() : ''

  if (!slug) {
    return jsonError('Missing market slug', 400)
  }

  try {
    // Active first (the common case); fall back to closed for post-mortems.
    let { markets, status } = await fetchUpstream(slug, 'active')
    if (markets.length === 0) {
      const closedResult = await fetchUpstream(slug, 'closed')
      markets = closedResult.markets
      if (closedResult.status >= 500) status = closedResult.status
    }

    if (markets.length === 0) {
      return jsonError(`Market "${slug}" not found`, 404)
    }

    // Prefer the market whose own slug matches the requested one (Gamma
    // sometimes returns multi-market events where only the *event* slug
    // matches); fall back to the first market in the response.
    const matched =
      markets.find((m) => m.slug === slug) ?? markets[0]

    if (!matched) {
      return jsonError(`Market "${slug}" not found`, 404)
    }

    const body: ApiResponse<Market> = {
      data: matched,
      fetchedAt: new Date().toISOString(),
    }

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=60',
      },
    })
  } catch (error) {
    return jsonError('Failed to fetch market', 500, error)
  }
}
