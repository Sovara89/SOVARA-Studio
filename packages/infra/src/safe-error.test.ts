import { describe, expect, test } from 'vitest';
import { safeErrorFields } from './safe-error.js';

describe('safeErrorFields', () => {
  test('never serializes messages, causes, stacks, URLs, or token-like values', () => {
    const error = Object.assign(
      new Error('token=secret https://provider.example/upload?access_token=secret'),
      {
        code: 'PROVIDER_TIMEOUT',
        cause: { refreshToken: 'secret-refresh-token' },
      },
    );
    const fields = safeErrorFields(error);
    expect(fields).toEqual({ errorName: 'Error', errorCode: 'PROVIDER_TIMEOUT' });
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(JSON.stringify(fields)).not.toContain('provider.example');
  });

  test('rejects unsafe provider-controlled names and codes', () => {
    expect(safeErrorFields({ name: 'Error token=secret', code: 'https://secret' })).toEqual({
      errorName: 'UnknownError',
      errorCode: 'UNKNOWN',
    });
  });
});
