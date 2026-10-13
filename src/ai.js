/**
 * ai.js — Groq LLM helpers (free tier)
 *  - summarizeContent: 2-sentence summary of a memory (map → reduce for long texts)
 *  - extractEvents: pull dated life events from free-form text
 */

import { callEdgeFn } from './services/api.js';
import { retryDelayMs, sleep } from './services/rateLimit.js';

// Groq retired the Llama chat models; gpt-oss handles Hebrew well.
const MODEL_FAST  = 'openai/gpt-oss-20b';         // fast, multilingual — summaries
const MODEL_MULTI = 'openai/gpt-oss-120b';        // stronger — structured extraction

// Groq's free tier allows 8,000 tokens per minute per model, counting the prompt
// plus max_tokens, and rejects any single request above that. Long texts (e.g. an
// hour-long transcript) are therefore split into parts. Hebrew can take ~2.5 chars
// per token, so 8,000 chars stays near 3,200 tokens.
const PART_CHARS = 8000;
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_OUTPUT_TOKENS = 4096;  // ai-proxy's cap

// Goes through the ai-proxy Edge Function, which holds the Groq key.
// Waits and retries when the per-minute token limit is hit (429).
// gpt-oss reasoning shares max_tokens with the answer, so a reply cut off by the
// limit (finish_reason "length") is retried once with double the room.
async function groqChat(messages, maxTokens = 600, model = MODEL_FAST) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await callEdgeFn('ai-proxy/chat', {
        method: 'POST',
        // gpt-oss are reasoning models: reasoning tokens count toward max_tokens,
        // so keep effort low and don't return the reasoning text.
        body: {
          model, messages, temperature: 0.1, max_tokens: maxTokens,
          reasoning_effort: 'low', include_reasoning: false
        }
      });
      const choice = data.choices[0];
      if (choice.finish_reason === 'length' && maxTokens < MAX_OUTPUT_TOKENS) {
        maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
        continue;
      }
      return choice.message.content.trim();
    } catch (err) {
      if (err.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      await sleep(retryDelayMs(err.message));
    }
  }
}

/**
 * Split text into parts of at most `maxChars`, cutting at a sentence end
 * (or at least a space) in the last fifth of each part.
 */
function splitText(text, maxChars = PART_CHARS) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const minCut = Math.floor(maxChars * 0.8);
    let cut = Math.max(...['. ', '? ', '! ', '\n'].map(p => window.lastIndexOf(p)));
    if (cut < minCut) cut = window.lastIndexOf(' ');
    cut = cut < minCut ? maxChars : cut + 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const MATCH_LANGUAGE =
  `Match the language of the source text (e.g., if the text is in Hebrew, write the summary in Hebrew; if in English, write it in English).\n\n`;

/**
 * 2-sentence summary. Long texts are summarized part by part first, then the
 * part summaries are combined (map → reduce).
 */
export async function summarizeContent(text) {
  const parts = splitText(text);
  if (parts.length === 1) {
    return groqChat([{
      role: 'user',
      content:
        `Summarize the following text in exactly 2 sentences. Be concise, preserve all emotional depth, and focus on the main point, relationships, and key topics (such as family, mother, conflicts, decisions).\n` +
        MATCH_LANGUAGE +
        `Text:\n"${text}"\n\nRespond with ONLY the 2-sentence summary in the matching language, no extra conversational text.`
    }], 1200, MODEL_FAST);
  }

  const partSummaries = [];
  for (let i = 0; i < parts.length; i++) {
    partSummaries.push(await groqChat([{
      role: 'user',
      content:
        `This is part ${i + 1} of ${parts.length} of a long transcript. Summarize this part in 3-4 sentences, keeping the people, events, decisions, and feelings mentioned.\n` +
        MATCH_LANGUAGE +
        `Text:\n"${parts[i]}"\n\nRespond with ONLY the summary in the matching language, no extra conversational text.`
    }], 1200, MODEL_FAST));
  }

  return groqChat([{
    role: 'user',
    content:
      `Below are summaries of consecutive parts of one long recording. Combine them into exactly 2 sentences about the whole recording. Be concise, preserve all emotional depth, and focus on the main point, relationships, and key topics (such as family, mother, conflicts, decisions).\n` +
      MATCH_LANGUAGE +
      partSummaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n\n') +
      `\n\nRespond with ONLY the 2-sentence summary in the matching language, no extra conversational text.`
  }], 1200, MODEL_FAST);
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
 * @returns {Promise<Array<{date:string, title:string, description:string}>>}
 */
export async function extractEvents(text) {
  const parts = splitText(text);
  if (parts.length === 1) return extractEventsFromPart(text, 4096);

  // Long text: extract per part (smaller output cap so each request stays under
  // the per-minute token limit), then drop duplicates found in two parts.
  const seen = new Set();
  const all = [];
  for (const part of parts) {
    for (const ev of await extractEventsFromPart(part, 2048)) {
      const key = `${ev.date}|${ev.title.trim().toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); all.push(ev); }
    }
  }
  return all;
}

async function extractEventsFromPart(text, maxTokens) {
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
    }], maxTokens, MODEL_MULTI);




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
