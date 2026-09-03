import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createOAuthTransactionRepository,
  createPublishingAccountRepository,
  type createDatabase,
} from '@sovara-studio/db';
import { decryptCredential, encryptCredential, type CredentialKeyring } from '@sovara-studio/infra';
import {
  createPkcePair,
  createVkOAuthProvider,
  createYouTubeOAuthProvider,
  type OAuthPlatform,
  type OAuthProvider,
} from '@sovara-studio/platforms';
import type { OAuthConfiguration } from '../oauth-config.js';
import { createPublishingCredentialService } from '@sovara-studio/infra';

type Database = ReturnType<typeof createDatabase>;
type AccountRepository = ReturnType<typeof createPublishingAccountRepository>;
type TransactionRepository = ReturnType<typeof createOAuthTransactionRepository>;

export class OAuthServiceError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'invalid_state'
      | 'not_found'
      | 'conflict'
      | 'reauthorization_required'
      | 'refresh_in_progress',
  ) {
    super(code);
    this.name = 'OAuthServiceError';
  }
}

type OAuthServiceOptions = {
  database: Database;
  credentialConfiguration: { keyring: CredentialKeyring; activeKeyId: string };
  providers: Partial<Record<OAuthPlatform, OAuthProvider>>;
  redirectUris: Record<OAuthPlatform, string>;
  now?: () => Date;
  transactionTtlMs?: number;
  refreshLeaseMs?: number;
  providerRequestTimeoutMs?: number;
};

function hashState(state: string) {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function publicAccount(account: {
  id: string;
  platform: string;
  providerAccountId: string | null;
  displayName: string | null;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  status: string;
}) {
  return {
    id: account.id,
    platform: account.platform,
    providerAccountId: account.providerAccountId,
    displayName: account.displayName,
    scopes: account.scopes,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    status: account.status,
  };
}

export function createOAuthService(options: OAuthServiceOptions) {
  const accounts: AccountRepository = createPublishingAccountRepository(options.database.db);
  const transactions: TransactionRepository = createOAuthTransactionRepository(options.database.db);
  const now = options.now ?? (() => new Date());
  const transactionTtlMs = options.transactionTtlMs ?? 10 * 60 * 1000;
  const refreshLeaseMs = options.refreshLeaseMs ?? 30_000;
  const providerRequestTimeoutMs = options.providerRequestTimeoutMs ?? 10_000;
  const refreshLeaseSafetyMs = 1_000;
  if (refreshLeaseMs <= providerRequestTimeoutMs + refreshLeaseSafetyMs)
    throw new Error('Refresh lease must exceed provider timeout plus safety margin');

  function providerFor(platform: OAuthPlatform) {
    const provider = options.providers[platform];
    if (!provider) throw new OAuthServiceError('not_configured');
    return provider;
  }

  const credentialService = createPublishingCredentialService({
    database: options.database,
    credentialConfiguration: options.credentialConfiguration,
    providers: options.providers,
    now,
    refreshLeaseMs,
    providerRequestTimeoutMs,
  });

  return {
    start: async (
      userId: string,
      sessionId: string,
      platform: OAuthPlatform,
      accountId?: string,
    ) => {
      const provider = providerFor(platform);
      if (accountId) {
        const owned = await accounts.findByIdForUser(userId, accountId);
        if (!owned[0]) throw new OAuthServiceError('not_found');
        if (owned[0].platform !== platform) throw new OAuthServiceError('conflict');
      }
      const state = randomBytes(32).toString('base64url');
      const pkce = await createPkcePair();
      const transactionId = randomUUID();
      const encryptedVerifier = encryptCredential(
        pkce.verifier,
        transactionId,
        platform,
        'metadata',
        options.credentialConfiguration.activeKeyId,
        options.credentialConfiguration.keyring,
      );
      await transactions.create({
        id: transactionId,
        userId,
        sessionId,
        platform,
        stateHash: hashState(state),
        codeVerifierCiphertext: encryptedVerifier,
        publishingAccountId: accountId,
        redirectUri: options.redirectUris[platform],
        scopes: [...provider.scopes],
        expiresAt: new Date(now().getTime() + transactionTtlMs),
      });
      return {
        authorizationUrl: provider.authorizationUrl({ state, codeChallenge: pkce.challenge }),
      };
    },

    complete: async (input: {
      userId: string;
      sessionId: string;
      platform: OAuthPlatform;
      state: string;
      code: string;
      providerDeviceId?: string;
    }) => {
      const provider = providerFor(input.platform);
      const current = now();
      const rows = await transactions.findUsable(hashState(input.state), input.platform, current);
      const transaction = rows[0];
      if (
        !transaction ||
        transaction.userId !== input.userId ||
        transaction.sessionId !== input.sessionId ||
        transaction.redirectUri !== options.redirectUris[input.platform]
      )
        throw new OAuthServiceError('invalid_state');
      const consumed = await transactions.consume(transaction.id, current);
      if (!consumed[0]) throw new OAuthServiceError('invalid_state');
      const codeVerifier = decryptCredential(
        transaction.codeVerifierCiphertext,
        transaction.id,
        input.platform,
        'metadata',
        options.credentialConfiguration.keyring,
      );
      const targetRows = transaction.publishingAccountId
        ? await accounts.findByIdForUser(input.userId, transaction.publishingAccountId)
        : [];
      const targetAccount = targetRows[0];
      if (transaction.publishingAccountId && !targetAccount)
        throw new OAuthServiceError('not_found');
      if (targetAccount && targetAccount.platform !== input.platform)
        throw new OAuthServiceError('conflict');
      const reconnectExpected = targetAccount
        ? {
            accountId: targetAccount.id,
            userId: targetAccount.userId,
            platform: targetAccount.platform,
            providerAccountId: targetAccount.providerAccountId,
            credentialRevision: targetAccount.credentialRevision,
            status: targetAccount.status,
          }
        : undefined;
      const tokenSet = await provider.exchangeCode({
        code: input.code,
        codeVerifier,
        state: input.state,
        providerDeviceId: input.providerDeviceId,
      });
      const identity = await provider.identity(tokenSet.accessToken);
      if (
        targetAccount &&
        (!targetAccount.providerAccountId ||
          targetAccount.providerAccountId !== identity.providerAccountId)
      )
        throw new OAuthServiceError('conflict');
      const existing = await accounts.findByProviderIdentity(
        input.platform,
        identity.providerAccountId,
      );
      if (existing[0] && existing[0].userId !== input.userId)
        throw new OAuthServiceError('conflict');
      if (transaction.publishingAccountId && existing[0] && existing[0].id !== targetAccount?.id)
        throw new OAuthServiceError('conflict');
      const accountId = targetAccount?.id ?? existing[0]?.id ?? randomUUID();
      const credentialAccount = targetAccount ?? existing[0];
      const deviceCiphertext = tokenSet.providerDeviceId
        ? encryptCredential(
            tokenSet.providerDeviceId,
            accountId,
            input.platform,
            'metadata',
            options.credentialConfiguration.activeKeyId,
            options.credentialConfiguration.keyring,
          )
        : (credentialAccount?.providerDeviceIdCiphertext ?? null);
      const refreshTokenCiphertext =
        tokenSet.refreshToken && tokenSet.refreshToken.length > 0
          ? encryptCredential(
              tokenSet.refreshToken,
              accountId,
              input.platform,
              'refresh',
              options.credentialConfiguration.activeKeyId,
              options.credentialConfiguration.keyring,
            )
          : (credentialAccount?.refreshTokenCiphertext ?? null);
      const credentialValues = {
        displayName: identity.displayName,
        providerAccountId: identity.providerAccountId,
        accessTokenCiphertext: encryptCredential(
          tokenSet.accessToken,
          accountId,
          input.platform,
          'access',
          options.credentialConfiguration.activeKeyId,
          options.credentialConfiguration.keyring,
        ),
        refreshTokenCiphertext,
        accessTokenExpiresAt: new Date(current.getTime() + tokenSet.expiresInSeconds * 1000),
        providerDeviceIdCiphertext: deviceCiphertext,
        scopes: tokenSet.scopes.length > 0 ? tokenSet.scopes : [...provider.scopes],
        credentialFormatVersion: 1,
        credentialKeyId: options.credentialConfiguration.activeKeyId,
        credentialUpdatedAt: current,
      };
      const connected = reconnectExpected
        ? await accounts.settleReconnect({
            accountId: reconnectExpected.accountId,
            userId: reconnectExpected.userId,
            platform: reconnectExpected.platform,
            providerAccountId: reconnectExpected.providerAccountId!,
            expectedCredentialRevision: reconnectExpected.credentialRevision,
            expectedStatus: reconnectExpected.status,
            values: credentialValues,
          })
        : await accounts.connect(
            {
              id: accountId,
              userId: input.userId,
              platform: input.platform,
              ...credentialValues,
              status: 'active',
              credentialRevision: 0,
            },
            existing[0]?.id,
          );
      const result = connected[0];
      if (!result) throw new OAuthServiceError('conflict');
      return publicAccount(result);
    },

    list: async (userId: string) =>
      (await accounts.listForUser(userId)).map((account) => publicAccount(account)),

    disconnect: async (userId: string, id: string) => {
      const rows = await accounts.findByIdForUser(userId, id);
      const account = rows[0];
      if (!account) throw new OAuthServiceError('not_found');
      const disconnected = await accounts.disconnect(userId, id, account.credentialRevision);
      if (!disconnected[0]) throw new OAuthServiceError('not_found');
      if (account.accessTokenCiphertext) {
        try {
          const provider = providerFor(account.platform as OAuthPlatform);
          const accessToken = decryptCredential(
            account.accessTokenCiphertext,
            account.id,
            account.platform,
            'access',
            options.credentialConfiguration.keyring,
          );
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), providerRequestTimeoutMs);
          try {
            await provider.revoke(accessToken, controller.signal);
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          // Local revocation is authoritative when the provider is unavailable.
        }
      }
      return publicAccount(disconnected[0]);
    },

    getAccessToken: credentialService.getAccessToken,
  };
}

export function createConfiguredOAuthProviders(configuration: OAuthConfiguration) {
  const providers: Partial<Record<OAuthPlatform, OAuthProvider>> = {};
  if (configuration.youtube) providers.youtube = createYouTubeOAuthProvider(configuration.youtube);
  if (configuration.vk) providers.vk = createVkOAuthProvider(configuration.vk);
  return providers;
}
