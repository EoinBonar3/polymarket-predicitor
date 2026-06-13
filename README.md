# Polymarket Predictor

A paper-trading simulator and signal dashboard for [Polymarket](https://polymarket.com)
prediction markets. Browse live binary markets, surface Kelly-sized trade signals,
place virtual bets against a £1,000 paper bankroll, and watch your equity curve
update as positions resolve in the real world.

> Educational tool only. Not financial advice. No real money is at risk —
> all trades are simulated in your browser.

## Screenshot

> _Drop a screenshot of the dashboard at `docs/screenshot.png` and it will
> render below._

![Polymarket Predictor dashboard](docs/screenshot.png)

## Tech stack

- **Next.js 16** — App Router, Server Components, Route Handlers
- **TypeScript** — strict mode end-to-end
- **Tailwind CSS** (v4) — utility-first styling, dark theme
- **TanStack Query** — caching, background refetching, request dedupe
- **Zustand** — paper-trading state with persisted bankroll
- **Recharts** — equity curve / performance visualisations
- **Polymarket Gamma API** — live market data (proxied through `/api/*`)

## Features

- **Live markets** — every active Polymarket binary market, refreshed every
  5 minutes, filterable by category and sortable by volume / liquidity /
  time-to-expiry.
- **Kelly Criterion signal engine** — ranks markets by expected value and
  suggests a per-bet stake against a £1,000 bankroll, capped at 25 % per
  trade.
- **Paper trading simulator** — place virtual YES/NO trades, override the
  Kelly-suggested size, and track open positions mark-to-market against
  live prices.
- **Equity-curve performance tracking** — Recharts area chart of your cash
  balance over time, plus win rate, total return, average stake, best win,
  and worst loss.
- **Auto-resolve** — a background poller closes any open position the
  moment its underlying Polymarket market settles to YES or NO, with a
  toast notification confirming the WIN/LOSS.
- **Persisted bankroll** — your positions and equity curve survive page
  reloads via `localStorage` (with a graceful in-memory fallback when
  storage is unavailable, e.g. inside sandboxed iframes).

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. The home page redirects to `/dashboard`.

### Scripts

- `npm run dev` — start the Next.js dev server (port 3000)
- `npm run build` — production build
- `npm run start` — run the production build
- `npm run lint` — ESLint

### Project layout

```
app/
  api/markets/route.ts   # proxy → Polymarket Gamma /events (active)
  api/resolve/route.ts   # proxy → Polymarket Gamma /events (closed + resolved)
  dashboard/page.tsx     # signals row + market grid
  portfolio/page.tsx     # bankroll summary + open positions + close UI
  performance/page.tsx   # equity curve + stats + closed-trade log
  layout.tsx             # root layout (server component)
  providers.tsx          # TanStack Query + auto-resolve + toaster
components/
  markets/               # market cards + filters
  signals/               # signal cards + paper-trade modal
hooks/
  useMarkets.ts          # TanStack Query wrapper for /api/markets
  useAutoResolve.ts      # background poller + toaster
lib/
  kelly.ts               # Kelly fraction, expected value, suggested stake
  signals.ts             # turns Market[] → ranked TradeSignal[]
  polymarket.ts          # browser-safe client for /api/*
  types.ts               # shared TypeScript types
  utils.ts               # formatting + time helpers
store/
  bankroll.ts            # Zustand store (persisted, with safe fallback)
```

## How it works

**The Kelly Criterion** is a position-sizing formula that maximises the
long-run growth rate of a bankroll given a known edge. For a binary bet at
market price _m_ where we estimate the true probability is _p_, Kelly says
to stake a fraction `f* = (p − m) / (1 − m)` of your bankroll — provided
`p > m`. Bigger edge ⇒ bigger bet, but never bigger than the cap (we hard-
limit to 25 %).

**The signal engine** scans every active market, computes our probability
estimate `ourP = price + shrink × (0.5 − price)` (a contrarian shrinkage
model — Phase 4 placeholder for a future news/odds-based model), picks
whichever side has a positive Kelly fraction, sizes it against a £1,000
bankroll, and ranks the resulting signals by expected value in £. The
top signals appear on the dashboard with a one-click "Paper Trade" button
that pre-fills the suggested stake.

**Auto-resolve** runs in the background while the app is open: every
60 seconds it polls `/api/resolve` for markets that have settled to YES
or NO, and if any of your open positions match it calls `closeBet()`
automatically and pops a toast in the corner so you don't have to babysit
the portfolio.

## Disclaimer

This project is for educational and research purposes only. The Kelly
sizing, signal engine, and paper-trading workflow are simplified
illustrations — none of it constitutes financial, investment, or trading
advice. Real prediction-market trading involves real risk; do your own
research before risking real capital.
