import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The request portal's page (#114), with Vite and React (#235, stage 7):
// built into dist/public/portal, which the server serves (apps/api/http/portal.ts).
// What's in public/ (the CSS, the theme script, the icon) is copied as is:
// the server names it with its hash (static.ts), as before.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  // The @apps/… @domains/… @platform/… @ui/… aliases, from tsconfig.json (#310).
  resolve: { tsconfigPaths: true },
  build: {
    outDir: fileURLToPath(new URL('../../../dist/public/portal', import.meta.url)),
    emptyOutDir: true,
  },
  // `pnpm portal:dev`: the page on Vite, its API from a ronin server running
  // locally (`pnpm server`).
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 3939}`, '/fonts': `http://127.0.0.1:${process.env.PORT ?? 3939}` } },
});
