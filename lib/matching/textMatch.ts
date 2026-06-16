/**
 * Lexical candidate matching — the cheap first pass before the LLM.
 *
 * For every Polymarket market we need the handful of Kalshi markets most likely
 * to be the same event, WITHOUT calling the LLM on every pair (that's hundreds
 * of calls per scan). This scores text similarity so only the top few survive
 * to the (expensive, accurate) LLM confirmation step.
 *
 * Pure, no I/O. Deliberately recall-oriented: it's fine to pass a few wrong
 * candidates to the LLM (it rejects them); it's costly to filter out the right
 * one before the LLM ever sees it.
 */

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'of', 'in', 'on', 'by', 'to', 'be', 'is', 'are', 'get', 'gets',
  'any', 'before', 'after', 'who', 'what', 'which', 'when', 'this', 'that', 'for', 'and', 'or',
  'at', 'as', 'it', 'its', 'with', 'than', 'then', 'do', 'does', 'go', 'goes', 'next', 'reach',
  'reaches', 'hit', 'hits', 'become', 'becomes', 'first', 'over', 'under', 'end',
])

export interface ScoredCandidate<T> {
  candidate: T
  score: number
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9$.,\s%-]/g, ' ')
}

/** Content tokens (stopwords + pure punctuation removed). */
function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of normalize(text).split(/\s+/)) {
    const t = raw.replace(/^[.,-]+|[.,-]+$/g, '')
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    out.add(t)
  }
  return out
}

/**
 * Numeric tokens, scale-normalised so "150k" and "150,000" match. Years and
 * price levels are the strongest disambiguators between near-identical
 * questions ("$100k in 2024" vs "$100k in 2025").
 */
function numbers(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of normalize(text).matchAll(/\$?\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?([km])?/g)) {
    const suffix = (m[2] ?? '').toLowerCase()
    let n = Number((m[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    if (suffix === 'k') n *= 1_000
    else if (suffix === 'm') n *= 1_000_000
    out.add(String(n))
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/**
 * Similarity in [0,1]: mostly token overlap, boosted when the same numbers
 * (strikes, years) appear in both. The number term only helps — its absence
 * never penalises a pair that has none.
 */
export function similarity(aText: string, bText: string): number {
  const tokenScore = jaccard(tokens(aText), bText ? tokens(bText) : new Set())
  const aNums = numbers(aText)
  const bNums = numbers(bText)
  const numScore = aNums.size && bNums.size ? jaccard(aNums, bNums) : 0
  const anyNums = aNums.size && bNums.size ? 1 : 0
  return (1 - 0.35 * anyNums) * tokenScore + 0.35 * anyNums * numScore
}

/**
 * Top-`k` candidates for a query text, scored ≥ `minScore`, best first.
 */
export function topCandidates<T>(
  queryText: string,
  candidates: T[],
  getText: (c: T) => string,
  k = 5,
  minScore = 0.12,
): ScoredCandidate<T>[] {
  const scored: ScoredCandidate<T>[] = []
  for (const candidate of candidates) {
    const score = similarity(queryText, getText(candidate))
    if (score >= minScore) scored.push({ candidate, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}
