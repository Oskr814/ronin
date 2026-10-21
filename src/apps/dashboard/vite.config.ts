import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard (#65): public/ is the shell, as is (index.html, app.js,
// app.css, the fonts), and src/ its pages in React (#235, stage 7), built
// into one pages.js next to app.js, which index.html loads first and app.js
// mounts each page with (window.roninPages). All of it into
// dist/public/dashboard, which the server serves (apps/api/http/static.ts).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../../dist/public/dashboard', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: { entryFileNames: 'pages.js', codeSplitting: false },
    },
  },
});
