-- =====================================================
-- 020: Shopify deployment drafts (save before deploy)
-- =====================================================
-- Allow a shopify_deployments row to exist as a DRAFT — saved form_data with
-- no live Shopify product yet. The "Save" button in the deploy dialog writes
-- such a row so a not-yet-deployed product keeps its config across reopens; a
-- later Deploy fills in the Shopify link on the same row.
--
-- shopify_product_id was NOT NULL (016). A draft has no Shopify product, and
-- the DELETE handler already clears it to null, so make it nullable.
-- Idempotent: DROP NOT NULL is a no-op if the constraint is already gone.
-- =====================================================

ALTER TABLE shopify_customizer.shopify_deployments
  ALTER COLUMN shopify_product_id DROP NOT NULL;
