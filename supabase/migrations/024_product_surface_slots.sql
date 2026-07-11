-- Surface customization slots designed in the internal editor.
-- JSON shape (SurfaceSlotsConfig in src/types/product.ts):
--   { "version": 1, "slots": [ { "id", "type": "image"|"text",
--     "x", "y", "w", "h",  -- fractions of the surface image (x across the
--                          -- width/circumference, y along the cue length)
--     "label", "maxChars", "font", "color" } ] }
-- Deployed to Shopify as the custom.surface_slots JSON metafield; the
-- storefront customizer dialog lets customers fill (not move) these slots.
alter table products add column if not exists surface_slots jsonb;
