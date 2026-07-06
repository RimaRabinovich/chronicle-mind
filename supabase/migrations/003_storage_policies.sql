-- =====================================================
-- Migration 003: Public access for storage bucket 'user-files'
-- Run in Supabase SQL Editor to resolve RLS upload policy errors
-- =====================================================

-- 1. Create the user-files bucket if not exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('user-files', 'user-files', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Drop existing policies on storage.objects for this bucket if any
DROP POLICY IF EXISTS "Allow public read-write on user-files" ON storage.objects;

-- 3. Create the policy allowing all users (including anonymous uploads from client)
-- to read, insert, update, and delete objects in 'user-files' bucket.
CREATE POLICY "Allow public read-write on user-files" ON storage.objects
  FOR ALL
  TO public
  USING (bucket_id = 'user-files')
  WITH CHECK (bucket_id = 'user-files');
