/**
 * GET /api/manifold
 *
 * Server-side proxy for the standalone Manifold source — mirrors `/api/markets`
 * so the browser never calls Manifold directly. Returns liquid, open binary
 * markets normalised to `ManifoldMarket`.
 *
 * Query params (optional):
 *   - sort:  'score' | 'liquidity' | 'close-date'  (default 'score')
 *   - limit: number (default 60)
 */

import { NextResponse } from 'next/server'

import {
  fetchManifoldMarkets,
  type FetchManifoldOptions,
  type ManifoldMarket,
} from '@/lib/sources/manifoldApi'

export const runtime = 'nodejs'
/** Cache on the server for 2 min — Manifold prices don't need sub-minute freshness here. */
export const revalidate = 120

const ALLOWED_SORTS: ReadonlyArray<NonNullable<FetchManifoldOptions['sort']>> = [
  'score',
  'liquidity',
  'close-date',
]

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const rawSort = params.get('sort')
  const sort = rawSort && (ALLOWED_SORTS as readonly string[]).includes(rawSort)
    ? (rawSort as FetchManifoldOptions['sort'])
    : 'score'
  const limit = Math.min(Math.max(Number(params.get('limit')) || 60, 1), 200)

  try {
    const markets = await fetchManifoldMarkets({ sort, limit })
    const body = {
      data: markets as ManifoldMarket[],
      count: markets.length,
      fetchedAt: new Date().toISOString(),
    }
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=240' },
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch Manifold markets' },
      { status: 502 },
    )
  }
}
