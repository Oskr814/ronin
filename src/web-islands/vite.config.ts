import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard's sections in React (#235, stage 7), as islands inside the
// page app.js draws: one file, dist/web/islands.js, next to app.js, which
// index.html loads first and app.js mounts each section with
// (window.roninIslands). Built after src/web is copied, so it adds to it.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: { entryFileNames: 'islands.js', codeSplitting: false },
    },
  },
});
