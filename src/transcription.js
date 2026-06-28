/**
 * transcription.js
 * Sends audio blob to Groq's Whisper API for transcription.
 */

/**
 * @param {Blob} audioBlob
 * @param {string} apiKey  Groq API key (free at console.groq.com)
 * @returns {Promise<string>} transcript text
 */
export async function transcribeAudio(audioBlob, apiKey) {
  if (!apiKey) {
    throw new Error('No Groq API key. Add one in ⚙️ Settings to enable audio transcription.');
  }

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

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      msg = err?.error?.message || msg;
    } catch {}
    throw new Error(`Transcription failed: ${msg}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}
