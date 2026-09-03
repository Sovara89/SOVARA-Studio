import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

export type CredentialTokenKind = 'access' | 'refresh' | 'metadata';
export type CredentialKeyring = Readonly<Record<string, Buffer>>;

export class CredentialIntegrityError extends Error {
  constructor() {
    super('Credential ciphertext integrity check failed');
    this.name = 'CredentialIntegrityError';
  }
}

export class CredentialKeyUnavailableError extends Error {
  constructor(keyId: string) {
    super(`Credential encryption key is unavailable: ${keyId}`);
    this.name = 'CredentialKeyUnavailableError';
  }
}

export function parseCredentialKeyring(raw: string): CredentialKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid credential keyring');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid credential keyring');
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error('Credential keyring is empty');
  return Object.fromEntries(
    entries.map(([id, encoded]) => {
      if (!/^[A-Za-z0-9._-]+$/.test(id) || typeof encoded !== 'string')
        throw new Error('Invalid credential keyring entry');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        throw new Error('Invalid credential keyring entry');
      const key = Buffer.from(encoded, 'base64');
      if (key.toString('base64') !== encoded) throw new Error('Invalid credential keyring entry');
      if (key.length !== KEY_BYTES) throw new Error(`Credential key must be ${KEY_BYTES} bytes`);
      return [id, key];
    }),
  );
}

function decodeBase64Url(value: string, allowEmpty = false) {
  if ((!allowEmpty && value.length === 0) || !/^[A-Za-z0-9_-]*$/.test(value))
    throw new CredentialIntegrityError();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new CredentialIntegrityError();
  return decoded;
}

function aad(accountId: string, platform: string, tokenKind: CredentialTokenKind) {
  return Buffer.from(
    `sovara-studio:publishing-account:${accountId}:${platform}:${tokenKind}:${VERSION}`,
  );
}

function requireKey(key: Buffer | undefined): Buffer {
  if (!key || key.length !== KEY_BYTES) throw new Error('Invalid credential encryption key');
  return key;
}

export function encryptCredential(
  value: string,
  accountId: string,
  platform: string,
  tokenKind: CredentialTokenKind,
  activeKeyId: string,
  keyring: CredentialKeyring,
) {
  const key = requireKey(keyring[activeKeyId]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(accountId, platform, tokenKind));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${VERSION}.${activeKeyId}.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function decryptCredential(
  envelope: string,
  accountId: string,
  platform: string,
  tokenKind: CredentialTokenKind,
  keyring: CredentialKeyring,
) {
  const parts = envelope.split('.');
  if (
    parts.length !== 5 ||
    parts[0] !== VERSION ||
    !parts[1] ||
    !parts[2] ||
    parts[3] === undefined ||
    !parts[4]
  )
    throw new CredentialIntegrityError();
  const [, keyId, encodedNonce, encodedCiphertext, encodedTag] = parts;
  if (!/^[A-Za-z0-9._-]+$/.test(keyId)) throw new CredentialIntegrityError();
  const key = keyring[keyId];
  if (!key) throw new CredentialKeyUnavailableError(keyId);
  try {
    requireKey(key);
    const nonce = decodeBase64Url(encodedNonce);
    const ciphertext = decodeBase64Url(encodedCiphertext, true);
    const tag = decodeBase64Url(encodedTag);
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES)
      throw new CredentialIntegrityError();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(accountId, platform, tokenKind));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialIntegrityError();
  }
}
