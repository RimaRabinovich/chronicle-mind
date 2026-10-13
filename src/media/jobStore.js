/**
 * media/jobStore.js
 *
 * Persists in-progress media imports in the local encrypted database so a page
 * refresh can resume them. A job is keyed by its memory id and holds the chunk
 * timings, the per-chunk transcripts done so far, then the transcript until the
 * summary is saved. The compressed chunk audio is kept in the encrypted media
 * store (ids "job-<id>-<n>"). The job is deleted once the memory is complete.
 *
 * The original file is never stored: if a refresh happens before compression
 * finishes, the job can't resume and the file has to be imported again.
 */

import { putRecord, getRecord, getAllRecords, deleteRecord, clearStore } from '../store/db.js';
import { putMedia, getMediaBlob, deleteMediaWithPrefix } from '../store/media.js';

const STORE = 'jobs';
const chunkPrefix = (id) => `job-${id}-`;

// Updates to one job are applied one after another (read → merge → write),
// since encryption is async and can't run inside one IndexedDB transaction.
const pending = new Map();   // job id → promise of the last update

export async function saveJob(job) {
  await putRecord(STORE, job.id, job);
  return job;
}

export const getJob = (id) => getRecord(STORE, id);
export const getAllJobs = () => getAllRecords(STORE);

/**
 * Merge `patch` into the stored job and return the updated job.
 * Throws if the job was deleted (import cancelled), so a still-running step
 * can't bring it back.
 */
export function updateJob(id, patch) {
  const run = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const existing = await getRecord(STORE, id);
    if (!existing) throw new Error('Import was cancelled');
    const job = { ...existing, ...patch, id };
    await putRecord(STORE, id, job);
    return job;
  });
  pending.set(id, run);
  return run;
}

/** Store a job's chunk audio; returns the chunk timings to keep on the job. */
export async function putJobChunks(id, chunks) {
  for (const [n, chunk] of chunks.entries()) {
    await putMedia(`${chunkPrefix(id)}${n}`, chunk.blob);
  }
  return chunks.map(({ start, end }) => ({ start, end }));
}

export const getJobChunkBlob = (id, n) => getMediaBlob(`${chunkPrefix(id)}${n}`);

/** Free a job's chunk audio once the transcript is saved. */
export const deleteJobChunks = (id) => deleteMediaWithPrefix(chunkPrefix(id));

export async function deleteJob(id) {
  pending.delete(id);
  await deleteRecord(STORE, id);
  await deleteJobChunks(id);
}

export async function clearJobs() {
  pending.clear();
  await clearStore(STORE);
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
