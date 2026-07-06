/**
 * src/services/migration.js
 *
 * One-time migration helper: reads the user's legacy IndexedDB data
 * (chronicle-mind-{uid}) and pushes it to Supabase.
 *
 * Called from main.js after first login if legacy data is detected.
 */

import { openDB } from 'idb';
import { saveMemory, embedMemory } from './memories.js';
import { saveEvent } from './events.js';

const DB_VERSION = 2;

/**
 * Check whether a legacy IndexedDB exists for this user.
 * @param {string} uid
 * @returns {Promise<boolean>}
 */
export async function hasLegacyData(uid) {
  try {
    const dbName  = `chronicle-mind-${uid}`;
    const dbNames = await indexedDB.databases?.();
    if (dbNames) {
      return dbNames.some(db => db.name === dbName);
    }
    // Fallback: try to open and count
    const db = await openDB(dbName, DB_VERSION);
    const count = await db.count('entries');
    db.close();
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Migrate legacy IndexedDB data to Supabase.
 * Reports progress via the onProgress callback.
 *
 * @param {string} uid
 * @param {(msg: string) => void} onProgress
 */
export async function migrateLegacyData(uid, onProgress = () => {}) {
  const dbName = `chronicle-mind-${uid}`;

  let legacyDB;
  try {
    legacyDB = await openDB(dbName, DB_VERSION);
  } catch (err) {
    throw new Error(`Could not open legacy DB: ${err.message}`);
  }

  // ── Migrate entries → memories ──────────────────────
  const entries = await legacyDB.getAllFromIndex('entries', 'by-timestamp').catch(() => []);
  onProgress(`Migrating ${entries.length} memories…`);

  const idMap = new Map(); // old id → new Supabase id

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onProgress(`Memory ${i + 1} / ${entries.length}`);

    try {
      const saved = await saveMemory({
        content:     entry.content ?? '',
        type:        entry.type ?? 'text',
        source:      'manual',
        summary:     entry.summary ?? null,
        metadata:    {
          legacy_id:    entry.id,
          original_ts:  entry.timestamp,
          ...(entry.metadata ?? {}),
        },
      });
      idMap.set(entry.id, saved.id);

      // Trigger background embedding (non-blocking)
      if (entry.content) {
        embedMemory(saved.id, entry.content).catch(() => {});
      }
    } catch (err) {
      console.warn(`Failed to migrate entry ${entry.id}:`, err);
    }
  }

  // ── Migrate events ───────────────────────────────────
  const events = await legacyDB.getAllFromIndex('events', 'by-date').catch(() => []);
  onProgress(`Migrating ${events.length} life events…`);

  for (const ev of events) {
    try {
      await saveEvent({
        title:          ev.title,
        date:           ev.date,
        description:    ev.description,
        memory_id:      idMap.get(ev.memoryId) ?? null,   // link to new Supabase memory id
        memory_snippet: ev.memorySnippet ?? null,
      });
    } catch (err) {
      console.warn(`Failed to migrate event ${ev.id}:`, err);
    }
  }

  legacyDB.close();
  onProgress('Migration complete!');

  return { memories: entries.length, events: events.length };
}
