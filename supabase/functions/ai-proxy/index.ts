/**
 * Edge Function: /functions/v1/ai-proxy
 *
 * Stateless passthrough to Groq so the API key never reaches the browser.
 *
 *   POST /ai-proxy/transcribe  multipart (file, model, response_format, prompt?, language?)
 *                              → Groq audio/transcriptions response
 *   POST /ai-proxy/chat        { model, messages, ... } → Groq chat/completions response
 *
 * Request and response bodies are never logged or stored.
 */

import { verifyFirebaseToken } from '../_shared/firebase-verify.ts';
import { corsHeaders, corsResponse, handleOptions } from '../_shared/cors.ts';

const PROJECT_ID   = Deno.env.get('FIREBASE_PROJECT_ID')!;
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!;
const GROQ_BASE    = 'https://api.groq.com/openai/v1';

const CHAT_MODELS = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
const WHISPER_MODELS = new Set(['whisper-large-v3', 'whisper-large-v3-turbo']);
const MAX_TOKENS_CAP = 4096;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq Whisper per-request limit

// Chat fields forwarded to Groq; anything else is dropped.
const CHAT_FIELDS = [
  'messages', 'temperature', 'top_p', 'stop', 'response_format',
  'reasoning_effort', 'include_reasoning', 'seed',
];
const TRANSCRIBE_FIELDS = ['response_format', 'prompt', 'language', 'temperature'];

// ── Per-uid rate limit ─────────────────────────────────
// In-memory, so it is per isolate and resets on cold start. Good enough to
// stop a runaway client; Groq's own limits remain the hard ceiling.
const WINDOW_MS = 60_000;
const LIMITS = { chat: 30, transcribe: 20 };
const hits = new Map<string, number[]>();

function rateLimited(uid: string, route: keyof typeof LIMITS): boolean {
  const key = `${route}:${uid}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMITS[route]) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Stream Groq's response back with CORS headers, without reading the body. */
function relay(res: Response): Response {
  return new Response(res.body, {
    status: res.status,
    headers: {
      ...corsHeaders,
      'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

async function handleChat(req: Request): Promise<Response> {
  const body = await req.json();
  if (!CHAT_MODELS.has(body.model)) {
    return corsResponse({ error: `Model not allowed: ${body.model}` }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return corsResponse({ error: 'messages is required' }, 400);
  }

  const payload: Record<string, unknown> = {
    model: body.model,
    max_tokens: Math.min(Number(body.max_tokens) || 600, MAX_TOKENS_CAP),
  };
  for (const f of CHAT_FIELDS) if (body[f] !== undefined) payload[f] = body[f];

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return relay(res);
}

async function handleTranscribe(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get('file');
  const model = String(form.get('model') ?? 'whisper-large-v3');

  if (!(file instanceof File)) return corsResponse({ error: 'file is required' }, 400);
  if (file.size > MAX_AUDIO_BYTES) {
    return corsResponse({ error: 'Audio file exceeds 25 MB' }, 413);
  }
  if (!WHISPER_MODELS.has(model)) {
    return corsResponse({ error: `Model not allowed: ${model}` }, 400);
  }

  const out = new FormData();
  out.append('file', file, file.name);
  out.append('model', model);
  for (const f of TRANSCRIBE_FIELDS) {
    const v = form.get(f);
    if (typeof v === 'string' && v) out.append(f, v);
  }

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: out,
  });
  return relay(res);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return corsResponse({ error: 'POST only' }, 405);

  let uid: string;
  try {
    uid = (await verifyFirebaseToken(req.headers.get('Authorization'), PROJECT_ID)).uid;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return corsResponse({ error: message }, 401);
  }

  const route = new URL(req.url).pathname.split('/').pop();
  if (route !== 'chat' && route !== 'transcribe') {
    return corsResponse({ error: 'Unknown route; use /chat or /transcribe' }, 404);
  }
  if (rateLimited(uid, route)) {
    return corsResponse({ error: 'Too many requests, slow down' }, 429);
  }

  try {
    return route === 'chat' ? await handleChat(req) : await handleTranscribe(req);
  } catch (err) {
    // Log only the error message, never the request body.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ai-proxy ${route} failed: ${message}`);
    return corsResponse({ error: 'AI proxy error' }, 502);
  }
});
