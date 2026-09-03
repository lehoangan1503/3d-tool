-- =====================================================
-- 029: Server-side render jobs (images + videos on rented GPU)
-- =====================================================
-- Rendering used to happen ONLY in the user's browser: the deploy dialog built
-- an ExtractorSceneManager, looped the picked image group, and each mockup cost
-- the operator's own machine 10-30s of WebGL. Picking several products was
-- impossible — the tab would freeze or run out of GPU memory.
--
-- This table is the handoff. The web app (a plain VPS, no GPU) only WRITES a
-- job here and returns its id; the actual pixels are produced by a headless
-- Chrome running on a rented GPU (RunPod Serverless / Beam / Modal), which
-- claims the job, renders, uploads to Storage, and writes the URLs back.
--
-- One job = one (product x group-or-template) render request. Selecting 3
-- products and one image group creates 3 jobs, so they can run on 3 GPU
-- workers in parallel and each product's progress is visible on its own.
--
-- Lifecycle:
--   queued -> running -> succeeded
--                     -> failed     (error_message set)
--          -> canceled              (user gave up before a worker claimed it)
-- =====================================================

SET search_path TO shopify_customizer, public;

CREATE TABLE IF NOT EXISTS shopify_customizer.render_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who asked. Kept even after the product is deleted so a user can still see
  -- their own history, hence ON DELETE SET NULL on the product instead of the
  -- job vanishing.
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES shopify_customizer.products(id) ON DELETE SET NULL,

  -- 'image' renders every reference in group_id; 'video' renders template_id.
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video')),

  -- Plain UUIDs, no FK: extractor_reference_groups and video_studio_templates
  -- have no migration in this repo (live-DB only), so a FK would not resolve
  -- on a fresh database. Same reasoning as 028's image_group_id.
  group_id     UUID,
  template_id  UUID,

  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),

  -- Progress so the dashboard can show "3/6 ảnh" while the GPU works.
  progress_done  INT NOT NULL DEFAULT 0,
  progress_total INT NOT NULL DEFAULT 0,
  progress_label TEXT,

  -- The frozen input the worker renders from. Written by the API at enqueue
  -- time (resolved references, product model/surface URLs, canvas sizes) so a
  -- worker never needs the caller's session, and so re-running an old job
  -- reproduces the same pixels even if the group was edited since.
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- [{ name, url, width, height, bytes }] — public Storage URLs, in gallery order.
  outputs      JSONB NOT NULL DEFAULT '[]'::jsonb,

  error_message TEXT,

  -- Which GPU backend ran it + that provider's own job id, for cost tracing
  -- and for cancelling a run that is already on the GPU.
  worker_provider TEXT,
  worker_job_id   TEXT,

  -- Guards against a crashed worker holding a job in 'running' forever: a
  -- sweeper (or the next enqueue) can requeue rows whose lease has expired.
  claimed_at   TIMESTAMPTZ,
  lease_until  TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

-- The dashboard's "my recent renders" list and the poll endpoint.
CREATE INDEX IF NOT EXISTS render_jobs_user_created_idx
  ON shopify_customizer.render_jobs (user_id, created_at DESC);

-- The worker's claim query: oldest queued job first.
CREATE INDEX IF NOT EXISTS render_jobs_queued_idx
  ON shopify_customizer.render_jobs (status, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS render_jobs_product_idx
  ON shopify_customizer.render_jobs (product_id, created_at DESC);

-- =====================================================
-- RLS — users see their own jobs; admins see everything.
-- Workers never come through RLS: they use the service key.
-- =====================================================
ALTER TABLE shopify_customizer.render_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "render_jobs_select_own" ON shopify_customizer.render_jobs;
CREATE POLICY "render_jobs_select_own"
  ON shopify_customizer.render_jobs FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM shopify_customizer.user_profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "render_jobs_insert_own" ON shopify_customizer.render_jobs;
CREATE POLICY "render_jobs_insert_own"
  ON shopify_customizer.render_jobs FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users may only cancel; every other transition belongs to the worker (service
-- key, RLS-exempt). The status check is intentionally narrow.
DROP POLICY IF EXISTS "render_jobs_update_own" ON shopify_customizer.render_jobs;
CREATE POLICY "render_jobs_update_own"
  ON shopify_customizer.render_jobs FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "render_jobs_delete_own" ON shopify_customizer.render_jobs;
CREATE POLICY "render_jobs_delete_own"
  ON shopify_customizer.render_jobs FOR DELETE
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM shopify_customizer.user_profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

-- =====================================================
-- Atomic claim — two GPU workers polling at once must not take the same job.
-- FOR UPDATE SKIP LOCKED makes the claim race-free without a queue server.
-- =====================================================
CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job(
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900,
  p_kind            TEXT DEFAULT NULL
)
RETURNS shopify_customizer.render_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
DECLARE
  v_job shopify_customizer.render_jobs;
BEGIN
  -- Reclaim jobs whose worker died mid-render before looking at fresh ones.
  UPDATE shopify_customizer.render_jobs
     SET status = 'queued', claimed_at = NULL, lease_until = NULL
   WHERE status = 'running'
     AND lease_until IS NOT NULL
     AND lease_until < NOW()
     AND attempts < 3;

  SELECT * INTO v_job
    FROM shopify_customizer.render_jobs
   WHERE status = 'queued'
     AND (p_kind IS NULL OR kind = p_kind)
   ORDER BY created_at
     FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE shopify_customizer.render_jobs
     SET status          = 'running',
         attempts        = attempts + 1,
         claimed_at      = NOW(),
         started_at      = COALESCE(started_at, NOW()),
         lease_until     = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
         worker_provider = p_worker_provider,
         worker_job_id   = p_worker_job_id
   WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION shopify_customizer.claim_render_job(TEXT, TEXT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.claim_render_job(TEXT, TEXT, INT, TEXT) TO service_role;

-- =====================================================
-- Claim ONE specific job. The dispatcher wakes a pod per job, so the pod must
-- take the job it was woken for rather than whatever is oldest — otherwise two
-- pods can swap jobs and one job is left with no pod at all.
--
-- Returns NULL when the job is already claimed, canceled, or finished; the pod
-- then falls back to the oldest-queued claim above.
-- =====================================================
CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job_by_id(
  p_job_id          UUID,
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900
)
RETURNS shopify_customizer.render_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
DECLARE
  v_job shopify_customizer.render_jobs;
BEGIN
  SELECT * INTO v_job
    FROM shopify_customizer.render_jobs
   WHERE id = p_job_id
     -- A 'running' row whose lease expired is a dead pod's job: retakeable.
     AND (
       status = 'queued'
       OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < NOW())
     )
     FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE shopify_customizer.render_jobs
     SET status          = 'running',
         attempts        = attempts + 1,
         claimed_at      = NOW(),
         started_at      = COALESCE(started_at, NOW()),
         lease_until     = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
         worker_provider = p_worker_provider,
         worker_job_id   = p_worker_job_id
   WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION shopify_customizer.claim_render_job_by_id(UUID, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.claim_render_job_by_id(UUID, TEXT, TEXT, INT) TO service_role;

NOTIFY pgrst, 'reload schema';
