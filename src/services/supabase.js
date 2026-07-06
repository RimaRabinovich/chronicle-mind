/**
 * src/services/supabase.js
 *
 * Supabase client — used ONLY for:
 *   1. Storage (direct file uploads/downloads)
 *   2. Calling Edge Functions with Firebase auth token
 *
 * All database reads/writes go through Edge Functions, not directly
 * from the browser. The anon key is safe to expose in client code.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let _client = null;

export function getSupabaseClient() {
  if (_client) return _client;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in .env');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

/** Base URL for Edge Function calls */
export function edgeFnUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}
