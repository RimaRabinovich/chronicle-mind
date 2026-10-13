/**
 * media/transcribePipeline.js
 *
 * Long-media transcription: compress → chunk → transcribe each chunk → stitch.
 * Chunks are sent one at a time so each can use the previous chunk's ending
 * as a Whisper prompt (keeps names and spelling consistent across cuts).
 * Groq transcribes a 10-minute chunk in a few seconds, so this stays fast.
 *
 * Groq's free tier also caps audio at 7,200 seconds per hour (2 h of audio per
 * hour). When that's hit, Groq says how long to wait, and we wait it out.
 */

import { compressMedia } from './compress.js';
import { requestTranscription } from '../transcription.js';
import { retryDelayMs, sleep } from '../services/rateLimit.js';

// Whisper's per-request limit is 25 MB; keep a margin for multipart overhead.
export const MAX_DIRECT_BYTES = 24 * 1024 * 1024;

const MAX_ATTEMPTS = 4;              // network / server errors
const MAX_RATE_LIMIT_WAITS = 10;     // 429s, each waiting as long as Groq asks
const PROMPT_CHARS = 200;

/** Network errors (no status) and server errors are worth retrying. */
function isRetryable(err) {
  return !err.status || err.status >= 500;
}

/**
 * @param {() => Promise} fn
 * @param {AbortSignal} [signal]
 * @param {(waitMs: number) => void} [onWait]  called before waiting out a rate limit
 */
async function withRetry(fn, signal, onWait) {
  for (let attempt = 1, waits = 0; ; ) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429 && ++waits <= MAX_RATE_LIMIT_WAITS) {
        const ms = retryDelayMs(err.message);
        onWait?.(ms);
        await sleep(ms, signal);
        continue;
      }
      if (++attempt > MAX_ATTEMPTS || !isRetryable(err)) throw err;
      await sleep(2_000 * 2 ** (attempt - 2), signal);
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
 * @param {Array<{text: string, segments: Array}>} [opts.done]  results of chunks already
 *        transcribed (from a resumed job); transcription continues after them
 * @param {(results: Array<{text: string, segments: Array}>) => Promise|void} [opts.onChunkDone]
 *        called with all results so far after each chunk, so they can be persisted
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {(waitMs: number, part: number, total: number) => void} [opts.onWait]
 *        called when Groq's rate limit makes us wait before a part
 * @param {AbortSignal} [opts.signal]  stops transcription (e.g. the memory was deleted)
 * @returns {Promise<{ text: string, segments: Array<[number, number, string]> }>}
 *          segments are [startSec, endSec, text] on the full-file timeline.
 */
export async function transcribeChunks(chunks, { language = '', done = [], onChunkDone, onProgress, onWait, signal } = {}) {
  const results = [...done];

  onProgress?.(results.length, chunks.length);
  for (let i = results.length; i < chunks.length; i++) {
    const { blob, start } = chunks[i];
    const prompt = promptFrom(results.findLast(r => r.text)?.text ?? '');
    const data = await withRetry(
      () => requestTranscription(blob, { language, prompt, responseFormat: 'verbose_json' }),
      signal,
      (ms) => onWait?.(ms, i + 1, chunks.length),
    ).catch(err => {
      if (signal?.aborted) throw err;
      throw new Error(`Transcription failed on part ${i + 1} of ${chunks.length}: ${err.message}`);
    });

    const segments = [];
    for (const seg of data.segments || []) {
      const segText = (seg.text || '').trim();
      if (!segText) continue;
      const round = (s) => Math.round((s + start) * 100) / 100;
      segments.push([round(seg.start), round(seg.end), segText]);
    }
    results.push({ text: (data.text || '').trim(), segments });
    await onChunkDone?.(results);
    onProgress?.(i + 1, chunks.length);
  }

  return {
    text: results.map(r => r.text).filter(Boolean).join(' '),
    segments: results.flatMap(r => r.segments),
  };
}
