-- =====================================================
-- 030: Render results expire after 24h
-- =====================================================
-- A single 1920x1080 studio video is tens of MB, and a batch queues one job per
-- product. Left alone, Storage fills up with output nobody will look at again:
-- every file here is REGENERABLE (re-run the job and the same pixels come back,
-- because the payload is frozen), so keeping it forever buys nothing.
--
-- Two columns, both driven by the purge routine in src/lib/render/purge.ts:
--
--   expires_at  when the Storage files may be deleted. Set at COMPLETION, not
--               at enqueue: a job that sat in the queue for 20 hours must still
--               give its owner a full day to download, and the countdown the UI
--               shows has to mean "time left to download", not "time since I
--               clicked render".
--
--   purged_at   set once the files are gone. This is what separates "results
--               were deleted, render again" from "this job produced nothing" —
--               without it the UI would show broken images for old jobs, since
--               `outputs` is emptied at the same time.
--
-- The row itself is kept: it is a few hundred bytes and it is the only record
-- that the render happened at all.
-- =====================================================

SET search_path TO shopify_customizer, public;

ALTER TABLE shopify_customizer.render_jobs
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS purged_at  TIMESTAMPTZ;

COMMENT ON COLUMN shopify_customizer.render_jobs.expires_at IS
  'When this job''s Storage output may be deleted. Set to finished_at + TTL by the completion path; NULL while the job is still queued or running.';

COMMENT ON COLUMN shopify_customizer.render_jobs.purged_at IS
  'Set when the Storage files were deleted and `outputs` emptied. Distinguishes a purged job from one that never produced output.';

-- The purge query: due, not yet purged, and never a job still being written to.
-- Partial so it stays tiny — most rows are either fresh or already purged.
CREATE INDEX IF NOT EXISTS render_jobs_expiry_idx
  ON shopify_customizer.render_jobs (expires_at)
  WHERE purged_at IS NULL AND expires_at IS NOT NULL;

-- =====================================================
-- Backfill: rows that finished before this migration have no expires_at, so
-- nothing would ever collect them. Give them the same 24h from their own
-- finish time — anything already older than that becomes due immediately,
-- which is correct: it IS older than the retention window.
-- =====================================================
UPDATE shopify_customizer.render_jobs
   SET expires_at = finished_at + INTERVAL '24 hours'
 WHERE expires_at IS NULL
   AND purged_at IS NULL
   AND finished_at IS NOT NULL
   AND status IN ('succeeded', 'failed', 'canceled');

-- A job canceled or failed before it ever reached a worker has no finished_at;
-- fall back to created_at so those cannot linger either.
UPDATE shopify_customizer.render_jobs
   SET expires_at = created_at + INTERVAL '24 hours'
 WHERE expires_at IS NULL
   AND purged_at IS NULL
   AND finished_at IS NULL
   AND status IN ('failed', 'canceled');

-- =====================================================
-- Table grants missing from 029.
--
-- `shopify_customizer` is not the `public` schema, so nothing inherits the
-- default privileges PostgREST roles get there — every other migration in this
-- repo grants explicitly for exactly this reason (see 017/018: "custom schema
-- needs explicit table grants; service_role too"). 029 granted EXECUTE on the
-- two claim functions but never the table itself.
--
-- The gap was invisible until deployment because the claim functions are
-- SECURITY DEFINER: they run as the owner and worked fine, while every route
-- that reads the table DIRECTLY failed with "permission denied for table
-- render_jobs" — /queue-depth (500) and the purge sweep. Measured against the
-- live app, not inferred.
--
-- RLS still applies to anon/authenticated; these grants only make the table
-- reachable at all. service_role remains RLS-exempt, which is what the worker
-- routes rely on.
-- =====================================================
GRANT USAGE ON SCHEMA shopify_customizer TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE shopify_customizer.render_jobs
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
