'use client'

/**
 * Four-up grid of calibration scoring metrics: Brier, log loss, mean
 * calibration error, and confidence bias. Each card mirrors the StatCard
 * pattern used by `app/performance/page.tsx` so the new section visually
 * slots in with the existing equity-curve stats.
 */

import { cn } from '@/lib/utils'
import type { CalibrationData } from '@/lib/calibration'

interface CalibrationStatsProps {
  data: CalibrationData
}

type Tone = 'positive' | 'neutral' | 'negative'

interface StatCardSpec {
  label: string
  value: string
  hint: string
  tooltip: string
  tone: Tone
}

// ---------------------------------------------------------------------------
// Tone helpers — green / amber / red bands per metric
// ---------------------------------------------------------------------------

function brierTone(score: number): Tone {
  if (score < 0.2) return 'positive'
  if (score <= 0.24) return 'neutral'
  return 'negative'
}

function logLossTone(score: number): Tone {
  if (score < 0.6) return 'positive'
  if (score <= 0.68) return 'neutral'
  return 'negative'
}

function calibrationErrorTone(error: number): Tone {
  // `error` is a 0..1 fraction.
  if (error < 0.05) return 'positive'
  if (error <= 0.1) return 'neutral'
  return 'negative'
}

function confidenceBiasTone(bias: number): Tone {
  const abs = Math.abs(bias)
  if (abs <= 0.05) return 'positive'
  if (abs <= 0.1) return 'neutral'
  return 'negative'
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatScore(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

function formatPct(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(decimals)}%`
}

function formatSignedPct(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—'
  const pct = n * 100
  const sign = pct > 0 ? '+' : pct < 0 ? '' : ''
  return `${sign}${pct.toFixed(decimals)}%`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CalibrationStats({ data }: CalibrationStatsProps) {
  const cards: StatCardSpec[] = [
    {
      label: 'Brier Score',
      value: formatScore(data.brierScore),
      hint: 'Random = 0.250',
      tooltip:
        'Mean squared error between predicted probability and outcome. Lower is better. A random guesser scores 0.250.',
      tone: brierTone(data.brierScore),
    },
    {
      label: 'Log Loss',
      value: formatScore(data.logLoss),
      hint: 'Random = 0.693',
      tooltip:
        'Penalises confident wrong predictions. Lower is better.',
      tone: logLossTone(data.logLoss),
    },
    {
      label: 'Mean Calibration Error',
      value: formatPct(data.meanCalibrationError),
      hint: 'Avg |predicted − actual|',
      tooltip:
        'Average gap between predicted probability and actual win rate across all buckets.',
      tone: calibrationErrorTone(data.meanCalibrationError),
    },
    {
      label: 'Confidence Bias',
      value: formatSignedPct(data.overconfidenceBias),
      hint:
        data.overconfidenceBias > 0.001
          ? 'Overconfident'
          : data.overconfidenceBias < -0.001
          ? 'Underconfident'
          : 'Well-balanced',
      tooltip:
        "Positive means your predictions are too high on average. Negative means you're more conservative than reality.",
      tone: confidenceBiasTone(data.overconfidenceBias),
    },
  ]

  return (
    <section
      aria-label="Calibration scoring metrics"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {cards.map((card) => (
        <StatCard key={card.label} spec={card} />
      ))}
    </section>
  )
}

function StatCard({ spec }: { spec: StatCardSpec }) {
  return (
    <div
      className="rounded-xl border border-gray-800 bg-gray-900/60 p-3"
      title={spec.tooltip}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {spec.label}
      </p>
      <p
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums',
          spec.tone === 'positive' && 'text-emerald-300',
          spec.tone === 'negative' && 'text-rose-300',
          spec.tone === 'neutral' && 'text-amber-300',
        )}
      >
        {spec.value}
      </p>
      <p className="mt-0.5 text-[11px] text-gray-500">{spec.hint}</p>
    </div>
  )
}

export default CalibrationStats
