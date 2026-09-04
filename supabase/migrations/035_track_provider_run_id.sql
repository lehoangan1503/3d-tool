-- =====================================================
-- Keep the provider's RUN id, separately from the pod that claimed the job.
--
-- THE BUG. Cancelling a running job could not reach RunPod, because the id it
-- had to address the run with was no longer there:
--
--   1. Dispatch POSTs /v2/{endpointId}/run, which returns a RUN id shaped like
--      "c60213bb-bd63-40d9-9fa2-79a09e709b33-e1", and enqueue.ts stores it in
--      worker_job_id. Correct so far — that is what /cancel/{id} wants.
--   2. The pod boots, opens the render page, and the page claims the job passing
--      its own WORKER id ("637k2usmz2cmp6", from RUNPOD_POD_ID).
--   3. claim_render_job writes that into the same worker_job_id column.
--
-- Step 3 overwrites step 1, so by the time anyone can cancel, the run id is
-- gone and only the pod id remains. POST /cancel/{pod id} answers 404 "job not
-- found" — which is why cancelling in the app left RunPod requests running until
-- they were cancelled by hand.
--
-- Both ids are worth keeping and neither can replace the other: the run id
-- addresses the provider's queue entry (and exists before any pod does), while
-- the worker id says which container did the work, which is what makes a GPU
-- bill traceable. So the run id gets its own column and nothing overwrites it.
-- =====================================================

ALTER TABLE shopify_customizer.render_jobs
  ADD COLUMN IF NOT EXISTS provider_run_id TEXT;

COMMENT ON COLUMN shopify_customizer.render_jobs.provider_run_id IS
  'The GPU provider''s own run id, as returned by dispatch (RunPod /run). Used to '
  'cancel a run that has not started yet — a pod waiting for GPU capacity runs '
  'none of our code, so the canceled status alone can never reach it. Distinct '
  'from worker_job_id, which the claiming pod overwrites with its own id.';

-- Cancellation looks a job up by id, so no index is needed for that. This one
-- serves the reverse direction: finding the job a provider webhook or a stray
-- run belongs to.
CREATE INDEX IF NOT EXISTS render_jobs_provider_run_id_idx
  ON shopify_customizer.render_jobs (provider_run_id)
  WHERE provider_run_id IS NOT NULL;
