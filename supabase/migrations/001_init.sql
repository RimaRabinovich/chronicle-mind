-- =====================================================
-- Chronicle Mind — Supabase Database Schema
-- Migration 001: Initial Setup
-- Run in Supabase SQL Editor
-- =====================================================

-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Memories ──────────────────────────────────────────
-- Core table: every piece of user data lives here.
-- "type" determines what it is; "source" where it came from.
CREATE TABLE IF NOT EXISTS memories (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL,                         -- Firebase UID
  type          text         NOT NULL DEFAULT 'text',          -- 'text' | 'audio' | 'video' | 'file'
  source        text         NOT NULL DEFAULT 'manual',        -- 'manual' | 'upload' | 'google_drive' | 'google_photos'
  content       text         NOT NULL DEFAULT '',              -- raw text or transcript
  summary       text,
  file_url      text,                                          -- Supabase Storage public URL
  file_name     text,
  file_type     text,                                          -- mime type
  duration_sec  int,                                           -- audio/video duration
  embedding     vector(768),                                   -- semantic embedding (768-dim nomic/MiniLM)
  metadata      jsonb        NOT NULL DEFAULT '{}',            -- flexible extras
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_user_id_idx     ON memories (user_id);
CREATE INDEX IF NOT EXISTS memories_created_at_idx  ON memories (created_at DESC);
CREATE INDEX IF NOT EXISTS memories_type_idx        ON memories (type);
CREATE INDEX IF NOT EXISTS memories_embedding_idx   ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);                                          -- tune lists = sqrt(row count)

-- ── Life Events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS life_events (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL,
  memory_id     uuid         REFERENCES memories(id) ON DELETE CASCADE,
  date          date,
  title         text         NOT NULL,
  description   text,
  memory_snippet text,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS life_events_user_id_idx  ON life_events (user_id);
CREATE INDEX IF NOT EXISTS life_events_date_idx     ON life_events (date ASC NULLS LAST);
CREATE INDEX IF NOT EXISTS life_events_memory_idx   ON life_events (memory_id);

-- ── Memory Chunks ─────────────────────────────────────
-- Long memories are split into smaller chunks for precise RAG retrieval.
-- Short memories (< 500 chars) are stored as a single chunk.
CREATE TABLE IF NOT EXISTS memory_chunks (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     uuid         NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id       text         NOT NULL,
  chunk_index   int          NOT NULL DEFAULT 0,
  content       text         NOT NULL,
  embedding     vector(768),
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_user_id_idx    ON memory_chunks (user_id);
CREATE INDEX IF NOT EXISTS chunks_memory_id_idx  ON memory_chunks (memory_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx  ON memory_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Knowledge Bases ───────────────────────────────────
-- Shared knowledge indexes (Buddhism, mentors, etc.)
-- These are not user-specific — they are pre-loaded by admin.
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text         UNIQUE NOT NULL,                  -- 'buddhism' | 'bob_proctor' | 'louise_hay'
  name          text         NOT NULL,
  description   text,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id         uuid         NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_title  text,
  source_url    text,
  content       text         NOT NULL,
  embedding     vector(768),
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kchunks_kb_id_idx      ON knowledge_chunks (kb_id);
CREATE INDEX IF NOT EXISTS kchunks_embedding_idx  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Insights Cache ────────────────────────────────────
-- Pre-computed insight reports per user (topics, patterns, etc.)
-- Regenerated periodically by Edge Functions.
CREATE TABLE IF NOT EXISTS insights_cache (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL UNIQUE,
  top_topics    jsonb,                                          -- [{ topic, count, last_mentioned }]
  life_themes   jsonb,                                         -- [{ theme, description }]
  computed_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS insights_user_idx ON insights_cache (user_id);

-- ── updated_at trigger ────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
