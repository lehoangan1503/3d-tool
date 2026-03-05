-- Add threejs_settings_id column to products table
-- This links each product to its own 3D viewer settings

ALTER TABLE shopify_customizer.products 
ADD COLUMN IF NOT EXISTS threejs_settings_id uuid NULL;

-- Add foreign key constraint
ALTER TABLE shopify_customizer.products
ADD CONSTRAINT products_threejs_settings_id_fkey 
FOREIGN KEY (threejs_settings_id) 
REFERENCES shopify_customizer.threejs_settings (id) 
ON DELETE SET NULL;

-- Create index for the foreign key
CREATE INDEX IF NOT EXISTS idx_products_threejs_settings_id 
ON shopify_customizer.products (threejs_settings_id);

-- Comment explaining the relationship
COMMENT ON COLUMN shopify_customizer.products.threejs_settings_id IS 
'Reference to threejs_settings record containing lighting and material config for this product';

-- =====================================================
-- ADD RLS POLICIES FOR threejs_settings INSERT/UPDATE
-- =====================================================

-- Allow authenticated users to create settings records
CREATE POLICY "Authenticated users can create settings" ON shopify_customizer.threejs_settings
  FOR INSERT TO authenticated WITH CHECK (true);

-- Allow authenticated users to update settings records
CREATE POLICY "Authenticated users can update settings" ON shopify_customizer.threejs_settings
  FOR UPDATE TO authenticated USING (true);

-- Allow authenticated users to delete settings records
CREATE POLICY "Authenticated users can delete settings" ON shopify_customizer.threejs_settings
  FOR DELETE TO authenticated USING (true);
