-- =====================================================
-- Migration 002: pgvector helper functions for RAG
-- Run AFTER 001_init.sql
-- =====================================================

-- Retrieve the top-K most similar memory chunks for a user
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

-- Retrieve the top-K most similar knowledge base chunks
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

-- Retrieve similar memories (top-level, not chunks) for a user
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
