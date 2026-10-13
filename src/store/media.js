/**
 * store/media.js — encrypted audio blobs in the local database
 *
 * A media item is stored as one row: an encrypted header ({ type, size }) and
 * the bytes encrypted in 1 MB parts. Memories reference it as
 * file_url = "media:<id>" (see mediaRef / mediaIdFromRef).
 */

import { getDB } from './db.js';
import { encryptBytes, decryptBytes, encryptJSON, decryptJSON } from '../crypto.js';

const PART_BYTES = 1024 * 1024;
const PREFIX = 'media:';

export const mediaRef = (id) => `${PREFIX}${id}`;
export const isMediaRef = (url) => typeof url === 'string' && url.startsWith(PREFIX);
export const mediaIdFromRef = (url) => url.slice(PREFIX.length);

export async function putMedia(id, blob) {
  const buf = await blob.arrayBuffer();
  const parts = [];
  for (let i = 0, n = 0; i < buf.byteLength || n === 0; i += PART_BYTES, n++) {
    parts.push(await encryptBytes(buf.slice(i, i + PART_BYTES), `media:${id}:${n}`));
  }
  const header = await encryptJSON({ type: blob.type, size: buf.byteLength }, `media:${id}`);
  await (await getDB()).put('media', { id, header, parts });
}

/** The decrypted media as a Blob, or null if it isn't stored. */
export async function getMediaBlob(id) {
  const row = await (await getDB()).get('media', id);
  if (!row) return null;
  const { type } = await decryptJSON(row.header, `media:${id}`);
  const parts = await Promise.all(row.parts.map((p, n) => decryptBytes(p, `media:${id}:${n}`)));
  return new Blob(parts, { type });
}

export async function deleteMedia(id) {
  await (await getDB()).delete('media', id);
}

/** Delete every media item whose id starts with `prefix` (e.g. a job's chunks). */
export async function deleteMediaWithPrefix(prefix) {
  const db = await getDB();
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  await db.delete('media', range);
}
