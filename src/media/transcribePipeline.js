/**
 * media/transcribePipeline.js
 *
 * Long-media transcription: compress → chunk → transcribe each chunk → stitch.
 * Chunks are sent one at a time so each can use the previous chunk's ending
 * as a Whisper prompt (keeps names and spelling consistent across cuts).
 * Groq transcribes a 10-minute chunk in a few seconds, so this stays fast.
 */

import { compressMedia } from './compress.js';
import { requestTranscription } from '../transcription.js';

// Whisper's per-request limit is 25 MB; keep a margin for multipart overhead.
export const MAX_DIRECT_BYTES = 24 * 1024 * 1024;

const MAX_ATTEMPTS = 4;
const PROMPT_CHARS = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Network errors (no status), rate limits and server errors are worth retrying. */
function isRetryable(err) {
  return !err.status || err.status === 429 || err.status >= 500;
}

async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      const base = err.status === 429 ? 10_000 : 2_000;
      await sleep(base * 2 ** (attempt - 1));
    }
  }
}

/** The tail of the previous chunk, trimmed to start at a word boundary. */
function promptFrom(text) {
  if (text.length <= PROMPT_CHARS) return text;
  const tail = text.slice(-PROMPT_CHARS);
  const space = tail.indexOf(' ');
  return space === -1 ? tail : tail.slice(space + 1);
}

/**
 * Compress a media blob and split it into Whisper-sized chunks.
 * If ffmpeg.wasm can't run (old browser, unsupported codec) and the original is
 * small enough, falls back to sending it as a single chunk.
 * @returns {Promise<{ audio: Blob|null, chunks: Array<{blob: Blob, start: number, end: number}>, duration: number|null, createdAt: string|null }>}
 *          `audio` is the compressed file, or null when the fallback was used.
 */
export async function prepareAudio(blob, { durationSec, onProgress } = {}) {
  try {
    return await compressMedia(blob, { durationSec, onProgress });
  } catch (err) {
    if (blob.size > MAX_DIRECT_BYTES) {
      throw new Error(`Could not compress this file for transcription: ${err.message}`);
    }
    console.warn('Compression failed, sending the original file:', err);
    return {
      audio: null,
      chunks: [{ blob, start: 0, end: durationSec ?? 0 }],
      duration: durationSec ?? null,
      createdAt: null,
    };
  }
}

/**
 * Transcribe chunks in order and stitch the results.
 * @param {Array<{blob: Blob, start: number}>} chunks
 * @param {object} [opts]
 * @param {string} [opts.language]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{ text: string, segments: Array<[number, number, string]> }>}
 *          segments are [startSec, endSec, text] on the full-file timeline.
 */
export async function transcribeChunks(chunks, { language = '', onProgress } = {}) {
  const texts = [];
  const segments = [];
  let prompt = '';

  onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const { blob, start } = chunks[i];
    const data = await withRetry(() =>
      requestTranscription(blob, { language, prompt, responseFormat: 'verbose_json' }),
    ).catch(err => {
      throw new Error(`Transcription failed on part ${i + 1} of ${chunks.length}: ${err.message}`);
    });

    const text = (data.text || '').trim();
    if (text) {
      texts.push(text);
      prompt = promptFrom(text);
    }
    for (const seg of data.segments || []) {
      const segText = (seg.text || '').trim();
      if (!segText) continue;
      const round = (s) => Math.round((s + start) * 100) / 100;
      segments.push([round(seg.start), round(seg.end), segText]);
    }
    onProgress?.(i + 1, chunks.length);
  }

  return { text: texts.join(' '), segments };
}
