/**
 * Phase 1 keystone runner — answers, with real data:
 *   "Does an options/vol-implied probability beat Polymarket crypto prices?"
 *
 * Usage:  npx tsx scripts/backtest-crypto.ts
 *
 * No env vars, no Supabase, no Next server — just public APIs (Polymarket
 * Gamma + CLOB, Deribit, Binance). Pure measurement.
 */

import { runCryptoBacktest } from '../lib/backtest/harness'

function pct(n: number, d = 1): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '—'
}
function num(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

async function main() {
  const report = await runCryptoBacktest({ log: (m) => console.error(`· ${m}`) })

  console.log('\n=== CRYPTO BACKTEST ===\n')

  const c = report.coverage
  console.log('Coverage')
  console.log(`  resolved markets parsed : ${c.resolvedMarketsParsed}`)
  console.log(`  markets scored          : ${c.marketsScored}`)
  console.log(`  snapshots (samples)     : ${c.samples}`)
  console.log(`  …with implied vol       : ${c.samplesWithImpliedVol}`)
  console.log(`  …with Polymarket price  : ${c.samplesWithPmPrice}`)

  console.log('\nCalibration (Brier — lower is better, random = 0.250)')
  console.log(`  model (implied vol)     : ${num(report.model.brier)}  [n=${report.model.samples}]`)
  console.log(`  model (realised vol)    : ${num(report.model.brierRealised)}`)
  console.log(`  Polymarket price        : ${num(report.market.brier)}  [n=${report.market.samples}]`)

  const printEdge = (label: string, e: typeof report.edgeContested) => {
    console.log(`\n${label}`)
    console.log(`  bets                    : ${e.n}`)
    console.log(`  hit rate                : ${pct(e.hitRate)}`)
    console.log(`  avg profit / £1 staked  : ${num(e.avgProfitPerPound)}  (>0 ⇒ edge)`)
    console.log(`  median profit / £1      : ${num(e.medianProfitPerPound)}  (robust to longshot variance)`)
    console.log(`  avg claimed edge        : ${pct(e.avgClaimedEdge)}`)
    console.log(`  model Brier vs market   : ${num(e.modelBrier)} vs ${num(e.marketBrier)}  (model better only if lower)`)
  }
  printEdge(`Edge test — ALL disagreements ≥ ${pct(report.edge.threshold)}`, { ...report.edge })
  printEdge('Edge test — CONTESTED only (market price 10–90%)', report.edgeContested)

  console.log('\nBy horizon (model Brier vs market Brier)')
  for (const h of report.byHorizon) {
    console.log(`  ${String(h.horizonDays).padStart(3)}d : model ${num(h.modelBrier)} | market ${num(h.marketBrier)}  [n=${h.samples}]`)
  }

  console.log('\nBy barrier type (model Brier vs market Brier)')
  for (const b of report.byBarrier) {
    console.log(`  ${b.barrier.padEnd(6)} : model ${num(b.modelBrier)} | market ${num(b.marketBrier)}  [n=${b.samples}]`)
  }

  console.log('\nExamples (model vs market vs outcome)')
  for (const e of report.examples) {
    console.log(
      `  [${e.horizonDays}d] model ${e.modelP == null ? '—' : pct(e.modelP)} | market ${e.pmP == null ? '—' : pct(e.pmP)} | → ${e.outcome ? 'YES' : 'NO '}  ${e.question.slice(0, 60)}`,
    )
  }
  console.log('')
}

main().catch((e) => {
  console.error('Backtest failed:', e)
  process.exit(1)
})
