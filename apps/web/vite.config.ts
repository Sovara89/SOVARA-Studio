import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        main: resolve(__dirname, 'index.html'),
        'bundle-smoke': resolve(__dirname, 'src/bundle-smoke-entry.ts'),
      },
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
