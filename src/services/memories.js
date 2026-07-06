/**
 * src/services/memories.js
 *
 * Cloud-backed CRUD for memories — replaces the IndexedDB db.js ENTRIES store.
 * All calls go through the Supabase 'memories' Edge Function.
 */

import { callEdgeFn } from './api.js';

/**
 * Save a new memory.
 * @param {object} memory - { content, type, source, summary, file_url, file_name, file_type, duration_sec, metadata }
 * @returns {Promise<object>} - saved memory with id, created_at, etc.
 */
export async function saveMemory(memory) {
  return callEdgeFn('memories', { method: 'POST', body: memory });
}

/**
 * Load all memories for the current user, newest first.
 * @param {{ limit?: number, offset?: number, type?: string }} opts
 */
export async function getAllMemories({ limit = 200, offset = 0, type } = {}) {
  const params = { limit, offset };
  if (type) params.type = type;
  return callEdgeFn('memories', { params });
}

/**
 * Get a single memory by id (fetches all then filters — use sparingly).
 * For a more efficient lookup, add a GET /:id route to the Edge Function later.
 */
export async function getMemoryById(id) {
  const all = await getAllMemories({ limit: 1000 });
  return all.find(m => m.id === id) ?? null;
}

/**
 * Update a memory's fields.
 * @param {object} updates - must include { id }
 */
export async function updateMemory(updates) {
  return callEdgeFn('memories', { method: 'PUT', body: updates });
}

/**
 * Delete a memory by id.
 */
export async function deleteMemory(id) {
  return callEdgeFn('memories', { method: 'DELETE', params: { id } });
}

/**
 * Trigger server-side embedding for a memory.
 * Chunks the content and stores vectors in memory_chunks.
 * Fire-and-forget: call without await if you don't need to wait.
 */
export async function embedMemory(memoryId, content) {
  return callEdgeFn('embed', {
    method: 'POST',
    body:   { memory_id: memoryId, content },
  });
}
