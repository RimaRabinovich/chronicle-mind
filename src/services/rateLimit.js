/**
 * src/services/rateLimit.js
 *
 * Helpers for waiting out Groq rate limits (429), which say how long to wait,
 * e.g. "Please try again in 3m36.5s".
 */

/** Milliseconds Groq asks us to wait (plus a small margin), or `fallbackMs` if it doesn't say. */
export function retryDelayMs(message, fallbackMs = 15_000) {
  const m = /try again in (?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(message || '');
  const ms = m ? (+(m[1] || 0)) * 60_000 + (+(m[2] || 0)) * 1000 + (+(m[3] || 0)) : 0;
  return (ms || fallbackMs) + 500;
}

/** setTimeout as a promise; rejects with the signal's reason if aborted. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
