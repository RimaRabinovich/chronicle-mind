import { openDB } from 'idb';

const DB_VERSION = 2;          // entries + events stores
const ENTRIES    = 'entries';
const EVENTS     = 'events';

// ── User-scoped DB ───────────────────────────────────────
// The DB name is derived from the signed-in user's UID so each
// user gets completely isolated storage on the same device.

let currentUserId = null;
let db = null;              // cached connection (reset on user change)

/** Call this once Firebase reports a signed-in user. */
export function setCurrentUser(uid) {
  if (uid === currentUserId) return;   // no-op if same user
  currentUserId = uid;
  db = null;                           // force re-open for new uid
}

function dbName() {
  if (!currentUserId) throw new Error('No user logged in — cannot open DB');
  return `chronicle-mind-${currentUserId}`;
}

async function getDB() {
  if (db) return db;
  db = await openDB(dbName(), DB_VERSION, {
    upgrade(database, oldVersion) {
      // ── v1: entries store ──
      if (!database.objectStoreNames.contains(ENTRIES)) {
        const store = database.createObjectStore(ENTRIES, { keyPath: 'id' });
        store.createIndex('by-timestamp', 'timestamp');
      }
      // ── v2: events store ──
      if (oldVersion < 2 && !database.objectStoreNames.contains(EVENTS)) {
        const evStore = database.createObjectStore(EVENTS, { keyPath: 'id' });
        evStore.createIndex('by-date',     'date');
        evStore.createIndex('by-memoryId', 'memoryId');
      }
    }
  });
  return db;
}

// ── Entries ──────────────────────────────────────────────

/** Save (or overwrite) an entry */
export async function saveEntry(entry) {
  const d = await getDB();
  await d.put(ENTRIES, entry);
}

/** Load all entries sorted chronologically (oldest → newest) */
export async function getAllEntries() {
  const d = await getDB();
  return d.getAllFromIndex(ENTRIES, 'by-timestamp');
}

/** Get a single entry by id */
export async function getEntryById(id) {
  const d = await getDB();
  return d.get(ENTRIES, id);
}

/** Delete an entry */
export async function deleteEntry(id) {
  const d = await getDB();
  await d.delete(ENTRIES, id);
}

// ── Events ───────────────────────────────────────────────

/** Save an extracted life event */
export async function saveEvent(event) {
  const d = await getDB();
  await d.put(EVENTS, event);
}

/** Update an existing event (same as saveEvent — put is upsert) */
export async function updateEvent(event) {
  const d = await getDB();
  await d.put(EVENTS, event);
}

/** Delete a single event by id */
export async function deleteEvent(id) {
  const d = await getDB();
  await d.delete(EVENTS, id);
}

/** Load all events sorted by date (oldest → newest) */
export async function getAllEvents() {
  const d = await getDB();
  return d.getAllFromIndex(EVENTS, 'by-date');
}

/** Delete all events linked to a memory */
export async function deleteEventsByMemoryId(memoryId) {
  const d = await getDB();
  const all = await d.getAllFromIndex(EVENTS, 'by-memoryId', memoryId);
  const tx  = d.transaction(EVENTS, 'readwrite');
  await Promise.all(all.map(e => tx.store.delete(e.id)));
  await tx.done;
}
