/**
 * store/migrateFromCloud.js — one-time "Move my data to this device"
 *
 * Copies the user's memories, life events and stored audio from Supabase into
 * the local encrypted database (keeping their ids, so event → memory links
 * survive), verifies the counts, and only then lets the caller delete the cloud
 * copy. Copying is idempotent: re-running after an interruption overwrites.
 */

import * as cloudMemories from '../services/memories.js';
import * as cloudEvents from '../services/events.js';
import { getSignedUrl, deleteUserFolder } from '../services/storage.js';
import { importMemory, getAllMemories } from './memories.js';
import { importEvent, getAllEvents } from './events.js';
import { putMedia, mediaRef } from './media.js';

const CLOUD_LIMIT = 10_000;

/** What's still in the cloud: { memories, events } arrays. */
export async function getCloudData() {
  const [memories, events] = await Promise.all([
    cloudMemories.getAllMemories({ limit: CLOUD_LIMIT }),
    cloudEvents.getAllEvents(),
  ]);
  return { memories: memories ?? [], events: events ?? [] };
}

/** A Supabase Storage path (not a Drive/web link or an already-local ref). */
const isStoragePath = (url) => !!url && !/^(https?:|blob:|media:)/.test(url);

async function downloadStorageFile(path) {
  const res = await fetch(await getSignedUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Copy cloud data into the local vault.
 * @param {{memories: object[], events: object[]}} cloud  from getCloudData()
 * @param {(text: string) => void} [onProgress]
 * @returns {Promise<{ memories: number, events: number, missingAudio: string[] }>}
 *          missingAudio lists file names whose audio couldn't be downloaded.
 */
export async function copyCloudToLocal(cloud, onProgress = () => {}) {
  const missingAudio = [];

  for (const [i, m] of cloud.memories.entries()) {
    onProgress(`Copying memory ${i + 1} of ${cloud.memories.length}…`);
    // Drop server-only columns (embedding, user_id); the rest is the same shape.
    const { embedding, user_id, ...memory } = m;
    if (isStoragePath(memory.file_url)) {
      try {
        const blob = await downloadStorageFile(memory.file_url);
        const mediaId = `audio-${memory.id}`;
        await putMedia(mediaId, blob);
        memory.file_url = mediaRef(mediaId);
        memory.file_type = blob.type || memory.file_type;
        if (memory.metadata) delete memory.metadata.storage_path;
      } catch (err) {
        console.error(`Audio download failed for memory ${memory.id}:`, err);
        missingAudio.push(memory.file_name || memory.id);
        memory.file_url = null;
      }
    }
    await importMemory(memory);
  }

  onProgress('Copying life events…');
  for (const ev of cloud.events) {
    const { user_id, ...event } = ev;
    await importEvent(event);
  }

  // Verify every cloud id is now stored locally.
  onProgress('Checking the copy…');
  const localMemoryIds = new Set((await getAllMemories()).map(m => m.id));
  const localEventIds  = new Set((await getAllEvents()).map(e => e.id));
  const lostMemories = cloud.memories.filter(m => !localMemoryIds.has(m.id)).length;
  const lostEvents   = cloud.events.filter(e => !localEventIds.has(e.id)).length;
  if (lostMemories || lostEvents) {
    throw new Error(`Copy incomplete: ${lostMemories} memories and ${lostEvents} events are missing locally`);
  }

  return { memories: cloud.memories.length, events: cloud.events.length, missingAudio };
}

/** Delete the cloud copy: memory rows (and their embedding chunks), events, stored files. */
export async function deleteCloudData(uid) {
  await cloudMemories.deleteAllUserMemories();
  await cloudEvents.deleteAllUserEvents();
  await deleteUserFolder(uid);
}
