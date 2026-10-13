import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // ffmpeg.wasm spawns its own worker; pre-bundling breaks its relative URLs
    exclude: ['@huggingface/transformers', '@ffmpeg/ffmpeg']
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext'
  }
});
