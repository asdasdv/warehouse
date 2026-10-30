import {defineConfig} from 'vite';
import {resolve} from 'node:path';

// Two pages: the Porter landing at / and the live warehouse demo at /demo/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, 'index.html'),
        demo: resolve(import.meta.dirname, 'demo/index.html'),
      },
    },
  },
});
