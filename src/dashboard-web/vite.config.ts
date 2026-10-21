import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard's pages in React (#235, stage 7), inside the shell app.js
// draws: one file, dist/web/pages.js, next to app.js, which index.html loads
// first and app.js mounts each page with (window.roninPages). Built after
// src/web is copied, so it adds to it.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: { entryFileNames: 'pages.js', codeSplitting: false },
    },
  },
});
