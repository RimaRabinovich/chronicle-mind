-- =====================================================
-- CHRONICLE MIND — COMPLETE DATABASE RESET & POLICIES
-- Run this in the Supabase SQL Editor (https://supabase.com)
-- This will recreate all tables with 384-dim vectors (gte-small)
-- and add public storage read/write policies.
-- =====================================================

-- ── 1. Drop existing functions and tables to prevent conflicts ──
DROP FUNCTION IF EXISTS match_memory_chunks(vector, text, int);
DROP FUNCTION IF EXISTS match_knowledge_chunks(vector, uuid[], int);
DROP FUNCTION IF EXISTS match_memories(vector, text, int, float);
DROP TABLE IF EXISTS memory_chunks CASCADE;
DROP TABLE IF EXISTS life_events CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS knowledge_chunks CASCADE;
DROP TABLE IF EXISTS knowledge_bases CASCADE;
DROP TABLE IF EXISTS insights_cache CASCADE;

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 2. Create memories table (384 dimensions) ──
CREATE TABLE memories (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL,
  type          text         NOT NULL DEFAULT 'text',
  source        text         NOT NULL DEFAULT 'manual',
  content       text         NOT NULL DEFAULT '',
  summary       text,
  file_url      text,
  file_name     text,
  file_type     text,
  duration_sec  int,
  embedding     vector(384),
  metadata      jsonb        NOT NULL DEFAULT '{}',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX memories_user_id_idx ON memories (user_id);
CREATE INDEX memories_created_at_idx ON memories (created_at DESC);

-- ── 3. Create life_events table ──
CREATE TABLE life_events (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL,
  memory_id     uuid         REFERENCES memories(id) ON DELETE CASCADE,
  date          date,
  title         text         NOT NULL,
  description   text,
  memory_snippet text,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX life_events_user_id_idx ON life_events (user_id);
CREATE INDEX life_events_date_idx ON life_events (date ASC NULLS LAST);

-- ── 4. Create memory_chunks table (384 dimensions) ──
CREATE TABLE memory_chunks (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     uuid         NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  user_id       text         NOT NULL,
  chunk_index   int          NOT NULL DEFAULT 0,
  content       text         NOT NULL,
  embedding     vector(384),
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX chunks_user_id_idx ON memory_chunks (user_id);
CREATE INDEX chunks_memory_id_idx ON memory_chunks (memory_id);

-- ── 5. Create knowledge_bases table ──
CREATE TABLE knowledge_bases (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text         UNIQUE NOT NULL,
  name          text         NOT NULL,
  description   text,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- ── 6. Create knowledge_chunks table (384 dimensions) ──
CREATE TABLE knowledge_chunks (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id         uuid         NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  source_title  text,
  source_url    text,
  content       text         NOT NULL,
  embedding     vector(384),
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- ── 7. Create insights_cache table ──
CREATE TABLE insights_cache (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text         NOT NULL UNIQUE,
  top_topics    jsonb,
  life_themes   jsonb,
  computed_at   timestamptz  NOT NULL DEFAULT now()
);

-- ── 8. Create pgvector similarity search functions ──
CREATE OR REPLACE FUNCTION match_memory_chunks(
  query_embedding vector(384),
  match_user_id   text,
  match_count     int DEFAULT 6
)
RETURNS TABLE (
  id          uuid,
  memory_id   uuid,
  content     text,
  created_at  timestamptz,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    mc.id,
    mc.memory_id,
    mc.content,
    mc.created_at,
    1 - (mc.embedding <=> query_embedding) AS similarity
  FROM memory_chunks mc
  WHERE mc.user_id = match_user_id
    AND mc.embedding IS NOT NULL
  ORDER BY mc.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_knowledge_chunks(
  query_embedding vector(384),
  kb_ids          uuid[],
  match_count     int DEFAULT 4
)
RETURNS TABLE (
  id            uuid,
  kb_id         uuid,
  source_title  text,
  content       text,
  similarity    float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    kc.id,
    kc.kb_id,
    kc.source_title,
    kc.content,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE kc.kb_id = ANY(kb_ids)
    AND kc.embedding IS NOT NULL
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(384),
  match_user_id   text,
  match_count     int DEFAULT 5,
  similarity_threshold float DEFAULT 0.3
)
RETURNS TABLE (
  id          uuid,
  type        text,
  content     text,
  summary     text,
  created_at  timestamptz,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    m.id,
    m.type,
    m.content,
    m.summary,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.user_id = match_user_id
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── 9. Configure Storage Bucket 'user-files' policies ──
INSERT INTO storage.buckets (id, name, public)
VALUES ('user-files', 'user-files', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Allow public read-write on user-files" ON storage.objects;

CREATE POLICY "Allow public read-write on user-files" ON storage.objects
  FOR ALL
  TO public
  USING (bucket_id = 'user-files')
  WITH CHECK (bucket_id = 'user-files');
