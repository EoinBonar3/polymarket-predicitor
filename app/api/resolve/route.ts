/**
 * GET /api/resolve
 *
 * Server-side proxy that returns Polymarket markets which have already
 * settled to a YES or NO outcome. Used by the client-side auto-resolve
 * poller (`hooks/useAutoResolve.ts`) to close out paper-trading positions
 * whose underlying markets have resolved upstream.
 *
 * We hit the same Gamma `/events` endpoint as `/api/markets`, but with
 * `closed=true` so we get settled events instead of active ones, then
 * filter to markets where `resolvedOutcome` is `'YES' | 'NO'`. Closed-but-
 * never-resolved markets (cancellations, invalid resolutions, etc.) are
 * dropped — the auto-resolve flow only ever wants definitive outcomes.
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
// Mapping helpers (kept local; the markets route owns its own copies — we
// intentionally duplicate the small handful of pure functions here to keep
// the two routes decoupled and independently evolvable).
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

/**
 * Definitive YES/NO outcome of a settled market, or null if it isn't cleanly
 * resolved. Gamma exposes no `resolved`/`resolvedOutcome` fields — a settled
 * market is `closed: true` with `umaResolutionStatus: "resolved"` (or
 * `automaticallyResolved: true`), and the winning leg priced ~1 in
 * `outcomePrices`. We read the winner straight from those prices so the
 * mapping survives the missing legacy fields.
 */
function resolvedOutcomeFrom(raw: GammaMarket): 'YES' | 'NO' | null {
  const settled =
    raw.closed === true &&
    (raw.umaResolutionStatus === 'resolved' || raw.automaticallyResolved === true)
  if (!settled) return null

  const outcomes = parseOutcomes(raw.outcomes).map((o) => o.toLowerCase())
  const prices = parseOutcomePrices(raw.outcomePrices)
  if (outcomes.length !== prices.length || outcomes.length < 2) return null

  // The winning leg settles to 1; require a decisive split so we never settle
  // a position against a still-uncertain or cancelled (e.g. 0.5/0.5) market.
  const winIdx = prices.findIndex((p) => p >= 0.99)
  if (winIdx === -1) return null

  const winner = outcomes[winIdx]
  if (winner === 'yes') return 'YES'
  if (winner === 'no') return 'NO'
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
    resolvedOutcome: resolvedOutcomeFrom(raw),
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

function buildUpstreamUrl(): string {
  const url = new URL('/events', GAMMA_BASE_URL)
  url.searchParams.set('closed', 'true')
  url.searchParams.set('limit', '200')
  url.searchParams.set('order', 'endDate')
  url.searchParams.set('ascending', 'false')
  return url.toString()
}

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

export async function GET() {
  const upstream = buildUpstreamUrl()

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
      next: { revalidate, tags: ['markets', 'resolved'] },
    })

    if (!response.ok) {
      return jsonError(
        `Upstream Polymarket request failed (${response.status})`,
        response.status === 429 ? 429 : 502,
        await response.text().catch(() => undefined),
      )
    }

    const raw = (await response.json()) as
      | GammaEvent[]
      | { events?: GammaEvent[] }
    const events: GammaEvent[] = Array.isArray(raw) ? raw : (raw.events ?? [])

    // Map everything, then keep only the ones with a definitive outcome —
    // closed-but-cancelled / closed-but-invalid markets stay out so the
    // auto-resolver never mistakenly settles a position against them.
    const markets = mapGammaResponse(events).filter(
      (m) => m.resolvedOutcome === 'YES' || m.resolvedOutcome === 'NO',
    )

    const body: ApiResponse<Market[]> = {
      data: markets,
      count: markets.length,
      fetchedAt: new Date().toISOString(),
    }

    return NextResponse.json(body, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    })
  } catch (error) {
    return jsonError('Failed to fetch resolved markets', 500, error)
  }
}
