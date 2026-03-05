-- =====================================================
-- CUE CUSTOMIZER - SUPABASE SCHEMA MIGRATION
-- Schema: shopify_customizer
-- =====================================================

-- Create schema if not exists
CREATE SCHEMA IF NOT EXISTS shopify_customizer;

-- Set search path
SET search_path TO shopify_customizer, public;

-- =====================================================
-- PRODUCTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('smooth', 'leather')),
  surface_url TEXT,
  texture_type VARCHAR(50),
  texture_url TEXT,
  color VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_products_user_id ON shopify_customizer.products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON shopify_customizer.products(updated_at DESC);

-- =====================================================
-- THREEJS SETTINGS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS shopify_customizer.threejs_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  settings JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default settings
INSERT INTO shopify_customizer.threejs_settings (name, settings) VALUES
('default', '{
  "camera": {"fov": 50, "position": [0, 1.8, 4], "near": 0.1, "far": 1000},
  "controls": {"enableDamping": true, "dampingFactor": 0.05, "minDistance": 0.5, "maxDistance": 10},
  "lighting": {"ambient": 0.55, "hemisphere": 0.4},
  "background": {"dark": "#2a2a2a", "light": "#f2f4f8"}
}'::jsonb),
('leather', '{
  "normalStrength": 3.0,
  "roughness": 245,
  "clearcoat": 5,
  "sheen": 80,
  "colorPalette": ["black", "chestnut", "chocolate", "darkBrown", "whiskey", "tan"],
  "textureTypes": ["crocodile", "snake"]
}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS
ALTER TABLE shopify_customizer.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_customizer.threejs_settings ENABLE ROW LEVEL SECURITY;

-- Products policies: Users can only access their own products
CREATE POLICY "Users can view own products" ON shopify_customizer.products
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own products" ON shopify_customizer.products
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own products" ON shopify_customizer.products
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own products" ON shopify_customizer.products
  FOR DELETE USING (auth.uid() = user_id);

-- Settings policies: All authenticated users can read settings
CREATE POLICY "Authenticated users can read settings" ON shopify_customizer.threejs_settings
  FOR SELECT TO authenticated USING (true);

-- =====================================================
-- STORAGE BUCKET (run this in Supabase dashboard or via API)
-- =====================================================
-- Note: Storage bucket creation requires Supabase admin access
-- Run this SQL in Supabase SQL Editor:
/*
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-assets', 'product-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'product-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'product-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'product-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Public read access"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-assets');
*/

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION shopify_customizer.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for products
DROP TRIGGER IF EXISTS trigger_products_updated_at ON shopify_customizer.products;
CREATE TRIGGER trigger_products_updated_at
  BEFORE UPDATE ON shopify_customizer.products
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();

-- Trigger for settings
DROP TRIGGER IF EXISTS trigger_settings_updated_at ON shopify_customizer.threejs_settings;
CREATE TRIGGER trigger_settings_updated_at
  BEFORE UPDATE ON shopify_customizer.threejs_settings
  FOR EACH ROW
  EXECUTE FUNCTION shopify_customizer.update_updated_at();
