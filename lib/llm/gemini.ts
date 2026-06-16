/**
 * Gemini-backed event matcher — the accurate second pass.
 *
 * The lexical pre-filter (`lib/matching/textMatch.ts`) hands us a few Kalshi
 * candidates per Polymarket market; this asks Gemini the question only an LLM
 * answers well: are these the SAME event with the SAME resolution criteria, and
 * does Kalshi's YES correspond to Polymarket's YES or is it inverted?
 *
 * Free-tier friendly: one cheap structured call per Polymarket market that had
 * any candidate, results cached in-process so a re-scan within the session is
 * free. Activates only when `GEMINI_API_KEY` is set; callers degrade to a
 * conservative lexical-only path otherwise.
 *
 * Uses structured output (`responseSchema`) so we never parse free text.
 *
 * ---------------------------------------------------------------------------
 * One-off schema migration — run manually in the Supabase SQL editor before
 * the persistent match cache below starts being read/written.
 *
 * Persists Gemini's same-event / YES-alignment decisions per
 * (Polymarket market, Kalshi ticker) pair, so a re-scan within the 7-day TTL
 * (`CACHE_TTL_MS`) skips the LLM call entirely. One row per candidate
 * considered for a given Polymarket market — `is_same_event` is true for at
 * most one row per `polymarket_id`.
 *
 *   CREATE TABLE IF NOT EXISTS match_cache (
 *     id bigserial PRIMARY KEY,
 *     polymarket_id text NOT NULL,
 *     kalshi_id text NOT NULL,
 *     is_same_event boolean NOT NULL,
 *     yes_aligned boolean NOT NULL,
 *     confidence double precision NOT NULL,
 *     caveats text,
 *     cached_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE UNIQUE INDEX IF NOT EXISTS match_cache_pair_idx
 *     ON match_cache (polymarket_id, kalshi_id);
 * ---------------------------------------------------------------------------
 */

import { supabase } from '../supabase'

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
const ENDPOINT = (key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`

/** How long a persisted `match_cache` row is trusted before Gemini is re-asked. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Rate limiting — 10 requests / minute = 1 call per 6 s minimum.
// ---------------------------------------------------------------------------

/** Minimum gap between Gemini API calls. 10 req/min → 6 000 ms. */
const GEMINI_MIN_INTERVAL_MS = 6_000
/** How long to wait after a 429 before the single retry. */
const GEMINI_RETRY_DELAY_MS = 6_000

let lastCallAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Thin wrapper around `fetch` to the Gemini endpoint that:
 *   1. Enforces the minimum inter-call interval before each request.
 *   2. On HTTP 429 waits `GEMINI_RETRY_DELAY_MS` and retries exactly once.
 */
async function callGeminiApi(key: string, bodyStr: string, signal?: AbortSignal): Promise<Response> {
  const elapsed = Date.now() - lastCallAt
  if (elapsed < GEMINI_MIN_INTERVAL_MS) {
    await sleep(GEMINI_MIN_INTERVAL_MS - elapsed)
  }
  lastCallAt = Date.now()

  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: bodyStr,
  }
  const res = await fetch(ENDPOINT(key), init)

  if (res.status === 429) {
    console.warn(`[gemini] 429 rate-limited — waiting ${GEMINI_RETRY_DELAY_MS / 1000} s before retry`)
    await sleep(GEMINI_RETRY_DELAY_MS)
    lastCallAt = Date.now()
    return fetch(ENDPOINT(key), init)
  }

  return res
}

export interface MatchCandidate {
  /** Stable id echoed back by the model (we use the Kalshi ticker). */
  id: string
  question: string
  rules?: string
}

export interface MatchQuery {
  /**
   * Polymarket market id — required for the persistent `match_cache` table.
   * When omitted, matching still works but only the in-process cache applies.
   */
  id?: string
  question: string
  endDate?: string
}

export interface MatchResult {
  /** Candidate id the model chose, or null when none is the same event. */
  matchId: string | null
  isSameEvent: boolean
  /** True if Kalshi YES ⇔ Polymarket YES; false if the YES sides are inverted. */
  yesAligned: boolean
  confidence: number
  resolutionCaveats: string
}

export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY
}

const cache = new Map<string, MatchResult | null>()

function cacheKey(query: MatchQuery, candidates: MatchCandidate[]): string {
  return `${query.question}::${candidates.map((c) => c.id).join('|')}`
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    match_id: { type: 'string', description: 'id of the matching candidate, or empty string if none' },
    is_same_event: { type: 'boolean' },
    yes_aligned: { type: 'boolean', description: 'true if the candidate YES means the same as the Polymarket YES' },
    confidence: { type: 'number', description: '0 to 1' },
    resolution_caveats: { type: 'string' },
  },
  required: ['match_id', 'is_same_event', 'yes_aligned', 'confidence', 'resolution_caveats'],
}

function buildPrompt(query: MatchQuery, candidates: MatchCandidate[]): string {
  const lines = candidates.map(
    (c) => `- id="${c.id}": "${c.question}"${c.rules ? `\n    rules: ${c.rules}` : ''}`,
  )
  return [
    'You match prediction-market questions across two venues.',
    '',
    'POLYMARKET question (its YES outcome is the event):',
    `"${query.question}"${query.endDate ? ` (resolves around ${query.endDate})` : ''}`,
    '',
    'KALSHI candidates:',
    ...lines,
    '',
    'Pick the ONE candidate that refers to the SAME underlying event AND resolves on the',
    'same criteria. If none truly match, set is_same_event=false and match_id="".',
    'Set yes_aligned=false if the matching candidate\'s YES is the logical opposite of the',
    "Polymarket YES (e.g. one asks 'above', the other 'below'). Be strict: a near-miss on",
    'threshold, date, or resolution source is NOT a match. confidence is your calibrated',
    'probability that this is genuinely the same tradeable event.',
  ].join('\n')
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
}

interface MatchCacheRow {
  kalshi_id: string
  is_same_event: boolean
  yes_aligned: boolean
  confidence: number
  caveats: string | null
  cached_at: string
}

/**
 * Reconstruct a `MatchResult` from `match_cache` rows for every candidate in
 * the current set, or `undefined` if any candidate isn't cached (or is stale)
 * and Gemini must be asked.
 */
async function loadCachedMatch(
  polymarketId: string,
  candidates: MatchCandidate[],
): Promise<MatchResult | null | undefined> {
  if (!supabase) return undefined

  const ids = candidates.map((c) => c.id)
  const { data, error } = await supabase
    .from('match_cache')
    .select('kalshi_id, is_same_event, yes_aligned, confidence, caveats, cached_at')
    .eq('polymarket_id', polymarketId)
    .in('kalshi_id', ids)

  if (error || !data) return undefined

  const cutoff = Date.now() - CACHE_TTL_MS
  const rows = data as MatchCacheRow[]
  const fresh = rows.filter((r) => new Date(r.cached_at).getTime() > cutoff)
  if (fresh.length < ids.length) return undefined

  const match = fresh.find((r) => r.is_same_event)
  if (!match) {
    return { matchId: null, isSameEvent: false, yesAligned: true, confidence: 0, resolutionCaveats: '' }
  }
  return {
    matchId: match.kalshi_id,
    isSameEvent: true,
    yesAligned: match.yes_aligned,
    confidence: match.confidence,
    resolutionCaveats: match.caveats ?? '',
  }
}

/** Persist one `match_cache` row per candidate considered for this match. */
async function writeCachedMatch(
  polymarketId: string,
  candidates: MatchCandidate[],
  result: MatchResult,
): Promise<void> {
  if (!supabase) return

  const now = new Date().toISOString()
  const rows = candidates.map((c) => {
    const isMatch = result.isSameEvent && result.matchId === c.id
    return {
      polymarket_id: polymarketId,
      kalshi_id: c.id,
      is_same_event: isMatch,
      yes_aligned: isMatch ? result.yesAligned : true,
      confidence: isMatch ? result.confidence : 0,
      caveats: isMatch ? result.resolutionCaveats : '',
      cached_at: now,
    }
  })

  const { error } = await supabase.from('match_cache').upsert(rows, { onConflict: 'polymarket_id,kalshi_id' })
  if (error) {
    console.error('[gemini] match_cache upsert failed:', error.message)
  }
}

/**
 * Returns the best match (or null) for a Polymarket question among Kalshi
 * candidates. Returns null on any error or when Gemini is unavailable — the
 * caller treats null as "no confirmed match".
 */
export async function matchEvent(
  query: MatchQuery,
  candidates: MatchCandidate[],
  signal?: AbortSignal,
): Promise<MatchResult | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key || candidates.length === 0) return null

  const ck = cacheKey(query, candidates)
  if (cache.has(ck)) return cache.get(ck) ?? null

  if (query.id) {
    const cached = await loadCachedMatch(query.id, candidates)
    if (cached !== undefined) {
      cache.set(ck, cached)
      return cached
    }
  }

  try {
    const bodyStr = JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(query, candidates) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    })
    const res = await callGeminiApi(key, bodyStr, signal)
    if (!res.ok) {
      console.error(`[gemini] matchEvent HTTP ${res.status}`)
      cache.set(ck, null)
      return null
    }
    const body = (await res.json()) as GeminiResponse
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      cache.set(ck, null)
      return null
    }
    const parsed = JSON.parse(text) as {
      match_id?: string
      is_same_event?: boolean
      yes_aligned?: boolean
      confidence?: number
      resolution_caveats?: string
    }
    const matchId = parsed.match_id && candidates.some((c) => c.id === parsed.match_id) ? parsed.match_id : null
    const result: MatchResult = {
      matchId: parsed.is_same_event ? matchId : null,
      isSameEvent: !!parsed.is_same_event && matchId != null,
      yesAligned: parsed.yes_aligned !== false,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      resolutionCaveats: parsed.resolution_caveats ?? '',
    }
    cache.set(ck, result)
    if (query.id) void writeCachedMatch(query.id, candidates, result)
    return result
  } catch (err) {
    console.error('[gemini] matchEvent failed:', err instanceof Error ? err.message : err)
    cache.set(ck, null)
    return null
  }
}
