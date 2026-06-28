/**
 * ai.js — Groq LLM helpers (free tier)
 *  - summarizeContent: 2-sentence summary of a memory
 *  - extractEvents: pull dated life events from free-form text
 */

const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL     = 'llama-3.1-8b-instant';

async function groqChat(messages, apiKey, maxTokens = 600) {
  const res = await fetch(GROQ_CHAT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, max_tokens: maxTokens })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq error ${res.status}`);
  }

  return (await res.json()).choices[0].message.content.trim();
}

/**
 * Summarize any text in 2 sentences.
 * @param {string} text
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function summarizeContent(text, apiKey) {
  if (!apiKey) throw new Error('No Groq API key — add VITE_GROQ_API_KEY to .env');
  return groqChat([{
    role: 'user',
    content:
      `Summarize the following text in exactly 2 sentences. Be concise and focus on the main point.\n\n"${text}"\n\nRespond with only the 2-sentence summary, nothing else.`
  }], apiKey, 220);
}

/**
 * Extract datable life events from free-form text.
 * Resolves relative dates ("last Wednesday", "3 years ago") to absolute dates.
 * @param {string} text
 * @param {string} apiKey
 * @returns {Promise<Array<{date:string, title:string, description:string}>>}
 */
export async function extractEvents(text, apiKey) {
  if (!apiKey) return [];
  const today = new Date().toISOString().slice(0, 10);

  let raw;
  try {
    raw = await groqChat([{
      role: 'user',
      content:
        `Today is ${today}.\n` +
        `Extract every event or life moment from the text below that has a specific or implied date ` +
        `(e.g. "last Wednesday", "yesterday", "born on Sep 24 1992", "3 years ago", etc.).\n\n` +
        `Return ONLY a valid JSON array — no explanation, no markdown fences. Format:\n` +
        `[{"date":"YYYY-MM-DD","title":"short event title","description":"one sentence"}]\n\n` +
        `If no datable events are found, return exactly: []\n\n` +
        `Text: "${text}"`
    }], apiKey, 500);
  } catch {
    return [];
  }

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const events = JSON.parse(match[0]);
    // Basic validation
    return events.filter(e => e.date && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
  } catch {
    return [];
  }
}
