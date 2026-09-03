import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  account as authAccount,
  applyMigrations,
  createDatabase,
  createPublishingAccountRepository,
  oauthTransaction,
  publishingAccount,
  session as dbSession,
} from '@sovara-studio/db';
import { decryptCredential, encryptCredential, parseCredentialKeyring } from '@sovara-studio/infra';
import { OAuthProviderError } from '@sovara-studio/platforms';
import type { OAuthProvider } from '@sovara-studio/platforms';
import { createAuth } from './auth/options.js';
import { registerApp } from './app.js';
import { createOAuthService } from './services/oauth-service.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-009 integration');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_oauth_test_${suffix}`;
const migrationRole = `sovara_oauth_migration_${suffix}`;
const runtimeRole = `sovara_oauth_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();

let database: ReturnType<typeof createDatabase>;
let migrationDatabaseUrl: string;
let runtimeDatabaseUrl: string;
let auth: ReturnType<typeof createAuth>;
let provisioningAuth: ReturnType<typeof createAuth>;
let server: ReturnType<typeof Fastify>;
let oauthService: ReturnType<typeof createOAuthService>;

const credentialKey = randomBytes(32).toString('base64');
const keyring = parseCredentialKeyring(JSON.stringify({ 'test-key': credentialKey }));
const credentialConfiguration = { keyring, activeKeyId: 'test-key' };
const appOrigin = 'http://localhost:5173';
const youtubeRedirect = `${appOrigin}/api/publishing-accounts/youtube/oauth/callback`;
const vkRedirect = `${appOrigin}/api/publishing-accounts/vk/oauth/callback`;

let youtubeIdentityId = 'youtube-channel-123';
let vkIdentityId = 'vk-user-456';
let youtubeRefreshBehavior:
  'success' | 'omit' | 'fail400' | 'other400' | 'fail500' | 'timeout' | 'reset' | 'gate' =
  'success';
let vkRefreshBehavior:
  'success' | 'omit' | 'fail400' | 'other400' | 'fail500' | 'timeout' | 'reset' | 'gate' =
  'success';
let exchangeRefreshToken = true;
let refreshCalls = 0;
let refreshStartedResolve: (() => void) | undefined;
let refreshGateResolve: (() => void) | undefined;
const revoked: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const identityGates = new Map<
  string,
  { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> }
>();

function createFakeProvider(platform: 'youtube' | 'vk'): OAuthProvider {
  const scopes =
    platform === 'youtube'
      ? [
          'https://www.googleapis.com/auth/youtube.readonly',
          'https://www.googleapis.com/auth/youtube.upload',
        ]
      : ['vkid.personal_info', 'video'];
  return {
    platform,
    scopes,
    authorizationUrl: ({ state, codeChallenge }) => {
      const url = new URL(
        platform === 'youtube'
          ? 'https://accounts.google.com/o/oauth2/v2/auth'
          : 'https://id.vk.ru/authorize',
      );
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('client_id', 'test-client');
      url.searchParams.set('redirect_uri', platform === 'youtube' ? youtubeRedirect : vkRedirect);
      return url.toString();
    },
    exchangeCode: async ({ code, codeVerifier }) => {
      if (!code || !codeVerifier) throw new OAuthProviderError(platform, 400, 'invalid_request');
      return {
        accessToken: `${platform}-access-${code}`,
        refreshToken: exchangeRefreshToken ? `${platform}-refresh-${code}` : undefined,
        expiresInSeconds: 3600,
        scopes: [...scopes],
      };
    },
    refreshToken: async ({ refreshToken, providerDeviceId }) => {
      refreshCalls += 1;
      refreshStartedResolve?.();
      const behavior = platform === 'youtube' ? youtubeRefreshBehavior : vkRefreshBehavior;
      if (behavior === 'fail400') throw new OAuthProviderError(platform, 400, 'invalid_grant');
      if (behavior === 'other400') throw new OAuthProviderError(platform, 400, 'invalid_client');
      if (behavior === 'fail500') throw new OAuthProviderError(platform, 500, 'server_error');
      if (behavior === 'reset') throw new Error('connection reset');
      if (behavior === 'timeout') return new Promise<never>(() => {});
      if (behavior === 'gate')
        await new Promise<void>((resolve) => {
          refreshGateResolve = resolve;
        });
      return {
        accessToken: `${platform}-refreshed-${refreshToken}`,
        refreshToken: behavior === 'omit' ? undefined : `${platform}-rotated-${refreshToken}`,
        expiresInSeconds: 3600,
        scopes: [...scopes],
        providerDeviceId,
      };
    },
    identity: async (accessToken) => {
      if (!accessToken) throw new OAuthProviderError(platform, 400, 'invalid_token');
      const prefix = `${platform}-access-`;
      const identityCode = accessToken.startsWith(prefix) ? accessToken.slice(prefix.length) : '';
      const gate = identityGates.get(identityCode);
      if (gate) {
        identityGates.delete(identityCode);
        gate.started.resolve();
        await gate.released.promise;
      }
      return {
        providerAccountId: platform === 'youtube' ? youtubeIdentityId : vkIdentityId,
        displayName: platform === 'youtube' ? 'YouTube Channel' : 'VK Account',
      };
    },
    revoke: async (accessToken) => {
      revoked.push(accessToken);
    },
  };
}

async function signUpAndSignIn(email: string, password: string) {
  const signed = await provisioningAuth.api.signUpEmail({
    body: { email, name: 'Tester', password },
  });
  if (!signed?.user) throw new Error('signUp failed');
  const login = await server.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers['set-cookie'] as unknown as string | string[];
  const cookie = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
  expect(cookie).toBeTruthy();
  const rows = await database.db
    .select()
    .from(dbSession)
    .where(eq(dbSession.userId, signed.user.id));
  const session = rows.find((s) => s.token && cookie.includes(s.token)) ?? rows[0];
  if (!session) throw new Error('session not found');
  return { userId: signed.user.id, cookie, sessionId: session.id };
}

function extractState(url: string) {
  return new URL(url).searchParams.get('state')!;
}

async function connectAccount(
  cookie: string,
  platform: 'youtube' | 'vk',
  code: string,
  accountId?: string,
) {
  const start = await server.inject({
    method: accountId ? 'POST' : 'GET',
    url: `/api/publishing-accounts/${platform}/oauth/${accountId ? 'reconnect' : 'start'}${
      accountId ? `?accountId=${accountId}` : ''
    }`,
    headers: { cookie, ...(accountId ? { origin: appOrigin } : {}) },
  });
  expect(start.statusCode).toBe(200);
  const state = extractState((start.json() as { authorizationUrl: string }).authorizationUrl);
  return server.inject({
    method: 'GET',
    url: `/api/publishing-accounts/${platform}/oauth/callback?code=${code}&state=${state}`,
    headers: { cookie },
  });
}

describe('TASK-009 OAuth account lifecycle', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE ${migrationRole} LOGIN PASSWORD '${migrationPassword}'`);
      await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
      await admin.query(`CREATE DATABASE ${databaseName} OWNER ${migrationRole}`);
    } finally {
      await admin.end();
    }
    const baseUrl = new URL(adminUrl);
    baseUrl.pathname = `/${databaseName}`;
    const migrationUrl = new URL(baseUrl);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    migrationDatabaseUrl = migrationUrl.toString();
    const migrationDb = createDatabase(migrationDatabaseUrl);
    await applyMigrations(migrationDb);
    await migrationDb.pool.end();

    const owner = new Client({ connectionString: baseUrl.toString() });
    await owner.connect();
    try {
      await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await owner.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, publishing_account, oauth_transaction TO ${runtimeRole}`,
      );
      await owner.query(`GRANT USAGE ON SCHEMA drizzle TO ${runtimeRole}`);
    } finally {
      await owner.end();
    }

    const runtimeUrl = new URL(baseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeDatabaseUrl = runtimeUrl.toString();
    database = createDatabase(runtimeDatabaseUrl);

    auth = createAuth(database, {
      secret: 'test-auth-secret-that-is-at-least-32-bytes',
      appOrigin,
    });
    provisioningAuth = createAuth(database, {
      secret: 'test-auth-secret-that-is-at-least-32-bytes',
      appOrigin,
      provisioning: true,
    });

    const youtubeProvider = createFakeProvider('youtube');
    const vkProvider = createFakeProvider('vk');
    oauthService = createOAuthService({
      database,
      credentialConfiguration,
      providers: { youtube: youtubeProvider, vk: vkProvider },
      redirectUris: { youtube: youtubeRedirect, vk: vkRedirect },
      providerRequestTimeoutMs: 50,
      refreshLeaseMs: 5_000,
    });

    server = Fastify({ logger: false });
    server.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    await server.register(registerApp, {
      prefix: '/api',
      auth,
      appOrigin,
      database,
      oauthService: oauthService as never,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await database?.pool.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${migrationRole}`);
    } finally {
      await admin.end();
    }
  });

  test('authenticated OAuth connect persists state, callback consumes once and persists encrypted credentials', async () => {
    const email = `oauth-${randomUUID()}@example.com`;
    const { userId, cookie } = await signUpAndSignIn(email, 'long-enough-password-123');

    const start = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts/youtube/oauth/start',
      headers: { cookie },
    });
    expect(start.statusCode).toBe(200);
    const { authorizationUrl } = start.json() as { authorizationUrl: string };
    expect(authorizationUrl).toContain('code_challenge');
    const state = extractState(authorizationUrl);
    expect(state.length).toBeGreaterThanOrEqual(32);

    const txRows = await database.db
      .select()
      .from(oauthTransaction)
      .where(eq(oauthTransaction.userId, userId));
    expect(txRows).toHaveLength(1);
    const tx = txRows[0]!;
    expect(tx.stateHash).toBe(createHash('sha256').update(state).digest('hex'));
    expect(tx.stateHash).not.toBe(state);
    expect(tx.codeVerifierCiphertext).not.toContain('plain');
    expect(tx.sessionId).toBeTruthy();
    expect(tx.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(tx.consumedAt).toBeNull();

    const callback = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/youtube/oauth/callback?code=code-1&state=${state}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(200);
    const account = callback.json() as { id: string; platform: string; status: string };
    expect(account.platform).toBe('youtube');
    expect(account.status).toBe('active');

    const listed = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts',
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    const list = listed.json() as unknown[];
    expect(list).toHaveLength(1);
    const listedStr = JSON.stringify(list);
    expect(listedStr).not.toContain('access_token');
    expect(listedStr).not.toContain('ciphertext');
    expect(listedStr).not.toContain('refresh');

    const dbAccounts = await database.db
      .select()
      .from(publishingAccount)
      .where(eq(publishingAccount.userId, userId));
    expect(dbAccounts).toHaveLength(1);
    const dbAcc = dbAccounts[0]!;
    expect(dbAcc.accessTokenCiphertext).toBeTruthy();
    expect(dbAcc.refreshTokenCiphertext).toBeTruthy();
    expect(dbAcc.providerAccountId).toBe(youtubeIdentityId);
    expect(dbAcc.status).toBe('active');
    // decrypt check
    expect(
      decryptCredential(dbAcc.accessTokenCiphertext!, dbAcc.id, 'youtube', 'access', keyring),
    ).toBe('youtube-access-code-1');
    expect(
      decryptCredential(dbAcc.refreshTokenCiphertext!, dbAcc.id, 'youtube', 'refresh', keyring),
    ).toBe('youtube-refresh-code-1');
    // Better Auth publishing tokens must be absent
    const authRows = await database.db
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, userId));
    for (const row of authRows) {
      expect(row.accessToken ?? '').not.toContain('youtube-access');
      expect(row.refreshToken ?? '').not.toContain('youtube-refresh');
    }
    // plaintext leakage
    const allStrings = JSON.stringify(dbAccounts);
    expect(allStrings).not.toContain('youtube-access-code-1');

    // one-time consumption
    const replay = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/youtube/oauth/callback?code=code-1&state=${state}`,
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'invalid_state' });

    // credential lookup via service persists refresh
    const expiredAt = new Date(Date.now() - 10_000);
    await database.db
      .update(publishingAccount)
      .set({ accessTokenExpiresAt: expiredAt })
      .where(eq(publishingAccount.id, dbAcc.id));
    youtubeRefreshBehavior = 'success';
    const refreshed = await oauthService.getAccessToken(userId, dbAcc.id);
    expect(refreshed).toBe('youtube-refreshed-youtube-refresh-code-1');
    const afterRefresh = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, dbAcc.id))
    )[0]!;
    expect(afterRefresh.credentialRevision).toBe(dbAcc.credentialRevision + 1);
    expect(
      decryptCredential(
        afterRefresh.accessTokenCiphertext!,
        afterRefresh.id,
        'youtube',
        'access',
        keyring,
      ),
    ).toBe(refreshed);
    // new refresh token rotated
    expect(
      decryptCredential(
        afterRefresh.refreshTokenCiphertext!,
        afterRefresh.id,
        'youtube',
        'refresh',
        keyring,
      ),
    ).toBe('youtube-rotated-youtube-refresh-code-1');

    // disconnect makes credential unusable
    const disconnect = await server.inject({
      method: 'POST',
      url: `/api/publishing-accounts/${dbAcc.id}/disconnect`,
      headers: { cookie, origin: appOrigin },
    });
    expect(disconnect.statusCode).toBe(200);
    const afterDisc = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, dbAcc.id))
    )[0]!;
    expect(afterDisc.status).toBe('revoked');
    expect(afterDisc.accessTokenCiphertext).toBeNull();
    expect(afterDisc.refreshTokenCiphertext).toBeNull();
    await expect(oauthService.getAccessToken(userId, dbAcc.id)).rejects.toMatchObject({
      message: 'reauthorization_required',
    });
  });

  test('wrong session and provider binding are rejected', async () => {
    const a = await signUpAndSignIn(
      `oauth-a-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const b = await signUpAndSignIn(
      `oauth-b-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const start = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts/vk/oauth/start',
      headers: { cookie: a.cookie },
    });
    const state = extractState((start.json() as { authorizationUrl: string }).authorizationUrl);
    // wrong user
    const wrongUser = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/vk/oauth/callback?code=code-wrong&state=${state}`,
      headers: { cookie: b.cookie },
    });
    expect(wrongUser.statusCode).toBe(400);
    // wrong provider
    const wrongProvider = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/youtube/oauth/callback?code=code-wrong&state=${state}`,
      headers: { cookie: a.cookie },
    });
    expect(wrongProvider.statusCode).toBe(400);
    // correct still works
    const correct = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/vk/oauth/callback?code=code-wrong&state=${state}`,
      headers: { cookie: a.cookie },
    });
    expect(correct.statusCode).toBe(200);
  });

  test('cross-user identity takeover is rejected', async () => {
    youtubeIdentityId = 'shared-youtube-id';
    const u1 = await signUpAndSignIn(
      `cross1-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const u2 = await signUpAndSignIn(
      `cross2-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const s1 = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts/youtube/oauth/start',
      headers: { cookie: u1.cookie },
    });
    const state1 = extractState((s1.json() as { authorizationUrl: string }).authorizationUrl);
    const c1 = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/youtube/oauth/callback?code=code-shared-1&state=${state1}`,
      headers: { cookie: u1.cookie },
    });
    expect(c1.statusCode).toBe(200);
    const s2 = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts/youtube/oauth/start',
      headers: { cookie: u2.cookie },
    });
    const state2 = extractState((s2.json() as { authorizationUrl: string }).authorizationUrl);
    const c2 = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/youtube/oauth/callback?code=code-shared-2&state=${state2}`,
      headers: { cookie: u2.cookie },
    });
    expect(c2.statusCode).toBe(409);
    expect(c2.json()).toMatchObject({ error: 'conflict' });
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('refresh preserves old refresh token when omitted, handles CAS/lease and ambiguous safety', async () => {
    vkIdentityId = `vk-refresh-${randomUUID()}`;
    youtubeIdentityId = `youtube-refresh-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `refresh-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    // create account via VK flow
    const start = await server.inject({
      method: 'GET',
      url: '/api/publishing-accounts/vk/oauth/start',
      headers: { cookie },
    });
    const state = extractState((start.json() as { authorizationUrl: string }).authorizationUrl);
    const cb = await server.inject({
      method: 'GET',
      url: `/api/publishing-accounts/vk/oauth/callback?code=code-refresh-1&state=${state}`,
      headers: { cookie },
    });
    expect(cb.statusCode).toBe(200);
    const accId = (cb.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accId))
    )[0]!;
    const beforeRefreshCipher = before.refreshTokenCiphertext;
    // expire and refresh with omission
    await database.db
      .update(publishingAccount)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 10_000) })
      .where(eq(publishingAccount.id, accId));
    vkRefreshBehavior = 'omit';
    const omitted = await oauthService.getAccessToken(userId, accId);
    expect(omitted).toBe('vk-refreshed-vk-refresh-code-refresh-1');
    const afterOmit = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accId))
    )[0]!;
    expect(afterOmit.refreshTokenCiphertext).toBe(beforeRefreshCipher);
    expect(
      decryptCredential(afterOmit.refreshTokenCiphertext!, afterOmit.id, 'vk', 'refresh', keyring),
    ).toBe('vk-refresh-code-refresh-1');

    // concurrent lease: first acquire succeeds, second fails
    await database.db
      .update(publishingAccount)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 10_000) })
      .where(eq(publishingAccount.id, accId));
    const repo = createPublishingAccountRepository(database.db);
    const now = new Date();
    const lease1 = await repo.acquireRefreshLease(
      accId,
      userId,
      'vk',
      afterOmit.credentialRevision,
      now,
      30_000,
    );
    expect(lease1).not.toBeNull();
    const lease2 = await repo.acquireRefreshLease(
      accId,
      userId,
      'vk',
      afterOmit.credentialRevision,
      now,
      30_000,
    );
    expect(lease2).toBeNull();
    // stale revision
    const stale = await repo.persistRefresh(accId, 9999, lease1!.leaseToken, {
      accessTokenCiphertext: before.accessTokenCiphertext!,
    });
    expect(stale).toHaveLength(0);
    // wrong lease token
    const wrongLease = await repo.persistRefresh(
      accId,
      afterOmit.credentialRevision,
      randomUUID(),
      { accessTokenCiphertext: before.accessTokenCiphertext! },
    );
    expect(wrongLease).toHaveLength(0);
    await repo.releaseRefreshLease(accId, lease1!.leaseToken);

    // invalid_grant is the only refresh response that transitions to reauthorization.
    await database.db
      .update(publishingAccount)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 10_000) })
      .where(eq(publishingAccount.id, accId));
    vkRefreshBehavior = 'fail400';
    await expect(oauthService.getAccessToken(userId, accId)).rejects.toMatchObject({
      message: 'reauthorization_required',
    });
    const afterFail = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accId))
    )[0]!;
    expect(afterFail.status).toBe('reauthorization_required');
    expect(afterFail.refreshLeaseToken).toBeNull();
    // second attempt should not do blind rotating refresh, should require reauth
    await expect(oauthService.getAccessToken(userId, accId)).rejects.toMatchObject({
      message: 'reauthorization_required',
    });
    vkRefreshBehavior = 'success';
  });

  test('reconnect rejects a different provider identity without mutating the target', async () => {
    youtubeIdentityId = `youtube-reconnect-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `reconnect-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'reconnect-initial');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    const wrongPlatform = await server.inject({
      method: 'POST',
      url: `/api/publishing-accounts/vk/oauth/reconnect?accountId=${accountId}`,
      headers: { cookie, origin: appOrigin },
    });
    expect(wrongPlatform.statusCode).toBe(409);
    youtubeIdentityId = `youtube-other-${randomUUID()}`;
    const mismatched = await connectAccount(cookie, 'youtube', 'reconnect-mismatch', accountId);
    expect(mismatched.statusCode).toBe(409);
    const after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.providerAccountId).toBe(before.providerAccountId);
    expect(after.accessTokenCiphertext).toBe(before.accessTokenCiphertext);
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);
    expect(after.status).toBe(before.status);
    expect(after.credentialRevision).toBe(before.credentialRevision);
    youtubeIdentityId = 'youtube-channel-123';
    expect(userId).toBeTruthy();
  });

  test('reconnect preserves the existing refresh token when the provider omits one', async () => {
    youtubeIdentityId = `youtube-omit-${randomUUID()}`;
    const { cookie } = await signUpAndSignIn(
      `reconnect-omit-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'reconnect-omit-initial');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    exchangeRefreshToken = false;
    const reconnected = await connectAccount(cookie, 'youtube', 'reconnect-omit', accountId);
    expect(reconnected.statusCode).toBe(200);
    const after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);
    expect(
      decryptCredential(after.refreshTokenCiphertext!, accountId, 'youtube', 'refresh', keyring),
    ).toBe('youtube-refresh-reconnect-omit-initial');
    exchangeRefreshToken = true;
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('stale reconnect cannot reactivate an account disconnected during provider work', async () => {
    youtubeIdentityId = `youtube-reconnect-disconnect-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `reconnect-disconnect-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'reconnect-disconnect-initial');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    const gate = { started: deferred(), released: deferred() };
    identityGates.set('reconnect-disconnect-stale', gate);
    const callback = connectAccount(cookie, 'youtube', 'reconnect-disconnect-stale', accountId);
    await gate.started.promise;
    const disconnected = await oauthService.disconnect(userId, accountId);
    expect(disconnected.status).toBe('revoked');
    gate.released.resolve();
    const stale = await callback;
    expect(stale.statusCode).toBe(409);
    const after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('revoked');
    expect(after.credentialRevision).toBe(before.credentialRevision + 1);
    expect(after.providerAccountId).toBe(before.providerAccountId);
    expect(after.accessTokenCiphertext).toBeNull();
    expect(after.refreshTokenCiphertext).toBeNull();
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('only the first concurrent reconnect callback settles a credential generation', async () => {
    youtubeIdentityId = `youtube-reconnect-concurrent-${randomUUID()}`;
    const { cookie } = await signUpAndSignIn(
      `reconnect-concurrent-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'reconnect-concurrent-initial');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    const gateA = { started: deferred(), released: deferred() };
    const gateB = { started: deferred(), released: deferred() };
    identityGates.set('reconnect-a', gateA);
    identityGates.set('reconnect-b', gateB);
    const callbackA = connectAccount(cookie, 'youtube', 'reconnect-a', accountId);
    const callbackB = connectAccount(cookie, 'youtube', 'reconnect-b', accountId);
    await Promise.all([gateA.started.promise, gateB.started.promise]);
    gateB.released.resolve();
    const winner = await callbackB;
    expect(winner.statusCode).toBe(200);
    gateA.released.resolve();
    const loser = await callbackA;
    expect(loser.statusCode).toBe(409);
    const after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('active');
    expect(after.credentialRevision).toBe(before.credentialRevision + 1);
    expect(
      decryptCredential(after.accessTokenCiphertext!, accountId, 'youtube', 'access', keyring),
    ).toBe('youtube-access-reconnect-b');
    expect(
      decryptCredential(after.refreshTokenCiphertext!, accountId, 'youtube', 'refresh', keyring),
    ).toBe('youtube-refresh-reconnect-b');
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('refresh keeps the lease for timeout/reset and preserves credentials for other failures', async () => {
    youtubeIdentityId = `youtube-refresh-errors-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `refresh-errors-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'refresh-errors');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const expire = () =>
      database.db
        .update(publishingAccount)
        .set({ accessTokenExpiresAt: new Date(Date.now() - 10_000) })
        .where(eq(publishingAccount.id, accountId));

    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    await expire();
    youtubeRefreshBehavior = 'other400';
    await expect(oauthService.getAccessToken(userId, accountId)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_client',
    });
    let after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('active');
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);

    await expire();
    youtubeRefreshBehavior = 'fail500';
    await expect(oauthService.getAccessToken(userId, accountId)).rejects.toMatchObject({
      status: 500,
      code: 'server_error',
    });
    after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('active');
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);

    await expire();
    youtubeRefreshBehavior = 'timeout';
    await expect(oauthService.getAccessToken(userId, accountId)).rejects.toMatchObject({
      code: 'timeout',
    });
    after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('active');
    expect(after.refreshLeaseToken).toBeTruthy();
    expect(after.refreshTokenCiphertext).toBe(before.refreshTokenCiphertext);
    const callsAfterTimeout = refreshCalls;
    await expect(oauthService.getAccessToken(userId, accountId)).rejects.toMatchObject({
      message: 'refresh_in_progress',
    });
    expect(refreshCalls).toBe(callsAfterTimeout);

    const repo = createPublishingAccountRepository(database.db);
    await repo.releaseRefreshLease(accountId, after.refreshLeaseToken!);
    await expire();
    youtubeRefreshBehavior = 'reset';
    await expect(oauthService.getAccessToken(userId, accountId)).rejects.toMatchObject({
      code: 'network_error',
    });
    after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.refreshLeaseToken).toBeTruthy();
    youtubeRefreshBehavior = 'success';
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('a stale pre-claim generation cannot refresh with its old token', async () => {
    youtubeIdentityId = `youtube-stale-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `stale-refresh-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'stale-initial');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    const before = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    await database.db
      .update(publishingAccount)
      .set({
        accessTokenCiphertext: encryptCredential(
          'youtube-new-access',
          accountId,
          'youtube',
          'access',
          'test-key',
          keyring,
        ),
        refreshTokenCiphertext: encryptCredential(
          'youtube-new-refresh',
          accountId,
          'youtube',
          'refresh',
          'test-key',
          keyring,
        ),
        accessTokenExpiresAt: new Date(Date.now() - 10_000),
        credentialRevision: before.credentialRevision + 1,
        credentialUpdatedAt: new Date(),
      })
      .where(eq(publishingAccount.id, accountId));
    youtubeRefreshBehavior = 'success';
    const refreshed = await oauthService.getAccessToken(userId, accountId);
    expect(refreshed).toBe('youtube-refreshed-youtube-new-refresh');
    youtubeIdentityId = 'youtube-channel-123';
  });

  test('disconnect wins against an in-flight refresh response', async () => {
    youtubeIdentityId = `youtube-disconnect-race-${randomUUID()}`;
    const { userId, cookie } = await signUpAndSignIn(
      `disconnect-race-${randomUUID()}@example.com`,
      'long-enough-password-123',
    );
    const connected = await connectAccount(cookie, 'youtube', 'disconnect-race');
    expect(connected.statusCode).toBe(200);
    const accountId = (connected.json() as { id: string }).id;
    await database.db
      .update(publishingAccount)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 10_000) })
      .where(eq(publishingAccount.id, accountId));
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    refreshStartedResolve = startedResolve;
    refreshGateResolve = undefined;
    youtubeRefreshBehavior = 'gate';
    const refresh = oauthService.getAccessToken(userId, accountId);
    await started;
    const disconnect = await oauthService.disconnect(userId, accountId);
    expect(disconnect.status).toBe('revoked');
    refreshGateResolve!();
    await expect(refresh).rejects.toMatchObject({ message: 'reauthorization_required' });
    const after = (
      await database.db.select().from(publishingAccount).where(eq(publishingAccount.id, accountId))
    )[0]!;
    expect(after.status).toBe('revoked');
    expect(after.accessTokenCiphertext).toBeNull();
    expect(after.refreshTokenCiphertext).toBeNull();
    youtubeRefreshBehavior = 'success';
    youtubeIdentityId = 'youtube-channel-123';
    refreshStartedResolve = undefined;
    refreshGateResolve = undefined;
  });
});
