-- =====================================================
-- Migration 005: Retire cloud data storage (Phase 3)
-- Memories, events and audio now live only in the browser's encrypted vault.
-- Run manually in the SQL Editor after every user has moved their data and the
-- `user-files` bucket was emptied and deleted in the dashboard (Supabase blocks
-- deleting storage objects from SQL). Applied 2026-10-13.
-- The only remaining server piece is the stateless `ai-proxy` Edge Function.
-- =====================================================

DROP POLICY IF EXISTS "Allow public read-write on user-files" ON storage.objects;

DROP FUNCTION IF EXISTS match_memory_chunks, match_knowledge_chunks, match_memories;
DROP TABLE IF EXISTS memory_chunks, life_events, insights_cache,
                     knowledge_chunks, knowledge_bases, memories CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP EXTENSION IF EXISTS vector;
