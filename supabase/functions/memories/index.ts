/**
 * Edge Function: /functions/v1/memories
 *
 * GET    → list all memories for the user (paginated)
 * POST   → create a new memory
 * PUT    → update an existing memory (body must include id)
 * DELETE → delete a memory by id (?id=...)
 *
 * All requests require Authorization: Bearer <firebase-id-token>
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsHeaders, corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID')!;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();

  try {
    const claims = await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID);
    const uid = claims.uid;
    const db  = getServiceClient();
    const url = new URL(req.url);

    // ── GET: list memories ──────────────────────────────
    if (req.method === 'GET') {
      const limit  = Number(url.searchParams.get('limit')  ?? 100);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const type   = url.searchParams.get('type');          // optional filter

      let query = db
        .from('memories')
        .select('id, type, source, content, summary, file_url, file_name, duration_sec, metadata, created_at, updated_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (type) query = query.eq('type', type);

      const { data, error } = await query;
      if (error) throw error;
      return corsResponse(data);
    }

    // ── POST: create memory ─────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const { content, type = 'text', source = 'manual', summary, file_url,
              file_name, file_type, duration_sec, metadata = {} } = body;

      if (!content && !file_url) {
        return corsResponse({ error: 'content or file_url is required' }, 400);
      }

      const { data, error } = await db.from('memories').insert({
        user_id: uid, content: content ?? '', type, source, summary,
        file_url, file_name, file_type, duration_sec, metadata,
      }).select().single();

      if (error) throw error;
      return corsResponse(data, 201);
    }

    // ── PUT: update memory ──────────────────────────────
    if (req.method === 'PUT') {
      const body = await req.json();
      const { id, ...updates } = body;
      if (!id) return corsResponse({ error: 'id is required' }, 400);

      // Prevent overwriting user_id
      delete updates.user_id;

      const { data, error } = await db
        .from('memories')
        .update(updates)
        .eq('id', id)
        .eq('user_id', uid)         // RLS-like enforcement
        .select()
        .single();

      if (error) throw error;
      return corsResponse(data);
    }

    // ── DELETE: remove memory ───────────────────────────
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return corsResponse({ error: 'id query param is required' }, 400);

      const { error } = await db
        .from('memories')
        .delete()
        .eq('id', id)
        .eq('user_id', uid);

      if (error) throw error;
      return corsResponse({ ok: true });
    }

    return corsResponse({ error: 'Method not allowed' }, 405);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status  = message.includes('expired') || message.includes('signature') ? 401 : 500;
    return corsResponse({ error: message }, status);
  }
});
