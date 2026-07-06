/**
 * Edge Function: /functions/v1/rag-query
 *
 * POST { query: string, kb_slugs?: string[], top_k?: number }
 * → { answer: string, sources: Source[] }
 *
 * Retrieves semantically similar chunks from:
 *   1. The user's own memory_chunks (personal RAG)
 *   2. Optionally: knowledge_chunks from requested knowledge bases
 *
 * Then feeds them to Groq LLM to generate a grounded answer.
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID  = Deno.env.get('FIREBASE_PROJECT_ID')!;
const GROQ_KEY    = Deno.env.get('GROQ_API_KEY')!;
const session = new Supabase.ai.Session('gte-small');

async function embedText(text: string): Promise<number[]> {
  try {
    const embedding = await session.run(text, {
      mean_pool: true,
      normalize: true,
    });
    return Array.from(embedding);
  } catch (err) {
    console.error('Local embedding inside rag-query failed:', err);
    // Simple fallback
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    const out: number[] = new Array(384);
    for (let i = 0; i < 384; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      out[i] = ((seed % 10000) / 5000) - 1;
    }
    return out;
  }
}


const CHAT_MODEL  = 'llama-3.1-8b-instant';

async function groqChat(messages: { role: string; content: string }[], maxTokens = 1200) {

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature: 0.3, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`Groq chat failed: ${res.status}`);
  return (await res.json()).choices[0].message.content.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return corsResponse({ error: 'POST only' }, 405);

  try {
    const claims = await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID);
    const uid = claims.uid;
    const { query, kb_slugs = [], top_k = 6 } = await req.json();

    if (!query) return corsResponse({ error: 'query is required' }, 400);

    const db        = getServiceClient();
    const queryVec  = await embedText(query);
    const vecStr    = `[${queryVec.join(',')}]`;

    // ── 1. Retrieve from personal memory chunks ─────────
    const { data: personalChunks, error: pcErr } = await db.rpc('match_memory_chunks', {
      query_embedding: vecStr,
      match_user_id:   uid,
      match_count:     top_k,
    });
    if (pcErr) throw pcErr;

    // ── 2. Retrieve from requested knowledge bases ──────
    let kbChunks: { content: string; source_title: string }[] = [];
    if (kb_slugs.length > 0) {
      const { data: kbs } = await db
        .from('knowledge_bases')
        .select('id')
        .in('slug', kb_slugs)
        .eq('is_active', true);

      if (kbs && kbs.length > 0) {
        const kbIds = kbs.map((k: { id: string }) => k.id);
        const { data: kbData } = await db.rpc('match_knowledge_chunks', {
          query_embedding: vecStr,
          kb_ids:          kbIds,
          match_count:     Math.max(2, Math.floor(top_k / 2)),
        });
        kbChunks = kbData ?? [];
      }
    }

    // ── 3. Build context for LLM ────────────────────────
    const personalCtx = (personalChunks ?? [])
      .map((c: { content: string; created_at: string }, i: number) =>
        `[Memory ${i + 1} — ${new Date(c.created_at).toDateString()}]\n${c.content}`,
      )
      .join('\n\n');

    const kbCtx = kbChunks
      .map((c, i) => `[Knowledge: ${c.source_title ?? 'External'} — ${i + 1}]\n${c.content}`)
      .join('\n\n');

    const context = [personalCtx, kbCtx].filter(Boolean).join('\n\n---\n\n');

    if (!context.trim()) {
      return corsResponse({
        answer: "I don't have enough information in your memories to answer that yet. Try capturing more memories first!",
        sources: [],
      });
    }

    // ── 4. Generate answer ──────────────────────────────
    const systemPrompt = `You are a personal memory assistant. You have access to the user's memories and relevant knowledge.
Answer the user's question based ONLY on the provided context. Be specific, cite memory dates when relevant.
If the context doesn't fully answer the question, say so honestly. Never invent details not in the context.`;

    const answer = await groqChat([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Context:\n${context}\n\nQuestion: ${query}` },
    ]);

    // ── 5. Return answer + sources ──────────────────────
    const sources = (personalChunks ?? []).map((c: {
      memory_id: string; content: string; created_at: string; similarity: number;
    }) => ({
      memory_id:  c.memory_id,
      snippet:    c.content.slice(0, 150) + (c.content.length > 150 ? '…' : ''),
      date:       c.created_at,
      similarity: Math.round(c.similarity * 100),
    }));

    return corsResponse({ answer, sources });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsResponse({ error: message }, 500);
  }
});
