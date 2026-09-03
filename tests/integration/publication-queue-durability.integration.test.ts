import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  applyMigrations,
  createDatabase,
  createMultipartUploadRepository,
  createPublicationRepository,
  createVideoRepository,
  publication,
  publishingAccount,
  user,
} from '../../packages/db/src/index.js';
import {
  createPublicationQueue,
  createPublicationWorker,
  type PublicationQueueConfiguration,
} from '../../packages/infra/dist/index.js';
import { createPublicationJobProcessor } from '../../apps/worker/src/publication-job-processor.js';
import { createPublicationReconciler } from '../../apps/worker/src/publication-reconciler.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for TASK-008 integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_queue_test_${suffix}`;
const migrationRole = `sovara_queue_migration_${suffix}`;
const runtimeRole = `sovara_queue_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
let database: ReturnType<typeof createDatabase>;
let ownerId: string;

const queueConfiguration: PublicationQueueConfiguration = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:16379',
  queueName: `sovara-publications-${suffix}`,
  prefix: `sovara-studio-${suffix}`,
  jobAttempts: 2,
  backoffMs: 50,
  lockDurationMs: 5_000,
  stalledIntervalMs: 1_000,
  maxStalledCount: 1,
  completedRetentionSeconds: 3_600,
  failedRetentionSeconds: 3_600,
  connectionTimeoutMs: 2_000,
};

async function createReadyVideo(label: string) {
  const videos = createVideoRepository(database.db);
  const uploads = createMultipartUploadRepository(database.db);
  const [created] = await videos.createOwnedVideo(ownerId, {
    originalFilename: `${label}.mp4`,
    contentType: 'video/mp4',
    expectedSizeBytes: 123,
    storageBackend: 's3-compatible',
    storageBucket: 'private-video-source',
    objectKey: `videos/${ownerId}/${randomUUID()}.mp4`,
  });
  if (!created) throw new Error('Test video was not created');
  const [upload] = await uploads.createOwnedUpload(ownerId, {
    videoId: created.id,
    providerUploadId: `provider-${randomUUID()}`,
    partSizeBytes: 123,
    expectedPartCount: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (!upload) throw new Error('Test upload was not created');
  await uploads.recordOrReplacePart(ownerId, upload.id, {
    partNumber: 1,
    etag: `etag-${label}`,
    reportedSizeBytes: 123,
  });
  const claimed = await uploads.claimCompletion(ownerId, upload.id, upload.revision, [
    { partNumber: 1, etag: `etag-${label}` },
  ]);
  const completed = await uploads.settleCompletion(
    ownerId,
    upload.id,
    claimed.upload.revision,
    created.revision + 1,
  );
  const [verifying] = await videos.beginVerification(ownerId, created.id, completed.video.revision);
  const [ready] = await videos.recordVerified(ownerId, created.id, verifying!.revision, {
    verifiedAt: new Date(),
    verifiedSizeBytes: 123,
    objectEtag: 'test-etag',
  });
  if (!ready) throw new Error('Test video was not verified');
  return ready;
}

async function createEligiblePublication(label: string, platform: 'youtube' | 'vk' = 'youtube') {
  const videos = await createReadyVideo(label);
  const [account] = await database.db
    .insert(publishingAccount)
    .values({
      userId: ownerId,
      platform,
      providerAccountId: `${platform}-${randomUUID()}`,
      displayName: `Test ${platform} account`,
      status: 'active',
      accessTokenCiphertext: 'test-only-ciphertext',
      credentialFormatVersion: 1,
      credentialKeyId: 'test-key',
      credentialUpdatedAt: new Date(),
      credentialRevision: 0,
    })
    .returning();
  if (!account) throw new Error('Test publishing account was not created');
  const publications = createPublicationRepository(database.db);
  const [created] = await publications.createOwnedPublication(ownerId, {
    videoId: videos.id,
    publishingAccountId: account.id,
    platform,
    title: `Queue test ${label}`,
  });
  if (!created) throw new Error('Test publication was not created');
  return created;
}

function payloadFor(publicationId: string, expectedRevision: number) {
  return { publicationId, expectedRevision };
}

function workerConfiguration() {
  return {
    ...queueConfiguration,
    workerConcurrency: 1,
  };
}

async function waitForState(
  queue: ReturnType<typeof createPublicationQueue>,
  jobId: string,
  expected: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await queue.queue.getJob(jobId);
    if (job && (await job.getState()) === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId} to become ${expected}`);
}

describe('TASK-008 publication queue durability', () => {
  const queue = createPublicationQueue(queueConfiguration);
  const publications = () => createPublicationRepository(database.db);

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
    database = createDatabase(runtimeUrl.toString());
    const [ownerRow] = await database.db
      .insert(user)
      .values({ name: 'Queue Owner', email: `queue-owner-${suffix}@example.com` })
      .returning();
    if (!ownerRow) throw new Error('Test owner was not created');
    ownerId = ownerRow.id;
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

  test('keeps DB work durable across queue insertion failure', async () => {
    const created = await createEligiblePublication('insert-failure');
    const reconciler = createPublicationReconciler({
      publications: publications(),
      queue,
      executors: new Map([['youtube', { executeAfterRequestSent: async () => undefined }]]),
      intervalMs: 10_000,
      batchSize: 1,
      leaseDurationMs: 5_000,
    });
    const addSpy = vi
      .spyOn(queue.queue, 'add')
      .mockRejectedValueOnce(new Error('simulated Redis insertion failure'));
    await expect(reconciler.reconcileOnce()).rejects.toThrow('Redis insertion failure');
    expect((await publications().findById(created.id))[0]?.state).toBe('queued');
    expect((await publications().findById(created.id))[0]?.attemptCount).toBe(0);
    addSpy.mockRestore();
    await reconciler.reconcileOnce();
    expect(await queue.queue.getJob(`publication-${created.id}-r${created.revision}`)).toBeTruthy();
  });

  test('filters unsupported older rows before applying the reconciliation limit', async () => {
    await database.db.delete(publication);
    for (let index = 0; index < 12; index += 1)
      await createEligiblePublication(`unsupported-${index}`, 'vk');
    const supported = await createEligiblePublication('supported-late', 'youtube');
    const candidates = await publications().listQueueCandidates({
      executablePlatforms: ['youtube'],
      includeQueued: true,
      includeDueRetryWait: true,
      reconcilablePlatforms: [],
      limit: 1,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(supported.id);
  });

  test('leaves eligible PostgreSQL work unchanged when no executor is registered', async () => {
    const created = await createEligiblePublication('no-executor');
    const reconciler = createPublicationReconciler({
      publications: publications(),
      queue,
      executors: new Map(),
      intervalMs: 10_000,
      batchSize: 1,
      leaseDurationMs: 5_000,
    });
    expect(await reconciler.reconcileOnce()).toEqual({ queued: 0, recovered: 0 });
    expect(
      await queue.queue.getJob(`publication-${created.id}-r${created.revision}`),
    ).toBeUndefined();
    expect(await publications().listAttemptsForUser(ownerId, created.id)).toHaveLength(0);
    expect((await publications().findById(created.id))[0]?.state).toBe('queued');
  });

  test('reconstructs a deleted Redis job from the same DB revision', async () => {
    const created = await createEligiblePublication('redis-loss');
    const reconciler = createPublicationReconciler({
      publications: publications(),
      queue,
      executors: new Map([['youtube', { executeAfterRequestSent: async () => undefined }]]),
      intervalMs: 10_000,
      batchSize: 1_000,
      leaseDurationMs: 5_000,
    });
    const first = await reconciler.reconcileOnce();
    expect(first.queued).toBeGreaterThan(0);
    const jobId = `publication-${created.id}-r${created.revision}`;
    const job = await queue.queue.getJob(jobId);
    if (!job) throw new Error('Expected Redis job was not created');
    await job.remove();
    await reconciler.reconcileOnce();
    expect(await queue.queue.getJob(jobId)).toBeTruthy();
    expect(await publications().listAttemptsForUser(ownerId, created.id)).toHaveLength(0);
  });

  test('recovers a retained failed job without stranding eligible DB work', async () => {
    const created = await createEligiblePublication('failed-recovery');
    const payload = payloadFor(created.id, created.revision);
    const failingWorker = createPublicationWorker(workerConfiguration(), async () => {
      throw new Error('simulated delivery failure');
    });
    await failingWorker.worker.waitUntilReady();
    const job = await queue.queue.add('process-publication', payload, {
      jobId: `publication-${created.id}-r${created.revision}`,
    });
    await waitForState(queue, job.id!, 'failed');
    await failingWorker.close(true);
    const reconciler = createPublicationReconciler({
      publications: publications(),
      queue,
      executors: new Map([['youtube', { executeAfterRequestSent: async () => undefined }]]),
      intervalMs: 10_000,
      batchSize: 1_000,
      leaseDurationMs: 5_000,
    });
    expect((await reconciler.reconcileOnce()).queued).toBeGreaterThan(0);
    expect((await publications().findById(created.id))[0]?.state).toBe('queued');
  });

  test('reconstructs a retained completed job while DB revision remains eligible', async () => {
    const created = await createEligiblePublication('completed-recovery');
    const payload = payloadFor(created.id, created.revision);
    const completingWorker = createPublicationWorker(workerConfiguration(), async () => undefined);
    await completingWorker.worker.waitUntilReady();
    const job = await queue.queue.add('process-publication', payload, {
      jobId: `publication-${created.id}-r${created.revision}`,
    });
    await waitForState(queue, job.id!, 'completed');
    await completingWorker.close();
    const reconciler = createPublicationReconciler({
      publications: publications(),
      queue,
      executors: new Map([['youtube', { executeAfterRequestSent: async () => undefined }]]),
      intervalMs: 10_000,
      batchSize: 1_000,
      leaseDurationMs: 5_000,
    });
    expect((await reconciler.reconcileOnce()).queued).toBeGreaterThan(0);
    expect((await publications().findById(created.id))[0]?.state).toBe('queued');
  });

  test('allows only one concurrent DB claim and one attempt', async () => {
    const created = await createEligiblePublication('concurrent-claim');
    let executorCalls = 0;
    const executor = {
      executeAfterRequestSent: async () => {
        executorCalls += 1;
      },
    };
    const processorA = createPublicationJobProcessor({
      publications: publications(),
      executors: new Map([['youtube', executor]]),
      legacyCredentialOwnership: (publication) => ({
        accountId: publication.publishingAccountId,
        userId: publication.userId,
        platform: publication.platform as 'youtube' | 'vk',
        credentialRevision: 0,
      }),
      leaseDurationMs: 5_000,
      leaseHeartbeatMs: 1_000,
    });
    const processorB = createPublicationJobProcessor({
      publications: publications(),
      executors: new Map([['youtube', executor]]),
      legacyCredentialOwnership: (publication) => ({
        accountId: publication.publishingAccountId,
        userId: publication.userId,
        platform: publication.platform as 'youtube' | 'vk',
        credentialRevision: 0,
      }),
      leaseDurationMs: 5_000,
      leaseHeartbeatMs: 1_000,
    });
    const results = await Promise.allSettled([
      processorA({
        id: `a-${created.id}`,
        data: payloadFor(created.id, created.revision),
      } as never),
      processorB({
        id: `b-${created.id}`,
        data: payloadFor(created.id, created.revision),
      } as never),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(executorCalls).toBe(1);
    expect(await publications().listAttemptsForUser(ownerId, created.id)).toHaveLength(1);
  });

  test('recovers an expired started attempt as retryable without creating another attempt', async () => {
    const created = await createEligiblePublication('expired-started');
    const repo = publications();
    const claimed = await repo.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    await database.db
      .update(publication)
      .set({ leaseExpiresAt: new Date(Date.now() - 1), updatedAt: new Date() })
      .where(eq(publication.id, created.id));
    const recovered = await repo.recoverExpiredPublicationLease({
      publicationId: created.id,
      expectedPublicationRevision: claimed.publication.revision,
      expectedLeaseToken: claimed.publication.leaseToken!,
      expectedAttemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      expectedAttemptState: 'started',
      retryAt: new Date(),
    });
    expect(recovered.outcome).toBe('retry_wait');
    expect((await repo.findById(created.id))[0]).toMatchObject({
      state: 'retry_wait',
      leaseToken: null,
      leaseExpiresAt: null,
      revision: claimed.publication.revision + 1,
    });
    expect((await repo.listAttemptsForUser(ownerId, created.id))[0]?.state).toBe(
      'definitely_failed',
    );
    expect(await repo.listAttemptsForUser(ownerId, created.id)).toHaveLength(1);
  });

  test('recovers an expired request_sent attempt only to reconciliation', async () => {
    const created = await createEligiblePublication('expired-request-sent');
    const repo = publications();
    const claimed = await repo.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const [sent] = await repo.markAttemptRequestSent(
      ownerId,
      claimed.attempt.id,
      claimed.attempt.revision,
      {
        publicationId: claimed.publication.id,
        expectedPublicationRevision: claimed.publication.revision,
        expectedLeaseToken: claimed.publication.leaseToken!,
        credential: {
          accountId: claimed.publication.publishingAccountId,
          userId: claimed.publication.userId,
          platform: claimed.publication.platform as 'youtube' | 'vk',
          credentialRevision: 0,
        },
      },
    );
    if (!sent) throw new Error('Request intent was not recorded');
    await database.db
      .update(publication)
      .set({ leaseExpiresAt: new Date(Date.now() - 1), updatedAt: new Date() })
      .where(eq(publication.id, created.id));
    const recovered = await repo.recoverExpiredPublicationLease({
      publicationId: created.id,
      expectedPublicationRevision: claimed.publication.revision,
      expectedLeaseToken: claimed.publication.leaseToken!,
      expectedAttemptId: claimed.attempt.id,
      expectedAttemptRevision: sent.revision,
      expectedAttemptState: 'request_sent',
      retryAt: new Date(),
    });
    expect(recovered.outcome).toBe('reconciling');
    expect((await repo.findById(created.id))[0]).toMatchObject({
      state: 'reconciling',
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect((await repo.listAttemptsForUser(ownerId, created.id))[0]?.state).toBe('ambiguous');
  });

  test('rejects stale lease recovery without touching newer ownership', async () => {
    const created = await createEligiblePublication('stale-lease');
    const repo = publications();
    const claimed = await repo.claimPublication(
      ownerId,
      created.id,
      'queued',
      created.revision,
      5_000,
    );
    const newerToken = randomUUID();
    await database.db
      .update(publication)
      .set({
        revision: claimed.publication.revision + 1,
        leaseToken: newerToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      })
      .where(eq(publication.id, created.id));
    const result = await repo.recoverExpiredPublicationLease({
      publicationId: created.id,
      expectedPublicationRevision: claimed.publication.revision,
      expectedLeaseToken: claimed.publication.leaseToken!,
      expectedAttemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      expectedAttemptState: 'started',
      retryAt: new Date(),
    });
    expect(result.outcome).toBe('stale');
    expect((await repo.findById(created.id))[0]).toMatchObject({
      revision: claimed.publication.revision + 1,
      leaseToken: newerToken,
    });
  });

  test('runs a real queued publication through the processor after request_sent', async () => {
    await queue.queue.obliterate({ force: true });
    await database.db.delete(publication);
    const created = await createEligiblePublication('real-round-trip');
    const repo = publications();
    let executorEntryState: string | undefined;
    let executorObservedDbState: string | undefined;
    let executorCalled!: () => void;
    const executorCalledPromise = new Promise<void>((resolve) => {
      executorCalled = resolve;
    });
    const worker = createPublicationWorker(
      workerConfiguration(),
      createPublicationJobProcessor({
        publications: repo,
        executors: new Map([
          [
            'youtube',
            {
              executeAfterRequestSent: async (context) => {
                executorEntryState = context.attempt.state;
                executorObservedDbState = (
                  await repo.findLatestAttemptForUser(ownerId, created.id)
                )[0]?.state;
                executorCalled();
              },
            },
          ],
        ]),
        legacyCredentialOwnership: (publication) => ({
          accountId: publication.publishingAccountId,
          userId: publication.userId,
          platform: publication.platform as 'youtube' | 'vk',
          credentialRevision: 0,
        }),
        leaseDurationMs: 5_000,
        leaseHeartbeatMs: 1_000,
      }),
    );
    const reconciler = createPublicationReconciler({
      publications: repo,
      queue,
      executors: new Map([['youtube', { executeAfterRequestSent: async () => undefined }]]),
      intervalMs: 10_000,
      batchSize: 1_000,
      leaseDurationMs: 5_000,
    });
    await worker.worker.waitUntilReady();
    expect((await reconciler.reconcileOnce()).queued).toBeGreaterThan(0);
    await executorCalledPromise;
    await worker.close();
    expect(executorEntryState).toBe('request_sent');
    expect(executorObservedDbState).toBe('request_sent');
    expect(await repo.listAttemptsForUser(ownerId, created.id)).toHaveLength(1);
  });
});
