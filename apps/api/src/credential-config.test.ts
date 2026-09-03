import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseCredentialConfiguration } from './credential-config.js';

const encodedKey = randomBytes(32).toString('base64');

describe('credential environment configuration', () => {
  test('accepts a valid keyring and active key', () => {
    const result = parseCredentialConfiguration(JSON.stringify({ current: encodedKey }), 'current');
    expect(result.activeKeyId).toBe('current');
    expect(result.keyring.current).toHaveLength(32);
  });

  test('rejects malformed JSON', () => {
    expect(() => parseCredentialConfiguration('{', 'current')).toThrow(
      'Invalid credential keyring',
    );
  });

  test('rejects a key with the wrong decoded length', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() =>
      parseCredentialConfiguration(JSON.stringify({ current: shortKey }), 'current'),
    ).toThrow('Credential key must be 32 bytes');
  });

  test('rejects an unknown active key', () => {
    expect(() =>
      parseCredentialConfiguration(JSON.stringify({ current: encodedKey }), 'missing'),
    ).toThrow('Active credential encryption key is unavailable');
  });
});
