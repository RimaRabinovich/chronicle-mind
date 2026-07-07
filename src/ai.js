/**
 * ai.js — Groq LLM helpers (free tier)
 *  - summarizeContent: 2-sentence summary of a memory
 *  - extractEvents: pull dated life events from free-form text
 */

const GROQ_CHAT   = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL_FAST  = 'llama-3.1-8b-instant';       // fast, English-only tasks
const MODEL_MULTI = 'llama-3.3-70b-versatile';    // multilingual, Hebrew support

async function groqChat(messages, apiKey, maxTokens = 600, model = MODEL_FAST) {
  const res = await fetch(GROQ_CHAT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens })
  });


  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Groq error ${res.status}`);
  }

  return (await res.json()).choices[0].message.content.trim();
}

export async function summarizeContent(text, apiKey) {
  if (!apiKey) throw new Error('No Groq API key — add VITE_GROQ_API_KEY to .env');
  return groqChat([{
    role: 'user',
    content:
      `Summarize the following text in exactly 2 sentences. Be concise and focus on the main point.\n` +
      `Match the language of the source text (e.g., if the text is in Hebrew, write the summary in Hebrew; if in English, write it in English).\n\n` +
      `Text:\n"${text}"\n\nRespond with ONLY the 2-sentence summary in the matching language, no extra conversational text.`
  }], apiKey, 250);
}

/**
 * Salvage any complete JSON objects from a potentially truncated JSON array string.
 * Finds every well-formed {...} object in the string and parses them individually.
 */
function salvageEvents(raw) {
  const results = [];
  // Match every complete {...} block in the string
  const objectRegex = /\{[^{}]*\}/g;
  let match;
  while ((match = objectRegex.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.date && obj.title && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) {
        results.push(obj);
      }
    } catch {
      // skip malformed fragment
    }
  }
  return results;
}

/**
 * Extract datable life events from free-form text.
 * Supports timeline-format text (years as headers), Hebrew text,
 * and gracefully handles truncated LLM responses.
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
        `Extract every event, milestone, or life moment from the text below.\n` +
        `The text may be a structured timeline where years (e.g. 1992, 2011, 2024) appear on their own lines as headers, ` +
        `and the events for those years are listed on the lines below. Associate each event with its correct year.\n\n` +
        `Rules:\n` +
        `1. Output ONLY a raw JSON array. No markdown, no backticks, no explanation.\n` +
        `2. Each item: {"date":"YYYY-MM-DD","title":"...","description":"..."}\n` +
        `3. Year-only headers → use YYYY-01-01 (e.g. 1992 → "1992-01-01").\n` +
        `4. Write Hebrew text as-is with actual Hebrew characters (NOT \\uXXXX escapes).\n` +
        `5. If nothing found, return: []\n\n` +
        `Text:\n${text}`
    }], apiKey, 4096, MODEL_MULTI);




  } catch (err) {
    console.error('LLM call failed in extractEvents:', err);
    return [];
  }

  // First try: parse the complete JSON array
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const events = JSON.parse(match[0]);
      const validated = events.filter(e => e.date && e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date));

      return validated;
    }
  } catch {
    // fall through to salvage
  }

  // Fallback: salvage all complete {...} objects from a truncated response
  console.warn('Full JSON parse failed — attempting partial salvage.');
  const salvaged = salvageEvents(raw);

  return salvaged;
}
