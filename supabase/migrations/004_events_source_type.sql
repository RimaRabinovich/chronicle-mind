-- Migration 004: Add source_type to life_events
-- Allows tagging events as 'memory' | 'audio' | 'video' | 'manual'

ALTER TABLE life_events
  ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'memory';
