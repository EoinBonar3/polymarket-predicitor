/**
 * List liquid, open binary Manifold markets — proves the standalone source and
 * lets you eyeball the universe it adds. No env, no LLM, no Supabase — just
 * Manifold's free public API.
 *
 *   npx tsx scripts/manifold-scan.ts                 # popular markets
 *   npx tsx scripts/manifold-scan.ts --sort=close-date --limit=30  # closing soon
 */

import { fetchManifoldMarkets, type FetchManifoldOptions } from '../lib/sources/manifoldApi'

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : undefined
}

async function main() {
  const sort = (arg('sort') as FetchManifoldOptions['sort']) ?? 'score'
  const limit = Number(arg('limit')) || 30

  console.error(`· Fetching Manifold markets (sort=${sort})…`)
  const markets = await fetchManifoldMarkets({ sort, limit, minVolume: Number(arg('min-volume')) || undefined })
  console.error(`· ✅ ${markets.length} liquid open binary markets\n`)

  console.log(`=== MANIFOLD — top ${markets.length} (sort=${sort}) ===\n`)
  for (const m of markets) {
    const days = Math.round((new Date(m.closeTime).getTime() - Date.now()) / 86_400_000)
    console.log(
      `${(m.yesProbability * 100).toFixed(0).padStart(3)}% | vol ${Math.round(m.volume).toLocaleString().padStart(9)} | ${String(m.uniqueBettors).padStart(4)} bettors | ${String(days).padStart(4)}d | ${m.question.slice(0, 70)}`,
    )
  }
  console.log('')
}

main().catch((e) => {
  console.error('Manifold scan failed:', e)
  process.exit(1)
})
