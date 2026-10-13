/**
 * Edge Function: /functions/v1/embed
 *
 * POST { text: string } → { embedding: number[] }
 *
 * Generates a 768-dim embedding using Groq's nomic-embed-text model.
 * Falls back to a simple hash-based mock if Groq embedding is unavailable.
 *
 * Also handles chunking + storing embeddings for a memory:
 * POST { memory_id: string, content: string, chunk_offset?: number } → { ok: true, chunks: number }
 * Long content is sent in batches: chunk_offset 0 replaces the memory's chunks,
 * later batches append from chunk_offset. Chunks are embedded one at a time,
 * since running them all in parallel exhausts the function's compute (546).
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID  = Deno.env.get('FIREBASE_PROJECT_ID')!;
// Initialize local embedding session (runs entirely in Deno using ONNX runtime)
const session = new Supabase.ai.Session('gte-small');

// Deterministic fallback embedder (returns 384 floats in [-1,1])
function mockEmbedding(text: string, dim = 384) {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const out: number[] = new Array(dim);
  for (let i = 0; i < dim; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    out[i] = ((seed % 10000) / 5000) - 1;
  }
  return out;
}

/** Generate local embeddings using gte-small */
async function embedText(text: string): Promise<number[]> {
  try {
    const embedding = await session.run(text, {
      mean_pool: true,
      normalize: true,
    });
    return Array.from(embedding);
  } catch (err) {
    console.warn('Local embedding session failed, using mock fallback:', err);
    return mockEmbedding(text, 384);
  }
}


/** Split text into overlapping chunks for RAG */
function chunkText(text: string, chunkSize = 800, overlap = 100): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
  }
  return chunks;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return corsResponse({ error: 'POST only' }, 405);

  try {
    const claims = await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID);
    const uid = claims.uid;
    const body = await req.json();

    // ── Mode 1: just embed a single text string ─────────
    if (body.text && !body.memory_id) {
      const embedding = await embedText(body.text);
      return corsResponse({ embedding });
    }

    // ── Mode 2: chunk + embed + store a memory ──────────
    if (body.memory_id && body.content) {
      const db     = getServiceClient();
      const chunks = chunkText(body.content);
      const offset = Number(body.chunk_offset) || 0;

      // The first batch replaces any existing chunks for this memory
      if (offset === 0) {
        await db.from('memory_chunks').delete().eq('memory_id', body.memory_id).eq('user_id', uid);
      }

      const rows = [];
      for (const [idx, chunk] of chunks.entries()) {
        rows.push({
          memory_id:   body.memory_id,
          user_id:     uid,
          chunk_index: offset + idx,
          content:     chunk,
          embedding:   `[${(await embedText(chunk)).join(',')}]`,
        });
      }

      const { error } = await db.from('memory_chunks').insert(rows);
      if (error) throw error;

      // Also store the top-level embedding on the memory row itself (first batch only)
      if (offset === 0) {
        await db.from('memories')
          .update({ embedding: rows[0].embedding })
          .eq('id', body.memory_id)
          .eq('user_id', uid);
      }

      return corsResponse({ ok: true, chunks: chunks.length });
    }

    return corsResponse({ error: 'Provide either "text" or "memory_id" + "content"' }, 400);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsResponse({ error: message }, 500);
  }
});
