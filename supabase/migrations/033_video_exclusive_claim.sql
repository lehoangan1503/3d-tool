-- =====================================================
-- Video jobs get the GPU to themselves.
--
-- WHY. A video is recorded in REALTIME: captureStream(fps) samples the canvas on
-- a wall-clock schedule, and the render loop throttles itself on
-- performance.now() (extractor-scene-manager.ts, `const animate`). When another
-- job competes for the card, a frame misses its 16.7 ms slot, requestAnimationFrame
-- fires late, `targetFrame` jumps, and the encoder samples a canvas that has not
-- been redrawn — dropped/duplicated frames, i.e. visible stutter. No encoder
-- setting fixes that; the frames were never drawn on time. Image rendering has no
-- such constraint: it is an offline loop that simply takes as long as it takes.
--
-- POLICY, enforced in the claim functions because that is the one chokepoint every
-- pod passes through (so it is race-free under FOR UPDATE SKIP LOCKED):
--
--   1. A video job does not start while ANY other job is running. It waits for a
--      quiet GPU instead of starting into contention.
--   2. While a video job is running, no OTHER job may start — image jobs wait.
--   3. Several video jobs may still run CONCURRENTLY, because each pod is its own
--      container on its own GPU. Rule 1 is per-pod isolation, not a global lock:
--      p_exclusive_scope = 'worker' (default) checks only this pod's own jobs.
--      Set it to 'global' for a single-GPU endpoint where all pods share one card.
--
-- Net effect: images drain in parallel as before, then videos run on a clean GPU —
-- one per pod, in parallel across pods. Exactly the "queue video at the end" shape,
-- without a scheduler process.
-- =====================================================

-- Which jobs count as "busy" for the isolation check.
-- Only jobs with a live lease: a crashed pod's row still says 'running' until its
-- lease expires, and treating that as busy would deadlock the queue.
CREATE OR REPLACE FUNCTION shopify_customizer.gpu_busy_count(
  p_scope         TEXT DEFAULT 'worker',
  p_worker_job_id TEXT DEFAULT NULL,
  p_kind          TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
  SELECT COUNT(*)::INT
    FROM shopify_customizer.render_jobs
   WHERE status = 'running'
     AND (lease_until IS NULL OR lease_until > NOW())
     AND (p_kind IS NULL OR kind = p_kind)
     -- 'worker' scope: this pod's own jobs only (one container, one GPU).
     -- 'global' scope: every pod, for an endpoint whose pods share one card.
     AND (p_scope = 'global' OR worker_job_id IS NOT DISTINCT FROM p_worker_job_id);
$$;

REVOKE ALL ON FUNCTION shopify_customizer.gpu_busy_count(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.gpu_busy_count(TEXT, TEXT, TEXT) TO service_role;

-- =====================================================
-- Drain claim, now scheduling-aware.
--
-- Signature gains p_exclusive_scope; the previous 4-arg form is dropped so a stale
-- call cannot silently bypass the new rules (PostgREST would happily resolve the
-- old overload and skip the isolation check).
-- =====================================================
DROP FUNCTION IF EXISTS shopify_customizer.claim_render_job(TEXT, TEXT, INT, TEXT);

CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job(
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900,
  p_kind            TEXT DEFAULT NULL,
  p_exclusive_scope TEXT DEFAULT 'worker'
)
RETURNS shopify_customizer.render_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
DECLARE
  v_job          shopify_customizer.render_jobs;
  v_busy         INT;
  v_video_busy   INT;
BEGIN
  -- Reclaim jobs whose worker died mid-render before looking at fresh ones.
  UPDATE shopify_customizer.render_jobs
     SET status = 'queued', claimed_at = NULL, lease_until = NULL
   WHERE status = 'running'
     AND lease_until IS NOT NULL
     AND lease_until < NOW()
     AND attempts < 3;

  v_busy       := shopify_customizer.gpu_busy_count(p_exclusive_scope, p_worker_job_id, NULL);
  v_video_busy := shopify_customizer.gpu_busy_count(p_exclusive_scope, p_worker_job_id, 'video');

  -- Rule 2: a running video owns the GPU. Nothing else starts beside it.
  IF v_video_busy > 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_job
    FROM shopify_customizer.render_jobs
   WHERE status = 'queued'
     AND (p_kind IS NULL OR kind = p_kind)
     -- Rule 1: video only onto a quiet GPU. Images are still free to drain
     -- alongside each other, so throughput for image batches is unchanged.
     AND (kind <> 'video' OR v_busy = 0)
   ORDER BY
     -- Images first, videos last: a video that has to wait for a quiet GPU
     -- should not block images that could be draining meanwhile. Within a kind,
     -- oldest first as before.
     (kind = 'video'),
     created_at
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

REVOKE ALL ON FUNCTION shopify_customizer.claim_render_job(TEXT, TEXT, INT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.claim_render_job(TEXT, TEXT, INT, TEXT, TEXT) TO service_role;

-- =====================================================
-- Targeted claim: same isolation, but it may only DEFER, never re-target.
--
-- The pod was woken for this specific job, so if the GPU is busy the answer is
-- "not yet" (NULL) and the dispatcher's next poke retries. Falling through to the
-- drain claim here would defeat the point: the pod would pick up an image job and
-- the video would keep waiting.
--
-- p_defer_if_busy is a parameter rather than unconditional so a single-job pod
-- (WORKER_MODE=job, local testing) can opt out and just run.
-- =====================================================
DROP FUNCTION IF EXISTS shopify_customizer.claim_render_job_by_id(UUID, TEXT, TEXT, INT);

CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job_by_id(
  p_job_id          UUID,
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900,
  p_exclusive_scope TEXT DEFAULT 'worker',
  p_defer_if_busy   BOOLEAN DEFAULT TRUE
)
RETURNS shopify_customizer.render_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
DECLARE
  v_job        shopify_customizer.render_jobs;
  v_kind       TEXT;
  v_busy       INT;
  v_video_busy INT;
BEGIN
  SELECT kind INTO v_kind
    FROM shopify_customizer.render_jobs
   WHERE id = p_job_id AND status = 'queued';

  IF v_kind IS NULL THEN
    RETURN NULL;  -- already claimed, canceled, or finished
  END IF;

  IF p_defer_if_busy THEN
    v_busy       := shopify_customizer.gpu_busy_count(p_exclusive_scope, p_worker_job_id, NULL);
    v_video_busy := shopify_customizer.gpu_busy_count(p_exclusive_scope, p_worker_job_id, 'video');

    -- Rule 2: nothing starts beside a running video.
    -- Rule 1: a video starts only on a quiet GPU.
    IF v_video_busy > 0 OR (v_kind = 'video' AND v_busy > 0) THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT * INTO v_job
    FROM shopify_customizer.render_jobs
   WHERE id = p_job_id
     AND status = 'queued'
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

REVOKE ALL ON FUNCTION shopify_customizer.claim_render_job_by_id(UUID, TEXT, TEXT, INT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.claim_render_job_by_id(UUID, TEXT, TEXT, INT, TEXT, BOOLEAN) TO service_role;

-- Ordering images-before-videos on every drain claim wants an index that already
-- carries that shape, so the planner does not sort the whole queued set.
CREATE INDEX IF NOT EXISTS render_jobs_queue_order_idx
  ON shopify_customizer.render_jobs ((kind = 'video'), created_at)
  WHERE status = 'queued';
