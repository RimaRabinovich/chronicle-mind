/**
 * src/services/supabase.js
 *
 * Supabase is used only to host the stateless ai-proxy Edge Function
 * (see services/api.js); no data is stored there.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

/** Base URL for Edge Function calls */
export function edgeFnUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}
