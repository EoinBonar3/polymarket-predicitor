/**
 * Active paper-trading loop — drives the system so it bets and settles on its
 * own. Run it alongside `npm run dev` in a second terminal:
 *
 *   npx tsx scripts/bet-loop.ts
 *   npx tsx scripts/bet-loop.ts --bet-hours=6 --resolve-mins=30 --base=http://localhost:3000
 *
 * It pings two FREE crons (no LLM, no Odds API, no quotas):
 *   - /api/cron/manifold-bet  — places favored-side Manifold paper bets
 *   - /api/cron/resolve       — settles bets whose markets have resolved
 *
 * The app's dev server must be running (it serves the endpoints). Reads
 * CRON_SECRET from .env.local. Runs until you stop it (Ctrl-C). Bankroll guards
 * live in the routes, so it self-limits when cash runs low.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

try {
  for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim()
  }
} catch { /* .env.local absent — fine */ }

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

const BASE = arg('base') ?? 'http://localhost:3000'
const SECRET = process.env.CRON_SECRET ?? ''
const BET_EVERY_MS = (Number(arg('bet-hours')) || 6) * 3600_000
const RESOLVE_EVERY_MS = (Number(arg('resolve-mins')) || 30) * 60_000
const TICK_MS = Math.min(RESOLVE_EVERY_MS, BET_EVERY_MS)

function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

async function hit(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { 'x-cron-secret': SECRET } })
    if (!res.ok) {
      console.error(`· ${ts()} ${path} → HTTP ${res.status}`)
      return null
    }
    return (await res.json()) as Record<string, unknown>
  } catch (e) {
    console.error(`· ${ts()} ${path} → ${e instanceof Error ? e.message : e} (is \`npm run dev\` running?)`)
    return null
  }
}

async function runBet() {
  const r = await hit('/api/cron/manifold-bet')
  if (!r) return
  const placed = Array.isArray(r.placed) ? r.placed.length : 0
  console.log(`· ${ts()} 🎲 manifold-bet: placed ${placed} (eligible ${r.eligible ?? '?'}) → balance £${r.balance ?? '?'}`)
}

async function runResolve() {
  const r = await hit('/api/cron/resolve')
  if (!r) return
  console.log(`· ${ts()} ✅ resolve: settled ${r.settled ?? 0} of ${r.openPositions ?? 0} open → balance £${r.balance ?? '?'}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!SECRET) {
    console.error('CRON_SECRET not set in .env.local — cannot authenticate to the crons.')
    process.exit(1)
  }
  console.log(`· bet-loop started — bet every ${BET_EVERY_MS / 3600_000}h, resolve every ${RESOLVE_EVERY_MS / 60_000}m, base ${BASE}`)

  let lastBet = 0
  let lastResolve = 0
  for (;;) {
    const now = Date.now()
    if (now - lastResolve >= RESOLVE_EVERY_MS) { await runResolve(); lastResolve = now }
    if (now - lastBet >= BET_EVERY_MS) { await runBet(); lastBet = now }
    await sleep(TICK_MS)
  }
}

void main()
