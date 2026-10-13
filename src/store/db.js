/**
 * store/db.js — the user's local encrypted database (IndexedDB)
 *
 * One database per signed-in user. Every record is stored as
 *   { id, ts?, iv, ct }
 * where only the id (and, for entries, a timestamp used for ordering) is in
 * plaintext; everything else is AES-GCM ciphertext (see crypto.js).
 *
 * Stores: meta (vault record, remembered device key), entries, events,
 *         media (encrypted audio), jobs (unfinished media imports).
 */

import { openDB, deleteDB } from 'idb';
import { currentUser } from '../auth.js';
import { encryptJSON, decryptJSON } from '../crypto.js';

const VERSION = 1;
let cached = { uid: null, db: null };

const dbName = (uid) => `chronicle-vault-${uid}`;

export async function getDB() {
  const uid = currentUser()?.uid;
  if (!uid) throw new Error('No user logged in — cannot open local database');
  if (cached.uid !== uid) {
    cached.db?.close();
    cached = {
      uid,
      db: await openDB(dbName(uid), VERSION, {
        upgrade(db) {
          db.createObjectStore('meta');
          db.createObjectStore('entries', { keyPath: 'id' }).createIndex('by-ts', 'ts');
          db.createObjectStore('events', { keyPath: 'id' });
          db.createObjectStore('media', { keyPath: 'id' });
          db.createObjectStore('jobs', { keyPath: 'id' });
        },
      }),
    };
  }
  return cached.db;
}

/**
 * Delete the unencrypted job database used before Phase 3 (it could hold
 * compressed audio and transcripts of unfinished imports).
 */
export async function deleteLegacyJobDatabase() {
  const uid = currentUser()?.uid;
  if (uid) await deleteDB(`chronicle-mind-jobs-${uid}`);
}

/** Permanently delete this user's local database. */
export async function wipeLocalDatabase() {
  const uid = currentUser()?.uid;
  if (!uid) return;
  if (cached.uid === uid) {
    cached.db?.close();
    cached = { uid: null, db: null };
  }
  await deleteDB(dbName(uid));
}

// ── Encrypted records ────────────────────────────────────

export async function putRecord(store, id, value, ts) {
  const sealed = await encryptJSON(value, `${store}:${id}`);
  const row = ts === undefined ? { id, ...sealed } : { id, ts, ...sealed };
  await (await getDB()).put(store, row);
}

export async function getRecord(store, id) {
  const row = await (await getDB()).get(store, id);
  return row ? decryptJSON(row, `${store}:${id}`) : undefined;
}

export async function getAllRecords(store) {
  const rows = await (await getDB()).getAll(store);
  return Promise.all(rows.map(row => decryptJSON(row, `${store}:${row.id}`)));
}

export async function deleteRecord(store, id) {
  await (await getDB()).delete(store, id);
}

export async function clearStore(store) {
  await (await getDB()).clear(store);
}

export async function countRecords(store) {
  return (await getDB()).count(store);
}
