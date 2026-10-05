import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // hls.js — самый крупный кусок, и он грузится только на странице просмотра.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
