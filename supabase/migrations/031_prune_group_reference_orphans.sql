-- =====================================================
-- Keep extractor_reference_groups.reference_ids free of orphans.
--
-- The group membership is a uuid[] column, not a junction table, so a FOREIGN
-- KEY is not available: Postgres FKs constrain scalar columns only. Deleting a
-- reference therefore used to leave its id behind in every group that held it,
-- and nothing ever noticed — both readers drop the misses silently
-- (src/lib/render/build-payload.ts:167, shopify-deploy-dialog.tsx:706), so a
-- group advertised "22 ảnh" while only 14 could render.
--
-- A trigger gives the same guarantee an ON DELETE CASCADE FK would, without
-- rewriting the 11 call sites that read/write reference_ids:
-- the id is stripped from every group in the same transaction as the delete,
-- so an orphan cannot outlive its reference.
--
-- Deliberately silent. Pruning is bookkeeping, not an event an operator has to
-- acknowledge — the group's count simply stays truthful.
-- =====================================================

CREATE OR REPLACE FUNCTION shopify_customizer.prune_deleted_reference_from_groups()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = shopify_customizer, pg_catalog
AS $$
BEGIN
  -- array_remove strips every occurrence, so a group that somehow listed the
  -- same reference twice ends up clean too. The WHERE clause keeps this to the
  -- affected rows instead of rewriting every group on each delete.
  UPDATE shopify_customizer.extractor_reference_groups
     SET reference_ids = array_remove(reference_ids, OLD.id)
   WHERE reference_ids @> ARRAY[OLD.id];

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prune_reference_from_groups
  ON shopify_customizer.extractor_references;

CREATE TRIGGER trg_prune_reference_from_groups
  AFTER DELETE ON shopify_customizer.extractor_references
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.prune_deleted_reference_from_groups();

-- One-time cleanup of orphans created before the trigger existed. Idempotent:
-- on a database where the trigger has always been present this matches nothing.
-- (Applied to the live DB on 2026-09-04: 10 orphan ids across 2 groups —
--  "Mockup Web" 22 -> 14, "test group" 8 -> 6.)
UPDATE shopify_customizer.extractor_reference_groups g
   SET reference_ids = COALESCE(
         (SELECT array_agg(id ORDER BY ord)
            FROM unnest(g.reference_ids) WITH ORDINALITY AS t(id, ord)
           WHERE EXISTS (
             SELECT 1 FROM shopify_customizer.extractor_references r
              WHERE r.id = t.id
           )),
         '{}'::uuid[]
       )
 WHERE EXISTS (
   SELECT 1
     FROM unnest(g.reference_ids) AS t(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM shopify_customizer.extractor_references r WHERE r.id = t.id
    )
 );
