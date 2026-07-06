/**
 * src/services/api.js
 *
 * Base helper for calling Supabase Edge Functions with Firebase auth.
 * Automatically attaches the current user's Firebase ID token as Bearer.
 */

import { edgeFnUrl } from './supabase.js';
import { currentUser } from '../auth.js';

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
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || `Edge Function error ${res.status}`);
  }

  return data;
}
