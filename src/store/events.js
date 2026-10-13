/**
 * store/events.js — life events in the local encrypted database
 *
 * Same functions as services/events.js (the old Supabase version). Events are
 * stored with snake_case fields (memory_id, source_type, memory_snippet) like
 * the old table; camelCase input from the UI is normalized.
 */

import { putRecord, getAllRecords, deleteRecord, clearStore } from './db.js';

const STORE = 'events';

function normalize(ev) {
  const { memoryId, sourceType, memorySnippet, ...rest } = ev;
  return {
    ...rest,
    memory_id:      rest.memory_id ?? memoryId ?? null,
    source_type:    rest.source_type ?? sourceType ?? 'memory',
    memory_snippet: rest.memory_snippet ?? memorySnippet ?? null,
  };
}

export async function saveEvent(event) {
  const saved = {
    ...normalize(event),
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  };
  await putRecord(STORE, saved.id, saved);
  return saved;
}

/** Store an event exactly as given (keeps its id); used by the cloud migration. */
export async function importEvent(event) {
  const ev = normalize(event);
  await putRecord(STORE, ev.id, ev);
  return ev;
}

/** All events, oldest date first (undated last). */
export async function getAllEvents() {
  const all = await getAllRecords(STORE);
  return all.sort((a, b) => (a.date ?? '￿').localeCompare(b.date ?? '￿'));
}

export async function updateEvent(event) {
  const ev = normalize(event);
  await putRecord(STORE, ev.id, ev);
  return ev;
}

export async function deleteEvent(id) {
  await deleteRecord(STORE, id);
}

export async function deleteAllUserEvents() {
  await clearStore(STORE);
}

export async function deleteEventsByMemoryId(memoryId) {
  const all = await getAllRecords(STORE);
  await Promise.all(all.filter(e => e.memory_id === memoryId).map(e => deleteRecord(STORE, e.id)));
}
