/**
 * src/services/storage.js
 *
 * File storage via Supabase Storage.
 * Bucket: 'user-files' (per-user paths: {uid}/{type}/{filename})
 *
 * Supported file types:
 *   - audio:  audio/webm, audio/mp4, audio/wav
 *   - video:  video/webm, video/mp4
 *   - docs:   application/pdf, text/plain, image/* (scanned docs)
 */

import { getSupabaseClient } from './supabase.js';
import { currentUser } from '../auth.js';

const BUCKET = 'user-files';

/**
 * Upload a file to Supabase Storage.
 * @param {Blob|File} file
 * @param {string} type   - 'audio' | 'video' | 'document' | 'image'
 * @param {string} name   - filename (will be prefixed with uid/type/)
 * @returns {Promise<{ path: string, publicUrl: string }>}
 */
export async function uploadFile(file, type, name) {
  const user = currentUser();
  if (!user) throw new Error('Not authenticated');

  const client = getSupabaseClient();
  const ext    = name.includes('.') ? name.split('.').pop() : 'bin';
  const ts     = Date.now();
  const path   = `${user.uid}/${type}/${ts}-${name}`;

  const { error } = await client.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = client.storage.from(BUCKET).getPublicUrl(path);

  return { path, publicUrl: urlData.publicUrl };
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
 * Generate a signed URL for temporary private access (e.g. audio playback).
 * @param {string} path   - storage path returned by uploadFile
 * @param {number} expiresIn - seconds (default 1 hour)
 */
export async function getSignedUrl(path, expiresIn = 3600) {
  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error) throw new Error(`Signed URL failed: ${error.message}`);
  return data.signedUrl;
}
