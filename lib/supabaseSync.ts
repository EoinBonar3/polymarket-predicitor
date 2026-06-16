/**
 * Supabase write-through sync layer.
 *
 * The Zustand bankroll store (and only the bankroll store) calls into this
 * module after every state-mutating action. All operations are best-effort:
 *
 *   - If the Supabase client is null (env vars missing) we no-op silently.
 *   - Network / DB errors are `console.error`-ed and swallowed; we never
 *     throw and we never block the UI thread.
 *
 * Components import nothing from `@supabase/supabase-js` directly — every
 * DB interaction in the app routes through this file, so swapping the
 * backend later (auth-scoped queries, server actions, etc.) stays a
 * single-file change.
 */

// ---------------------------------------------------------------------------
// One-off schema migration — run manually in the Supabase SQL editor before
// the structural-signal price-floor logging starts producing rows.
//
// `suppressed_reason` annotates rows inserted by `syncLogSuppression` so we
// can audit how many markets the new structural filters are removing.
// `position_id` and the trading-columns must be nullable because suppressed
// markets never produced a `TradeSignal` and never reached the Kelly engine.
//
//   ALTER TABLE signals_log ADD COLUMN IF NOT EXISTS suppressed_reason text;
//   ALTER TABLE signals_log ALTER COLUMN position_id DROP NOT NULL;
//   ALTER TABLE signals_log ALTER COLUMN outcome DROP NOT NULL;
//   ALTER TABLE signals_log ALTER COLUMN our_probability DROP NOT NULL;
//   ALTER TABLE signals_log ALTER COLUMN edge DROP NOT NULL;
//   ALTER TABLE signals_log ALTER COLUMN kelly_fraction DROP NOT NULL;
//   ALTER TABLE signals_log ALTER COLUMN suggested_stake DROP NOT NULL;
//
// Closed-loop learner (`lib/learning.ts`) — signal provenance on `positions`,
// so resolved bets can be attributed back to the signals that produced them.
// All nullable (odds-api / legacy bets carry no structural breakdown):
//
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS signal_source text;
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS signal_count int;
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS signal_strength text;
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS active_volume_spike boolean;
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS active_price_momentum boolean;
//   ALTER TABLE positions ADD COLUMN IF NOT EXISTS active_stale_market boolean;
// ---------------------------------------------------------------------------

import { supabase, type SupabasePosition } from './supabase'
import type {
  BankrollHistoryPoint,
  Market,
  Position,
  TradeSignal,
} from './types'

// A `Position` enriched with the upstream Polymarket slug (matches the
// `BankrollPosition` shape in `store/bankroll.ts` without creating a
// store ⇄ sync import cycle).
type SluggedPosition = Position & { slug?: string | null }

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toRow(p: SluggedPosition): SupabasePosition {
  return {
    id: p.id,
    market_id: p.marketId,
    market_title: p.marketTitle,
    outcome: p.outcome,
    stake: p.stake,
    price: p.price,
    shares: p.shares,
    potential_payout: p.potentialPayout,
    signal_edge: p.signalEdge,
    status: p.status,
    placed_at: p.placedAt,
    resolved_at: p.resolvedAt ?? null,
    profit: p.profit ?? null,
    market_slug: p.slug ?? null,
    // Signal provenance for the closed-loop learner.
    signal_source: p.signalSource ?? null,
    signal_count: p.signalCount ?? null,
    signal_strength: p.signalStrength ?? null,
    active_volume_spike: p.activeSignals?.volumeSpike ?? null,
    active_price_momentum: p.activeSignals?.priceMomentum ?? null,
    active_stale_market: p.activeSignals?.staleMarket ?? null,
  }
}

function fromRow(r: SupabasePosition): Position & { slug: string } {
  return {
    id: r.id,
    marketId: r.market_id,
    marketTitle: r.market_title,
    outcome: r.outcome,
    // Postgres `numeric` round-trips through supabase-js as a JS number
    // already, but we coerce defensively in case it ever arrives as a
    // string (e.g. very large values via REST).
    stake: Number(r.stake),
    price: Number(r.price),
    shares: Number(r.shares),
    potentialPayout: Number(r.potential_payout),
    signalEdge: Number(r.signal_edge),
    ourProbability: r.our_probability == null ? undefined : Number(r.our_probability),
    status: r.status,
    placedAt: r.placed_at,
    resolvedAt: r.resolved_at ?? undefined,
    profit: r.profit == null ? undefined : Number(r.profit),
    slug: r.market_slug ?? '',
    // Signal provenance — feeds the closed-loop learner after rehydration.
    signalSource:
      r.signal_source === 'structural' ||
      r.signal_source === 'odds_api' ||
      r.signal_source === 'kalshi' ||
      r.signal_source === 'manifold'
        ? r.signal_source
        : undefined,
    signalCount: r.signal_count == null ? undefined : Number(r.signal_count),
    signalStrength: r.signal_strength ?? undefined,
    activeSignals:
      r.active_volume_spike == null &&
      r.active_price_momentum == null &&
      r.active_stale_market == null
        ? undefined
        : {
            volumeSpike: r.active_volume_spike === true,
            priceMomentum: r.active_price_momentum === true,
            staleMarket: r.active_stale_market === true,
          },
  }
}

// ---------------------------------------------------------------------------
// Writes — fire-and-forget; callers do not await.
// ---------------------------------------------------------------------------

/**
 * Insert a new position + snapshot the post-trade cash balance.
 *
 * supabase-js v2 does not return inserted rows unless `.select()` is
 * chained, so the bare `.insert()` already satisfies the "minimal
 * returning" requirement.
 */
export async function syncPlaceBet(
  position: SluggedPosition,
  newBalance: number,
): Promise<void> {
  if (!supabase) return
  try {
    const { error: posErr } = await supabase
      .from('positions')
      .insert({ ...toRow(position), our_probability: position.ourProbability })
    if (posErr) {
      console.error('[supabaseSync] insert position failed:', posErr.message)
    }

    const { error: snapErr } = await supabase
      .from('bankroll_snapshots')
      .insert({ balance: newBalance })
    if (snapErr) {
      console.error('[supabaseSync] insert snapshot failed:', snapErr.message)
    }
  } catch (err) {
    console.error('[supabaseSync] syncPlaceBet failed:', err)
  }
}

/**
 * Mark a position as won/lost with realised profit + snapshot the new
 * post-resolution cash balance.
 */
export async function syncCloseBet(
  positionId: string,
  updates: {
    status: 'won' | 'lost'
    profit: number
    resolvedAt: string
  },
  newBalance: number,
): Promise<void> {
  if (!supabase) return
  try {
    const { error: posErr } = await supabase
      .from('positions')
      .update({
        status: updates.status,
        profit: updates.profit,
        resolved_at: updates.resolvedAt,
      })
      .eq('id', positionId)
    if (posErr) {
      console.error('[supabaseSync] update position failed:', posErr.message)
    }

    const { error: snapErr } = await supabase
      .from('bankroll_snapshots')
      .insert({ balance: newBalance })
    if (snapErr) {
      console.error('[supabaseSync] insert snapshot failed:', snapErr.message)
    }
  } catch (err) {
    console.error('[supabaseSync] syncCloseBet failed:', err)
  }
}

/**
 * Log the `TradeSignal` that triggered a paper trade. We only log signals
 * that were actually acted on — the dashboard generates hundreds per poll
 * and storing all of them would balloon the table with noise.
 *
 * `context` carries fields the `TradeSignal` doesn't track itself (raw
 * market liquidity / volume / category) for downstream ML feature work.
 */
export async function syncLogSignal(
  signal: TradeSignal,
  positionId: string,
  context: {
    category?: string
    liquidity?: number
    volume24h?: number
    daysToExpiry?: number
  } = {},
): Promise<void> {
  if (!supabase) return
  try {
    // Defaults to 'structural' when the caller didn't tag a source — the
    // legacy `buildSignals` output doesn't set `signalSource`, and we want
    // `signal_source` (NOT NULL in Postgres) populated regardless.
    const signalSource = signal.signalSource ?? 'structural'
    const isOddsApi = signalSource === 'odds_api'
    // `signal.edgePct` is a percentage (e.g. 4.2 means +4.2%); the DB
    // columns are 0..1 fractions to match the rest of our schema.
    const edgeFraction = signal.edgePct / 100

    const { error } = await supabase.from('signals_log').insert({
      market_id: signal.marketId,
      market_title: signal.title,
      market_slug: signal.slug,
      category: context.category ?? null,
      outcome: signal.recommendedOutcome,
      market_price: signal.marketPrice,
      our_probability: signal.ourProbability,
      edge: edgeFraction,
      kelly_fraction: signal.kellyFraction,
      suggested_stake: signal.suggestedStake,
      liquidity: context.liquidity ?? null,
      volume_24h: context.volume24h ?? null,
      days_to_expiry: context.daysToExpiry ?? null,
      signal_source: signalSource,
      position_id: positionId,
      // Odds-API-only fields. For structural signals these stay NULL so
      // ML training queries can cleanly distinguish the two populations.
      bookmaker_probability: isOddsApi ? signal.ourProbability : null,
      odds_api_gap: isOddsApi ? edgeFraction : null,
      match_confidence: signal.matchConfidence ?? null,
      bookmaker_count: signal.bookmakerCount ?? null,
    })
    if (error) {
      console.error('[supabaseSync] insert signals_log failed:', error.message)
    }
  } catch (err) {
    console.error('[supabaseSync] syncLogSignal failed:', err)
  }
}

/**
 * Reasons a structural signal was filtered out before reaching the Kelly
 * engine. Currently only `price_floor` is wired up — the structural blender
 * is unreliable on markets priced < 10% or > 90% YES, so we drop them and
 * audit the volume here.
 */
export type SignalSuppressedReason = 'price_floor'

// In-process dedupe so a single render storm (markets re-fetched, React
// Strict Mode double-invocation, etc.) doesn't fire the same suppression
// row twice. The Set lives for the tab's lifetime — that's the right
// granularity, since "how many distinct markets did we suppress this
// session?" is the question we actually want to answer in audits.
const suppressionLogged = new Set<string>()

// One-shot circuit breaker: when PostgREST reports a schema-level error
// (missing column, NOT NULL violation on a column we're nulling, etc.)
// we know the migration at the top of this file hasn't been run yet, so
// every subsequent insert in this session would fail identically. Flip
// this flag and bail early so the console gets a single actionable warn
// instead of one error per filtered market.
let suppressionLoggingDisabled = false

/**
 * Detect the class of PostgREST errors that mean "the schema migration
 * documented at the top of this file hasn't been run yet". We disable
 * suppression logging for the session when we see one, so the console
 * doesn't fill up with one log per extreme-priced market.
 *
 * The patterns cover:
 *   - missing `suppressed_reason` column (PostgREST schema-cache message)
 *   - NOT NULL constraints on trading columns the migration drops
 *   - FK violations on `position_id` while it's still NOT NULL
 */
function isSchemaMigrationError(message: string): boolean {
  return /schema cache|does not exist|null value in column|violates not-null|violates foreign key/i.test(
    message,
  )
}

/**
 * Fire-and-forget log of a market that was suppressed by a structural
 * pre-filter. The callsite must NOT await this — Supabase failures are
 * swallowed in `console.error` so the UI never blocks on a flaky DB.
 *
 * The trading columns (`outcome`, `our_probability`, `edge`,
 * `kelly_fraction`, `suggested_stake`, `position_id`) are sent as NULL —
 * suppressed markets never produced a `TradeSignal`. The schema migration
 * at the top of this file is what makes those columns nullable.
 */
export async function syncLogSuppression(
  market: Market,
  reason: SignalSuppressedReason,
): Promise<void> {
  if (!supabase) return
  if (suppressionLoggingDisabled) return

  const dedupeKey = `${market.id}:${reason}`
  if (suppressionLogged.has(dedupeKey)) return
  suppressionLogged.add(dedupeKey)

  try {
    const { error } = await supabase.from('signals_log').insert({
      market_id: market.id,
      market_title: market.title,
      market_slug: market.slug,
      category: market.category ?? null,
      market_price: market.yesPrice,
      liquidity: Number.isFinite(market.liquidity) ? market.liquidity : null,
      volume_24h: Number.isFinite(market.volume24h) ? market.volume24h : null,
      days_to_expiry: daysUntil(market.endDate),
      signal_source: 'structural',
      suppressed_reason: reason,
      // Trading columns left NULL — see the schema migration comment at
      // the top of this file. The Postgres FK on `position_id` must also
      // be nullable for this insert to succeed.
      outcome: null,
      our_probability: null,
      edge: null,
      kelly_fraction: null,
      suggested_stake: null,
      position_id: null,
      bookmaker_probability: null,
      odds_api_gap: null,
      match_confidence: null,
      bookmaker_count: null,
    })
    if (error) {
      if (isSchemaMigrationError(error.message)) {
        // Trip the breaker so we don't log this once per market.
        suppressionLoggingDisabled = true
        console.warn(
          '[supabaseSync] suppression logging disabled — run the SQL ' +
            'migration documented at the top of `lib/supabaseSync.ts` ' +
            'in the Supabase SQL editor, then refresh. Original error: ' +
            error.message,
        )
        return
      }
      console.error('[supabaseSync] insert suppression failed:', error.message)
      // Roll the dedupe entry back so a transient (non-schema) failure
      // doesn't black out audit logging for the rest of the session.
      suppressionLogged.delete(dedupeKey)
    }
  } catch (err) {
    console.error('[supabaseSync] syncLogSuppression failed:', err)
    suppressionLogged.delete(dedupeKey)
  }
}

function daysUntil(endDate: string): number | null {
  const end = new Date(endDate).getTime()
  if (!Number.isFinite(end)) return null
  const days = (end - Date.now()) / (24 * 60 * 60 * 1000)
  return Number.isFinite(days) ? Math.max(0, days) : null
}

// ---------------------------------------------------------------------------
// Read — called once on app load from `app/providers.tsx`.
// ---------------------------------------------------------------------------

export async function fetchAllData(): Promise<{
  positions: (Position & { slug: string })[]
  bankrollHistory: BankrollHistoryPoint[]
} | null> {
  if (!supabase) return null
  try {
    const [posRes, snapRes] = await Promise.all([
      supabase
        .from('positions')
        .select('*')
        .order('placed_at', { ascending: true }),
      supabase
        .from('bankroll_snapshots')
        .select('balance, snapshot_at')
        .order('snapshot_at', { ascending: true }),
    ])

    if (posRes.error) {
      console.error(
        '[supabaseSync] fetch positions failed:',
        posRes.error.message,
      )
      return null
    }
    if (snapRes.error) {
      console.error(
        '[supabaseSync] fetch snapshots failed:',
        snapRes.error.message,
      )
      return null
    }

    const positions = (posRes.data ?? []).map((r) =>
      fromRow(r as SupabasePosition),
    )
    const bankrollHistory: BankrollHistoryPoint[] = (snapRes.data ?? []).map(
      (row) => {
        const r = row as { snapshot_at: string; balance: number | string }
        return {
          timestamp: r.snapshot_at,
          balance: Number(r.balance),
        }
      },
    )

    return { positions, bankrollHistory }
  } catch (err) {
    console.error('[supabaseSync] fetchAllData failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Reset — called from `resetBankroll`.
// ---------------------------------------------------------------------------

/**
 * Wipe every paper-trading row. Ordered to respect the FK from
 * `signals_log.position_id → positions.id`.
 *
 * supabase-js requires every `.delete()` to be filtered, so we use a
 * tautological `id is not null` predicate to mean "everything".
 */
export async function resetAllData(): Promise<void> {
  if (!supabase) return
  try {
    const tables = ['signals_log', 'positions', 'bankroll_snapshots'] as const
    for (const table of tables) {
      const { error } = await supabase
        .from(table)
        .delete()
        .not('id', 'is', null)
      if (error) {
        console.error(
          `[supabaseSync] reset ${table} failed:`,
          error.message,
        )
      }
    }
  } catch (err) {
    console.error('[supabaseSync] resetAllData failed:', err)
  }
}
