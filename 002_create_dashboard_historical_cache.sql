-- ============================================================
-- BPOS Dashboard Historical Cache
-- Caches BigQuery results for closed months (older than prior month)
-- to speed up Module 8 (Dashboard Analytics) initial load.
--
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor) once.
-- ============================================================

-- 1. Create the cache table
--    One row per (query_type, snapshot_month).
--    payload is the JSONB array of rows BigQuery returned for that month.
CREATE TABLE IF NOT EXISTS public.dashboard_historical_cache (
  query_type      TEXT        NOT NULL,
  snapshot_month  TEXT        NOT NULL,          -- 'YYYY-MM'
  payload         JSONB       NOT NULL,          -- rows for this (type, month)
  row_count       INTEGER     NOT NULL DEFAULT 0,
  cached_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cached_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (query_type, snapshot_month)
);

-- 2. Index for fast "all months for this type" lookups
CREATE INDEX IF NOT EXISTS idx_dashboard_cache_type_month
  ON public.dashboard_historical_cache (query_type, snapshot_month);

-- 3. Enable RLS (defense in depth — edge function uses service role, UI uses anon)
ALTER TABLE public.dashboard_historical_cache ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies

-- Allow any client with the project's anon/authenticated key to SELECT.
-- This matches the access model for bq-dashboard (public-anon reads with UI-level
-- property filtering in the dashboard). Writes are still restricted below.
DROP POLICY IF EXISTS "authenticated_read_cache" ON public.dashboard_historical_cache;
CREATE POLICY "public_read_cache"
  ON public.dashboard_historical_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Writes are restricted to superadmin only (extra safety beyond edge function check)
DROP POLICY IF EXISTS "superadmin_write_cache" ON public.dashboard_historical_cache;
CREATE POLICY "superadmin_write_cache"
  ON public.dashboard_historical_cache
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'superadmin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'superadmin'
    )
  );

-- 5. Helper view — shows cache status per query type (for the refresh UI)
CREATE OR REPLACE VIEW public.v_dashboard_cache_status AS
SELECT
  query_type,
  COUNT(*)                  AS months_cached,
  MIN(snapshot_month)       AS earliest_month,
  MAX(snapshot_month)       AS latest_month,
  SUM(row_count)            AS total_rows,
  MAX(cached_at)            AS last_refreshed
FROM public.dashboard_historical_cache
GROUP BY query_type
ORDER BY query_type;

GRANT SELECT ON public.v_dashboard_cache_status TO anon, authenticated;

-- 6. Comment the table so it's easy to find in Supabase Studio
COMMENT ON TABLE public.dashboard_historical_cache IS
  'Cache of BigQuery results for closed months (older than prior month). '
  'Speeds up Module 8 Dashboard Analytics initial load. '
  'Populated via bq-dashboard edge function action=cache_type. Superadmin-writable only.';
