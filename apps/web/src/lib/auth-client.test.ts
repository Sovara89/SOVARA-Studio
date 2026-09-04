// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';

describe('auth client', () => {
  test('initializes with the browser default auth URL', async () => {
    await expect(import('./auth-client.js')).resolves.toHaveProperty('authClient');
  });
});
