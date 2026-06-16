/**
 * Thin client for Deribit's public market-data API (no auth, free).
 *
 * We use Deribit because its options are priced by professional vol desks —
 * an independent, model-grounded read on the probability of a crypto price
 * level, against which Polymarket's retail-driven prices can be compared.
 *
 * Only the handful of endpoints the crypto source needs:
 *   - get_index_price          → spot
 *   - get_instruments          → the live option chain (strike, expiry, type)
 *   - ticker                   → mark IV per option
 */

const BASE_URL = 'https://www.deribit.com/api/v2/public'

export type DeribitAsset = 'BTC' | 'ETH' | 'SOL'

export interface DeribitOption {
  instrumentName: string
  expirationTimestamp: number
  strike: number
  optionType: 'call' | 'put'
}

interface RpcResponse<T> {
  result?: T
  error?: { message?: string }
}

async function rpc<T>(method: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = new URL(`${BASE_URL}/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`Deribit ${method} failed (${res.status})`)
  const body = (await res.json()) as RpcResponse<T>
  if (body.error) throw new Error(`Deribit ${method}: ${body.error.message ?? 'error'}`)
  if (body.result === undefined) throw new Error(`Deribit ${method}: empty result`)
  return body.result
}

/** Spot index price for the asset (e.g. BTC → `btc_usd`). */
export async function getIndexPrice(asset: DeribitAsset, signal?: AbortSignal): Promise<number> {
  const r = await rpc<{ index_price: number }>(
    'get_index_price',
    { index_name: `${asset.toLowerCase()}_usd` },
    signal,
  )
  return r.index_price
}

/** Live (non-expired) option chain for the asset. */
export async function getOptionChain(asset: DeribitAsset, signal?: AbortSignal): Promise<DeribitOption[]> {
  const r = await rpc<
    Array<{ instrument_name: string; expiration_timestamp: number; strike: number; option_type: string }>
  >('get_instruments', { currency: asset, kind: 'option', expired: 'false' }, signal)
  return r.map((o) => ({
    instrumentName: o.instrument_name,
    expirationTimestamp: o.expiration_timestamp,
    strike: o.strike,
    optionType: o.option_type === 'put' ? 'put' : 'call',
  }))
}

/** Mark implied vol (decimal, e.g. 0.65) + underlying price for one option. */
export async function getMarkIv(
  instrumentName: string,
  signal?: AbortSignal,
): Promise<{ markIv: number; underlyingPrice: number }> {
  const r = await rpc<{ mark_iv: number; underlying_price: number }>(
    'ticker',
    { instrument_name: instrumentName },
    signal,
  )
  // Deribit quotes mark_iv as a percentage (90.88 = 90.88%).
  return { markIv: r.mark_iv / 100, underlyingPrice: r.underlying_price }
}

/**
 * Implied vol at (target expiry, strike), read off the live chain:
 *   1. pick the listed expiry closest to the target date,
 *   2. take the two calls bracketing the strike at that expiry,
 *   3. linearly interpolate their mark IVs by strike.
 *
 * Returns the interpolated vol plus the expiry actually used (so the caller can
 * discount confidence when the term gap is large).
 */
export async function impliedVolAt(
  chain: DeribitOption[],
  targetExpiryMs: number,
  strike: number,
  signal?: AbortSignal,
): Promise<{ sigma: number; usedExpiryMs: number } | null> {
  const calls = chain.filter((o) => o.optionType === 'call')
  if (calls.length === 0) return null

  // Nearest listed expiry to the target.
  const expiries = [...new Set(calls.map((o) => o.expirationTimestamp))]
  let usedExpiryMs = expiries[0]
  for (const e of expiries) {
    if (Math.abs(e - targetExpiryMs) < Math.abs(usedExpiryMs - targetExpiryMs)) usedExpiryMs = e
  }

  const atExpiry = calls
    .filter((o) => o.expirationTimestamp === usedExpiryMs)
    .sort((a, b) => a.strike - b.strike)
  if (atExpiry.length === 0) return null

  // Bracketing strikes.
  let lower: DeribitOption | null = null
  let upper: DeribitOption | null = null
  for (const o of atExpiry) {
    if (o.strike <= strike) lower = o
    if (o.strike >= strike && upper === null) upper = o
  }

  if (lower && upper && lower.strike !== upper.strike) {
    const [a, b] = await Promise.all([getMarkIv(lower.instrumentName, signal), getMarkIv(upper.instrumentName, signal)])
    const w = (strike - lower.strike) / (upper.strike - lower.strike)
    const sigma = a.markIv + w * (b.markIv - a.markIv)
    return { sigma, usedExpiryMs }
  }

  const nearest = lower ?? upper ?? atExpiry[0]
  const { markIv } = await getMarkIv(nearest.instrumentName, signal)
  return { sigma: markIv, usedExpiryMs }
}
