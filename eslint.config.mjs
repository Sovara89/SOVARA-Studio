import pluginTs from '@typescript-eslint/eslint-plugin';
import parserTs from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '.opencode/**',
      'node_modules/**',
      '**/dist/**',
      'coverage/**',
      '**/*.tsbuildinfo',
      '**/pnpm-lock.yaml',
    ],
  },
  {
    files: [
      'apps/web/**/*.{ts,tsx}',
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/**/*.ts',
      'vitest*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: {
      parser: parserTs,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {},
    },
    plugins: {
      '@typescript-eslint': pluginTs,
    },
    rules: {
      ...pluginTs.configs['recommended'].rules,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', importMeta: 'readonly' },
    },
  },
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' } },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'vitest*.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
  },
];
