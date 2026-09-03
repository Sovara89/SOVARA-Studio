import { parseCredentialKeyring, type CredentialKeyring } from '@sovara-studio/infra';

export function parseCredentialConfiguration(
  rawKeyring: string,
  activeKeyId: string,
): { keyring: CredentialKeyring; activeKeyId: string } {
  const keyring = parseCredentialKeyring(rawKeyring);
  if (!keyring[activeKeyId]) throw new Error('Active credential encryption key is unavailable');
  return { keyring, activeKeyId };
}
