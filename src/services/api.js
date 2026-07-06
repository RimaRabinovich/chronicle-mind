/**
 * src/services/api.js
 *
 * Base helper for calling Supabase Edge Functions with Firebase auth.
 * Supabase requires BOTH:
 *   - apikey: <supabase-anon-key>   (Supabase gateway auth)
 *   - Authorization: Bearer <firebase-jwt>  (our custom Firebase verification)
 */

import { edgeFnUrl } from './supabase.js';
import { currentUser } from '../auth.js';

const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Call a Supabase Edge Function.
 * @param {string} fnName   - Edge Function name (e.g. 'memories')
 * @param {object} options  - fetch options (method, body, params)
 */
export async function callEdgeFn(fnName, { method = 'GET', body, params } = {}) {
  const user = currentUser();
  if (!user) throw new Error('Not authenticated');

  // Get fresh Firebase ID token (auto-refreshes if needed)
  const token = await user.getIdToken();

  let url = edgeFnUrl(fnName);
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url = `${url}?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      // Supabase gateway requires its own anon key
      'apikey': SUPABASE_ANON_KEY,
      // Our Edge Function reads this to verify the Firebase user
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message =
      (typeof data?.error === 'string' && data.error.trim())
        ? data.error
        : (typeof data?.error?.message === 'string' && data.error.message.trim())
          ? data.error.message
          : (typeof data?.message === 'string' && data.message.trim())
            ? data.message
            : `Edge Function error ${res.status}`;

    throw new Error(message);
  }

  return data ?? {};
}
