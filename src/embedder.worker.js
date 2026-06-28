/**
 * embedder.worker.js
 * Runs Transformers.js (all-MiniLM-L6-v2) in a Web Worker
 * so the main thread stays responsive during model load + inference.
 */
import { pipeline, env } from '@huggingface/transformers';

// Use Hugging Face CDN — no local models needed
env.allowLocalModels = false;
env.useBrowserCache  = true;

let embedder = null;

async function load() {
  embedder = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    {
      progress_callback: (info) => {
        self.postMessage({ type: 'progress', data: info });
      }
    }
  );
}

async function embed(text, id) {
  if (!embedder) await load();
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

self.addEventListener('message', async (e) => {
  const { type, text, id } = e.data;

  try {
    if (type === 'load') {
      await load();
      self.postMessage({ type: 'loaded' });
    }

    if (type === 'embed') {
      const embedding = await embed(text, id);
      self.postMessage({ type: 'embedding', embedding, id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, id });
  }
});
