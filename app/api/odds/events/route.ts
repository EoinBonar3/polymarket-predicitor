/**
 * GET /api/odds/events?sport={sportKey}
 *
 * Server-side proxy to The Odds API's `/sports/{sportKey}/odds` endpoint.
 *
 * Hard-coded query params (the client never gets to override these — the
 * less the browser knows about Odds API specifics, the better):
 *   - regions=uk,eu,us
 *   - markets=h2h        (head-to-head moneyline — all we use for matching)
 *   - oddsFormat=decimal
 *   - dateFormat=iso
 *
 * Response shape:
 *   200 → { events: OddsApiEvent[], quotaRemaining: number | null, quotaUsed: number | null }
 *   400 → { error: 'sport query parameter required' }
 *   503 → { error }     (key missing or invalid)
 *   429 → { error }     (upstream quota exhausted)
 *   500 → { error }
 *
 * Mirrors the quota-header forwarding in `app/api/odds/sports/route.ts`.
 */

import { NextResponse } from 'next/server'

import { ODDS_API_BASE_URL, POLYMARKET_RELEVANT_SPORTS } from '@/lib/oddsApi'

export const runtime = 'nodejs'
// Odds move every few seconds upstream, but we cache 5 minutes server-side
// so two clicks of the manual "Refresh signals" button within the same
// window only burn one upstream credit. The client hook
// (`hooks/useOddsSignals.ts`) is the primary credit budget; this proxy
// cache is a secondary backstop for accidental double-clicks.
export const revalidate = 300

const ALLOWED_SPORTS = new Set<string>(POLYMARKET_RELEVANT_SPORTS)

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

export async function GET(request: Request) {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) {
    return jsonError('Odds API not configured', 503)
  }

  const sport = new URL(request.url).searchParams.get('sport')?.trim()
  if (!sport) {
    return jsonError('sport query parameter required', 400)
  }
  if (!ALLOWED_SPORTS.has(sport)) {
    // Reject unknown sport keys so a misconfigured client can't burn the
    // free-tier quota on irrelevant sports.
    return jsonError(`Sport "${sport}" is not on the allow-list`, 400)
  }

  const url = new URL(`/v4/sports/${encodeURIComponent(sport)}/odds`, ODDS_API_BASE_URL)
  url.searchParams.set('apiKey', apiKey)
  url.searchParams.set('regions', 'uk,eu,us')
  url.searchParams.set('markets', 'h2h')
  url.searchParams.set('oddsFormat', 'decimal')
  url.searchParams.set('dateFormat', 'iso')

  try {
    const upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate, tags: ['odds', `odds:${sport}`] },
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

    const events = await upstream.json()

    const remainingRaw = upstream.headers.get('x-requests-remaining')
    const usedRaw = upstream.headers.get('x-requests-used')
    const remaining = remainingRaw ? Number(remainingRaw) : null
    const used = usedRaw ? Number(usedRaw) : null
    const quotaRemaining = Number.isFinite(remaining) ? remaining : null
    const quotaUsed = Number.isFinite(used) ? used : null

    // Console-log quota so the operator can watch monthly burn live in
    // the server logs. This is intentionally noisy in dev — once we hook
    // up Datadog / Logflare it'll become structured.
    console.info(
      `[odds-api] ${sport} fetched · quota remaining=${quotaRemaining ?? '?'} used=${quotaUsed ?? '?'}`,
    )

    return NextResponse.json(
      {
        events: Array.isArray(events) ? events : [],
        quotaRemaining,
        quotaUsed,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          ...(quotaRemaining != null
            ? { 'x-requests-remaining': String(quotaRemaining) }
            : {}),
          ...(quotaUsed != null
            ? { 'x-requests-used': String(quotaUsed) }
            : {}),
        },
      },
    )
  } catch (err) {
    console.error('[api/odds/events] failed:', err)
    return jsonError(
      err instanceof Error ? err.message : 'Failed to fetch odds',
      500,
    )
  }
}
