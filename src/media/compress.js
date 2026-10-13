/**
 * media/compress.js
 *
 * In-browser audio extraction + compression with ffmpeg.wasm.
 *   any audio/video → mono 16 kHz Opus @ 32 kbps (≈ 14 MB per hour)
 *   → split into ~10-minute chunks for Whisper (25 MB per-request limit).
 *
 * ffmpeg.wasm runs in its own Web Worker, and the input is mounted via
 * WORKERFS so a large video is read lazily instead of copied into memory.
 * The ~32 MB wasm core is only downloaded the first time media is imported.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

export const SEGMENT_SEC = 600;

let ffmpegPromise = null;

function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    })().catch(err => {
      ffmpegPromise = null; // allow a retry on the next import
      throw err;
    });
  }
  return ffmpegPromise;
}

/** Parse "time=00:12:34.56" from an ffmpeg log line into seconds. */
function parseLogTime(message) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null;
}

/**
 * Parse the container's "creation_time : 2023-05-01T10:20:30.000000Z" (when the
 * phone/camera recorded it) into an ISO string. Ignores zero/epoch placeholder dates.
 */
function parseCreationTime(message) {
  const m = /creation_time\s*:\s*(\S+)/.exec(message);
  if (!m) return null;
  const d = new Date(m[1]);
  return !isNaN(d) && d.getFullYear() > 1980 ? d.toISOString() : null;
}

/**
 * Compress a media file to Opus audio and split it into chunks.
 * @param {Blob|File} file
 * @param {object}   [opts]
 * @param {number}   [opts.durationSec]  known duration, for progress reporting
 * @param {(stage: 'loading'|'compressing', ratio: number) => void} [opts.onProgress]
 * @returns {Promise<{ audio: Blob, chunks: Array<{ blob: Blob, start: number, end: number }>, duration: number, createdAt: string|null }>}
 *          `createdAt` is the recording date from the file's metadata, if present.
 */
export async function compressMedia(file, { durationSec, onProgress } = {}) {
  onProgress?.('loading', 0);
  const ffmpeg = await getFFmpeg();

  const ext = (file.name?.match(/\.[a-z0-9]+$/i)?.[0] || '').toLowerCase();
  const inputName = `input${ext}`;
  const recentLogs = [];
  let createdAt = null;

  const onLog = ({ message }) => {
    recentLogs.push(message);
    if (recentLogs.length > 20) recentLogs.shift();
    createdAt ??= parseCreationTime(message);
    const t = parseLogTime(message);
    if (t !== null && durationSec) onProgress?.('compressing', Math.min(t / durationSec, 1));
  };

  const run = async (args) => {
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error(`ffmpeg failed (exit ${code}): ${recentLogs.slice(-3).join(' | ')}`);
    }
  };

  ffmpeg.on('log', onLog);
  await ffmpeg.createDir('/in');
  await ffmpeg.mount('WORKERFS', { blobs: [{ name: inputName, data: file }] }, '/in');

  const segFiles = [];
  try {
    onProgress?.('compressing', 0);
    // Audio only, mono, 16 kHz Opus. 32 kbps in the default 'audio' mode: 16k/'voip'
    // high-passes and smears quiet or noisy speech, and Whisper then drops sentences.
    await run([
      '-i', `/in/${inputName}`,
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '32k',
      '/audio.webm',
    ]);

    // Split without re-encoding; the CSV list gives each chunk's exact start/end.
    await run([
      '-i', '/audio.webm',
      '-c', 'copy', '-f', 'segment',
      '-segment_time', String(SEGMENT_SEC),
      '-segment_format', 'webm',
      '-segment_list', '/segments.csv', '-segment_list_type', 'csv',
      '-reset_timestamps', '1',
      '/seg%03d.webm',
    ]);

    const audioData = await ffmpeg.readFile('/audio.webm');
    const audio = new Blob([audioData], { type: 'audio/webm' });

    const csv = new TextDecoder().decode(await ffmpeg.readFile('/segments.csv'));
    const chunks = [];
    for (const line of csv.trim().split('\n')) {
      const [name, start, end] = line.split(',');
      segFiles.push(`/${name}`);
      const data = await ffmpeg.readFile(`/${name}`);
      chunks.push({ blob: new Blob([data], { type: 'audio/webm' }), start: +start, end: +end });
    }

    onProgress?.('compressing', 1);
    return { audio, chunks, duration: chunks.at(-1)?.end ?? 0, createdAt };
  } finally {
    ffmpeg.off('log', onLog);
    for (const path of ['/audio.webm', '/segments.csv', ...segFiles]) {
      await ffmpeg.deleteFile(path).catch(() => {});
    }
    await ffmpeg.unmount('/in').catch(() => {});
    await ffmpeg.deleteDir('/in').catch(() => {});
  }
}
