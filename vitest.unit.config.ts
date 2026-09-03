import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/src/**/*.{test,spec}.{ts,tsx}', 'packages/**/src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
      'tests/integration/**',
    ],
    environment: 'node',
  },
});
