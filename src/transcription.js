/**
 * transcription.js
 * Sends audio blob to Groq's Whisper API (via the ai-proxy Edge Function).
 */

import { callEdgeFnForm } from './services/api.js';

/**
 * @param {Blob} audioBlob
 * @param {string} [language]  ISO-639-1 code ('he', 'en'); empty = auto-detect
 * @returns {Promise<string>} transcript text
 */
export async function transcribeAudio(audioBlob, language = '') {
  // Determine file extension from MIME type
  const type = audioBlob.type || 'audio/webm';
  const ext  = type.includes('mp4') ? 'mp4'
             : type.includes('ogg') ? 'ogg'
             : type.includes('wav') ? 'wav'
             : 'webm';

  const formData = new FormData();
  formData.append('file', audioBlob, `recording.${ext}`);
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'json');
  // Whisper's auto-detect often misreads short Hebrew clips, so pass a hint when known.
  if (language) formData.append('language', language);

  let data;
  try {
    data = await callEdgeFnForm('ai-proxy/transcribe', formData);
  } catch (err) {
    throw new Error(`Transcription failed: ${err.message}`);
  }

  return (data.text || '').trim();
}
