/**
 * Edge Function: /functions/v1/events
 *
 * GET    → list all life events for the user, sorted by date
 * POST   → create a new life event
 * PUT    → update an existing event (body must include id)
 * DELETE → delete an event by id (?id=...)
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsResponse, handleOptions } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/supabase-client.ts';

const PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID')!;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();

  try {
    const claims = await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID);
    const uid = claims.uid;
    const db  = getServiceClient();
    const url = new URL(req.url);

    // ── GET ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await db
        .from('life_events')
        .select('*')
        .eq('user_id', uid)
        .order('date', { ascending: true, nullsFirst: false });

      if (error) throw error;
      return corsResponse(data);
    }

    // ── POST ────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const { title, date, description, memory_id, memory_snippet } = body;

      if (!title) return corsResponse({ error: 'title is required' }, 400);

      const { data, error } = await db.from('life_events').insert({
        user_id: uid, title, date, description, memory_id, memory_snippet,
      }).select().single();

      if (error) throw error;
      return corsResponse(data, 201);
    }

    // ── PUT ─────────────────────────────────────────────
    if (req.method === 'PUT') {
      const body = await req.json();
      const { id, ...updates } = body;
      if (!id) return corsResponse({ error: 'id is required' }, 400);
      delete updates.user_id;

      const { data, error } = await db
        .from('life_events')
        .update(updates)
        .eq('id', id)
        .eq('user_id', uid)
        .select()
        .single();

      if (error) throw error;
      return corsResponse(data);
    }

    // ── DELETE ──────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return corsResponse({ error: 'id query param required' }, 400);

      const { error } = await db
        .from('life_events')
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
