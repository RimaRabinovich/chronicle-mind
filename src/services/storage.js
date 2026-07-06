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
  const path  = `${user.uid}/${type}/${ts}-${name}`;

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
