/**
 * transcription.js
 * Sends audio blob to Groq's Whisper API (via the ai-proxy Edge Function).
 */

import { callEdgeFnForm } from './services/api.js';

/**
 * Low-level Whisper request; returns Groq's raw response.
 * @param {Blob} audioBlob
 * @param {object} [opts]
 * @param {string} [opts.language]        ISO-639-1 code ('he', 'en'); empty = auto-detect
 * @param {string} [opts.prompt]          preceding text, for continuity across chunks
 * @param {string} [opts.responseFormat]  'json' | 'verbose_json' (adds segment timestamps)
 */
export async function requestTranscription(audioBlob, { language = '', prompt = '', responseFormat = 'json' } = {}) {
  // Determine file extension from MIME type
  const type = audioBlob.type || 'audio/webm';
  const ext  = type.includes('mp4') || type.includes('m4a') ? 'mp4'
             : type.includes('mpeg') || type.includes('mp3') ? 'mp3'
             : type.includes('ogg') ? 'ogg'
             : type.includes('wav') ? 'wav'
             : 'webm';

  const formData = new FormData();
  formData.append('file', audioBlob, `recording.${ext}`);
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', responseFormat);
  // Whisper's auto-detect often misreads short Hebrew clips, so pass a hint when known.
  if (language) formData.append('language', language);
  if (prompt) formData.append('prompt', prompt);

  return callEdgeFnForm('ai-proxy/transcribe', formData);
}

/**
 * @param {Blob} audioBlob
 * @param {string} [language]  ISO-639-1 code ('he', 'en'); empty = auto-detect
 * @returns {Promise<string>} transcript text
 */
export async function transcribeAudio(audioBlob, language = '') {
  let data;
  try {
    data = await requestTranscription(audioBlob, { language });
  } catch (err) {
    throw new Error(`Transcription failed: ${err.message}`);
  }

  return (data.text || '').trim();
}
