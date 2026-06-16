/**
 * Polymarket calibration backtest — answers, with real data:
 *   "Is the Polymarket crowd calibrated, and is there a favorite-longshot bias?"
 *
 * Usage:
 *   npx tsx scripts/backtest.ts                       # defaults
 *   npx tsx scripts/backtest.ts --markets=200 --lead=14 --min-volume=50000
 *
 * No env vars, no Supabase, no Next server — just public Polymarket Gamma +
 * CLOB APIs. Point-in-time, no look-ahead. Writes nothing to the live tables.
 */

import { runPmBacktest } from '../lib/backtest/pmBacktest'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}
function pct(n: number, d = 1): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '—'
}
function num(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}
function signedPct(n: number): string {
  return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}pp` : '—'
}

async function main() {
  const report = await runPmBacktest({
    maxMarkets: Number(arg('markets')) || undefined,
    leadDays: Number(arg('lead')) || undefined,
    minVolume: Number(arg('min-volume')) || undefined,
    maxPages: Number(arg('pages')) || undefined,
    log: (m) => console.error(`· ${m}`),
  })

  console.log(`\n=== POLYMARKET CALIBRATION BACKTEST (snapshot ${report.leadDays}d pre-resolution) ===\n`)

  const c = report.coverage
  console.log('Coverage')
  console.log(`  resolved markets parsed : ${c.parsed}`)
  console.log(`  …with CLOB price history: ${c.withHistory}`)
  console.log(`  scored snapshots        : ${c.samples}`)
  console.log(`  base rate (YES share)   : ${pct(report.baseRate)}`)

  console.log('\nCalibration (Brier — lower is better)')
  console.log(`  crowd price             : ${num(report.brierMarket)}`)
  console.log(`  baseline (predict base) : ${num(report.brierBaseline)}   (crowd skilled only if lower)`)
  console.log(`  log loss (crowd)        : ${num(report.logLossMarket)}   (random ≈ 0.693)`)

  console.log('\nCalibration by price bucket (predicted vs actual)')
  for (const b of report.buckets) {
    console.log(
      `  ${b.label.padEnd(8)} predicted ${pct(b.predicted).padStart(6)} → actual ${pct(b.actual).padStart(6)}  gap ${signedPct(b.gap).padStart(8)}  [n=${b.n}]`,
    )
  }

  console.log('\nFavorite-longshot bias  (gap = actual − predicted; negative ⇒ overpriced)')
  console.log(`  longshot buckets (<40%) : ${signedPct(report.longshotBias.longshotGap)}`)
  console.log(`  favorite buckets (>60%) : ${signedPct(report.longshotBias.favoriteGap)}`)

  const f = report.favoriteStrategy
  console.log('\nStrategy — flat stake on the favored side of every market')
  console.log(`  bets                    : ${f.n}`)
  console.log(`  win rate                : ${pct(f.winRate)}`)
  console.log(`  ROI / staked            : ${signedPct(f.roi)}   (>0 ⇒ favorites underpriced)`)
  console.log(`  bankroll                : £${f.startBankroll} → £${f.finalBankroll}`)

  console.log('\nExamples (crowd price → outcome)')
  for (const e of report.examples) {
    console.log(`  ${pct(e.predicted).padStart(6)} → ${e.outcome ? 'YES' : 'NO '}  ${e.question.slice(0, 64)}`)
  }
  console.log('')
}

main().catch((e) => {
  console.error('Backtest failed:', e)
  process.exit(1)
})
