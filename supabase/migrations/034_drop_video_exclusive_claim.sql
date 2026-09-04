-- =====================================================
-- Videos no longer own the GPU: the reason they had to is gone.
--
-- WHY THIS REVERSES 033. That migration's whole premise was that video is
-- recorded in REALTIME — captureStream(fps) sampling the canvas on a wall-clock
-- schedule, with the render loop throttled on performance.now(). Under that
-- design a competing job was genuinely destructive: a frame missing its 16.7 ms
-- slot meant requestAnimationFrame fired late, `targetFrame` jumped, and the
-- encoder sampled a canvas nobody had redrawn. The frames were never drawn, so
-- no encoder setting could recover them, and the only defence was to keep the
-- card quiet.
--
-- The GPU worker no longer records that way. It renders frame N, waits for that
-- frame to be written to disk, and only then renders N+1
-- (_runDeterministicRecording in extractor-scene-manager.ts), then muxes with
-- ffmpeg afterwards. Time is an INDEX, not a clock. Contention for the card now
-- costs only WALL-CLOCK TIME: a slow frame makes the job take longer and changes
-- nothing about the output. Every frame still lands, in order, at full quality.
--
-- So the isolation now buys nothing and costs throughput: five queued videos
-- serialised behind one another instead of running on five pods, which is what
-- the endpoint's Max Workers was raised for. Measured: one 20s video is ~7.4
-- minutes of real rendering, so serialising five is ~37 minutes against ~8.
--
-- WHAT THIS DOES NOT CHANGE. The browser callers (video studio, bulk video tab,
-- Shopify deploy, auto-deploy pipeline) still use the realtime MediaRecorder
-- path. They are unaffected either way: these functions gate the GPU worker's
-- queue, not an operator's own browser, and one browser tab was never competing
-- with a pod for the same card.
--
-- The signatures are kept EXACTLY as 033 left them, including
-- p_exclusive_scope and p_defer_if_busy. Callers keep working untouched, and
-- reverting is re-running 033 rather than editing application code. The
-- parameters are now accepted and deliberately ignored; gpu_busy_count is kept
-- (it is still the honest answer to "what is running") so 033 can be replayed.
-- =====================================================

-- Drain claim: same signature, no isolation.
CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job(
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900,
  p_kind            TEXT DEFAULT NULL,
  -- Accepted for signature compatibility with 033; no longer consulted.
  p_exclusive_scope TEXT DEFAULT 'worker'
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
  -- Unchanged from 033, and still required: a crashed pod's row says 'running'
  -- until its lease expires.
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
   ORDER BY
     -- Images still ahead of videos. Not isolation — just latency: an image is
     -- seconds and a video is minutes, so draining images first gets the most
     -- outputs in front of the operator soonest. Videos are no longer WAITING
     -- for anything, they are merely later in line when both kinds are queued.
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
-- Targeted claim: same signature, and it now never defers.
--
-- Deferral was the mechanism behind the "Đang chờ GPU" wait an operator sees on
-- a queued video. With no isolation left there is nothing to wait FOR, so a pod
-- woken for a specific job simply takes it.
-- =====================================================
CREATE OR REPLACE FUNCTION shopify_customizer.claim_render_job_by_id(
  p_job_id          UUID,
  p_worker_provider TEXT,
  p_worker_job_id   TEXT,
  p_lease_seconds   INT DEFAULT 900,
  -- Both accepted for signature compatibility with 033; no longer consulted.
  p_exclusive_scope TEXT DEFAULT 'worker',
  p_defer_if_busy   BOOLEAN DEFAULT TRUE
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
     AND status = 'queued'
     FOR UPDATE SKIP LOCKED
   LIMIT 1;

  -- Already claimed by a retry, canceled, or finished.
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
