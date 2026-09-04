-- =====================================================
-- Atomic append of one finished file to render_jobs.outputs.
--
-- The upload route did this as a read-modify-write: SELECT outputs, filter, then
-- UPDATE with the whole new array. A video job uploads exactly one file so it
-- can never race itself, but an image job appends once per reference — and any
-- two appends that interleave lose whichever wrote first.
--
-- Doing it in one statement inside the function makes the row lock cover the
-- read and the write, so N concurrent uploads all survive.
--
-- Dedup on storage_path is kept from the original: a retried upload of the same
-- reference replaces its entry instead of doubling it.
-- =====================================================
CREATE OR REPLACE FUNCTION shopify_customizer.append_render_output(
  p_job_id UUID,
  p_output JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, public
AS $$
DECLARE
  v_outputs JSONB;
BEGIN
  -- FOR UPDATE so a second uploader waits here rather than reading the array
  -- this call is about to replace.
  PERFORM 1
     FROM shopify_customizer.render_jobs
    WHERE id = p_job_id
      FOR UPDATE;

  UPDATE shopify_customizer.render_jobs
     SET outputs = (
           SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) || jsonb_build_array(p_output)
             FROM jsonb_array_elements(COALESCE(outputs, '[]'::jsonb)) AS elem
            WHERE elem->>'storagePath' IS DISTINCT FROM p_output->>'storagePath'
         )
   WHERE id = p_job_id
  RETURNING outputs INTO v_outputs;

  RETURN COALESCE(v_outputs, '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION shopify_customizer.append_render_output(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shopify_customizer.append_render_output(UUID, JSONB) TO service_role;
