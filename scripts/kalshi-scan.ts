/**
 * Phase 2 scan — find live Polymarket↔Kalshi cross-market divergences.
 *
 *   npx tsx scripts/kalshi-scan.ts              # full run (LLM required)
 *   npx tsx scripts/kalshi-scan.ts --cached-only # live prices on confirmed pairs, no LLM
 *
 * Pulls live Polymarket + Kalshi markets, runs the matcher, and prints where
 * the two venues price the same event differently.
 */

// tsx doesn't auto-load .env.local (that's a Next.js convention). Load it
// here with Node's built-in fs so env vars are available when this script
// runs directly. Real env vars take precedence.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
try {
  const lines = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    const val = t.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = val
  }
} catch { /* .env.local absent — fine */ }

import { fetchKalshiMarkets, type KalshiMarket } from '../lib/sources/kalshiApi'
import { createKalshiSource } from '../lib/sources/kalshi'
import { topCandidates } from '../lib/matching/textMatch'
import { isGeminiAvailable, isGroqTpdExhausted } from '../lib/llm/groq'
import { getDb } from '../lib/supabase'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PmMarket {
  title: string
  startDate: string
  endDate: string
  yesPrice: number
  slug: string
}

type Signal = { pm: PmMarket; ourP: number; edge: number; ref: Record<string, unknown> }

interface ConfirmedPair {
  polymarket_slug: string
  kalshi_ticker: string
  yes_aligned: boolean
  llm_confidence: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_SIM_THRESHOLD = 0.50
const LLM_MAX_CANDIDATES = 50
const MIN_EDGE = 0.08
// A cross-venue gap this large on two reasonably efficient venues is almost
// always a resolution-criteria mismatch the LLM missed (e.g. "impeached" vs
// "impeached AND removed"), not a real arbitrage. Such pairs are flagged as
// SUSPECT and NOT auto-persisted to confirmed_pairs — surface for human review.
const SUSPECT_EDGE = 0.25

// ---------------------------------------------------------------------------
// Supabase confirmed_pairs helpers
// ---------------------------------------------------------------------------

async function writeConfirmedPair(
  pmSlug: string,
  kalshiTicker: string,
  yesAligned: boolean,
  llmConfidence: number,
): Promise<void> {
  const db = getDb()
  if (!db) return
  const { error } = await db.from('confirmed_pairs').upsert(
    {
      polymarket_slug: pmSlug,
      kalshi_ticker: kalshiTicker,
      yes_aligned: yesAligned,
      llm_confidence: llmConfidence,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'polymarket_slug,kalshi_ticker' },
  )
  if (error) console.error('[confirmed_pairs] upsert failed:', error.message)
}

async function loadConfirmedPairs(): Promise<ConfirmedPair[]> {
  const db = getDb()
  if (!db) {
    console.error('[confirmed_pairs] Supabase not configured — cannot load cached pairs')
    return []
  }
  const { data, error } = await db
    .from('confirmed_pairs')
    .select('polymarket_slug, kalshi_ticker, yes_aligned, llm_confidence')
  if (error) {
    console.error('[confirmed_pairs] load failed:', error.message)
    return []
  }
  return (data ?? []) as ConfirmedPair[]
}

// ---------------------------------------------------------------------------
// Polymarket fetch
// ---------------------------------------------------------------------------

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw)
      if (Array.isArray(p)) return p.map(String)
    } catch { /* ignore */ }
  }
  return []
}

async function fetchPolymarketMarkets(): Promise<PmMarket[]> {
  const out: PmMarket[] = []
  for (let page = 0; ; page += 1) {
    const url = `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset=${page * 100}&order=volumeNum&ascending=false`
    const batch = (await fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json())) as Array<{
      question?: string
      startDate?: string
      endDate?: string
      slug?: string
      outcomePrices?: unknown
      outcomes?: unknown
    }>
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const m of batch) {
      if (!m.question) continue
      const outcomes = parseJsonArray(m.outcomes).map((o) => o.toLowerCase())
      const prices = parseJsonArray(m.outcomePrices).map(Number)
      let yes = NaN
      const yesIdx = outcomes.indexOf('yes')
      if (yesIdx !== -1 && prices[yesIdx] != null) yes = prices[yesIdx]
      else if (prices.length === 2) yes = prices[0]
      if (!Number.isFinite(yes) || yes <= 0.02 || yes >= 0.98) continue
      out.push({ title: m.question, startDate: m.startDate ?? '', endDate: m.endDate ?? '', yesPrice: yes, slug: m.slug ?? '' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

function edgeStr(edge: number): string {
  return `${edge * 100 >= 0 ? '+' : ''}${(edge * 100).toFixed(0)}pp`
}

function printSignal(s: Signal, prefix = '') {
  const ask = s.ref.kalshiAsk as number | undefined
  const bid = s.ref.kalshiBid as number | undefined
  const mid = s.ref.kalshiMid as number | undefined
  const spreadStr =
    ask != null && bid != null && ask > 0 && bid > 0
      ? ` spread ${((ask - bid) * 100).toFixed(0)}pp`
      : ''
  const midStr = mid != null ? ` mid ${pct(mid)}` : ''
  console.log(
    `${prefix}Δ ${edgeStr(s.edge)} | PM ${pct(s.pm.yesPrice)} → K ask ${pct(s.ourP)}${midStr}${spreadStr} | ${s.pm.title}`,
  )
  console.log(`${prefix}   ↳ ${s.ref.ticker} (${s.ref.matchedBy}) "${s.ref.question}"`)
}

// ---------------------------------------------------------------------------
// Artifact detection (shared between both modes)
// ---------------------------------------------------------------------------

function detectArtifacts(
  signals: Signal[],
  kalshiByTicker: Map<string, KalshiMarket>,
  legCountByEvent: Map<string, number>,
): { cleanSignals: Signal[]; artifactSignals: Signal[] } {
  const eventTickerOf = (ticker: string) => kalshiByTicker.get(ticker)?.eventTicker ?? ticker

  const byEvent = new Map<string, Signal[]>()
  for (const s of signals) {
    const et = eventTickerOf(String(s.ref.ticker))
    const group = byEvent.get(et) ?? []
    group.push(s)
    byEvent.set(et, group)
  }

  const artifactTickers = new Set<string>()
  for (const [et, group] of byEvent) {
    const totalLegs = legCountByEvent.get(et) ?? 1
    const sumYes = group.reduce((acc, s) => acc + (kalshiByTicker.get(String(s.ref.ticker))?.yesProbability ?? 0), 0)
    if (totalLegs >= 3 || sumYes > 1.10) {
      for (const s of group) artifactTickers.add(String(s.ref.ticker))
    }
  }

  const isFlagged = (s: Signal) => artifactTickers.has(String(s.ref.ticker)) || s.ref.suspect === true

  return {
    cleanSignals: signals.filter((s) => !isFlagged(s) && Math.abs(s.edge) >= MIN_EDGE),
    artifactSignals: signals.filter(isFlagged),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cachedOnly = process.argv.includes('--cached-only')

  // ── Fetch (always needed for live prices) ──────────────────────────────────
  console.error('· Fetching Kalshi markets…')
  const kalshi: KalshiMarket[] = await fetchKalshiMarkets({ maxPages: 8, minVolume: 100 })
  console.error(`· ✅ Kalshi: ${kalshi.length} markets fetched`)

  console.error('· Fetching Polymarket markets…')
  const pm = await fetchPolymarketMarkets()
  console.error(`· ✅ Polymarket: ${pm.length} markets fetched`)

  const kalshiByTicker = new Map(kalshi.map((k) => [k.ticker, k]))
  const legCountByEvent = new Map<string, number>()
  for (const k of kalshi) {
    legCountByEvent.set(k.eventTicker, (legCountByEvent.get(k.eventTicker) ?? 0) + 1)
  }

  // Pre-filter: drop Kalshi legs from multi-outcome events (≥3 legs per event).
  // These are always artifacts and would waste LLM tokens to confirm.
  const kalshiSingleOutcome = kalshi.filter((k) => (legCountByEvent.get(k.eventTicker) ?? 1) < 3)
  const multiOutcomeDropped = kalshi.length - kalshiSingleOutcome.length
  if (multiOutcomeDropped > 0) {
    console.error(`· ✂️  Multi-outcome pre-filter: ${multiOutcomeDropped} Kalshi legs dropped (events with ≥3 markets)`)
  }

  // Pre-filter: drop PM markets opened in the last 24 h — prices haven't stabilised.
  const MIN_MARKET_AGE_MS = 24 * 3600 * 1000
  const pmMature = pm.filter((m) => {
    if (!m.startDate) return true
    return Date.now() - new Date(m.startDate).getTime() >= MIN_MARKET_AGE_MS
  })
  const tooNewDropped = pm.length - pmMature.length
  if (tooNewDropped > 0) {
    console.error(`· ✂️  Min-age filter: ${tooNewDropped} PM markets opened in last 24 h dropped`)
  }

  // Load confirmed pairs — used in both paths.
  console.error('· Loading confirmed pairs from Supabase…')
  const confirmedPairs = await loadConfirmedPairs()
  console.error(`· ✅ ${confirmedPairs.length} confirmed pairs loaded`)
  const confirmedSlugs = new Set(confirmedPairs.map((p) => p.polymarket_slug))

  // ── Cached-only path ───────────────────────────────────────────────────────
  if (cachedOnly) {

    const pmBySlug = new Map(pm.map((m) => [m.slug, m]))
    const signals: Signal[] = []
    let staleCount = 0

    for (const pair of confirmedPairs) {
      const pmMarket = pmBySlug.get(pair.polymarket_slug)
      const km = kalshiByTicker.get(pair.kalshi_ticker)
      if (!pmMarket || !km) {
        staleCount++
        continue
      }
      const ourP = pair.yes_aligned
        ? (km.yesAsk > 0 ? km.yesAsk : km.yesProbability)
        : (km.yesBid > 0 ? 1 - km.yesBid : 1 - km.yesProbability)
      const edge = ourP - pmMarket.yesPrice
      signals.push({
        pm: pmMarket,
        ourP,
        edge,
        ref: {
          ticker: km.ticker,
          matchedBy: 'cached',
          question: km.question,
          kalshiMid: km.yesProbability,
          kalshiAsk: km.yesAsk,
          kalshiBid: km.yesBid,
          yesAligned: pair.yes_aligned,
          volume: km.volume,
          llmConfidence: pair.llm_confidence,
          suspect: Math.abs(edge) >= SUSPECT_EDGE,
        },
      })
    }

    if (staleCount > 0) {
      console.error(`· ⚠️  ${staleCount} confirmed pairs missing from current fetch (likely resolved)`)
    }

    const { cleanSignals, artifactSignals } = detectArtifacts(signals, kalshiByTicker, legCountByEvent)
    console.error(`· ✅ Artifact filter: ${cleanSignals.length} clean (|Δ| ≥ ${MIN_EDGE * 100}pp), ${artifactSignals.length} flagged`)

    console.log(`\n=== CONFIRMED CROSS-MARKET SIGNALS (cached — ${confirmedPairs.length} pairs) ===`)
    if (cleanSignals.length === 0) {
      console.log('(no clean signals above the minimum edge threshold right now)')
    } else {
      cleanSignals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
      for (const s of cleanSignals) printSignal(s)
    }

    if (artifactSignals.length > 0) {
      console.log(`\n=== ⚠️  MULTI-OUTCOME ARTIFACTS (${artifactSignals.length}) ===`)
      for (const s of artifactSignals) printSignal(s, '⚠️  ')
    }

    console.error(`· ✅ Done — ${cleanSignals.length} actionable signals`)
    console.log('')
    return
  }

  // ── Full path: lexical + LLM ───────────────────────────────────────────────
  console.error(`· LLM: ${isGeminiAvailable() ? 'ON (Groq)' : 'off (lexical only)'}`)

  interface Pair { score: number; edge: number; pm: PmMarket; k: KalshiMarket }
  const pairs: Pair[] = []
  for (const m of pmMature) {
    const top = topCandidates(m.title, kalshiSingleOutcome, (c) => c.question, 1, 0.22)
    if (top.length === 0) continue
    const k = top[0].candidate
    pairs.push({ score: top[0].score, edge: k.yesProbability - m.yesPrice, pm: m, k })
  }
  pairs.sort((a, b) => b.score - a.score)
  console.error(`· ✅ Lexical pass complete — ${pairs.filter((p) => p.score >= LLM_SIM_THRESHOLD).length} pairs ≥ ${LLM_SIM_THRESHOLD}`)

  console.log('\n=== KALSHI ↔ POLYMARKET — top lexical candidate pairs ===')
  console.log('(diagnostic: LLM confirms which are truly the same event)\n')
  for (const p of pairs.slice(0, 25)) {
    console.log(`sim ${p.score.toFixed(2)} | PM ${pct(p.pm.yesPrice)} vs K ${pct(p.k.yesProbability)} | Δ ${edgeStr(p.edge)}`)
    console.log(`   PM: ${p.pm.title}`)
    console.log(`   K : ${p.k.question}  [${p.k.category}, vol ${Math.round(p.k.volume)}]`)
  }
  const bands = [0.75, 0.6, 0.45, 0.3, 0.22]
  console.log('\nlexical pairs by similarity band:')
  for (const b of bands) console.log(`  ≥ ${b.toFixed(2)} : ${pairs.filter((p) => p.score >= b).length}`)

  const pmScoreBySlug = new Map(pairs.map((p) => [p.pm.slug, p.score]))

  // Skip confirmed pairs — already in Supabase, priced by --cached-only.
  // Sort soonest-expiring first so limited LLM budget goes to fastest-turning signals.
  const skippedConfirmed = pmMature.filter(
    (m) => (pmScoreBySlug.get(m.slug) ?? 0) >= LLM_SIM_THRESHOLD && confirmedSlugs.has(m.slug),
  ).length
  if (skippedConfirmed > 0) {
    console.error(`· ⏭️  Skipping ${skippedConfirmed} already-confirmed markets (run --cached-only to price them)`)
  }
  // Sort by lexical similarity first (best matches get the scarce LLM budget),
  // then soonest-expiring as a tiebreaker within equal-similarity pairs. Sorting
  // by expiry alone let low-quality near-term pairs crowd out strong matches.
  const llmCandidates = pmMature
    .filter((m) => (pmScoreBySlug.get(m.slug) ?? 0) >= LLM_SIM_THRESHOLD && !confirmedSlugs.has(m.slug))
    .sort((a, b) => {
      const scoreDiff = (pmScoreBySlug.get(b.slug) ?? 0) - (pmScoreBySlug.get(a.slug) ?? 0)
      if (scoreDiff !== 0) return scoreDiff
      const aEnd = a.endDate ? new Date(a.endDate).getTime() : Infinity
      const bEnd = b.endDate ? new Date(b.endDate).getTime() : Infinity
      return aEnd - bEnd
    })
    .slice(0, LLM_MAX_CANDIDATES)
  console.error(`· LLM candidates (sim ≥ ${LLM_SIM_THRESHOLD}, cap ${LLM_MAX_CANDIDATES}, new only): ${llmCandidates.length}`)

  const source = createKalshiSource(kalshiSingleOutcome)
  const signals: Signal[] = []

  console.log(`\n=== CONFIRMED CROSS-MARKET SIGNALS (${isGeminiAvailable() ? 'LLM' : 'lexical fallback'}) ===`)

  for (let i = 0; i < llmCandidates.length; i++) {
    const m = llmCandidates[i]
    if (isGeminiAvailable()) {
      process.stderr.write(`\r· LLM pass ${i + 1}/${llmCandidates.length}: ${m.title.slice(0, 55).padEnd(55)}`)
    }
    // Pass the PM slug as `id` so matchEvent's persistent match_cache (keyed on
    // polymarket_id) populates — this caches REJECTIONS too, so subsequent full
    // scans don't re-spend LLM tokens re-deriving the same "not a match" verdicts.
    const est = await source.estimate({ id: m.slug, title: m.title, endDate: m.endDate })
    if (isGroqTpdExhausted()) {
      if (isGeminiAvailable()) process.stderr.write('\n')
      console.error('· ⛔ Groq daily token limit hit — stopping LLM pass. Run again tomorrow or use --cached-only.')
      break
    }
    if (!est) continue

    const edge = est.ourP - m.yesPrice
    const suspect = Math.abs(edge) >= SUSPECT_EDGE
    const s: Signal = { pm: m, ourP: est.ourP, edge, ref: { ...est.reference, suspect } }
    signals.push(s)

    // Persist to confirmed_pairs so --cached-only works on the next run — but
    // NOT for suspect-large divergences (likely an unverified resolution
    // mismatch). Those are surfaced below for human review instead.
    if (!suspect) {
      void writeConfirmedPair(
        m.slug,
        String(est.reference.ticker),
        Boolean(est.reference.yesAligned),
        est.resolutionMatchConfidence,
      )
    }

    if (isGeminiAvailable()) process.stderr.write('\n')
    if (suspect) {
      console.log(
        `⚠️  SUSPECT (Δ ${edgeStr(edge)} ≥ ${SUSPECT_EDGE * 100}pp — likely resolution mismatch, NOT auto-confirmed):`,
      )
    }
    printSignal(s)
  }
  if (isGeminiAvailable()) process.stderr.write('\n')

  if (signals.length === 0 && !isGeminiAvailable()) {
    console.log('(set GROQ_API_KEY to have the LLM confirm matches and surface real divergences)')
    console.log('')
    return
  }

  const { cleanSignals, artifactSignals } = detectArtifacts(signals, kalshiByTicker, legCountByEvent)
  console.error(`· ✅ Artifact filter: ${cleanSignals.length} clean (|Δ| ≥ ${MIN_EDGE * 100}pp), ${artifactSignals.length} flagged`)

  if (artifactSignals.length > 0) {
    console.log(`\n=== ⚠️  MULTI-OUTCOME ARTIFACTS (${artifactSignals.length}) — event has ≥ 3 Kalshi legs or YES sum > 110% ===`)
    for (const s of artifactSignals) printSignal(s, '⚠️  ')
  }

  console.error(`· ✅ Done — ${cleanSignals.length} actionable signals (|Δ| ≥ ${MIN_EDGE * 100}pp, single-outcome)`)
  console.log('')
}

main().catch((e) => {
  console.error('Scan failed:', e)
  process.exit(1)
})
