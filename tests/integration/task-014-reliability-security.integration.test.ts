import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  applyMigrations,
  createDatabase,
  createMultipartUploadRepository,
  createPublicationRepository,
  createVideoRepository,
  publishingAccount,
  user,
  video,
} from '../../packages/db/src/index.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-014 integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_task014_${suffix}`;
let database: ReturnType<typeof createDatabase>;
let ownerId: string;
let otherUserId: string;

describe('TASK-014 reliability and ownership', () => {
  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await admin.end();
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    database = createDatabase(databaseUrl.toString());
    await applyMigrations(database);
    const createdUsers = await database.db
      .insert(user)
      .values([
        { name: 'Owner', email: `owner-${suffix}@example.com` },
        { name: 'Other', email: `other-${suffix}@example.com` },
      ])
      .returning();
    ownerId = createdUsers[0]!.id;
    otherUserId = createdUsers[1]!.id;
  });

  afterAll(async () => {
    await database?.pool.end();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    } finally {
      await admin.end();
    }
  });

  test('starts one new retry cycle without duplicating or discarding attempt history', async () => {
    const [readyVideo] = await database.db
      .insert(video)
      .values({
        userId: ownerId,
        originalFilename: 'retry.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 100,
        verifiedSizeBytes: 100,
        storageBackend: 's3-compatible',
        storageBucket: 'private-source',
        objectKey: `sources/${ownerId}/${randomUUID()}`,
        objectEtag: 'verified-etag',
        state: 'ready',
        verifiedAt: new Date(),
      })
      .returning();
    const [account] = await database.db
      .insert(publishingAccount)
      .values({
        userId: ownerId,
        platform: 'youtube',
        providerAccountId: `channel-${suffix}`,
        status: 'active',
        accessTokenCiphertext: 'encrypted-test-value',
        credentialFormatVersion: 1,
        credentialKeyId: 'test-key',
        credentialUpdatedAt: new Date(),
      })
      .returning();
    const publications = createPublicationRepository(database.db);
    const [created] = await publications.createOwnedPublication(ownerId, {
      videoId: readyVideo!.id,
      publishingAccountId: account!.id,
      platform: 'youtube',
      title: 'Retry safely',
    });
    const claimed = await publications.claimPublication(
      ownerId,
      created!.id,
      'queued',
      created!.revision,
      60_000,
    );
    const failed = await publications.settleDefinitiveFailure(
      ownerId,
      created!.id,
      claimed.attempt.id,
      claimed.attempt.revision,
      claimed.publication.revision,
      'started',
      {
        failureClass: 'provider',
        failureCode: 'DEFINITE_TERMINAL',
        retryable: false,
      },
    );

    expect(
      await publications.retryFailedPublication(
        otherUserId,
        created!.id,
        failed.publication.revision,
      ),
    ).toHaveLength(0);
    const concurrent = await Promise.all([
      publications.retryFailedPublication(ownerId, created!.id, failed.publication.revision),
      publications.retryFailedPublication(ownerId, created!.id, failed.publication.revision),
    ]);
    expect(concurrent.filter((rows) => rows.length === 1)).toHaveLength(1);
    const retried = concurrent.flat()[0]!;
    expect(retried).toMatchObject({
      state: 'queued',
      attemptCount: 1,
      retryCycleAttemptCount: 0,
      failureCode: null,
    });
    expect(await publications.listAttemptsForUser(ownerId, created!.id)).toHaveLength(1);
  });

  test('claims an expired multipart cleanup candidate once across a race', async () => {
    const videos = createVideoRepository(database.db);
    const uploads = createMultipartUploadRepository(database.db);
    const [createdVideo] = await videos.createOwnedVideo(ownerId, {
      originalFilename: 'expired.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 100,
      storageBackend: 's3-compatible',
      storageBucket: 'private-source',
      objectKey: `sources/${ownerId}/${randomUUID()}`,
    });
    const [createdUpload] = await uploads.createOwnedUpload(ownerId, {
      videoId: createdVideo!.id,
      providerUploadId: `provider-${randomUUID()}`,
      partSizeBytes: 100,
      expectedPartCount: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const now = new Date();
    const candidates = await uploads.listCleanupCandidates({
      now,
      abortPendingBefore: new Date(now.getTime() - 120_000),
      limit: 100,
    });
    expect(candidates.some(({ upload }) => upload.id === createdUpload!.id)).toBe(true);
    const claims = await Promise.all([
      uploads.claimCleanupCandidate(
        ownerId,
        createdUpload!.id,
        'active',
        createdUpload!.revision,
        now,
        new Date(now.getTime() - 120_000),
      ),
      uploads.claimCleanupCandidate(
        ownerId,
        createdUpload!.id,
        'active',
        createdUpload!.revision,
        now,
        new Date(now.getTime() - 120_000),
      ),
    ]);
    expect(claims.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect(claims.flat()[0]).toMatchObject({ state: 'abort_pending' });
  });
});
