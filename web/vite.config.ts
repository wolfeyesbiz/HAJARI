import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output is served by the Express API server (single deployable unit).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
