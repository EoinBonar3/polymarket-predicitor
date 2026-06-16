/**
 * Manifold Markets public API client (read-only, no auth).
 *
 * Manifold is a large play-money prediction market with a free, open REST API
 * and thousands of binary markets. We use it as a STANDALONE source — more
 * markets to display and to paper-trade against — NOT as a cross-venue arb
 * anchor, so it never touches the LLM matcher. That keeps it free of token /
 * rate-limit pressure entirely (just public HTTP).
 *
 * Prices ARE probabilities here too: a binary market's `probability` is the
 * current YES probability in [0,1].
 *
 * Endpoints used:
 *   - /v0/search-markets — ranked, filterable list (sort/filter/contractType)
 *   - /v0/market/{id}    — single market, for resolution look-ups when settling
 */

const BASE_URL = 'https://api.manifold.markets/v0'

export interface ManifoldMarket {
  id: string
  question: string
  slug: string
  url: string
  /** Current YES probability in [0,1]. */
  yesProbability: number
  /** Total traded volume (in mana — play money). */
  volume: number
  /** Distinct bettors — the best cheap quality filter against joke/solo markets. */
  uniqueBettors: number
  closeTime: string
}

interface RawManifoldMarket {
  id?: string
  question?: string
  slug?: string
  url?: string
  probability?: number
  volume?: number
  uniqueBettorCount?: number
  closeTime?: number
  outcomeType?: string
  isResolved?: boolean
}

export interface FetchManifoldOptions {
  /** How many markets to return after filtering. */
  limit?: number
  /** Drop markets below this traded volume. */
  minVolume?: number
  /** Drop markets with fewer distinct bettors (filters joke/personal markets). */
  minBettors?: number
  /**
   * Ranking: 'score' (popularity, default), 'liquidity', or 'close-date'
   * (soonest-closing first — useful for fast-resolving paper-trade demos).
   */
  sort?: 'score' | 'liquidity' | 'close-date'
  /** Skip markets already effectively decided (price outside this band). */
  priceFloor?: number
  priceCeil?: number
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Manifold GET ${url} failed (${res.status})`)
  return (await res.json()) as T
}

/**
 * Fetch liquid, open, binary Manifold markets, normalised to `ManifoldMarket`.
 * Walks `search-markets` pages until `limit` survivors are collected or the
 * feed is exhausted.
 */
export async function fetchManifoldMarkets(opts: FetchManifoldOptions = {}): Promise<ManifoldMarket[]> {
  const limit = opts.limit ?? 200
  const minVolume = opts.minVolume ?? 1000
  const minBettors = opts.minBettors ?? 20
  const sort = opts.sort ?? 'score'
  const priceFloor = opts.priceFloor ?? 0.02
  const priceCeil = opts.priceCeil ?? 0.98

  const out: ManifoldMarket[] = []
  const pageSize = 500
  const now = Date.now()

  for (let offset = 0; offset < 5000 && out.length < limit; offset += pageSize) {
    const url =
      `${BASE_URL}/search-markets?term=&sort=${sort}&filter=open&contractType=BINARY` +
      `&limit=${pageSize}&offset=${offset}`
    const batch = await getJson<RawManifoldMarket[]>(url)
    if (!Array.isArray(batch) || batch.length === 0) break

    for (const m of batch) {
      if (m.isResolved || m.outcomeType !== 'BINARY') continue
      if (!m.id || !m.question) continue
      const p = Number(m.probability)
      if (!(p > priceFloor && p < priceCeil)) continue
      const volume = Number(m.volume) || 0
      if (volume < minVolume) continue
      const bettors = Number(m.uniqueBettorCount) || 0
      if (bettors < minBettors) continue
      const closeMs = Number(m.closeTime)
      if (!Number.isFinite(closeMs) || closeMs <= now) continue

      out.push({
        id: m.id,
        question: m.question,
        slug: m.slug ?? m.id,
        url: m.url ?? `https://manifold.markets/market/${m.id}`,
        yesProbability: p,
        volume,
        uniqueBettors: bettors,
        closeTime: new Date(closeMs).toISOString(),
      })
      if (out.length >= limit) break
    }
  }

  return out
}

/**
 * Resolution outcome for a single Manifold market, or null if it isn't cleanly
 * resolved YES/NO yet (open, or resolved to MKT/CANCEL/N-A). Used by the resolve
 * loop to settle Manifold-sourced paper positions.
 */
export async function fetchManifoldResolution(id: string): Promise<'YES' | 'NO' | null> {
  try {
    const m = await getJson<{ isResolved?: boolean; resolution?: string }>(`${BASE_URL}/market/${id}`)
    if (!m.isResolved) return null
    if (m.resolution === 'YES') return 'YES'
    if (m.resolution === 'NO') return 'NO'
    return null
  } catch {
    return null
  }
}
