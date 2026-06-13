'use client'

/**
 * Filter / sort controls for the dashboard market grid.
 *
 * Category tabs are derived from the live data so the dropdown always
 * matches what's actually fetchable — we never hard-code Polymarket's
 * evolving taxonomy.
 */

import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import type { Market } from '@/lib/types'

export type SortKey = 'volume_24hr' | 'liquidity' | 'ending_soon'

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'volume_24hr', label: 'Volume 24h' },
  { value: 'liquidity', label: 'Liquidity' },
  { value: 'ending_soon', label: 'Ending Soon' },
]

export const ALL_CATEGORIES = 'All'

interface MarketFiltersProps {
  markets: Market[]
  category: string
  sort: SortKey
  onCategoryChange: (category: string) => void
  onSortChange: (sort: SortKey) => void
}

export function MarketFilters({
  markets,
  category,
  sort,
  onCategoryChange,
  onSortChange,
}: MarketFiltersProps) {
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const m of markets) {
      const c = m.category?.trim()
      if (c) set.add(c)
    }
    return [ALL_CATEGORIES, ...Array.from(set).sort((a, b) => a.localeCompare(b))]
  }, [markets])

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-gray-800 bg-gray-900/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div
        role="tablist"
        aria-label="Filter markets by category"
        className="-mx-1 flex flex-1 flex-wrap items-center gap-1 overflow-x-auto px-1"
      >
        {categories.map((c) => {
          const active = c === category
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onCategoryChange(c)}
              className={cn(
                'whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition',
                active
                  ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200'
                  : 'border-gray-700/70 bg-gray-900/60 text-gray-300 hover:border-gray-600 hover:text-white',
              )}
            >
              {c}
            </button>
          )
        })}
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-400 sm:ml-4">
        <span className="hidden sm:inline">Sort by</span>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-sm text-gray-100 outline-none transition focus:border-emerald-400/60 focus:ring-1 focus:ring-emerald-400/40"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export default MarketFilters
