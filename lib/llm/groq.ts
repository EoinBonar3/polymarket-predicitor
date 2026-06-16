/**
 * Multi-provider LLM event matcher (Groq + Cerebras, OpenAI-compatible).
 *
 * Provider priority: Groq keys first (GROQ_API_KEY, _2, _3), then Cerebras
 * (CEREBRAS_API_KEY). When a key hits its daily token limit the next provider
 * is used automatically — no manual intervention needed.
 *
 * Exports the same surface as the old gemini.ts so callers need no changes.
 */

import { getDb } from '../supabase'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Provider pool
// ---------------------------------------------------------------------------

interface ProviderKey {
  key: string
  endpoint: string
  model: string
  label: string
}

// Lazily built on first use so env vars loaded by the scan script's .env.local
// reader are visible even though ES module imports are hoisted.
let _providerKeys: ProviderKey[] | null = null

function providerKeys(): ProviderKey[] {
  if (_providerKeys !== null) return _providerKeys
  _providerKeys = [
    // Groq — tried first
    ...(process.env.GROQ_API_KEY
      ? [
          {
            key: process.env.GROQ_API_KEY,
            endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
            label: 'groq',
          },
        ]
      : []),
    // Cerebras — automatic fallback when Groq hits its daily token limit
    ...(process.env.CEREBRAS_API_KEY
      ? [
          {
            key: process.env.CEREBRAS_API_KEY,
            endpoint: 'https://api.cerebras.ai/v1/chat/completions',
            // Cerebras retired llama-3.3-70b; gpt-oss-120b is the current
            // instruction model and honours response_format json_object.
            model: process.env.CEREBRAS_MODEL ?? 'gpt-oss-120b',
            label: 'cerebras',
          },
        ]
      : []),
  ]
  return _providerKeys
}

const tpdExhaustedKeys = new Set<string>()

function activeProvider(): ProviderKey | null {
  for (const p of providerKeys()) {
    if (!tpdExhaustedKeys.has(p.key)) return p
  }
  return null
}

// ---------------------------------------------------------------------------
// Rate limiting — 2 s floor between calls (safe for both providers' free tiers)
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 2_000
const RETRY_DELAY_MS = 15_000

let lastCallAt = 0

export function isGroqTpdExhausted(): boolean {
  return providerKeys().length > 0 && activeProvider() === null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function callLlmApi(
  messages: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): Promise<Response> {
  const provider = activeProvider()
  if (!provider) {
    return new Response('{"error":{"message":"All LLM providers TPD exhausted","type":"tokens"}}', { status: 429 })
  }

  const elapsed = Date.now() - lastCallAt
  if (elapsed < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - elapsed)
  lastCallAt = Date.now()

  const bodyStr = JSON.stringify({
    model: provider.model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' },
  })

  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
    signal,
    body: bodyStr,
  }
  const res = await fetch(provider.endpoint, init)

  if (res.status === 429) {
    const body = await res.clone().text().catch(() => '')
    const isDaily = body.includes('per day') || body.includes('daily') || body.includes('TPD')

    if (isDaily) {
      tpdExhaustedKeys.add(provider.key)
      const next = activeProvider()
      if (next) {
        console.warn(`[llm] ${provider.label} TPD exhausted — rotating to ${next.label}`)
        return callLlmApi(messages, signal)
      }
      console.warn('[llm] All LLM providers TPD exhausted — halting calls. Resets at midnight Pacific.')
      return res
    }

    console.warn(`[llm] ${provider.label} rate-limited (per-minute) — waiting ${RETRY_DELAY_MS / 1000} s`)
    await sleep(RETRY_DELAY_MS)
    lastCallAt = Date.now()
    return fetch(provider.endpoint, init)
  }

  return res
}

// ---------------------------------------------------------------------------
// Public types (identical to gemini.ts so callers need no changes)
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  id: string
  question: string
  rules?: string
}

export interface MatchQuery {
  id?: string
  question: string
  endDate?: string
}

export interface MatchResult {
  matchId: string | null
  isSameEvent: boolean
  yesAligned: boolean
  confidence: number
  resolutionCaveats: string
}

export function isGeminiAvailable(): boolean {
  return providerKeys().length > 0
}

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

const cache = new Map<string, MatchResult | null>()

function cacheKey(query: MatchQuery, candidates: MatchCandidate[]): string {
  return `${query.question}::${candidates.map((c) => c.id).join('|')}`
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildMessages(query: MatchQuery, candidates: MatchCandidate[]) {
  const lines = candidates.map(
    (c) => `- id="${c.id}": "${c.question}"${c.rules ? `\n    rules: ${c.rules}` : ''}`,
  )
  const userContent = [
    'You match prediction-market questions across two venues.',
    '',
    'POLYMARKET question (its YES outcome is the event):',
    `"${query.question}"${query.endDate ? ` (resolves around ${query.endDate})` : ''}`,
    '',
    'KALSHI candidates:',
    ...lines,
    '',
    'Pick the ONE candidate that refers to the SAME underlying event AND resolves on the',
    'same criteria. If none truly match, set is_same_event to false and match_id to "".',
    '',
    'THE TEST FOR is_same_event=true: the two YES conditions must be LOGICALLY EQUIVALENT —',
    'every world where one resolves YES, the other also resolves YES, and vice versa. Sharing',
    'a topic, person, or date is NOT enough. If one side has a strictly stronger or weaker',
    'condition than the other, they are DIFFERENT events → is_same_event=false.',
    '',
    'Disqualifying mismatches (these are NOT the same event):',
    '- A vs "A and B": "impeached" ≠ "impeached AND removed from office"; "nominated" ≠ "nominated and confirmed".',
    '- Whole vs part: "acquire/annex all of X" ≠ "take control of any part of X".',
    '- Action vs attempt/intent: "win the nomination" ≠ "run for the nomination"; "passes" ≠ "is introduced".',
    '- Specific vs broad outcome: "wins the election" ≠ "the election occurs"; one candidate ≠ the field.',
    '- Different threshold, date window, jurisdiction, or resolution source — even if close.',
    '',
    'Set yes_aligned to false if the matching candidate\'s YES is the logical opposite of the',
    "Polymarket YES (e.g. one asks 'above', the other 'below'). confidence is your calibrated",
    'probability (0-1) that the YES conditions are genuinely equivalent. If you are not highly',
    'sure the resolution criteria match exactly, lower confidence or set is_same_event=false.',
    '',
    'Respond with valid JSON only, no markdown, matching this shape:',
    '{"match_id":"<id or empty>","is_same_event":<bool>,"yes_aligned":<bool>,"confidence":<0-1>,"resolution_caveats":"<string>"}',
  ].join('\n')

  return [
    {
      role: 'system',
      content: 'You are a strict prediction-market analyst. Respond with valid JSON only, no markdown fences.',
    },
    { role: 'user', content: userContent },
  ]
}

// ---------------------------------------------------------------------------
// Supabase persistent cache (identical schema to gemini.ts)
// ---------------------------------------------------------------------------

interface MatchCacheRow {
  kalshi_id: string
  is_same_event: boolean
  yes_aligned: boolean
  confidence: number
  caveats: string | null
  cached_at: string
}

async function loadCachedMatch(
  polymarketId: string,
  candidates: MatchCandidate[],
): Promise<MatchResult | null | undefined> {
  const supabase = getDb(); if (!supabase) return undefined

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

async function writeCachedMatch(
  polymarketId: string,
  candidates: MatchCandidate[],
  result: MatchResult,
): Promise<void> {
  const supabase = getDb(); if (!supabase) return

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
    console.error('[groq] match_cache upsert failed:', error.message)
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export async function matchEvent(
  query: MatchQuery,
  candidates: MatchCandidate[],
  signal?: AbortSignal,
): Promise<MatchResult | null> {
  if (providerKeys().length === 0 || candidates.length === 0) return null

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
    const res = await callLlmApi(buildMessages(query, candidates), signal)
    if (!res.ok) {
      console.error(`[groq] matchEvent HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      cache.set(ck, null)
      return null
    }

    const body = (await res.json()) as GroqResponse
    const text = body.choices?.[0]?.message?.content
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
    console.error('[groq] matchEvent failed:', err instanceof Error ? err.message : err)
    cache.set(ck, null)
    return null
  }
}
