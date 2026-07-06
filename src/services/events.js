/**
 * src/services/events.js
 *
 * Cloud-backed CRUD for life events — replaces IndexedDB events store.
 */

import { callEdgeFn } from './api.js';

export async function saveEvent(event) {
  return callEdgeFn('events', { method: 'POST', body: event });
}

export async function getAllEvents() {
  return callEdgeFn('events');
}

export async function updateEvent(event) {
  return callEdgeFn('events', { method: 'PUT', body: event });
}

export async function deleteEvent(id) {
  return callEdgeFn('events', { method: 'DELETE', params: { id } });
}

export async function deleteAllUserEvents() {
  return callEdgeFn('events', { method: 'DELETE', params: { all: 'true' } });
}


export async function deleteEventsByMemoryId(memoryId) {
  // Fetch all events for this memory, then delete each.
  // The Edge Function doesn't have a bulk-delete-by-memory route yet,
  // so we filter client-side and delete individually.
  const all = await getAllEvents();
  const toDelete = all.filter(e => e.memory_id === memoryId);
  await Promise.all(toDelete.map(e => deleteEvent(e.id)));
}
