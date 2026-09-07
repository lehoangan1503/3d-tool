-- =====================================================
-- 038: where a render job came from
-- =====================================================
-- Renders now arrive from two places that look identical in this table: a
-- person clicking Render in the dashboard, and an AI agent calling
-- POST /api/v1/renders with a bearer token.
--
-- They belong to the same queue and the same worker — that is the point of the
-- design, and nothing here changes it. What differs is who is watching. The
-- operator who queued a batch by hand wants their own queue, not a list mixed
-- with whatever an automation started overnight; and when checking that an
-- agent is behaving, they want exactly the opposite. One column lets the UI
-- answer both without a second table.
--
-- Deliberately NOT derived from the token: a token id would say WHICH
-- credential, but the question the screen asks is "was a human involved", and
-- api_tokens rows get deleted while their jobs stay.
-- =====================================================

SET search_path TO shopify_customizer, public;

ALTER TABLE shopify_customizer.render_jobs
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dashboard'
    CHECK (source IN ('dashboard', 'api'));

COMMENT ON COLUMN shopify_customizer.render_jobs.source IS
  'dashboard = queued by a signed-in person; api = queued through /api/v1/renders '
  'with an API token (see migration 038).';

-- Every existing row predates the token API, so the 'dashboard' default is
-- already correct for them — no backfill needed.

-- The tab filters on (user_id, source) and orders by created_at, which is the
-- same shape as the existing user index; this one keeps the API tab from
-- scanning a busy operator's dashboard jobs.
CREATE INDEX IF NOT EXISTS idx_render_jobs_user_source_created
  ON shopify_customizer.render_jobs (user_id, source, created_at DESC);

NOTIFY pgrst, 'reload schema';
