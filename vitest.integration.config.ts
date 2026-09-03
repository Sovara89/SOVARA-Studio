import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/integration/**/*.{test,spec}.{ts,tsx}',
      'apps/api/src/**/*.integration.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
