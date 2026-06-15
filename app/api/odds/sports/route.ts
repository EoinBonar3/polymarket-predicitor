/**
 * GET /api/odds/sports
 *
 * Server-side proxy to The Odds API's `/sports` endpoint. We use
 * `all=false` so only currently in-season sports come back — saving a
 * client-side filter and keeping the payload tiny.
 *
 * Response shape:
 *   200 → { sports: string[], quotaRemaining: number | null, quotaUsed: number | null }
 *   503 → { error }     (key missing or invalid)
 *   429 → { error }     (upstream quota exhausted)
 *   500 → { error }
 *
 * `x-requests-remaining` / `x-requests-used` are also forwarded as response
 * headers so the client `lib/oddsApi.ts` fetch helpers can stash them in
 * the shared quota store without parsing the body.
 *
 * IMPORTANT: `ODDS_API_KEY` is read here on the server only — it MUST NOT
 * appear in any client bundle. That's why this lives under `app/api/*`.
 */

import { NextResponse } from 'next/server'

import { ODDS_API_BASE_URL, POLYMARKET_RELEVANT_SPORTS } from '@/lib/oddsApi'

export const runtime = 'nodejs'
// Sports list barely changes — cache hard on the server.
export const revalidate = 3600

interface OddsApiSport {
  key: string
  group: string
  title: string
  active: boolean
  has_outrights: boolean
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

function forwardQuotaHeaders(
  source: Response,
  target: NextResponse,
): { remaining: number | null; used: number | null } {
  const remainingRaw = source.headers.get('x-requests-remaining')
  const usedRaw = source.headers.get('x-requests-used')

  if (remainingRaw) target.headers.set('x-requests-remaining', remainingRaw)
  if (usedRaw) target.headers.set('x-requests-used', usedRaw)

  const remaining = remainingRaw ? Number(remainingRaw) : null
  const used = usedRaw ? Number(usedRaw) : null
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    used: Number.isFinite(used) ? used : null,
  }
}

export async function GET() {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) {
    return jsonError('Odds API not configured', 503)
  }

  const url = new URL('/v4/sports', ODDS_API_BASE_URL)
  url.searchParams.set('apiKey', apiKey)
  url.searchParams.set('all', 'false')

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate, tags: ['odds', 'odds:sports'] },
    })

    if (upstream.status === 401) {
      return jsonError('Invalid Odds API key', 503)
    }
    if (upstream.status === 429) {
      return jsonError('Odds API quota exceeded', 429)
    }
    if (!upstream.ok) {
      return jsonError(`Upstream Odds API failed (${upstream.status})`, 500)
    }

    const sports = (await upstream.json()) as OddsApiSport[]

    // Filter to the subset Polymarket typically covers. Preserve the
    // priority order from `POLYMARKET_RELEVANT_SPORTS` so the client can
    // fetch the highest-coverage leagues first when conserving quota.
    const activeKeys = new Set(
      sports.filter((s) => s?.active).map((s) => s.key),
    )
    const filtered = POLYMARKET_RELEVANT_SPORTS.filter((s) =>
      activeKeys.has(s),
    )

    const body = NextResponse.json(
      // `quotaRemaining` / `quotaUsed` are also populated below from the
      // upstream response headers; mirroring them in the body is a
      // belt-and-braces fallback in case headers get stripped by an edge
      // proxy between us and the browser.
      { sports: filtered, quotaRemaining: null, quotaUsed: null },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        },
      },
    )

    const quota = forwardQuotaHeaders(upstream, body)
    return NextResponse.json(
      { sports: filtered, quotaRemaining: quota.remaining, quotaUsed: quota.used },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
          ...(quota.remaining != null
            ? { 'x-requests-remaining': String(quota.remaining) }
            : {}),
          ...(quota.used != null
            ? { 'x-requests-used': String(quota.used) }
            : {}),
        },
      },
    )
  } catch (err) {
    console.error('[api/odds/sports] failed:', err)
    return jsonError(
      err instanceof Error ? err.message : 'Failed to fetch sports',
      500,
    )
  }
}
