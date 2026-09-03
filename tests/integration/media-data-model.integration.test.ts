import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applyMigrations,
  createDatabase,
  createMultipartUploadRepository,
  createPublicationRepository,
  createVideoRepository,
  multipartUpload,
  publication,
  publishingAccount,
  uploadPart,
  user,
  video,
} from '../../packages/db/src/index.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-004 integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_media_test_${suffix}`;
const migrationRole = `sovara_media_migration_${suffix}`;
const runtimeRole = `sovara_media_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
let databaseUrl: string;
let migrationDatabaseUrl: string;
let database: ReturnType<typeof createDatabase>;
let ownerId: string;
let otherUserId: string;

async function createTestUser(name: string) {
  const [created] = await database.db
    .insert(user)
    .values({ name, email: `${name.toLowerCase()}-${suffix}@example.com` })
    .returning();
  if (!created) throw new Error('Test user was not created');
  return created.id;
}

async function createReadyVideo(userId: string, label: string, size = 123) {
  const repository = createVideoRepository(database.db);
  const multipartRepository = createMultipartUploadRepository(database.db);
  const [created] = await repository.createOwnedVideo(userId, {
    originalFilename: `${label}.mp4`,
    contentType: 'video/mp4',
    expectedSizeBytes: size,
    storageBackend: 's3-compatible',
    storageBucket: 'private-video-source',
    objectKey: `videos/${userId}/${randomUUID()}.mp4`,
  });
  if (!created) throw new Error('Video was not created');
  const [upload] = await multipartRepository.createOwnedUpload(userId, {
    videoId: created.id,
    providerUploadId: `provider-${randomUUID()}`,
    partSizeBytes: size,
    expectedPartCount: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!upload) throw new Error('Multipart upload was not created');
  await multipartRepository.recordOrReplacePart(userId, upload.id, {
    partNumber: 1,
    etag: `etag-${label}`,
    reportedSizeBytes: size,
  });
  const claimed = await multipartRepository.claimCompletion(userId, upload.id, upload.revision, [
    { partNumber: 1, etag: `etag-${label}` },
  ]);
  const completed = await multipartRepository.settleCompletion(
    userId,
    upload.id,
    claimed.upload.revision,
    created.revision + 1,
  );
  const [verifying] = await repository.beginVerification(
    userId,
    created.id,
    completed.video.revision,
  );
  const [ready] = await repository.recordVerified(userId, created.id, verifying!.revision, {
    verifiedAt: new Date(),
    verifiedSizeBytes: size,
    objectEtag: 'etag-not-md5',
  });
  if (!ready) throw new Error('Video was not made ready');
  return ready;
}

async function createPublishingAccount(userId: string, platform: 'youtube' | 'vk') {
  const [created] = await database.db
    .insert(publishingAccount)
    .values({
      userId,
      platform,
      providerAccountId: `${platform}-${randomUUID()}`,
      displayName: `${platform} test account`,
      status: 'active',
      accessTokenCiphertext: 'test-only-ciphertext',
      credentialFormatVersion: 1,
      credentialKeyId: 'test-key',
      credentialUpdatedAt: new Date(),
      credentialRevision: 0,
    })
    .returning();
  if (!created) throw new Error('Publishing account was not created');
  return created;
}

function requestOwnership(publicationRow: {
  id: string;
  revision: number;
  leaseToken: string | null;
  publishingAccountId: string;
  userId: string;
  platform: string;
}) {
  return {
    publicationId: publicationRow.id,
    expectedPublicationRevision: publicationRow.revision,
    expectedLeaseToken: publicationRow.leaseToken!,
    credential: {
      accountId: publicationRow.publishingAccountId,
      userId: publicationRow.userId,
      platform: publicationRow.platform as 'youtube' | 'vk',
      credentialRevision: 0,
    },
  };
}

describe('TASK-004 media data model', () => {
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
    databaseUrl = baseUrl.toString();
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.username = migrationRole;
    migrationUrl.password = migrationPassword;
    migrationDatabaseUrl = migrationUrl.toString();
    const migrationDatabase = createDatabase(migrationDatabaseUrl);
    await applyMigrations(migrationDatabase);
    await applyMigrations(migrationDatabase);
    await migrationDatabase.pool.end();

    const owner = new Client({ connectionString: databaseUrl });
    await owner.connect();
    try {
      await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await owner.query('REVOKE ALL ON SCHEMA drizzle FROM PUBLIC');
      await owner.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, publishing_account, video, multipart_upload, upload_part, publication, publication_attempt TO ${runtimeRole}`,
      );
    } finally {
      await owner.end();
    }
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    database = createDatabase(runtimeUrl.toString());
    ownerId = await createTestUser('Owner');
    otherUserId = await createTestUser('Other');
  });

  afterAll(async () => {
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

  test('supports owned video lifecycle and verifies database constraints', async () => {
    const repository = createVideoRepository(database.db);
    const ready = await createReadyVideo(ownerId, 'owned');
    expect(await repository.findByIdForUser(otherUserId, ready.id)).toHaveLength(0);
    expect(await repository.findByIdForUser(ownerId, ready.id)).toHaveLength(1);
    expect(
      await repository.requestDeletion(ownerId, ready.id, 'ready', ready.revision),
    ).toHaveLength(1);
    expect((await repository.findByIdForUser(ownerId, ready.id))[0]?.objectEtag).toBe(
      'etag-not-md5',
    );

    await expect(
      database.db
        .insert(video)
        .values({
          userId: ownerId,
          originalFilename: 'invalid.mp4',
          contentType: 'video/mp4',
          expectedSizeBytes: 10,
          storageBackend: 's3-compatible',
          storageBucket: 'private-video-source',
          objectKey: `invalid/${randomUUID()}`,
          state: 'ready',
        })
        .returning(),
    ).rejects.toBeTruthy();
    await expect(
      database.db.insert(video).values({
        userId: ownerId,
        originalFilename: 'wrong-size.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 10,
        verifiedSizeBytes: 9,
        storageBackend: 's3-compatible',
        storageBucket: 'private-video-source',
        objectKey: `wrong-size/${randomUUID()}`,
        state: 'ready',
        verifiedAt: new Date(),
      }),
    ).rejects.toBeTruthy();

    const duplicateKey = `unique/${randomUUID()}`;
    const baseVideo = {
      userId: ownerId,
      originalFilename: 'tuple.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 10,
      storageBackend: 's3-compatible',
      storageBucket: 'private-video-source',
      objectKey: duplicateKey,
    };
    await database.db.insert(video).values(baseVideo);
    await expect(database.db.insert(video).values(baseVideo)).rejects.toBeTruthy();

    await expect(
      database.db.insert(video).values({
        ...baseVideo,
        objectKey: `checksum/${randomUUID()}`,
        verifiedChecksumAlgorithm: 'sha256',
      }),
    ).rejects.toBeTruthy();
    const [checksumVideo] = await database.db
      .insert(video)
      .values({
        ...baseVideo,
        objectKey: `checksum-valid/${randomUUID()}`,
        verifiedChecksumAlgorithm: 'sha256',
        verifiedChecksumValue: 'abc123',
      })
      .returning();
    expect(checksumVideo?.objectEtag).toBeNull();
  });

  test('keeps multipart uploads resumable, owned, and CAS-protected', async () => {
    const videoRepository = createVideoRepository(database.db);
    const multipartRepository = createMultipartUploadRepository(database.db);
    const [source] = await videoRepository.createOwnedVideo(ownerId, {
      originalFilename: 'upload.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 200,
      storageBackend: 's3-compatible',
      storageBucket: 'private-video-source',
      objectKey: `uploads/${randomUUID()}`,
    });
    if (!source) throw new Error('Source video was not created');
    const [upload] = await multipartRepository.createOwnedUpload(ownerId, {
      videoId: source.id,
      providerUploadId: `provider-${randomUUID()}`,
      partSizeBytes: 100,
      expectedPartCount: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (!upload) throw new Error('Multipart upload was not created');
    expect((await videoRepository.findByIdForUser(ownerId, source.id))[0]?.state).toBe('uploading');
    expect(await multipartRepository.findByIdForUser(otherUserId, upload.id)).toHaveLength(0);
    await expect(
      multipartRepository.createOwnedUpload(ownerId, {
        videoId: source.id,
        providerUploadId: `second-${randomUUID()}`,
        partSizeBytes: 100,
        expectedPartCount: 2,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toBeTruthy();
    await expect(
      multipartRepository.recordOrReplacePart(otherUserId, upload.id, {
        partNumber: 1,
        etag: 'foreign',
      }),
    ).rejects.toBeTruthy();
    await expect(
      multipartRepository.recordOrReplacePart(ownerId, upload.id, { partNumber: 0, etag: 'bad' }),
    ).rejects.toBeTruthy();
    await expect(
      multipartRepository.recordOrReplacePart(ownerId, upload.id, { partNumber: 3, etag: 'bad' }),
    ).rejects.toBeTruthy();
    await multipartRepository.recordOrReplacePart(ownerId, upload.id, {
      partNumber: 1,
      etag: 'opaque-not-md5',
      reportedSizeBytes: 100,
    });
    await multipartRepository.recordOrReplacePart(ownerId, upload.id, {
      partNumber: 1,
      etag: 'opaque-replacement',
      reportedSizeBytes: 100,
    });
    await multipartRepository.recordOrReplacePart(ownerId, upload.id, {
      partNumber: 2,
      etag: 'second',
      reportedSizeBytes: 100,
      providerChecksumAlgorithm: 'crc32c',
      providerChecksumValue: 'provider-value',
    });
    expect(
      (await multipartRepository.listPartsForUser(ownerId, upload.id)).map((part) => part.etag),
    ).toEqual(['opaque-replacement', 'second']);
    await expect(
      multipartRepository.claimCompletion(ownerId, upload.id, upload.revision, [
        { partNumber: 1, etag: 'opaque-replacement' },
      ]),
    ).rejects.toBeTruthy();
    await expect(
      multipartRepository.claimCompletion(ownerId, upload.id, upload.revision, [
        { partNumber: 1, etag: 'wrong' },
        { partNumber: 2, etag: 'second' },
      ]),
    ).rejects.toBeTruthy();
    const claimed = await multipartRepository.claimCompletion(ownerId, upload.id, upload.revision, [
      { partNumber: 1, etag: 'opaque-replacement' },
      { partNumber: 2, etag: 'second' },
    ]);
    expect(claimed.upload.state).toBe('completing');
    const partsBeforeRejectedMutations = await multipartRepository.listPartsForUser(
      ownerId,
      upload.id,
    );
    await expect(
      multipartRepository.recordOrReplacePart(ownerId, upload.id, {
        partNumber: 1,
        etag: 'replacement-after-completing',
        reportedSizeBytes: 100,
      }),
    ).rejects.toThrow('Multipart upload is not active');
    await expect(
      multipartRepository.recordOrReplacePart(ownerId, upload.id, {
        partNumber: 2,
        etag: 'change-after-completing',
        reportedSizeBytes: 100,
      }),
    ).rejects.toThrow('Multipart upload is not active');
    expect(await multipartRepository.listPartsForUser(ownerId, upload.id)).toEqual(
      partsBeforeRejectedMutations,
    );
    const [uploadAfterRejectedMutations] = await multipartRepository.findByIdForUser(
      ownerId,
      upload.id,
    );
    expect(uploadAfterRejectedMutations?.state).toBe('completing');
    expect(uploadAfterRejectedMutations?.revision).toBe(claimed.upload.revision);
    await expect(
      multipartRepository.settleCompletion(
        ownerId,
        upload.id,
        claimed.upload.revision + 1,
        source.revision + 1,
      ),
    ).rejects.toBeTruthy();
    expect((await multipartRepository.findByIdForUser(ownerId, upload.id))[0]?.state).toBe(
      'completing',
    );
    expect((await videoRepository.findByIdForUser(ownerId, source.id))[0]?.state).toBe('uploading');
    const completed = await multipartRepository.settleCompletion(
      ownerId,
      upload.id,
      claimed.upload.revision,
      source.revision + 1,
    );
    expect(completed.upload.state).toBe('completed');
    expect(completed.video.state).toBe('uploaded');
    expect((await videoRepository.findByIdForUser(ownerId, source.id))[0]?.state).toBe('uploaded');
    await expect(
      multipartRepository.createOwnedUpload(ownerId, {
        videoId: source.id,
        providerUploadId: `after-complete-${randomUUID()}`,
        partSizeBytes: 100,
        expectedPartCount: 2,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow('Video is not available');
    await expect(
      database.db.insert(uploadPart).values({
        multipartUploadId: upload.id,
        userId: otherUserId,
        partNumber: 1,
        etag: 'wrong-owner',
      }),
    ).rejects.toBeTruthy();
  });

  test('keeps YouTube and VK publications independent and reconciliable', async () => {
    const publicationRepository = createPublicationRepository(database.db);
    const youtubeVideo = await createReadyVideo(ownerId, 'youtube');
    const vkVideo = await createReadyVideo(ownerId, 'vk');
    const retryVideo = await createReadyVideo(ownerId, 'retry');
    const youtubeAccount = await createPublishingAccount(ownerId, 'youtube');
    const vkAccount = await createPublishingAccount(ownerId, 'vk');
    const otherAccount = await createPublishingAccount(otherUserId, 'youtube');
    const [youtube] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: youtubeVideo.id,
      publishingAccountId: youtubeAccount.id,
      platform: 'youtube',
      title: 'YouTube title',
    });
    const [vk] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: vkVideo.id,
      publishingAccountId: vkAccount.id,
      platform: 'vk',
      title: 'VK title',
    });
    if (!youtube || !vk) throw new Error('Publications were not created');
    expect(await publicationRepository.findByIdForUser(otherUserId, youtube.id)).toHaveLength(0);
    await expect(
      publicationRepository.createOwnedPublication(ownerId, {
        videoId: retryVideo.id,
        publishingAccountId: otherAccount.id,
        platform: 'youtube',
        title: 'Wrong owner',
      }),
    ).rejects.toBeTruthy();
    await expect(
      publicationRepository.claimPublication(
        ownerId,
        youtube.id,
        'queued',
        youtube.revision + 1,
        60_000,
      ),
    ).rejects.toBeTruthy();
    await expect(
      publicationRepository.createOwnedPublication(ownerId, {
        videoId: retryVideo.id,
        publishingAccountId: vkAccount.id,
        platform: 'youtube',
        title: 'Wrong platform',
      }),
    ).rejects.toBeTruthy();
    await expect(
      publicationRepository.createOwnedPublication(ownerId, {
        videoId: youtubeVideo.id,
        publishingAccountId: youtubeAccount.id,
        platform: 'youtube',
        title: 'Duplicate intent',
      }),
    ).rejects.toBeTruthy();

    const youtubeClaim = await publicationRepository.claimPublication(
      ownerId,
      youtube.id,
      'queued',
      youtube.revision,
      60_000,
    );
    const failedYoutube = await publicationRepository.settleDefinitiveFailure(
      ownerId,
      youtube.id,
      youtubeClaim.attempt.id,
      youtubeClaim.attempt.revision,
      youtubeClaim.publication.revision,
      'started',
      {
        failureClass: 'provider',
        failureCode: 'rejected',
        failureMessage: 'definitive failure',
        retryable: false,
      },
    );
    expect(failedYoutube.publication.state).toBe('failed');
    expect(
      await publicationRepository.retryFailedPublication(
        otherUserId,
        youtube.id,
        failedYoutube.publication.revision,
      ),
    ).toHaveLength(0);
    const [manuallyRetried] = await publicationRepository.retryFailedPublication(
      ownerId,
      youtube.id,
      failedYoutube.publication.revision,
    );
    expect(manuallyRetried).toMatchObject({
      state: 'queued',
      attemptCount: 1,
      retryCycleAttemptCount: 0,
      failureCode: null,
      revision: failedYoutube.publication.revision + 1,
    });
    expect(
      await publicationRepository.retryFailedPublication(
        ownerId,
        youtube.id,
        failedYoutube.publication.revision,
      ),
    ).toHaveLength(0);
    expect((await publicationRepository.findByIdForUser(ownerId, vk.id))[0]?.state).toBe('queued');
    expect(await publicationRepository.listAttemptsForUser(ownerId, youtube.id)).toHaveLength(1);

    const [retryPublication] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: retryVideo.id,
      publishingAccountId: youtubeAccount.id,
      platform: 'youtube',
      title: 'Retry title',
    });
    if (!retryPublication) throw new Error('Retry publication was not created');
    const firstClaim = await publicationRepository.claimPublication(
      ownerId,
      retryPublication.id,
      'queued',
      retryPublication.revision,
      60_000,
    );
    const sent = await publicationRepository.markAttemptRequestSent(
      ownerId,
      firstClaim.attempt.id,
      firstClaim.attempt.revision,
      requestOwnership(firstClaim.publication),
    );
    expect(sent).toHaveLength(1);
    const ambiguous = await publicationRepository.markAmbiguous(
      ownerId,
      retryPublication.id,
      firstClaim.attempt.id,
      sent[0]!.revision,
      firstClaim.publication.revision,
    );
    expect('transitionState' in publicationRepository).toBe(false);
    expect('transitionAttemptState' in publicationRepository).toBe(false);
    await expect(
      publicationRepository.reconcileAbsent(
        ownerId,
        retryPublication.id,
        firstClaim.attempt.id,
        ambiguous.attempt.revision + 1,
        ambiguous.publication.revision,
        new Date(Date.now() - 1),
      ),
    ).rejects.toBeTruthy();
    await expect(
      publicationRepository.reconcileAbsent(
        ownerId,
        retryPublication.id,
        firstClaim.attempt.id,
        ambiguous.attempt.revision,
        ambiguous.publication.revision + 1,
        new Date(Date.now() - 1),
      ),
    ).rejects.toBeTruthy();
    expect(
      (await publicationRepository.findByIdForUser(ownerId, retryPublication.id))[0]?.state,
    ).toBe('reconciling');
    expect(
      (await publicationRepository.listAttemptsForUser(ownerId, retryPublication.id))[0]?.state,
    ).toBe('ambiguous');
    const retryWait = await publicationRepository.reconcileAbsent(
      ownerId,
      retryPublication.id,
      firstClaim.attempt.id,
      ambiguous.attempt.revision,
      ambiguous.publication.revision,
      new Date(Date.now() - 1),
    );
    expect(retryWait.publication.state).toBe('retry_wait');
    const secondClaim = await publicationRepository.claimPublication(
      ownerId,
      retryPublication.id,
      'retry_wait',
      retryWait.publication.revision,
      60_000,
    );
    const secondSent = await publicationRepository.markAttemptRequestSent(
      ownerId,
      secondClaim.attempt.id,
      secondClaim.attempt.revision,
      requestOwnership(secondClaim.publication),
    );
    const secondAmbiguous = await publicationRepository.markAmbiguous(
      ownerId,
      retryPublication.id,
      secondClaim.attempt.id,
      secondSent[0]!.revision,
      secondClaim.publication.revision,
    );
    await expect(
      publicationRepository.reconcileSucceeded(
        ownerId,
        retryPublication.id,
        secondClaim.attempt.id,
        secondAmbiguous.attempt.revision,
        secondAmbiguous.publication.revision,
        null,
        ' ',
      ),
    ).rejects.toThrow('Remote media identity is required');
    const published = await publicationRepository.reconcileSucceeded(
      ownerId,
      retryPublication.id,
      secondClaim.attempt.id,
      secondAmbiguous.attempt.revision,
      secondAmbiguous.publication.revision,
      null,
      `youtube-remote-${randomUUID()}`,
      'https://youtube.example/video',
    );
    expect(published.publication.state).toBe('published');
    const vkClaim = await publicationRepository.claimPublication(
      ownerId,
      vk.id,
      'queued',
      vk.revision,
      60_000,
    );
    const vkSent = await publicationRepository.markAttemptRequestSent(
      ownerId,
      vkClaim.attempt.id,
      vkClaim.attempt.revision,
      requestOwnership(vkClaim.publication),
    );
    const vkPublished = await publicationRepository.settleDefinitiveSuccess(
      ownerId,
      vk.id,
      vkClaim.attempt.id,
      vkSent[0]!.revision,
      vkClaim.publication.revision,
      'vk-owner-a',
      'vk-media-1',
    );
    expect(vkPublished.publication.state).toBe('published');
    const youtubeIdentityVideo = await createReadyVideo(ownerId, 'youtube-identity');
    const [youtubeIdentityPublication] = await publicationRepository.createOwnedPublication(
      ownerId,
      {
        videoId: youtubeIdentityVideo.id,
        publishingAccountId: youtubeAccount.id,
        platform: 'youtube',
        title: 'YouTube identity duplicate',
      },
    );
    if (!youtubeIdentityPublication)
      throw new Error('YouTube identity publication was not created');
    await expect(
      database.db
        .update(publication)
        .set({
          state: 'published',
          remoteMediaId: published.publication.remoteMediaId,
          publishedAt: new Date(),
          revision: youtubeIdentityPublication.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(publication.id, youtubeIdentityPublication.id)),
    ).rejects.toBeTruthy();
    const vkIdentityVideoB = await createReadyVideo(ownerId, 'vk-identity-b');
    const vkIdentityVideoC = await createReadyVideo(ownerId, 'vk-identity-c');
    const [vkIdentityB] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: vkIdentityVideoB.id,
      publishingAccountId: vkAccount.id,
      platform: 'vk',
      title: 'VK identity B',
    });
    const [vkIdentityC] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: vkIdentityVideoC.id,
      publishingAccountId: vkAccount.id,
      platform: 'vk',
      title: 'VK identity C',
    });
    if (!vkIdentityB || !vkIdentityC) throw new Error('VK identity publications were not created');
    const vkIdentityValues = {
      state: 'published' as const,
      remoteOwnerId: 'vk-owner-a',
      remoteMediaId: 'vk-media-1',
      publishedAt: new Date(),
    };
    await expect(
      database.db
        .update(publication)
        .set(vkIdentityValues)
        .where(eq(publication.id, vkIdentityB.id))
        .returning(),
    ).rejects.toBeTruthy();
    await expect(
      database.db
        .update(publication)
        .set({ ...vkIdentityValues, remoteOwnerId: 'vk-owner-b' })
        .where(eq(publication.id, vkIdentityC.id))
        .returning(),
    ).resolves.toHaveLength(1);
    expect(youtubeVideo.id).not.toBe(vkVideo.id);
  });

  test('enforces runtime privilege and deletion restrictions', async () => {
    const client = new Client({
      connectionString: databaseUrl.replace(/\/\/[^@]+@/, `//${runtimeRole}:${runtimePassword}@`),
    });
    await client.connect();
    try {
      await expect(client.query('CREATE TABLE forbidden_media_ddl(id uuid)')).rejects.toBeTruthy();
      await expect(
        client.query('SELECT * FROM "drizzle"."__drizzle_migrations"'),
      ).rejects.toBeTruthy();
    } finally {
      await client.end();
    }
    const videoRepository = createVideoRepository(database.db);
    const [source] = await videoRepository.createOwnedVideo(ownerId, {
      originalFilename: 'delete-active.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 100,
      storageBackend: 's3-compatible',
      storageBucket: 'private-video-source',
      objectKey: `delete-active/${randomUUID()}`,
    });
    if (!source) throw new Error('Deletion test video was not created');
    const multipartRepository = createMultipartUploadRepository(database.db);
    const [active] = await multipartRepository.createOwnedUpload(ownerId, {
      videoId: source.id,
      providerUploadId: `active-${randomUUID()}`,
      partSizeBytes: 100,
      expectedPartCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (!active) throw new Error('Active upload was not created');
    await expect(database.db.delete(video).where(eq(video.id, source.id))).rejects.toBeTruthy();
    const [abortPending] = await multipartRepository.requestAbort(
      ownerId,
      active.id,
      'active',
      active.revision,
    );
    expect(abortPending?.state).toBe('abort_pending');
    const [expired] = await multipartRepository.settleAbort(
      ownerId,
      active.id,
      abortPending!.revision,
      'expired',
    );
    expect(expired?.state).toBe('expired');
    await database.db.delete(multipartUpload).where(eq(multipartUpload.id, active.id));
    const publicationRepository = createPublicationRepository(database.db);
    const retainedVideo = await createReadyVideo(ownerId, 'retained-remote');
    const account = await createPublishingAccount(ownerId, 'youtube');
    const [publicationRow] = await publicationRepository.createOwnedPublication(ownerId, {
      videoId: retainedVideo.id,
      publishingAccountId: account.id,
      platform: 'youtube',
      title: 'Retained remote publication',
    });
    if (!publicationRow) throw new Error('Publication was not created');
    await expect(
      database.db.delete(video).where(eq(video.id, retainedVideo.id)),
    ).rejects.toBeTruthy();
  });
});
