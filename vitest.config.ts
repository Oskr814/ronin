import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The @apps/… @domains/… @platform/… @ui/… aliases (#310), as in
  // tsconfig.json: here by hand, because Vite only takes them from there for
  // the files that tsconfig includes, and test/ isn't one of them.
  resolve: {
    alias: [{ find: /^@(apps|domains|platform|ui)\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/$1/` }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
  },
});
