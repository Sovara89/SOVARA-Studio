import { createPublishingAccountRepository, type createDatabase } from '@sovara-studio/db';
import {
  decryptCredential,
  encryptCredential,
  type CredentialKeyring,
} from './credential-crypto.js';
import {
  OAuthProviderError,
  type OAuthPlatform,
  type OAuthProvider,
} from '@sovara-studio/platforms';

type Database = ReturnType<typeof createDatabase>;
type AccountRepository = ReturnType<typeof createPublishingAccountRepository>;

export class CredentialServiceError extends Error {
  constructor(readonly code: 'reauthorization_required' | 'refresh_in_progress') {
    super(code);
    this.name = 'CredentialServiceError';
  }
}

type PublishingCredentialServiceOptions = {
  database: Database;
  credentialConfiguration: { keyring: CredentialKeyring; activeKeyId: string };
  providers: Partial<Record<OAuthPlatform, OAuthProvider>>;
  now?: () => Date;
  refreshLeaseMs?: number;
  providerRequestTimeoutMs?: number;
};

async function refreshWithTimeout(
  provider: OAuthProvider,
  input: { refreshToken: string; providerDeviceId?: string },
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.refreshToken({ ...input, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new OAuthProviderError(provider.platform, 0, 'timeout', 'ambiguous'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createPublishingCredentialService(options: PublishingCredentialServiceOptions) {
  const accounts: AccountRepository = createPublishingAccountRepository(options.database.db);
  const now = options.now ?? (() => new Date());
  const refreshLeaseMs = options.refreshLeaseMs ?? 30_000;
  const providerRequestTimeoutMs = options.providerRequestTimeoutMs ?? 10_000;
  const refreshLeaseSafetyMs = 1_000;
  if (refreshLeaseMs <= providerRequestTimeoutMs + refreshLeaseSafetyMs)
    throw new Error('Refresh lease must exceed provider timeout plus safety margin');

  function providerFor(platform: OAuthPlatform) {
    const provider = options.providers[platform];
    if (!provider) throw new CredentialServiceError('reauthorization_required');
    return provider;
  }

  const getAccessTokenSnapshot = async (
    userId: string,
    id: string,
    input: { forceRefresh?: boolean; expectedCredentialRevision?: number } = {},
  ) => {
    const rows = await accounts.findByIdForUser(userId, id);
    const account = rows[0];
    if (!account || account.status !== 'active' || !account.accessTokenCiphertext)
      throw new CredentialServiceError('reauthorization_required');
    if (
      input.expectedCredentialRevision !== undefined &&
      account.credentialRevision !== input.expectedCredentialRevision
    )
      throw new CredentialServiceError('refresh_in_progress');
    const current = now();
    if (
      account.accessTokenExpiresAt &&
      !input.forceRefresh &&
      account.accessTokenExpiresAt.getTime() > current.getTime() + 60_000
    ) {
      const accessToken = decryptCredential(
        account.accessTokenCiphertext,
        account.id,
        account.platform,
        'access',
        options.credentialConfiguration.keyring,
      );
      return {
        accountId: account.id,
        userId: account.userId,
        platform: account.platform as OAuthPlatform,
        credentialRevision: account.credentialRevision,
        accessToken,
        providerAccountId: account.providerAccountId!,
        scopes: account.scopes,
      };
    }
    if (!account.refreshTokenCiphertext)
      throw new CredentialServiceError('reauthorization_required');
    const lease = await accounts.acquireRefreshLease(
      account.id,
      userId,
      account.platform,
      account.credentialRevision,
      current,
      refreshLeaseMs,
    );
    if (!lease) {
      const latest = (await accounts.findByIdForUser(userId, id))[0];
      if (
        latest?.accessTokenExpiresAt &&
        !input.forceRefresh &&
        latest.accessTokenExpiresAt.getTime() > now().getTime() + 60_000 &&
        latest.accessTokenCiphertext
      ) {
        const accessToken = decryptCredential(
          latest.accessTokenCiphertext,
          latest.id,
          latest.platform,
          'access',
          options.credentialConfiguration.keyring,
        );
        return {
          accountId: latest.id,
          userId: latest.userId,
          platform: latest.platform as OAuthPlatform,
          credentialRevision: latest.credentialRevision,
          accessToken,
          providerAccountId: latest.providerAccountId!,
          scopes: latest.scopes,
        };
      }
      throw new CredentialServiceError('refresh_in_progress');
    }
    try {
      const claimedRows = await accounts.findByIdForUser(userId, id);
      const claimed = claimedRows[0];
      if (
        !claimed ||
        claimed.userId !== userId ||
        claimed.platform !== account.platform ||
        claimed.status !== 'active' ||
        claimed.credentialRevision !== account.credentialRevision ||
        claimed.credentialRevision !== lease.account.credentialRevision ||
        claimed.refreshLeaseToken !== lease.leaseToken ||
        !claimed.refreshTokenCiphertext
      )
        throw new CredentialServiceError('refresh_in_progress');
      const provider = providerFor(claimed.platform as OAuthPlatform);
      const refreshToken = decryptCredential(
        claimed.refreshTokenCiphertext,
        claimed.id,
        claimed.platform,
        'refresh',
        options.credentialConfiguration.keyring,
      );
      const providerDeviceId = claimed.providerDeviceIdCiphertext
        ? decryptCredential(
            claimed.providerDeviceIdCiphertext,
            claimed.id,
            claimed.platform,
            'metadata',
            options.credentialConfiguration.keyring,
          )
        : undefined;
      let refreshed;
      try {
        refreshed = await refreshWithTimeout(
          provider,
          { refreshToken, providerDeviceId },
          providerRequestTimeoutMs,
        );
      } catch (error) {
        if (error instanceof OAuthProviderError) throw error;
        throw new OAuthProviderError(provider.platform, 0, 'network_error', 'ambiguous');
      }
      const refreshNow = now();
      const persisted = await accounts.persistRefresh(
        claimed.id,
        claimed.credentialRevision,
        lease.leaseToken,
        {
          accessTokenCiphertext: encryptCredential(
            refreshed.accessToken,
            claimed.id,
            claimed.platform,
            'access',
            options.credentialConfiguration.activeKeyId,
            options.credentialConfiguration.keyring,
          ),
          refreshTokenCiphertext:
            refreshed.refreshToken && refreshed.refreshToken.length > 0
              ? encryptCredential(
                  refreshed.refreshToken,
                  claimed.id,
                  claimed.platform,
                  'refresh',
                  options.credentialConfiguration.activeKeyId,
                  options.credentialConfiguration.keyring,
                )
              : claimed.refreshTokenCiphertext,
          accessTokenExpiresAt: new Date(refreshNow.getTime() + refreshed.expiresInSeconds * 1000),
          scopes: refreshed.scopes.length > 0 ? refreshed.scopes : claimed.scopes,
          credentialFormatVersion: 1,
          credentialKeyId: options.credentialConfiguration.activeKeyId,
          credentialUpdatedAt: refreshNow,
          status: 'active',
          providerDeviceIdCiphertext:
            refreshed.providerDeviceId && refreshed.providerDeviceId.length > 0
              ? encryptCredential(
                  refreshed.providerDeviceId,
                  claimed.id,
                  claimed.platform,
                  'metadata',
                  options.credentialConfiguration.activeKeyId,
                  options.credentialConfiguration.keyring,
                )
              : claimed.providerDeviceIdCiphertext,
        },
      );
      if (!persisted[0]) {
        const latest = (await accounts.findByIdForUser(userId, id))[0];
        if (
          latest?.status === 'active' &&
          !input.forceRefresh &&
          latest.accessTokenExpiresAt &&
          latest.accessTokenExpiresAt.getTime() > now().getTime() + 60_000 &&
          latest.accessTokenCiphertext
        ) {
          const accessToken = decryptCredential(
            latest.accessTokenCiphertext,
            latest.id,
            latest.platform,
            'access',
            options.credentialConfiguration.keyring,
          );
          return {
            accountId: latest.id,
            userId: latest.userId,
            platform: latest.platform as OAuthPlatform,
            credentialRevision: latest.credentialRevision,
            accessToken,
            providerAccountId: latest.providerAccountId!,
            scopes: latest.scopes,
          };
        }
        throw new CredentialServiceError('reauthorization_required');
      }
      return {
        accountId: claimed.id,
        userId: claimed.userId,
        platform: claimed.platform as OAuthPlatform,
        credentialRevision: persisted[0]!.credentialRevision,
        accessToken: refreshed.accessToken,
        providerAccountId: persisted[0]!.providerAccountId!,
        scopes: persisted[0]!.scopes,
      };
    } catch (error) {
      const ambiguous = error instanceof OAuthProviderError && error.kind === 'ambiguous';
      if (
        error instanceof OAuthProviderError &&
        error.code === 'invalid_grant' &&
        error.kind === 'definite_response' &&
        error.status === 400
      ) {
        await accounts.markRefreshReauthorization(
          account.id,
          account.credentialRevision,
          lease.leaseToken,
        );
        throw new CredentialServiceError('reauthorization_required');
      }
      if (!ambiguous) await accounts.releaseRefreshLease(account.id, lease.leaseToken);
      throw error;
    }
  };
  return {
    getAccessTokenSnapshot,
    getAccessToken: async (
      userId: string,
      id: string,
      input: { forceRefresh?: boolean; expectedCredentialRevision?: number } = {},
    ) => (await getAccessTokenSnapshot(userId, id, input)).accessToken,
  };
}
