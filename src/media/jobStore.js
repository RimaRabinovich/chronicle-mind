/**
 * media/jobStore.js
 *
 * Persists in-progress media imports in IndexedDB so a page refresh can resume them.
 * A job is keyed by its memory id and holds the compressed chunks (Blobs), the
 * per-chunk transcripts done so far, and the upload result. It is deleted once
 * the memory has its transcript and summary.
 *
 * The original file is never stored: if a refresh happens before compression
 * finishes, the job can't resume and the file has to be imported again.
 */

import { openDB } from 'idb';
import { currentUser } from '../auth.js';

const STORE = 'jobs';
let cached = { uid: null, db: null };

async function getDB() {
  const uid = currentUser()?.uid;
  if (!uid) throw new Error('No user logged in — cannot open job store');
  if (cached.uid !== uid) {
    cached = {
      uid,
      db: await openDB(`chronicle-mind-jobs-${uid}`, 1, {
        upgrade(db) { db.createObjectStore(STORE, { keyPath: 'id' }); },
      }),
    };
  }
  return cached.db;
}

export async function saveJob(job) {
  await (await getDB()).put(STORE, job);
  return job;
}

export async function getJob(id) {
  return (await getDB()).get(STORE, id);
}

/**
 * Merge `patch` into the stored job atomically and return the updated job.
 * Throws if the job was deleted (import cancelled), so a still-running step
 * can't bring it back.
 */
export async function updateJob(id, patch) {
  const tx = (await getDB()).transaction(STORE, 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) throw new Error('Import was cancelled');  // tx commits with no writes
  const job = { ...existing, ...patch, id };
  await tx.store.put(job);
  await tx.done;
  return job;
}

export async function getAllJobs() {
  return (await getDB()).getAll(STORE);
}

export async function deleteJob(id) {
  await (await getDB()).delete(STORE, id);
}

export async function clearJobs() {
  await (await getDB()).clear(STORE);
}

/**
 * Run `fn` only if no other tab is already working on this job (Web Locks).
 * Returns false when the lock was taken. Falls back to running directly in
 * browsers without navigator.locks.
 */
export async function withJobLock(id, fn) {
  if (!navigator.locks) { await fn(); return true; }
  return navigator.locks.request(`media-job-${id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}
