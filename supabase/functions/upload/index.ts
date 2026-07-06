import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID')!;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return corsResponse({ error: 'POST only' }, 405);

  try {
    // 1. Verify user token
    const claims = await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID);
    const uid = claims.uid;

    const filePath = req.headers.get('X-File-Path');
    if (!filePath) return corsResponse({ error: 'X-File-Path header required' }, 400);

    // Enforce folder isolation: user can only write inside their own UID directory
    if (!filePath.startsWith(`${uid}/`)) {
      return corsResponse({ error: 'Forbidden: path must start with your UID' }, 403);
    }

    const contentType = req.headers.get('Content-Type') || 'application/octet-stream';
    const body = await req.arrayBuffer();

    // 2. Upload to storage using service role client (bypasses RLS)
    const db = getServiceClient();
    const { data, error } = await db.storage
      .from('user-files')
      .upload(filePath, body, {
        contentType,
        upsert: true
      });

    if (error) throw error;

    return corsResponse({ ok: true, path: filePath });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsResponse({ error: message }, 500);
  }
});
