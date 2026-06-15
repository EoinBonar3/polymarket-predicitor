/**
 * Browser-safe client wrappers around our internal Polymarket proxy routes.
 *
 *   ┌────────────┐  fetchActiveMarkets()  ┌──────────────────┐    ┌──────────┐
 *   │  React UI  │  ───────────────────▶  │  /api/markets    │ ─▶ │  Gamma   │
 *   └────────────┘                        └──────────────────┘    └──────────┘
 *
 * Components / hooks only ever import functions from this file — they must
 * never call `https://gamma-api.polymarket.com` directly. CORS aside, going
 * through `/api/*` lets us add caching, rate-limiting, and mocks in one place.
 *
 * This module is intentionally framework-agnostic: it just exposes typed
 * `Promise<...>` functions. TanStack Query / RSC / unit tests can all consume
 * it identically.
 */

import type { ApiError, ApiResponse, Market, MarketsQuery } from './types'

// ---------------------------------------------------------------------------
// Base URL handling
// ---------------------------------------------------------------------------

/**
 * Resolve a base URL that works in both the browser and on the server.
 * - In the browser, relative URLs are fine, so we return `''`.
 * - On the server, `fetch` needs an absolute URL; prefer the public site URL
 *   env var, then Vercel's, then localhost as a last resort.
 */
function getBaseUrl(): string {
  if (typeof window !== 'undefined') return ''
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  const port = process.env.PORT ?? '3000'
  return `http://localhost:${port}`
}

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const base = getBaseUrl()
  const url = new URL(path, base || 'http://localhost')

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }

  return base ? url.toString() : `${url.pathname}${url.search}`
}

// ---------------------------------------------------------------------------
// Low-level fetch helper
// ---------------------------------------------------------------------------

class PolymarketClientError extends Error {
  readonly status: number
  readonly details?: string

  constructor(message: string, status: number, details?: string) {
    super(message)
    this.name = 'PolymarketClientError'
    this.status = status
    this.details = details
  }
}

export { PolymarketClientError }

interface FetchJsonOptions {
  signal?: AbortSignal
  /** Tags forwarded to Next's `fetch` cache when running on the server. */
  tags?: string[]
  /** Re-validation window in seconds when running on the server. */
  revalidate?: number
}

async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const init: RequestInit & { next?: { revalidate?: number; tags?: string[] } } = {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  }

  if (typeof window === 'undefined') {
    init.next = {
      revalidate: opts.revalidate ?? 30,
      tags: opts.tags,
    }
  }

  const response = await fetch(url, init)

  if (!response.ok) {
    let errorBody: ApiError | undefined
    try {
      errorBody = (await response.json()) as ApiError
    } catch {
      // Non-JSON error body; fall through.
    }
    throw new PolymarketClientError(
      errorBody?.error ?? `Request failed with status ${response.status}`,
      response.status,
      errorBody?.details,
    )
  }

  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the current list of active markets via our `/api/markets` proxy.
 *
 * @param query  Optional filtering / paging params.
 * @param signal Optional AbortSignal to cancel the request (TanStack passes
 *               one automatically).
 */
export async function fetchActiveMarkets(
  query: MarketsQuery = {},
  signal?: AbortSignal,
): Promise<Market[]> {
  const url = buildUrl('/api/markets', {
    category: query.category,
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
  })

  const body = await fetchJson<ApiResponse<Market[]>>(url, {
    signal,
    tags: ['markets'],
  })

  return body.data
}

/**
 * Fetch a single market by slug via the dedicated `/api/markets/[slug]`
 * proxy. Returns `null` (not throw) when the slug doesn't resolve to any
 * active or closed market, so TanStack Query callers can render a clean
 * "not found" state without an error boundary.
 */
export async function fetchMarketBySlug(
  slug: string,
  signal?: AbortSignal,
): Promise<Market | null> {
  if (!slug) return null

  const slugUrl = buildUrl(`/api/markets/${encodeURIComponent(slug)}`)

  try {
    const body = await fetchJson<ApiResponse<Market>>(slugUrl, {
      signal,
      tags: ['markets', `market:${slug}`],
    })
    return body.data ?? null
  } catch (error) {
    // 404 means "this slug doesn't match any active or closed market" —
    // a normal not-found we surface as `null`. Any other status is a real
    // failure (5xx, network, etc.) and bubbles up to the caller.
    if (error instanceof PolymarketClientError && error.status === 404) {
      return null
    }
    throw error
  }
}

/**
 * Fetch markets that have already resolved.
 *
 * Phase 0 placeholder — until we wire up `/api/resolve` and the Gamma
 * `closed=true` query, we return `[]` so callers can render empty-state UI
 * without crashing. The signature is the contract Phase 1 will fulfil.
 */
export async function fetchResolvedMarkets(
  signal?: AbortSignal,
): Promise<Market[]> {
  const url = buildUrl('/api/resolve')

  try {
    const body = await fetchJson<ApiResponse<Market[]>>(url, {
      signal,
      tags: ['markets', 'resolved'],
    })
    return body.data
  } catch (error) {
    if (error instanceof PolymarketClientError && error.status === 404) {
      return []
    }
    throw error
  }
}
