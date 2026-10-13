/**
 * src/services/storage.js
 *
 * File storage via Supabase Storage.
 * Bucket: 'user-files' (completely private, no public access policies)
 *
 * Direct uploads from browser are sent to /functions/v1/upload,
 * which verifies Firebase token and writes using service role.
 */

import { getSupabaseClient } from './supabase.js';
import { currentUser } from '../auth.js';

const BUCKET = 'user-files';

/**
 * Upload a file to Supabase Storage securely via Edge Function.
 * @param {Blob|File} file
 * @param {string} type   - 'audio' | 'video' | 'document' | 'image'
 * @param {string} name   - filename
 * @returns {Promise<{ path: string }>}
 */
export async function uploadFile(file, type, name) {
  const user = currentUser();
  if (!user) throw new Error('Not authenticated');

  const token = await user.getIdToken();
  const ts    = Date.now();
  // The path travels in an HTTP header (Latin-1 only), and storage keys reject many
  // characters, so keep it ASCII; the real name is kept in the memory's metadata.
  const safeName = name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_');
  const path  = `${user.uid}/${type}/${ts}-${safeName}`;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey     = import.meta.env.VITE_SUPABASE_ANON_KEY;

  const res = await fetch(`${supabaseUrl}/functions/v1/upload`, {
    method: 'POST',
    headers: {
      'apikey':        anonKey,
      'Authorization': `Bearer ${token}`,
      'X-File-Path':   path,
      'Content-Type':  file.type || 'application/octet-stream'
    },
    body: file
  });

  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(data.error || `Upload Edge Function failed: ${res.status}`);
  }

  return { path };
}

/**
 * Generate a signed URL for temporary private access (e.g. audio playback).
 * @param {string} path   - storage path (e.g. "uid/audio/filename.webm")
 * @param {number} expiresIn - seconds (default 1 hour = 3600)
 */
export async function getSignedUrl(path, expiresIn = 3600) {
  const user = currentUser();
  if (!user) throw new Error('Not authenticated');

  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error) throw new Error(`Signed URL generation failed: ${error.message}`);
  return data.signedUrl;
}

/**
 * Delete a file from Supabase Storage by its path.
 */
export async function deleteFile(path) {
  const client = getSupabaseClient();
  const { error } = await client.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

/**
 * Permanently delete all files stored under a user's UID folder
 * (uploads live in <uid>/audio/, <uid>/video/, …). Throws if anything fails.
 * @param {string} uid
 */
export async function deleteUserFolder(uid) {
  const client = getSupabaseClient();
  const bucket = client.storage.from(BUCKET);

  // list() returns one level, at most `limit` items: folders first, then files.
  const { data: folders, error: folderError } = await bucket.list(uid, { limit: 1000 });
  if (folderError) throw new Error(`Storage list failed: ${folderError.message}`);

  const remove = async (paths) => {
    const { data, error } = await bucket.remove(paths);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
    // A remove blocked by storage policies "succeeds" with nothing removed.
    if (!data?.length) throw new Error('Storage delete failed: no files were removed');
  };

  // Folder entries have no id; anything with an id is a file directly under <uid>/.
  const topFiles = (folders ?? []).filter(f => f.id).map(f => `${uid}/${f.name}`);
  if (topFiles.length) await remove(topFiles);

  for (const folder of (folders ?? []).filter(f => !f.id)) {
    const prefix = `${uid}/${folder.name}`;
    // Remove page by page; each removal shrinks the listing, so always read from offset 0.
    for (;;) {
      const { data: files, error } = await bucket.list(prefix, { limit: 1000 });
      if (error) throw new Error(`Storage list failed: ${error.message}`);
      const paths = (files ?? []).filter(f => f.id).map(f => `${prefix}/${f.name}`);
      if (paths.length === 0) break;
      await remove(paths);
    }
  }
}
