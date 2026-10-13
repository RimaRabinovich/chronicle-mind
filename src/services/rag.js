/**
 * src/services/rag.js
 *
 * RAG query interface — skeleton for the future Insights tab.
 * Calls the 'rag-query' Edge Function which retrieves relevant
 * memory chunks and generates a grounded answer via Groq.
 */

import { callEdgeFn } from './api.js';

/**
 * Ask a natural language question against the user's memories.
 *
 * @param {string} query         - e.g. "What was my life at age 22?"
 * @param {object} opts
 * @param {string[]} opts.kbSlugs - knowledge bases to also search
 *                                  e.g. ['buddhism', 'bob_proctor']
 * @param {number}  opts.topK     - number of chunks to retrieve (default 6)
 *
 * @returns {Promise<{ answer: string, sources: Source[] }>}
 *
 * Source: { memory_id, snippet, date, similarity }
 */
export async function ragQuery(query, { kbSlugs = [], topK = 6 } = {}) {
  return callEdgeFn('rag-query', {
    method: 'POST',
    body:   { query, kb_slugs: kbSlugs, top_k: topK },
  });
}

/**
 * Embed a single piece of text (for client-side similarity comparisons).
 * Returns a 768-dim float array.
 */
export async function embedText(text) {
  const result = await callEdgeFn('embed', {
    method: 'POST',
    body:   { text },
  });
  return result.embedding;
}

/**
 * Trigger background embedding for a memory after it's been saved.
 * Fire-and-forget — don't block the UI on this.
 */
export function triggerEmbedding(memoryId, content) {
  embedInBatches(memoryId, content)
    .catch(err => console.warn('Background embedding failed:', err));
}

// The embed function chunks text into ~800-char pieces; a long transcript in one
// request runs it out of compute, so send ~5 pieces' worth per request.
const EMBED_BATCH_CHARS = 4000;

async function embedInBatches(memoryId, content) {
  let offset = 0;
  for (let start = 0; start < content.length; ) {
    let end = Math.min(start + EMBED_BATCH_CHARS, content.length);
    if (end < content.length) {
      const space = content.lastIndexOf(' ', end);
      if (space > start + EMBED_BATCH_CHARS / 2) end = space;  // don't cut a word
    }
    const { chunks } = await callEdgeFn('embed', {
      method: 'POST',
      body:   { memory_id: memoryId, content: content.slice(start, end), chunk_offset: offset },
    });
    offset += chunks;
    start = end;
  }
}
