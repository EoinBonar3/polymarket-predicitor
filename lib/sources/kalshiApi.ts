/**
 * Kalshi public market-data client (read-only, no auth).
 *
 * Kalshi is a CFTC-regulated US exchange whose prices ARE probabilities (no
 * vig — a YES at $0.62 means the market thinks 62%). It overlaps heavily with
 * Polymarket on politics, elections, economics, weather, and world events, but
 * is a different, independently-liquid crowd. Divergence between the two on the
 * *same* event is the Phase 2 signal.
 *
 * We read through `/events?with_nested_markets=true` (not `/markets`) because
 * the bare markets feed is dominated by provisional sports parlays, while the
 * events feed is cleanly categorised and lets us drop Sports up front (already
 * covered by the Odds API source).
 *
 * A Kalshi *market* is one binary leg of an *event*; the human question is the
 * event title plus the leg's `yes_sub_title`
 *   "Who will be the next Pope?"  +  "Pierbattista Pizzaballa"
 * which we compose into a single `question` for matching against Polymarket.
 */

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2'

export interface KalshiMarket {
  ticker: string
  eventTicker: string
  category: string
  eventTitle: string
  /** The specific YES leg, e.g. a candidate name or threshold. */
  optionLabel: string
  /** Composed natural-language question: `${eventTitle} — ${optionLabel}`. */
  question: string
  /** YES probability in [0,1] — bid/ask midpoint, falling back to last price. */
  yesProbability: number
  yesBid: number
  yesAsk: number
  volume: number
  closeTime: string
  /** Resolution criteria — fed to the LLM matcher to check the YES conditions line up. */
  rules: string
}

interface RawKalshiMarket {
  ticker?: string
  event_ticker?: string
  yes_sub_title?: string
  yes_bid_dollars?: string | number
  yes_ask_dollars?: string | number
  last_price_dollars?: string | number
  volume_fp?: string | number
  close_time?: string
  status?: string
  market_type?: string
  rules_primary?: string
}

interface RawKalshiEvent {
  event_ticker?: string
  title?: string
  category?: string
  markets?: RawKalshiMarket[]
}

function num(x: unknown): number {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}

function midProbability(m: RawKalshiMarket): number {
  const bid = num(m.yes_bid_dollars)
  const ask = num(m.yes_ask_dollars)
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  const last = num(m.last_price_dollars)
  return last > 0 ? last : bid > 0 ? bid : ask
}

export interface FetchKalshiOptions {
  /** Max event pages (200 events each) to walk. */
  maxPages?: number
  /** Drop markets below this traded volume. */
  minVolume?: number
  /** Categories to exclude (case-insensitive substring). Defaults to Sports. */
  excludeCategories?: string[]
}

/**
 * Fetch liquid, non-sports binary Kalshi markets, flattened across events.
 */
export async function fetchKalshiMarkets(opts: FetchKalshiOptions = {}): Promise<KalshiMarket[]> {
  const maxPages = opts.maxPages ?? 8
  const minVolume = opts.minVolume ?? 50
  const exclude = (opts.excludeCategories ?? ['sport']).map((c) => c.toLowerCase())

  const out: KalshiMarket[] = []
  let cursor = ''

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${BASE_URL}/events`)
    url.searchParams.set('limit', '200')
    url.searchParams.set('status', 'open')
    url.searchParams.set('with_nested_markets', 'true')
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Kalshi /events failed (${res.status})`)
    const body = (await res.json()) as { events?: RawKalshiEvent[]; cursor?: string }
    const events = body.events ?? []

    for (const ev of events) {
      const category = ev.category ?? ''
      if (exclude.some((c) => category.toLowerCase().includes(c))) continue
      const eventTitle = ev.title ?? ''
      for (const m of ev.markets ?? []) {
        if (m.market_type && m.market_type !== 'binary') continue
        if (m.status && m.status !== 'active' && m.status !== 'open') continue
        const volume = num(m.volume_fp)
        if (volume < minVolume) continue
        const p = midProbability(m)
        if (!(p > 0 && p < 1)) continue

        const optionLabel = m.yes_sub_title ?? ''
        out.push({
          ticker: m.ticker ?? '',
          eventTicker: ev.event_ticker ?? m.event_ticker ?? '',
          category,
          eventTitle,
          optionLabel,
          question: optionLabel ? `${eventTitle} — ${optionLabel}` : eventTitle,
          yesProbability: p,
          yesBid: num(m.yes_bid_dollars),
          yesAsk: num(m.yes_ask_dollars),
          volume,
          closeTime: m.close_time ?? '',
          rules: (m.rules_primary ?? '').slice(0, 600),
        })
      }
    }

    cursor = body.cursor ?? ''
    if (!cursor || events.length === 0) break
  }

  return out
}
