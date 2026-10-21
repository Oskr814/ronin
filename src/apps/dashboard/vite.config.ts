import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard (#65): public/ as is (index.html, app.css, theme.js, the
// fonts), and src/ (the shell and its pages, in React since #235) built
// into one dashboard.js, which index.html loads. All of it into
// dist/public/dashboard, which the server serves (apps/api/http/static.ts).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  // The @apps/… @domains/… @platform/… @ui/… aliases, from tsconfig.json (#310).
  resolve: { tsconfigPaths: true },
  build: {
    outDir: fileURLToPath(new URL('../../../dist/public/dashboard', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: { entryFileNames: 'dashboard.js', codeSplitting: false },
    },
  },
});
