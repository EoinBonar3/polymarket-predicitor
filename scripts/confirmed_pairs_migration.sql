-- Run this once in the Supabase SQL editor:
-- https://supabase.com/dashboard/project/ugatjlwdbevdkgcyvycr/sql

CREATE TABLE IF NOT EXISTS confirmed_pairs (
  polymarket_slug  text NOT NULL,
  kalshi_ticker    text NOT NULL,
  yes_aligned      boolean NOT NULL DEFAULT true,
  llm_confidence   double precision NOT NULL DEFAULT 0,
  -- first_seen_at never changes; last_seen_at updates on each scan that re-confirms the pair.
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (polymarket_slug, kalshi_ticker)
);

-- Index for the cached-only scan's slug lookup.
CREATE INDEX IF NOT EXISTS confirmed_pairs_slug_idx ON confirmed_pairs (polymarket_slug);
