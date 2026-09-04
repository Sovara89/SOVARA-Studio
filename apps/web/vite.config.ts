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
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/sovara-uploads': { target: 'http://localhost:19000', changeOrigin: false },
    },
    allowedHosts: [
      new URL(process.env.APP_ORIGIN ?? 'http://localhost:5173').hostname,
      'defiantly-moved-snook.cloudpub.ru',
    ],
  },
});
