import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applyMigrations,
  createDatabase,
  createPublishingAccountRepository,
  createPublicationRepository,
  createVideoRepository,
  publication,
  publishingAccount,
  publicationAttempt,
  user,
  video as videoTable,
} from '../../packages/db/src/index.js';
import {
  createPublicationQueue,
  createPublicationWorker,
  createPublishingCredentialService,
  createS3MediaSource,
  encryptCredential,
  type PublicationQueueConfiguration,
} from '../../packages/infra/dist/index.js';
import { createPublicationJobProcessor } from '../../apps/worker/src/publication-job-processor.js';
import { createPublicationReconciler } from '../../apps/worker/src/publication-reconciler.js';
import { createPublicationPreflight } from '../../apps/worker/src/publication-preflight.js';
import type { PublicationPublisher } from '../../packages/platforms/src/publication.js';
import { createYouTubePublisher } from '../../packages/platforms/src/youtube-publisher.js';
import { createVKVideoPublisher } from '../../packages/platforms/src/vk-video-publisher.js';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-010 integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_publish_test_${suffix}`;
const migrationRole = `sovara_publish_migration_${suffix}`;
const runtimeRole = `sovara_publish_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
let database: ReturnType<typeof createDatabase> | undefined;
let runtimeDatabaseUrl: string;
let ownerId: string;
let accountId: string;
let vkProviderSequence = 0;
const credentialKeyring = { 'test-key': Buffer.alloc(32, 7) };
const credentialConfiguration = { keyring: credentialKeyring, activeKeyId: 'test-key' };

const queueConfiguration: PublicationQueueConfiguration = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:16379',
  queueName: `sovara-publications-${suffix}`,
  prefix: `sovara-studio-${suffix}`,
  jobAttempts: 1,
  backoffMs: 25,
  lockDurationMs: 5_000,
  stalledIntervalMs: 1_000,
  maxStalledCount: 1,
  completedRetentionSeconds: 3_600,
  failedRetentionSeconds: 3_600,
  connectionTimeoutMs: 2_000,
};

const queue = createPublicationQueue(queueConfiguration);

async function createTestAccount(
  userId: string,
  platform: 'youtube' | 'vk' = 'youtube',
  credentialRevision = 7,
) {
  if (!database) throw new Error('Database is not initialized');
  const id = randomUUID();
  const [account] = await database.db
    .insert(publishingAccount)
    .values({
      id,
      userId,
      platform,
      providerAccountId:
        platform === 'vk'
          ? String(700_000_000 + (vkProviderSequence += 1))
          : `${platform}-${suffix}-${id}`,
      displayName: 'Integration publishing account',
      accessTokenCiphertext: encryptCredential(
        'test-access-token',
        id,
        platform,
        'access',
        credentialConfiguration.activeKeyId,
        credentialKeyring,
      ),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes:
        platform === 'youtube'
          ? [
              'https://www.googleapis.com/auth/youtube.readonly',
              'https://www.googleapis.com/auth/youtube.upload',
            ]
          : ['vkid.personal_info', 'video'],
      credentialFormatVersion: 1,
      credentialKeyId: credentialConfiguration.activeKeyId,
      credentialUpdatedAt: new Date(),
      credentialRevision,
      status: 'active',
    })
    .returning();
  if (!account) throw new Error('Test account was not created');
  return account;
}

async function createPublication(
  label: string,
  publishingAccountId = accountId,
  platform: 'youtube' | 'vk' = 'youtube',
) {
  if (!database) throw new Error('Database is not initialized');
  const [readyVideo] = await database.db
    .insert(videoTable)
    .values({
      userId: ownerId,
      originalFilename: `${label}.mp4`,
      contentType: 'video/mp4',
      expectedSizeBytes: 10,
      verifiedSizeBytes: 10,
      storageBackend: 's3-compatible',
      storageBucket: process.env.S3_BUCKET ?? 'sovara-uploads',
      objectKey: `videos/${ownerId}/${randomUUID()}.mp4`,
      state: 'ready',
      verifiedAt: new Date(),
      objectEtag: label.endsWith('-publisher') ? null : `etag-${label}`,
    })
    .returning();
  if (!readyVideo) throw new Error('Test video was not created');
  const publications = createPublicationRepository(database.db);
  const [created] = await publications.createOwnedPublication(ownerId, {
    videoId: readyVideo.id,
    publishingAccountId,
    platform,
    title: `Integration ${label}`,
  });
  if (!created) throw new Error('Test publication was not created');
  return created;
}

function requestOwnership(
  publicationRow: {
    id: string;
    revision: number;
    leaseToken: string | null;
    publishingAccountId: string;
    userId: string;
    platform: string;
  },
  credentialRevision: number,
) {
  return {
    publicationId: publicationRow.id,
    expectedPublicationRevision: publicationRow.revision,
    expectedLeaseToken: publicationRow.leaseToken!,
    credential: {
      accountId: publicationRow.publishingAccountId,
      userId: publicationRow.userId,
      platform: publicationRow.platform as 'youtube' | 'vk',
      credentialRevision,
    },
  };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for integration state');
}

async function waitForLockWait(admin: Client, queryFragment: string, minimum = 1) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await admin.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid <> pg_backend_pid() ' +
        "AND wait_event_type = 'Lock' AND query LIKE $1",
      [`%${queryFragment}%`],
    );
    if (
      (result.rows[0]?.count as number | undefined) !== undefined &&
      result.rows[0].count >= minimum
    )
      return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock wait: ${queryFragment}`);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createProductionPreflight() {
  if (!database) throw new Error('Database is not initialized');
  const credentialService = createPublishingCredentialService({
    database,
    credentialConfiguration,
    providers: {},
  });
  const accounts = createPublishingAccountRepository(database.db);
  const videos = createVideoRepository(database.db);
  const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
    forcePathStyle: true,
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    },
  });
  return createPublicationPreflight({
    accounts,
    videos,
    credentials: credentialService,
    createMediaSource: (video) => {
      if (video.verifiedSizeBytes === null) throw new Error('Test video is not verified');
      return createS3MediaSource({
        client: s3Client,
        bucket: video.storageBucket,
        objectKey: video.objectKey,
        sizeBytes: video.verifiedSizeBytes,
        contentType: video.contentType,
        expectedEtag: video.objectEtag,
      });
    },
  });
}

describe('TASK-010 generic publication execution', () => {
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

    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    const migrationDatabase = createDatabase(migrationUrl.toString());
    await applyMigrations(migrationDatabase);
    await migrationDatabase.pool.end();

    const owner = new Client({ connectionString: databaseUrl.toString() });
    await owner.connect();
    try {
      await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await owner.query('REVOKE ALL ON SCHEMA drizzle FROM PUBLIC');
      await owner.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await owner.query(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, publishing_account, video, multipart_upload, upload_part, publication, publication_attempt TO ' +
          runtimeRole,
      );
    } finally {
      await owner.end();
    }

    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtimeDatabaseUrl = runtimeUrl.toString();
    database = createDatabase(runtimeUrl.toString());
    const [ownerRow] = await database.db
      .insert(user)
      .values({ name: 'Publication Owner', email: `publication-owner-${suffix}@example.com` })
      .returning();
    if (!ownerRow) throw new Error('Test owner was not created');
    ownerId = ownerRow.id;
    const account = await createTestAccount(ownerId);
    accountId = account.id;
    await queue.queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue.close();
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

  test('runs generic publish through production preflight, PostgreSQL, BullMQ, and worker orchestration', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const created = await createPublication('generic-execution');
    let publishCalls = 0;
    const publisher: PublicationPublisher = {
      platform: 'youtube' as const,
      publish: async (context) => {
        publishCalls += 1;
        expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
          'request_sent',
        );
        expect(context.credential.credentialRevision).toBe(7);
        expect(await context.credential.getAccessToken()).toBe('test-access-token');
        expect(context.media?.sizeBytes).toBe(10);
        return {
          kind: 'published' as const,
          remote: {
            remoteMediaId: 'provider-media-execution',
            remoteUrl: 'https://youtube.example/video',
          },
        };
      },
    };
    const preflight = createProductionPreflight();
    const worker = createPublicationWorker(
      { ...queueConfiguration, workerConcurrency: 1 },
      createPublicationJobProcessor({
        publications,
        publishers: new Map([['youtube', publisher]]),
        preflight,
        leaseDurationMs: 5_000,
        leaseHeartbeatMs: 1_000,
      }),
    );
    await worker.worker.waitUntilReady();
    try {
      await queue.ensurePublicationJob({
        publicationId: created.id,
        expectedRevision: created.revision,
      });
      const queuedJobs = await queue.queue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
        'failed',
      ]);
      const queuedData = JSON.stringify(queuedJobs.map((job) => job.data));
      expect(queuedData).not.toContain('test-access-token');
      expect(queuedData).not.toContain('accessToken');
      expect(queuedData).not.toContain('ciphertext');
      await waitFor(
        () => publications.findById(created.id),
        (rows) => rows[0]?.state === 'published',
      );
      expect(publishCalls).toBe(1);
      const attempts = await publications.listAttemptsForUser(ownerId, created.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        state: 'succeeded',
        remoteMediaId: 'provider-media-execution',
        remoteUrl: 'https://youtube.example/video',
      });
      expect((await publications.findById(created.id))[0]).toMatchObject({
        state: 'published',
        remoteMediaId: 'provider-media-execution',
        remoteUrl: 'https://youtube.example/video',
      });
    } finally {
      await worker.close();
    }
  });

  test('runs the real YouTube publisher through PostgreSQL, BullMQ, MinIO, and worker orchestration', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const created = await createPublication('youtube-publisher');
    const video = (
      await createVideoRepository(database.db).findByIdForUser(ownerId, created.videoId)
    )[0];
    if (!video) throw new Error('Integration video was not found');
    const storage = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
      forcePathStyle: true,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
      },
    });
    await storage.send(
      new PutObjectCommand({
        Bucket: video.storageBucket,
        Key: video.objectKey,
        Body: Buffer.alloc(video.verifiedSizeBytes ?? 0),
        ContentType: video.contentType,
      }),
    );
    const providerChannelId = `youtube-${suffix}-${accountId}`;
    const request = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=integration-session',
          },
        });
      if (url.includes('/upload/')) return jsonResponse({ id: 'integrVid01' }, 201);
      return jsonResponse({
        items: [{ id: 'integrVid01', snippet: { channelId: providerChannelId } }],
      });
    };
    const publisher = createYouTubePublisher({ fetch: request, chunkSizeBytes: 256 * 1024 });
    const preflight = createProductionPreflight();
    const worker = createPublicationWorker(
      { ...queueConfiguration, workerConcurrency: 1 },
      createPublicationJobProcessor({
        publications,
        publishers: new Map([['youtube', publisher]]),
        preflight,
        leaseDurationMs: 5_000,
        leaseHeartbeatMs: 1_000,
      }),
    );
    await worker.worker.waitUntilReady();
    try {
      await queue.ensurePublicationJob({
        publicationId: created.id,
        expectedRevision: created.revision,
      });
      await waitFor(
        () => publications.findById(created.id),
        (rows) => rows[0]?.state === 'published',
      );
      expect((await publications.findById(created.id))[0]).toMatchObject({
        state: 'published',
        remoteMediaId: 'integrVid01',
        remoteUrl: 'https://youtu.be/integrVid01',
      });
    } finally {
      await worker.close();
      storage.destroy();
    }
  });

  test('runs the real VK publisher through PostgreSQL, BullMQ, MinIO, and fake VK HTTP', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const vkAccount = await createTestAccount(ownerId, 'vk');
    const created = await createPublication('vk-publisher', vkAccount.id, 'vk');
    const video = (
      await createVideoRepository(database.db).findByIdForUser(ownerId, created.videoId)
    )[0];
    if (!video) throw new Error('VK integration video was not found');
    const storage = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
      forcePathStyle: true,
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
      },
    });
    await storage.send(
      new PutObjectCommand({
        Bucket: video.storageBucket,
        Key: video.objectKey,
        Body: Buffer.from('0123456789'),
        ContentType: video.contentType,
      }),
    );
    const groupId = '54321';
    const communityOwnerId = `-${groupId}`;
    const providerVideoId = '8123456';
    let saveCalls = 0;
    let capabilityCalls = 0;
    let uploadedMedia: Buffer | undefined;
    const request = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/groups.getById')) {
        capabilityCalls += 1;
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('group_ids')).toBe(groupId);
        expect(form.get('access_token')).toBe('test-access-token');
        expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
          'started',
        );
        return jsonResponse({
          response: { groups: [{ id: Number(groupId), is_admin: 1, admin_level: 2 }] },
        });
      }
      if (url.endsWith('/video.save')) {
        saveCalls += 1;
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('access_token')).toBe('test-access-token');
        expect(form.get('v')).toBe('5.199');
        expect(form.get('group_id')).toBe(groupId);
        expect(form.has('wallpost')).toBe(false);
        expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
          'request_sent',
        );
        return jsonResponse({
          response: {
            owner_id: Number(communityOwnerId),
            video_id: Number(providerVideoId),
            upload_url: 'https://upload.vk.example/integration?opaque=not-persisted',
          },
        });
      }
      if (url.startsWith('https://upload.vk.example/')) {
        const chunks: Buffer[] = [];
        for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        uploadedMedia = Buffer.concat(chunks);
        expect(uploadedMedia.toString()).toContain('name="video_file"');
        expect(uploadedMedia.includes(Buffer.from('0123456789'))).toBe(true);
        return jsonResponse({ size: 10, video_id: Number(providerVideoId) });
      }
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('videos')).toBe(`${communityOwnerId}_${providerVideoId}`);
      return jsonResponse({
        response: {
          count: 1,
          items: [{ owner_id: Number(communityOwnerId), id: Number(providerVideoId) }],
        },
      });
    };
    const publisher = createVKVideoPublisher({
      groupId,
      fetch: request as typeof fetch,
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      uploadTransport: ({ target, headers, body, signal }) =>
        request(target.url.toString(), {
          method: 'POST',
          headers,
          body: body as unknown as BodyInit,
          redirect: 'manual',
          signal,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
    });
    const preflight = createProductionPreflight();
    const worker = createPublicationWorker(
      { ...queueConfiguration, workerConcurrency: 1 },
      createPublicationJobProcessor({
        publications,
        publishers: new Map([['vk', publisher]]),
        preflight,
        leaseDurationMs: 5_000,
        leaseHeartbeatMs: 1_000,
      }),
    );
    await worker.worker.waitUntilReady();
    try {
      await queue.ensurePublicationJob({
        publicationId: created.id,
        expectedRevision: created.revision,
      });
      await waitFor(
        () => publications.findById(created.id),
        (rows) => rows[0]?.state === 'published',
      );
      expect(capabilityCalls).toBe(1);
      expect(saveCalls).toBe(1);
      expect(uploadedMedia).toBeDefined();
      expect((await publications.findById(created.id))[0]).toMatchObject({
        state: 'published',
        remoteOwnerId: communityOwnerId,
        remoteMediaId: providerVideoId,
        remoteUrl: `https://vk.com/video${communityOwnerId}_${providerVideoId}`,
      });
      const [attempt] = await publications.listAttemptsForUser(ownerId, created.id);
      expect(attempt).toMatchObject({
        state: 'succeeded',
        remoteOwnerId: communityOwnerId,
        remoteMediaId: providerVideoId,
      });
      expect(JSON.stringify(attempt)).not.toContain('opaque=not-persisted');
      expect(JSON.stringify(attempt)).not.toContain('test-access-token');
    } finally {
      await worker.close();
      storage.destroy();
    }
  });

  test('reconciles an ambiguous publication using the same attempt', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const created = await createPublication('generic-reconciliation');
    let publishCalls = 0;
    let reconcileCalls = 0;
    const publisher: PublicationPublisher = {
      platform: 'youtube',
      publish: async (context) => {
        publishCalls += 1;
        expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
          'request_sent',
        );
        await context.checkpointEvidence({
          providerRequestId: 'provider-request-1',
          remoteMediaId: 'provider-media-reconciliation',
        });
        return {
          kind: 'ambiguous',
          failure: { classification: 'ambiguous', code: 'network_timeout' },
          evidence: {
            providerRequestId: 'provider-request-1',
            remoteMediaId: 'provider-media-reconciliation',
          },
        };
      },
      reconcile: async (context) => {
        reconcileCalls += 1;
        expect(context.evidence.providerRequestId).toBe('provider-request-1');
        return {
          kind: 'published',
          remote: {
            remoteMediaId: 'provider-media-reconciliation',
            remoteUrl: 'https://youtube.example/video',
          },
        };
      },
    };
    const preflight = createProductionPreflight();
    const worker = createPublicationWorker(
      { ...queueConfiguration, workerConcurrency: 1 },
      createPublicationJobProcessor({
        publications,
        publishers: new Map([['youtube', publisher]]),
        preflight,
        leaseDurationMs: 5_000,
        leaseHeartbeatMs: 1_000,
      }),
    );
    await worker.worker.waitUntilReady();
    const reconciler = createPublicationReconciler({
      publications,
      queue,
      publishers: new Map([['youtube', publisher]]),
      intervalMs: 10_000,
      batchSize: 10,
      leaseDurationMs: 5_000,
    });
    try {
      await queue.ensurePublicationJob({
        publicationId: created.id,
        expectedRevision: created.revision,
      });
      await waitFor(
        () => publications.findById(created.id),
        (rows) => rows[0]?.state === 'reconciling',
      );
      const beforeAttempts = await publications.listAttemptsForUser(ownerId, created.id);
      const beforeAttempt = beforeAttempts[0];
      if (!beforeAttempt) throw new Error('Ambiguous attempt was not created');
      expect(beforeAttempt.state).toBe('ambiguous');
      expect((await publications.findById(created.id))[0]?.state).toBe('reconciling');

      expect((await reconciler.reconcileOnce()).queued).toBeGreaterThan(0);
      await waitFor(
        () => publications.findById(created.id),
        (rows) => rows[0]?.state === 'published',
      );
      const afterAttempts = await publications.listAttemptsForUser(ownerId, created.id);
      const afterAttempt = afterAttempts[0];
      expect(reconcileCalls).toBe(1);
      expect(publishCalls).toBe(1);
      expect(afterAttempts).toHaveLength(beforeAttempts.length);
      expect(afterAttempt?.id).toBe(beforeAttempt.id);
      expect(afterAttempt?.state).toBe('reconciled_succeeded');
      expect(afterAttempt).toMatchObject({
        remoteMediaId: 'provider-media-reconciliation',
        remoteUrl: 'https://youtube.example/video',
      });
      expect((await publications.findById(created.id))[0]).toMatchObject({
        state: 'published',
        remoteMediaId: 'provider-media-reconciliation',
        remoteUrl: 'https://youtube.example/video',
      });
    } finally {
      await reconciler.close();
      await worker.close();
    }
  });

  test('requires an exact active credential ownership snapshot for request intent', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);

    const attemptWith = async (
      label: string,
      mutate: (accountId: string, attemptId: string) => Promise<void> = async () => undefined,
      credentialOverride: Partial<{
        accountId: string;
        userId: string;
        platform: 'youtube' | 'vk';
        credentialRevision: number;
      }> = {},
      requestOverride: Partial<{
        expectedPublicationRevision: number;
        expectedLeaseToken: string;
        attemptId: string;
        attemptRevision: number;
      }> = {},
    ) => {
      const account = await createTestAccount(ownerId, 'youtube', 0);
      const created = await createPublication(label, account.id);
      const claimed = await publications.claimPublication(
        ownerId,
        created.id,
        'queued',
        created.revision,
        5_000,
      );
      await mutate(account.id, claimed.attempt.id);
      const ownership = requestOwnership(claimed.publication, 0);
      ownership.credential = { ...ownership.credential, ...credentialOverride };
      if (requestOverride.expectedPublicationRevision !== undefined)
        ownership.expectedPublicationRevision = requestOverride.expectedPublicationRevision;
      if (requestOverride.expectedLeaseToken !== undefined)
        ownership.expectedLeaseToken = requestOverride.expectedLeaseToken;
      return publications.markAttemptRequestSent(
        ownerId,
        requestOverride.attemptId ?? claimed.attempt.id,
        requestOverride.attemptRevision ?? claimed.attempt.revision,
        ownership,
      );
    };

    const pending = await attemptWith('pending-account', async (id) => {
      await database!.db
        .update(publishingAccount)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(publishingAccount.id, id));
    });
    expect(pending).toHaveLength(0);

    const revoked = await attemptWith('revoked-account', async (id) => {
      await database!.db
        .update(publishingAccount)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(publishingAccount.id, id));
    });
    expect(revoked).toHaveLength(0);

    const stale = await attemptWith('stale-account-revision', async (id) => {
      await database!.db
        .update(publishingAccount)
        .set({ credentialRevision: 1, updatedAt: new Date() })
        .where(eq(publishingAccount.id, id));
    });
    expect(stale).toHaveLength(0);

    const wrongAccount = await createTestAccount(ownerId, 'youtube', 0);
    const wrongAccountResult = await attemptWith('wrong-account', async () => undefined, {
      accountId: wrongAccount.id,
    });
    expect(wrongAccountResult).toHaveLength(0);

    const wrongUser = await attemptWith('wrong-user', async () => undefined, {
      userId: randomUUID(),
    });
    expect(wrongUser).toHaveLength(0);

    const wrongPlatform = await attemptWith('wrong-platform', async () => undefined, {
      platform: 'vk',
    });
    expect(wrongPlatform).toHaveLength(0);

    const wrongPublicationRevision = await attemptWith(
      'wrong-publication-revision',
      async () => undefined,
      {},
      { expectedPublicationRevision: 999 },
    );
    expect(wrongPublicationRevision).toHaveLength(0);

    const wrongLease = await attemptWith(
      'wrong-lease',
      async () => undefined,
      {},
      { expectedLeaseToken: randomUUID() },
    );
    expect(wrongLease).toHaveLength(0);

    const wrongAttemptRevision = await attemptWith(
      'wrong-attempt-revision',
      async () => undefined,
      {},
      { attemptRevision: 1 },
    );
    expect(wrongAttemptRevision).toHaveLength(0);

    const wrongAttemptState = await attemptWith(
      'wrong-attempt-state',
      async (_accountId, attemptId) => {
        await database!.db
          .update(publicationAttempt)
          .set({ state: 'request_sent', requestSentAt: new Date(), updatedAt: new Date() })
          .where(eq(publicationAttempt.id, attemptId));
      },
    );
    expect(wrongAttemptState).toHaveLength(0);

    const valid = await attemptWith('valid-ownership');
    expect(valid).toHaveLength(1);
  });

  test('denies request intent when disconnect commits before locked validation', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const account = await createTestAccount(ownerId, 'youtube', 0);
    const created = await createPublication('disconnect-wins', account.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const mutation = new Client({ connectionString: runtimeDatabaseUrl });
    await mutation.connect();
    try {
      await mutation.query('BEGIN');
      await mutation.query('SELECT id FROM publishing_account WHERE id = $1 FOR UPDATE', [
        account.id,
      ]);
      await mutation.query(
        'UPDATE publishing_account SET status = $1, credential_revision = $2 WHERE id = $3',
        ['revoked', 1, account.id],
      );
      await mutation.query('COMMIT');
      const sent = await publications.markAttemptRequestSent(
        ownerId,
        claimed.attempt.id,
        claimed.attempt.revision,
        requestOwnership(claimed.publication, 0),
      );
      expect(sent).toHaveLength(0);
      expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
        'started',
      );
    } finally {
      await mutation.query('ROLLBACK').catch(() => undefined);
      await mutation.end();
    }
  });

  test('denies request intent when reconnect commits a new generation first', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const account = await createTestAccount(ownerId, 'youtube', 0);
    const created = await createPublication('reconnect-wins', account.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const mutation = new Client({ connectionString: runtimeDatabaseUrl });
    await mutation.connect();
    try {
      await mutation.query('BEGIN');
      await mutation.query('SELECT id FROM publishing_account WHERE id = $1 FOR UPDATE', [
        account.id,
      ]);
      await mutation.query(
        'UPDATE publishing_account SET status = $1, credential_revision = $2 WHERE id = $3',
        ['active', 1, account.id],
      );
      await mutation.query('COMMIT');
      const sent = await publications.markAttemptRequestSent(
        ownerId,
        claimed.attempt.id,
        claimed.attempt.revision,
        requestOwnership(claimed.publication, 0),
      );
      expect(sent).toHaveLength(0);
      expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
        'started',
      );
    } finally {
      await mutation.query('ROLLBACK').catch(() => undefined);
      await mutation.end();
    }
  });

  test('serializes request intent before a competing account mutation', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const account = await createTestAccount(ownerId, 'youtube', 0);
    const created = await createPublication('request-sent-wins', account.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const blocker = new Client({ connectionString: runtimeDatabaseUrl });
    const observer = new Client({ connectionString: runtimeDatabaseUrl });
    const competitor = new Client({ connectionString: runtimeDatabaseUrl });
    await blocker.connect();
    await observer.connect();
    await competitor.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM publishing_account WHERE id = $1 FOR UPDATE', [
        account.id,
      ]);
      const requestPromise = publications.markAttemptRequestSent(
        ownerId,
        claimed.attempt.id,
        claimed.attempt.revision,
        requestOwnership(claimed.publication, 0),
      );
      await waitForLockWait(observer, 'publishing_account');
      const mutationPromise = competitor.query(
        'UPDATE publishing_account SET status = $1, credential_revision = $2 WHERE id = $3',
        ['revoked', 1, account.id],
      );
      await waitForLockWait(observer, 'publishing_account', 2);
      await blocker.query('COMMIT');
      const sent = await requestPromise;
      await mutationPromise;
      expect(sent).toHaveLength(1);
      expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
        'request_sent',
      );
      const accountAfter = (
        await createPublishingAccountRepository(database.db).findByIdForUser(ownerId, account.id)
      )[0];
      expect(accountAfter).toMatchObject({ status: 'revoked', credentialRevision: 1 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
      await observer.end();
      await competitor.end();
    }
  });

  test('denies request intent after publication ownership changes first', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const account = await createTestAccount(ownerId, 'youtube', 0);
    const created = await createPublication('publication-change-wins', account.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    await database.db
      .update(publication)
      .set({
        revision: claimed.publication.revision + 1,
        leaseToken: randomUUID(),
        updatedAt: new Date(),
      })
      .where(eq(publication.id, created.id));
    const sent = await publications.markAttemptRequestSent(
      ownerId,
      claimed.attempt.id,
      claimed.attempt.revision,
      requestOwnership(claimed.publication, 0),
    );
    expect(sent).toHaveLength(0);
    expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
      'started',
    );
  });

  test('allows only one concurrent request intent transition', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const account = await createTestAccount(ownerId, 'youtube', 0);
    const created = await createPublication('duplicate-request-sent', account.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const ownership = requestOwnership(claimed.publication, 0);
    const results = await Promise.all([
      publications.markAttemptRequestSent(
        ownerId,
        claimed.attempt.id,
        claimed.attempt.revision,
        ownership,
      ),
      publications.markAttemptRequestSent(
        ownerId,
        claimed.attempt.id,
        claimed.attempt.revision,
        ownership,
      ),
    ]);
    expect(results.filter((result) => result.length === 1)).toHaveLength(1);
    expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
      'request_sent',
    );
  });

  test('rejects a stale credential generation before request intent', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const staleAccount = await createTestAccount(ownerId, 'youtube', 7);
    const created = await createPublication('credential-generation-race', staleAccount.id);
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    await database.db
      .update(publishingAccount)
      .set({ credentialRevision: 8, updatedAt: new Date() })
      .where(eq(publishingAccount.id, staleAccount.id));
    const sent = await publications.markAttemptRequestSent(
      ownerId,
      claimed.attempt.id,
      claimed.attempt.revision,
      requestOwnership(claimed.publication, 7),
    );
    expect(sent).toHaveLength(0);
    expect((await publications.findLatestAttemptForUser(ownerId, created.id))[0]?.state).toBe(
      'started',
    );
  });

  test('makes evidence checkpoint idempotent, conflict-safe, and URL-safe', async () => {
    if (!database) throw new Error('Database is not initialized');
    const publications = createPublicationRepository(database.db);
    const created = await createPublication('evidence-cas');
    const claimed = await publications.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const [sent] = await publications.markAttemptRequestSent(
      ownerId,
      claimed.attempt.id,
      claimed.attempt.revision,
      requestOwnership(claimed.publication, 7),
    );
    if (!sent) throw new Error('Request intent was not recorded');
    const ownership = {
      expectedPublicationRevision: claimed.publication.revision,
      expectedLeaseToken: claimed.publication.leaseToken!,
      expectedPublicationState: 'publishing' as const,
      expectedAttemptState: 'request_sent' as const,
    };
    const first = await publications.checkpointAttemptEvidence(
      ownerId,
      created.id,
      sent.id,
      sent.revision,
      ownership,
      { providerRequestId: 'request-cas', remoteUrl: 'https://youtube.example/video' },
    );
    expect(first.outcome).toBe('updated');
    const second = await publications.checkpointAttemptEvidence(
      ownerId,
      created.id,
      sent.id,
      first.outcome === 'updated' ? first.attempt.revision : sent.revision,
      ownership,
      { providerRequestId: 'request-cas', remoteUrl: 'https://youtube.example/video' },
    );
    expect(second.outcome).toBe('unchanged');
    const conflict = await publications.checkpointAttemptEvidence(
      ownerId,
      created.id,
      sent.id,
      first.outcome === 'updated' ? first.attempt.revision : sent.revision,
      ownership,
      { providerRequestId: 'different-request' },
    );
    expect(conflict.outcome).toBe('conflict');
    await expect(
      publications.checkpointAttemptEvidence(
        ownerId,
        created.id,
        sent.id,
        first.outcome === 'updated' ? first.attempt.revision : sent.revision,
        ownership,
        { remoteUrl: 'http://127.0.0.1/private' },
      ),
    ).rejects.toThrow('Remote URL is unsafe');
  });
});
