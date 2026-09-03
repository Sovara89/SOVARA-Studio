import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  CredentialIntegrityError,
  CredentialKeyUnavailableError,
  decryptCredential,
  encryptCredential,
  parseCredentialKeyring,
} from './credential-crypto.js';

describe('credential crypto', () => {
  const key = randomBytes(32).toString('base64');
  const keyring = parseCredentialKeyring(JSON.stringify({ current: key }));

  test('round trips and uses a non-repeating envelope', () => {
    const first = encryptCredential('secret', 'account-1', 'youtube', 'access', 'current', keyring);
    const second = encryptCredential(
      'secret',
      'account-1',
      'youtube',
      'access',
      'current',
      keyring,
    );
    expect(first).not.toBe(second);
    expect(decryptCredential(first, 'account-1', 'youtube', 'access', keyring)).toBe('secret');
  });

  test('rejects tampering and wrong AAD', () => {
    const envelope = encryptCredential(
      'secret',
      'account-1',
      'youtube',
      'access',
      'current',
      keyring,
    );
    expect(() =>
      decryptCredential(`${envelope}x`, 'account-1', 'youtube', 'access', keyring),
    ).toThrow(CredentialIntegrityError);
    expect(() => decryptCredential(envelope, 'account-2', 'youtube', 'access', keyring)).toThrow(
      CredentialIntegrityError,
    );
    expect(() => decryptCredential(envelope, 'account-1', 'vk', 'access', keyring)).toThrow(
      CredentialIntegrityError,
    );
    expect(() => decryptCredential(envelope, 'account-1', 'youtube', 'refresh', keyring)).toThrow(
      CredentialIntegrityError,
    );
  });

  test('rejects malformed envelope fields and wrong keys without exposing secrets', () => {
    const envelope = encryptCredential(
      'secret',
      'account-1',
      'youtube',
      'access',
      'current',
      keyring,
    );
    expect(() => decryptCredential(envelope, 'account-1', 'youtube', 'access', {})).toThrow(
      CredentialKeyUnavailableError,
    );
    expect(() =>
      decryptCredential(
        envelope.replace(/\.[^.]+$/, '.AA'),
        'account-1',
        'youtube',
        'access',
        keyring,
      ),
    ).toThrow(CredentialIntegrityError);
    const fields = envelope.split('.');
    expect(() =>
      decryptCredential(
        [fields[0], fields[1], 'AQ', fields[3], fields[4]].join('.'),
        'account-1',
        'youtube',
        'access',
        keyring,
      ),
    ).toThrow(CredentialIntegrityError);
    expect(() =>
      decryptCredential(`${envelope}=`, 'account-1', 'youtube', 'access', keyring),
    ).toThrow(CredentialIntegrityError);
    expect(() =>
      decryptCredential(`${envelope}.extra`, 'account-1', 'youtube', 'access', keyring),
    ).toThrow(CredentialIntegrityError);
    expect(() =>
      decryptCredential(
        envelope,
        'account-1',
        'youtube',
        'access',
        parseCredentialKeyring(JSON.stringify({ old: key })),
      ).toString(),
    ).toThrow();
    expect(() =>
      parseCredentialKeyring(JSON.stringify({ current: randomBytes(16).toString('base64') })),
    ).toThrow();
    expect(() => parseCredentialKeyring('{')).toThrow();
    try {
      decryptCredential(`${envelope}.secret`, 'account-1', 'youtube', 'access', keyring);
    } catch (error) {
      expect(error).not.toHaveProperty('message', expect.stringContaining('secret'));
    }
  });

  test('decrypts with a historical key and rejects a wrong key', () => {
    const oldKey = randomBytes(32);
    const oldEnvelope = encryptCredential('historical', 'account-1', 'youtube', 'access', 'old', {
      old: oldKey,
    });
    expect(
      decryptCredential(oldEnvelope, 'account-1', 'youtube', 'access', {
        old: oldKey,
        current: randomBytes(32),
      }),
    ).toBe('historical');
    expect(() =>
      decryptCredential(oldEnvelope, 'account-1', 'youtube', 'access', { old: randomBytes(32) }),
    ).toThrow(CredentialIntegrityError);
  });
});
