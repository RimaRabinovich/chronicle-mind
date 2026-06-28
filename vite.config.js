import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['@huggingface/transformers']
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext'
  }
});
