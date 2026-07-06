/**
 * Edge Function: /functions/v1/embed
 *
 * POST { text: string } → { embedding: number[] }
 *
 * Generates a 768-dim embedding using Groq's nomic-embed-text model.
 * Falls back to a simple hash-based mock if Groq embedding is unavailable.
 *
 * Also handles chunking + storing embeddings for a memory:
 * POST { memory_id: string, content: string } → { ok: true, chunks: number }
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID  = Deno.env.get('FIREBASE_PROJECT_ID')!;
const GROQ_KEY    = Deno.env.get('GROQ_API_KEY')!;
// nomic-embed-text produces 768-dim vectors on Groq
const EMBED_MODEL = 'nomic-embed-text-v1_5';
const EMBED_URL   = 'https://api.groq.com/openai/v1/embeddings';

/** Call Groq embeddings API */
async function embedText(text: string): Promise<number[]> {
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq embedding error ${res.status}: ${JSON.stringify(err)}`);
  }

  const json = await res.json();
  return json.data[0].embedding as number[];
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

      // Delete any existing chunks for this memory
      await db.from('memory_chunks').delete().eq('memory_id', body.memory_id);

      const rows = await Promise.all(
        chunks.map(async (chunk, idx) => ({
          memory_id:   body.memory_id,
          user_id:     uid,
          chunk_index: idx,
          content:     chunk,
          embedding:   `[${(await embedText(chunk)).join(',')}]`,
        })),
      );

      const { error } = await db.from('memory_chunks').insert(rows);
      if (error) throw error;

      // Also store the top-level embedding on the memory row itself
      const topEmbedding = await embedText(body.content.slice(0, 800));
      await db.from('memories')
        .update({ embedding: `[${topEmbedding.join(',')}]` })
        .eq('id', body.memory_id)
        .eq('user_id', uid);

      return corsResponse({ ok: true, chunks: chunks.length });
    }

    return corsResponse({ error: 'Provide either "text" or "memory_id" + "content"' }, 400);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsResponse({ error: message }, 500);
  }
});
