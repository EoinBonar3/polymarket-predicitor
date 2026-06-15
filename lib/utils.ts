/**
 * Generic formatting + time helpers used across the app.
 *
 * Keep this file UI-agnostic — no React, no Tailwind, no Next.js imports.
 */

// ---------------------------------------------------------------------------
// Numbers / probabilities
// ---------------------------------------------------------------------------

/**
 * Format a 0..1 decimal as a percentage string.
 *
 * @example formatPercent(0.7321) // "73%"
 * @example formatPercent(0.7321, 1) // "73.2%"
 */
export function formatPercent(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(decimals)}%`
}

/**
 * Format a basis-point edge value (already on a 0..1 scale) with a sign.
 *
 * @example formatEdge(0.04) // "+4.0%"
 * @example formatEdge(-0.012) // "-1.2%"
 */
export function formatEdge(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—'
  const pct = value * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(decimals)}%`
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const GBP_FORMATTER = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const GBP_COMPACT_FORMATTER = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  notation: 'compact',
  maximumFractionDigits: 1,
})

/**
 * Format a number as GBP currency.
 *
 * @example formatCurrency(1234.5) // "£1,234.50"
 * @example formatCurrency(-42)    // "-£42.00"
 */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return GBP_FORMATTER.format(value)
}

/**
 * Compact GBP formatter for chart axes / dense UI.
 *
 * @example formatCurrencyCompact(12500) // "£12.5K"
 */
export function formatCurrencyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return GBP_COMPACT_FORMATTER.format(value)
}

/**
 * Format a signed profit value, e.g. "+£12.34" / "-£5.00".
 */
export function formatProfit(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const formatted = GBP_FORMATTER.format(Math.abs(value))
  if (value > 0) return `+${formatted}`
  if (value < 0) return `-${formatted}`
  return formatted
}

// ---------------------------------------------------------------------------
// Volume / liquidity (raw USD figures from Polymarket)
// ---------------------------------------------------------------------------

const USD_COMPACT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
})

/**
 * Compact USD formatter — Polymarket reports volume/liquidity in USDC.
 *
 * @example formatVolume(1_234_567) // "$1.2M"
 */
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return USD_COMPACT_FORMATTER.format(value)
}

// ---------------------------------------------------------------------------
// Dates / time
// ---------------------------------------------------------------------------

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export const DAY_MS = 24 * 60 * 60 * 1000
export const FIVE_MINUTES_MS = 5 * 60 * 1000

/** Coerce string | number | Date inputs to a `Date`. */
export function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Milliseconds remaining until `endDate`. Negative if already passed. */
export function timeUntilExpiry(endDate: string | number | Date): number {
  return toDate(endDate).getTime() - Date.now()
}

/** Returns true if the market end date is in the past. */
export function isExpired(endDate: string | number | Date): boolean {
  return timeUntilExpiry(endDate) <= 0
}

/**
 * Format the time remaining until a market ends as a short human label.
 *
 * @example formatTimeUntilExpiry(in3Days) // "3 days left"
 * @example formatTimeUntilExpiry(in2Hours) // "2 hours left"
 * @example formatTimeUntilExpiry(yesterday) // "Expired"
 */
export function formatTimeUntilExpiry(endDate: string | number | Date): string {
  const ms = timeUntilExpiry(endDate)
  if (ms <= 0) return 'Expired'

  if (ms >= WEEK) {
    const weeks = Math.floor(ms / WEEK)
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} left`
  }
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY)
    return `${days} ${days === 1 ? 'day' : 'days'} left`
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`
  }
  if (ms >= MINUTE) {
    const minutes = Math.floor(ms / MINUTE)
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`
  }
  return 'Less than a minute left'
}

/**
 * Format a past timestamp as a relative-time string.
 *
 * @example formatRelativeTime(threeDaysAgo) // "3 days ago"
 * @example formatRelativeTime(now)          // "just now"
 */
export function formatRelativeTime(timestamp: string | number | Date): string {
  const ms = Date.now() - toDate(timestamp).getTime()
  if (ms < 0) {
    return formatTimeUntilExpiry(timestamp).replace(' left', ' from now')
  }
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE)
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  if (ms < WEEK) {
    const days = Math.floor(ms / DAY)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }
  const weeks = Math.floor(ms / WEEK)
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Clamp a number to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Tiny `clsx`-style helper for conditional class strings.
 * Avoids pulling in a dependency for the trivial cases we actually need.
 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return inputs.filter(Boolean).join(' ')
}

/** Generate a short, URL-safe id without a dependency. */
export function generateId(prefix = 'id'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Wilson score confidence interval for a proportion.
 *
 * Statistically correct for small sample sizes and extreme probabilities —
 * unlike the naive normal-approximation interval, Wilson never produces
 * bounds outside [0, 1] and stays well-calibrated near p = 0 / p = 1.
 *
 * @param successes number of successful trials
 * @param total     total trials
 * @param z         z-score (default 1.96 → 95% CI)
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 }
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const spread =
    z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  return {
    lower: Math.max(0, (centre - spread) / denominator),
    upper: Math.min(1, (centre + spread) / denominator),
  }
}
