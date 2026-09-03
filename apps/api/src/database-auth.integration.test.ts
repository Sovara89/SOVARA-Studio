import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  account,
  createDatabase,
  createPublishingAccountRepository,
  publishingAccount,
  session as dbSession,
  user,
  verification,
} from '@sovara-studio/db';
import { eq } from 'drizzle-orm';
import { applyMigrations } from '@sovara-studio/db';
import { createAuth } from './auth/options.js';
import { registerApp } from './app.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    'TEST_DATABASE_ADMIN_URL is required; integration tests never skip database provisioning',
  );

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_test_${suffix}`;
const migrationRole = `sovara_migration_${suffix}`;
const runtimeRole = `sovara_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
let databaseUrl: string;
let migrationDatabaseUrl: string;
let runtimeDatabaseUrl: string;
let database: ReturnType<typeof createDatabase>;
let auth: ReturnType<typeof createAuth>;
let provisioningAuth: ReturnType<typeof createAuth>;
let server: ReturnType<typeof Fastify>;

async function sql(client: Client, query: string) {
  return client.query(query);
}

describe('TASK-003 database and authentication foundation', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await sql(admin, `CREATE ROLE ${migrationRole} LOGIN PASSWORD '${migrationPassword}'`);
      await sql(admin, `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);
      await sql(admin, `CREATE DATABASE ${databaseName} OWNER ${migrationRole}`);
    } finally {
      await admin.end();
    }
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    migrationDatabaseUrl = migrationUrl.toString();
    const migrationDatabase = createDatabase(migrationDatabaseUrl);
    await applyMigrations(migrationDatabase);
    await migrationDatabase.pool.end();
    const owner = new Client({ connectionString: databaseUrl });
    await owner.connect();
    try {
      await sql(owner, `GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await sql(owner, `GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await sql(
        owner,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, publishing_account TO ${runtimeRole}`,
      );
    } finally {
      await owner.end();
    }
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeDatabaseUrl = runtimeUrl.toString();
    database = createDatabase(runtimeDatabaseUrl);
    auth = createAuth(database, {
      secret: 'test-auth-secret-that-is-at-least-32-bytes',
      appOrigin: 'http://localhost:5173',
    });
    provisioningAuth = createAuth(database, {
      secret: 'test-auth-secret-that-is-at-least-32-bytes',
      appOrigin: 'http://localhost:5173',
      provisioning: true,
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
      appOrigin: 'http://localhost:5173',
      database,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await database?.pool.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await sql(admin, `DROP DATABASE IF EXISTS ${databaseName}`);
      await sql(admin, `DROP ROLE IF EXISTS ${runtimeRole}`);
      await sql(admin, `DROP ROLE IF EXISTS ${migrationRole}`);
    } finally {
      await admin.end();
    }
  });

  test('runtime role has CRUD but no DDL or migration-journal access', async () => {
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    const client = new Client({ connectionString: runtimeUrl.toString() });
    await client.connect();
    try {
      await expect(
        client.query('CREATE TABLE forbidden_runtime_ddl(id uuid)'),
      ).rejects.toBeTruthy();
      await expect(
        client.query('ALTER TABLE "user" ADD COLUMN forbidden_runtime_ddl text'),
      ).rejects.toBeTruthy();
      await expect(client.query('DROP TABLE "publishing_account"')).rejects.toBeTruthy();
      const journalOperations = [
        () => client.query('SELECT * FROM "drizzle"."__drizzle_migrations"'),
        () =>
          client.query(
            'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
            ['forbidden', Date.now()],
          ),
        () => client.query('UPDATE "drizzle"."__drizzle_migrations" SET hash = $1', ['forbidden']),
        () => client.query('DELETE FROM "drizzle"."__drizzle_migrations"'),
      ];
      for (const operation of journalOperations) {
        await expect(operation()).rejects.toMatchObject({ code: '42501' });
      }
      expect((await client.query('SELECT count(*) FROM "user"')).rows[0].count).toBe('0');
      const migration = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../../../packages/db/dist/migrate.js', import.meta.url))],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...process.env, MIGRATION_DATABASE_URL: runtimeUrl.toString() },
          encoding: 'utf8',
        },
      );
      expect(migration.status).not.toBe(0);
    } finally {
      await client.end();
    }
  });

  test('public signup is blocked and protected routes require a session', async () => {
    const signup = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'blocked@example.com', name: 'Blocked', password: 'long-enough-password' },
    });
    expect(signup.statusCode).toBe(404);
    const unauthorized = await server.inject({ method: 'GET', url: '/api/me' });
    expect(unauthorized.statusCode).toBe(401);
    const invalid = await server.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: 'sovara_studio.session_token=invalid' },
    });
    expect(invalid.statusCode).toBe(401);
  });

  test('provisioned users authenticate, persist sessions, and logout revokes them', async () => {
    const commandPath = fileURLToPath(
      new URL('../dist/commands/provision-user.js', import.meta.url),
    );
    const password = `test-${randomUUID()}-password`;
    const email = 'Creator.MixedCase@Example.COM';
    const commandEnv = { ...process.env };
    delete commandEnv.TEST_DATABASE_ADMIN_URL;
    delete commandEnv.MIGRATION_DATABASE_URL;
    commandEnv.DATABASE_URL = runtimeDatabaseUrl;
    commandEnv.AUTH_SECRET = 'test-auth-secret-that-is-at-least-32-bytes';
    commandEnv.APP_ORIGIN = 'http://localhost:5173';
    commandEnv.CREDENTIAL_ENCRYPTION_KEYS =
      '{"test-key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}';
    commandEnv.CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID = 'test-key';
    expect(commandEnv.TEST_DATABASE_ADMIN_URL).toBeUndefined();
    expect(commandEnv.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(commandEnv.DATABASE_URL).toBe(runtimeDatabaseUrl);
    const provision = spawnSync(
      process.execPath,
      [commandPath, '--email', email, '--name', 'Creator', '--password-stdin'],
      { input: `${password}\n`, env: commandEnv, encoding: 'utf8' },
    );
    expect(provision.status).toBe(0);
    const provisionedRows = await database.db
      .select()
      .from(user)
      .where(eq(user.email, 'creator.mixedcase@example.com'));
    expect(provisionedRows).toHaveLength(1);
    const provisioned = provisionedRows[0]!;
    expect(provisioned.email).toBe('creator.mixedcase@example.com');
    // Global counts after successful CLI provisioning
    const allUsersAfterProvision = await database.db.select().from(user);
    expect(allUsersAfterProvision).toHaveLength(1);
    const allAccountsAfterProvision = await database.db.select().from(account);
    expect(allAccountsAfterProvision).toHaveLength(1);
    const allSessionsAfterProvision = await database.db.select().from(dbSession);
    expect(allSessionsAfterProvision).toHaveLength(0);
    const credentialRows = await database.db
      .select()
      .from(account)
      .where(eq(account.userId, provisioned.id));
    expect(credentialRows).toHaveLength(1);
    const credential = credentialRows[0]!;
    expect(credential.providerId).toBe('credential');
    expect(credential.issuer).toBe('local:credential');
    expect(credential.accountId).toBe(provisioned.id);
    expect(credential.password).not.toBeNull();
    expect(credential.password).not.toBe(password);
    // Check plaintext absence in all auth persistence tables
    const allValues = [
      ...allUsersAfterProvision.map((u) => Object.values(u)),
      ...allAccountsAfterProvision.map((a) => Object.values(a)),
      ...allSessionsAfterProvision.map((s) => Object.values(s)),
      // verification table is empty in this test, but we can still query it
      ...(await database.db.select().from(verification)).map((v) => Object.values(v)),
    ].flat();
    const plaintextAsString = password;
    // Ensure none of the string values equals the plaintext password
    for (const val of allValues) {
      if (typeof val === 'string' && val.includes(plaintextAsString))
        throw new Error('Plaintext password found in persistence');
    }
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: email.toUpperCase(), password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = login.headers['set-cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies?.[0]).toMatch(/HttpOnly/i);
    expect(cookies?.[0]).toMatch(/SameSite=Lax/i);
    expect(cookies?.[0]).toMatch(/Path=\//i);
    expect(cookies?.[0]).not.toMatch(/Domain=/i);
    expect(cookies?.[0]).not.toMatch(/Secure/i);
    const secureAuth = createAuth(database, {
      secret: 'test-auth-secret-that-is-at-least-32-bytes',
      appOrigin: 'https://localhost:5173',
    });
    const secureServer = Fastify({ logger: false });
    secureServer.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    await secureServer.register(registerApp, {
      prefix: '/api',
      auth: secureAuth,
      appOrigin: 'https://localhost:5173',
      database,
    });
    const secureLogin = await secureServer.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: email, password },
    });
    const secureCookies = secureLogin.headers['set-cookie'];
    expect(secureLogin.statusCode).toBe(200);
    expect(secureCookies?.[0]).toMatch(/__Secure-sovara_studio\.session_token/i);
    expect(secureCookies?.[0]).toMatch(/Secure/i);
    expect(secureCookies?.[0]).toMatch(/HttpOnly/i);
    expect(secureCookies?.[0]).toMatch(/SameSite=Lax/i);
    const secureLogout = await secureServer.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: secureCookies?.[0] },
    });
    expect(secureLogout.statusCode).toBe(200);
    await secureServer.close();
    const session = await server.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookies?.[0] },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ userId: provisioned.id });
    const logout = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: cookies?.[0] },
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await server.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookies?.[0] } }))
        .statusCode,
    ).toBe(401);
    const beforeDuplicate = (
      await database.db.select({ userId: account.userId, password: account.password }).from(account)
    ).filter((row) => row.userId === provisioned.id);
    const duplicate = spawnSync(
      process.execPath,
      [commandPath, '--email', email, '--name', 'Duplicate', '--password-stdin'],
      { input: 'another-password\n', env: commandEnv, encoding: 'utf8' },
    );
    const caseDuplicate = spawnSync(
      process.execPath,
      [commandPath, '--email', email.toUpperCase(), '--name', 'Duplicate', '--password-stdin'],
      { input: 'another-password\n', env: commandEnv, encoding: 'utf8' },
    );
    expect(duplicate.status).not.toBe(0);
    expect(caseDuplicate.status).not.toBe(0);
    expect(duplicate.stdout).not.toContain('Provisioned user');
    expect(caseDuplicate.stdout).not.toContain('Provisioned user');
    expect(
      (
        await database.db
          .select({ userId: account.userId, password: account.password })
          .from(account)
      ).filter((row) => row.userId === provisioned.id),
    ).toEqual(beforeDuplicate);
    // After duplicate attempt, counts should remain unchanged
    const afterDuplicateUsers = await database.db.select().from(user);
    const afterDuplicateAccounts = await database.db.select().from(account);
    const afterDuplicateSessions = await database.db.select().from(dbSession);
    expect(afterDuplicateUsers).toHaveLength(1);
    expect(afterDuplicateAccounts).toHaveLength(1);
    expect(afterDuplicateSessions).toHaveLength(0);
    // After case-only duplicate attempt, counts should remain unchanged
    const afterCaseDuplicateUsers = await database.db.select().from(user);
    expect(afterCaseDuplicateUsers).toHaveLength(1);
    const afterCaseDuplicateAccounts = await database.db.select().from(account);
    expect(afterCaseDuplicateAccounts).toHaveLength(1);
    const afterCaseDuplicateSessions = await database.db.select().from(dbSession);
    expect(afterCaseDuplicateSessions).toHaveLength(0);
    await expect(
      provisioningAuth.api.signUpEmail({
        body: {
          email: ' whitespace@example.com ',
          name: 'Whitespace',
          password: 'long-enough-password',
        },
      }),
    ).rejects.toBeTruthy();
  });

  test('publishing repository is owner-scoped', async () => {
    // Create two independent users for this test to avoid reliance on test order
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const ownerEmail = `owner-${suffix}@example.com`;
    const otherEmail = `other-${suffix}@example.com`;
    const password = 'long-enough-password';
    // Provision owner user
    const ownerResult = await provisioningAuth.api.signUpEmail({
      body: { email: ownerEmail, name: 'Owner', password },
    });
    if (!ownerResult?.user) throw new Error('Failed to provision owner user');
    const ownerUser = ownerResult.user;
    // Provision other user
    const otherResult = await provisioningAuth.api.signUpEmail({
      body: { email: otherEmail, name: 'Other', password },
    });
    if (!otherResult?.user) throw new Error('Failed to provision other user');
    const otherUser = otherResult.user;
    const [owner, other] = [ownerUser, otherUser];
    // Create a publishing account for the owner
    const [created] = await database.db
      .insert(publishingAccount)
      .values({ userId: owner.id, platform: 'youtube' })
      .returning();
    if (!created) throw new Error('Publishing account was not created');
    const repo = createPublishingAccountRepository(database.db);
    expect(await repo.findByIdForUser(other.id, created.id)).toHaveLength(0);
    expect(await repo.findByIdForUser(owner.id, created.id)).toHaveLength(1);
    expect(
      await repo.updateCredentialRevision(other.id, created.id, 0, { displayName: 'attacker' }),
    ).toHaveLength(0);
    expect(
      await repo.updateCredentialRevision(owner.id, created.id, 0, { displayName: 'owner' }),
    ).toHaveLength(1);
    const rerun = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../../packages/db/dist/migrate.js', import.meta.url))],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, MIGRATION_DATABASE_URL: migrationDatabaseUrl },
        encoding: 'utf8',
      },
    );
    expect(rerun.status).toBe(0);
  });
});
