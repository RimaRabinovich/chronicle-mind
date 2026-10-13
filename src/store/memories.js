/**
 * store/memories.js — memories in the local encrypted database
 *
 * Same functions and record shape as services/memories.js (the old Supabase
 * version), so main.js call sites stay the same. The plaintext `ts` on each row
 * is the memory's capture time, used only for ordering.
 */

import { putRecord, getRecord, getAllRecords, deleteRecord, clearStore } from './db.js';
import { deleteMedia, isMediaRef, mediaIdFromRef } from './media.js';

const STORE = 'entries';

const sortTime = (m) => m.metadata?.captured_at || m.created_at;

async function put(memory) {
  await putRecord(STORE, memory.id, memory, sortTime(memory));
  return memory;
}

/**
 * Save a new memory.
 * @param {object} memory - { content, type, source, summary, file_url, file_name, file_type, duration_sec, metadata }
 * @returns {Promise<object>} the saved memory with id, created_at, updated_at
 */
export async function saveMemory(memory) {
  const now = new Date().toISOString();
  return put({
    content: '', type: 'text', source: 'manual', summary: null,
    file_url: null, file_name: null, file_type: null, duration_sec: null,
    ...memory,
    metadata: memory.metadata ?? {},
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  });
}

/** Store a memory exactly as given (keeps its id and dates); used by the cloud migration. */
export async function importMemory(memory) {
  return put(memory);
}

/** All memories, newest first. */
export async function getAllMemories() {
  const all = await getAllRecords(STORE);
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Update a memory's fields (shallow merge: a given `metadata` replaces the old one).
 * @param {object} updates - must include { id }
 */
export async function updateMemory({ id, ...updates }) {
  const existing = await getRecord(STORE, id);
  if (!existing) throw new Error('Memory not found');
  return put({ ...existing, ...updates, id, updated_at: new Date().toISOString() });
}

/** Delete a memory and its stored audio. */
export async function deleteMemory(id) {
  const existing = await getRecord(STORE, id);
  if (isMediaRef(existing?.file_url)) await deleteMedia(mediaIdFromRef(existing.file_url));
  await deleteRecord(STORE, id);
}

export async function deleteAllUserMemories() {
  await clearStore(STORE);
  await clearStore('media');
}
