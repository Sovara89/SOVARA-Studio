import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import Fastify from '../../apps/api/node_modules/fastify/fastify.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  applyMigrations,
  createDatabase,
  createPublicationIntentRepository,
  publication,
  publicationAttempt,
  publishingAccount,
  video,
} from '../../packages/db/src/index.js';
import { createS3Client, createS3PrivatePreviewStorage } from '../../packages/infra/src/index.js';
import { registerApp } from '../../apps/api/src/app.js';
import { createAuth } from '../../apps/api/src/auth/options.js';
import { createPublicationIntentService } from '../../apps/api/src/services/publication-intent-service.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-013 integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_task013_test_${suffix}`;
const migrationRole = `sovara_task013_migration_${suffix}`;
const runtimeRole = `sovara_task013_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
const appOrigin = 'http://localhost:5173';
const bucket = process.env.S3_BUCKET ?? 'sovara-uploads';
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<typeof Fastify>;
let storageClient: ReturnType<typeof createS3Client>;
let ownerId: string;
let ownerEmail: string;
let ownerPassword: string;
let cookie: string;
let vkAccountId: string;

function storageConfiguration() {
  return {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
    forcePathStyle: true,
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }) {
  const cookies = response.headers['set-cookie'];
  if (!cookies) throw new Error('Authentication cookie was not returned');
  return (Array.isArray(cookies) ? cookies : [cookies])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

async function createReadyVideo(label: string) {
  const [created] = await database.db
    .insert(video)
    .values({
      userId: ownerId,
      originalFilename: `${label}.mp4`,
      contentType: 'video/mp4',
      expectedSizeBytes: 10,
      verifiedSizeBytes: 10,
      storageBackend: 's3-compatible',
      storageBucket: bucket,
      objectKey: `task-013/${ownerId}/${randomUUID()}.mp4`,
      state: 'ready',
      verifiedAt: new Date(),
    })
    .returning();
  if (!created) throw new Error('Ready test video was not created');
  return created;
}

async function createDraft(videoId: string, link?: string | null) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/publication-intents',
    headers: { cookie, origin: appOrigin },
    payload: {
      videoId,
      platform: 'vk',
      publishingAccountId: vkAccountId,
      mode: 'DRAFT',
      title: 'TASK-013 VK draft',
      description: null,
      ...(link === undefined ? {} : { link }),
      createCommunityPost: false,
      scheduledAt: null,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; link: string | null; revision: number; preview: unknown };
}

async function createReadyPreview(intent: { id: string; revision: number }) {
  const prepared = await server.inject({
    method: 'POST',
    url: `/api/publication-intents/${intent.id}/preview`,
    headers: { cookie, origin: appOrigin },
    payload: { contentType: 'image/png', sizeBytes: 3, revision: intent.revision },
  });
  expect(prepared.statusCode).toBe(200);
  const preparation = prepared.json() as { uploadUrl: string; revision: number };
  const uploaded = await fetch(preparation.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from([1, 2, 3]),
  });
  expect(uploaded.ok).toBe(true);
  const completed = await server.inject({
    method: 'POST',
    url: `/api/publication-intents/${intent.id}/preview/complete`,
    headers: { cookie, origin: appOrigin },
    payload: { revision: preparation.revision },
  });
  expect(completed.statusCode).toBe(200);
  return completed.json() as { revision: number; preview: { state: string } | null };
}

describe('TASK-013 draft-only API persistence', () => {
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
    const migrationDatabase = createDatabase(migrationUrl.toString());
    await applyMigrations(migrationDatabase);
    await migrationDatabase.pool.end();
    const owner = new Client({ connectionString: baseUrl.toString() });
    await owner.connect();
    try {
      await owner.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, publishing_account, video, multipart_upload, upload_part, publication, publication_attempt, publication_intent TO ${runtimeRole}`,
      );
    } finally {
      await owner.end();
    }
    const runtimeUrl = new URL(baseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    database = createDatabase(runtimeUrl.toString());
    const auth = createAuth(database, {
      secret: 'task-013-integration-secret-that-is-at-least-32-bytes',
      appOrigin,
    });
    const provisioningAuth = createAuth(database, {
      secret: 'task-013-integration-secret-that-is-at-least-32-bytes',
      appOrigin,
      provisioning: true,
    });
    ownerEmail = `task-013-${suffix}@example.com`;
    ownerPassword = `task-013-${randomUUID()}-password`;
    const provisioned = await provisioningAuth.api.signUpEmail({
      body: { email: ownerEmail, name: 'TASK-013 Owner', password: ownerPassword },
    });
    if (!provisioned.user) throw new Error('Test user was not created');
    ownerId = provisioned.user.id;
    const [account] = await database.db
      .insert(publishingAccount)
      .values({
        userId: ownerId,
        platform: 'vk',
        providerAccountId: `task-013-vk-${suffix}`,
        displayName: 'TASK-013 VK',
        accessTokenCiphertext: 'test-only-ciphertext',
        credentialFormatVersion: 1,
        credentialKeyId: 'test-key',
        credentialUpdatedAt: new Date(),
        status: 'active',
      })
      .returning();
    if (!account) throw new Error('VK account was not created');
    vkAccountId = account.id;
    storageClient = createS3Client({ ...storageConfiguration(), maxAttempts: 1 });
    const previewStorage = createS3PrivatePreviewStorage(storageClient, bucket);
    server = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    server.addContentTypeParser(
      ['application/json'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    await server.register(registerApp, {
      prefix: '/api',
      auth,
      appOrigin,
      database,
      publicationIntentService: createPublicationIntentService({
        intents: createPublicationIntentRepository(database.db),
        previewStorage,
      }),
    });
    await server.ready();
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ownerEmail, password: ownerPassword },
    });
    expect(login.statusCode).toBe(200);
    cookie = cookieFrom(login);
  });

  afterAll(async () => {
    await server?.close();
    storageClient?.destroy();
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

  test('unlinks a READY-video preview in PostgreSQL, removes its private object, and reloads absent', async () => {
    const draft = await createDraft((await createReadyVideo('preview-remove')).id);
    const withPreview = await createReadyPreview(draft);
    expect(withPreview.preview).toMatchObject({ state: 'ready' });
    const [beforeRemoval] = await createPublicationIntentRepository(database.db).findForUser(
      ownerId,
      draft.id,
    );
    if (!beforeRemoval?.previewObjectKey)
      throw new Error('Ready preview object key was not recorded');
    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/publication-intents/${draft.id}/preview`,
      headers: { cookie, origin: appOrigin },
      payload: { revision: withPreview.revision },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ preview: null });
    const [unlinked] = await createPublicationIntentRepository(database.db).findForUser(
      ownerId,
      draft.id,
    );
    expect(unlinked).toMatchObject({
      previewObjectKey: null,
      previewContentType: null,
      previewSizeBytes: null,
      previewState: null,
    });
    await expect(
      storageClient.send(
        new HeadObjectCommand({ Bucket: bucket, Key: beforeRemoval.previewObjectKey }),
      ),
    ).rejects.toMatchObject({ $metadata: expect.objectContaining({ httpStatusCode: 404 }) });
    const reloaded = await server.inject({
      method: 'GET',
      url: '/api/publication-intents',
      headers: { cookie },
    });
    expect(reloaded.statusCode).toBe(200);
    expect(
      (reloaded.json() as Array<{ id: string; preview: unknown }>).find(
        ({ id }) => id === draft.id,
      ),
    ).toMatchObject({ preview: null });
  });

  test('keeps the saved unlink successful when deterministic storage cleanup fails', async () => {
    const failingStorage = createS3PrivatePreviewStorage(storageClient, bucket);
    const service = createPublicationIntentService({
      intents: createPublicationIntentRepository(database.db),
      previewStorage: {
        ...failingStorage,
        deleteObject: async () => Promise.reject(new Error('forced')),
      },
    });
    const draft = await createDraft((await createReadyVideo('cleanup-failure')).id);
    const prepared = await service.preparePreview(ownerId, draft.id, {
      contentType: 'image/png',
      sizeBytes: 3,
      revision: draft.revision,
    });
    await fetch(prepared.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([4, 5, 6]),
    });
    const ready = await service.completePreview(ownerId, draft.id, prepared.revision);
    await expect(service.removePreview(ownerId, draft.id, ready.revision)).resolves.toMatchObject({
      preview: null,
    });
    expect(
      (await createPublicationIntentRepository(database.db).findForUser(ownerId, draft.id))[0],
    ).toMatchObject({ previewObjectKey: null, previewState: null });
  });

  test('persists the exact VK default, replacement, and intentional clear without publication execution', async () => {
    const draft = await createDraft((await createReadyVideo('vk-link')).id);
    expect(draft.link).toBe('https://vk.com/sovara_news');
    const afterCreation = await server.inject({
      method: 'GET',
      url: '/api/publication-intents',
      headers: { cookie },
    });
    expect(afterCreation.statusCode).toBe(200);
    expect(
      (afterCreation.json() as Array<{ id: string; link: string | null }>).find(
        ({ id }) => id === draft.id,
      ),
    ).toMatchObject({ link: 'https://vk.com/sovara_news' });
    const replacement = 'https://www.vk.com/sovara_news?from=task013';
    const edited = await server.inject({
      method: 'PUT',
      url: `/api/publication-intents/${draft.id}`,
      headers: { cookie, origin: appOrigin },
      payload: {
        mode: 'DRAFT',
        title: 'TASK-013 VK draft edited',
        description: null,
        link: replacement,
        createCommunityPost: false,
        scheduledAt: null,
        revision: draft.revision,
      },
    });
    expect(edited.statusCode).toBe(200);
    const saved = edited.json() as { revision: number; link: string | null };
    expect(saved.link).toBe(replacement);
    const afterReplacement = await server.inject({
      method: 'GET',
      url: '/api/publication-intents',
      headers: { cookie },
    });
    expect(afterReplacement.statusCode).toBe(200);
    expect(
      (afterReplacement.json() as Array<{ id: string; link: string | null }>).find(
        ({ id }) => id === draft.id,
      ),
    ).toMatchObject({ link: replacement });
    const cleared = await server.inject({
      method: 'PUT',
      url: `/api/publication-intents/${draft.id}`,
      headers: { cookie, origin: appOrigin },
      payload: {
        mode: 'DRAFT',
        title: 'TASK-013 VK draft cleared',
        description: null,
        link: null,
        createCommunityPost: false,
        scheduledAt: null,
        revision: saved.revision,
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ link: null });
    const reloaded = await server.inject({
      method: 'GET',
      url: '/api/publication-intents',
      headers: { cookie },
    });
    expect(reloaded.statusCode).toBe(200);
    expect(
      (reloaded.json() as Array<{ id: string; link: string | null }>).find(
        ({ id }) => id === draft.id,
      ),
    ).toMatchObject({ link: null });
    expect(await database.db.select().from(publication)).toHaveLength(0);
    expect(await database.db.select().from(publicationAttempt)).toHaveLength(0);
  });
});
