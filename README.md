# Polymarket Predictor

A paper trading simulator and edge-finder for [Polymarket](https://polymarket.com) prediction markets. Pulls live market data, cross-references external probability anchors, sizes bets with the Kelly criterion, and tracks performance over time.

> Educational tool only. Not financial advice. No real money is traded.

## How it works

The app looks for price discrepancies between Polymarket and three external sources:

| Source | Signal |
|--------|--------|
| **The Odds API** | Vig-removed bookmaker consensus for sports events, matched to Polymarket markets via fuzzy text match |
| **Kalshi** | Kalshi's YES price on political/macro markets, aligned to Polymarket outcomes via Gemini LLM |
| **Structural** | Three on-chain signals (volume spike, price momentum, stale market) blended into a probability estimate when no external anchor exists |

When the model's probability diverges from the Polymarket price beyond a minimum edge threshold, it surfaces a trade signal. Kelly criterion sizing converts that edge into a suggested paper stake against a £1,000 bankroll. A closed-loop calibrator tracks resolved bets and adjusts per-signal reliability weights and the global Kelly multiplier over time.

### Signal pipeline

```
Polymarket markets
       │
       ├─ Path A: Odds API match ──► vig-removed bookmaker consensus
       ├─ Path B: Kalshi match ─────► Kalshi YES price (Gemini-confirmed)
       └─ Path C: Structural ───────► volume spike + momentum + stale blender
                                            │
                                   calibration layer
                                   (per-signal reliability × Kelly multiplier)
                                            │
                                   Kelly criterion sizing
                                            │
                                   TradeSignals ranked by £-EV
```

Signals clear the bar only when:
- **Structural:** ≥4 pp edge, market price between 8–92%, at least one signal fires
- **Odds API / Kalshi:** ≥5 pp edge, high-confidence fuzzy match
- **All paths:** suggested stake ≥ £1

## Stack

- **Next.js 16 / React 19** — App Router, server route handlers for API proxying
- **TypeScript** — strict mode throughout
- **Tailwind CSS 4** — dark theme
- **TanStack Query** — market data fetching and caching
- **Zustand** — bankroll and position state
- **Recharts** — equity curve and performance charts
- **Supabase** — bankroll history persistence
- **Gemini / Groq** — LLM market matching (Kalshi ↔ Polymarket)

## Pages

| Route | Purpose |
|-------|---------|
| `/dashboard` | Live markets grid + ranked trade signals |
| `/market/[slug]` | Market detail with price history and signal breakdown |
| `/portfolio` | Open and closed paper positions |
| `/performance` | P&L chart, win rate, ROI, calibration stats |
| `/manifold` | Manifold Markets signal feed |

## Project structure

```
app/
  api/
    markets/        # Proxy → Polymarket Gamma API
    odds/           # Proxy → The Odds API (sports + events)
    manifold/       # Proxy → Manifold Markets API
    resolve/        # Settles open positions against resolved markets
    cron/
      auto-bet/     # Cron: auto-place paper bets on top signals
      manifold-bet/ # Cron: Manifold-sourced auto-bets
      resolve/      # Cron: settle resolved markets
lib/
  signals.ts        # Signal engine — markets → ranked TradeSignals
  probability.ts    # Structural 3-signal blender
  kelly.ts          # Kelly criterion sizing + EV
  calibration.ts    # Per-signal reliability tracking
  learning.ts       # Closed-loop model update from resolved bets
  marketMatcher.ts  # Fuzzy text match: Polymarket ↔ Odds API / Kalshi
  supabase.ts       # Supabase client
  supabaseSync.ts   # Bankroll sync helpers
  sources/          # Kalshi, Deribit, Manifold API clients
  llm/              # Gemini + Groq clients (market matching)
  backtest/         # Offline backtesting harness
scripts/
  backtest.ts           # Polymarket structural signal backtest
  backtest-crypto.ts    # Deribit crypto backtest (no edge found)
  kalshi-scan.ts        # Find Kalshi ↔ Polymarket pairs
  manifold-scan.ts      # Scan Manifold for matching markets
  bet-loop.ts           # Headless auto-bet loop
```

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Environment variables** — create `.env.local`:

   ```env
   # The Odds API
   ODDS_API_KEY=

   # Kalshi
   KALSHI_API_KEY=

   # Supabase
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=

   # LLM (for Kalshi market matching)
   GEMINI_API_KEY=
   GROQ_API_KEY=
   ```

3. **Run the dev server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) — redirects to `/dashboard`.

## Backtesting

```bash
npx ts-node scripts/backtest.ts        # Structural signals on Polymarket history
npx ts-node scripts/backtest-crypto.ts # Deribit crypto (no edge found — see roadmap)
npx ts-node scripts/kalshi-scan.ts     # Find confirmed Kalshi ↔ Polymarket pairs
```

## Disclaimer

This project is for educational and research purposes only. Nothing here constitutes financial, investment, or trading advice. Real prediction-market trading involves real risk.
