import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import Fastify from '../../apps/api/node_modules/fastify/fastify.js';
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createDatabase,
  createMultipartUploadRepository,
  createVideoRepository,
  applyMigrations,
} from '../../packages/db/src/index.js';
import {
  createS3Client,
  createS3MultipartStorage,
  type MultipartStorage,
} from '../../packages/infra/src/index.js';
import { registerApp } from '../../apps/api/src/app.js';
import { createAuth } from '../../apps/api/src/auth/options.js';
import { createMultipartUploadService } from '../../apps/api/src/services/multipart-upload-service.js';
import { parseStorageConfiguration } from '../../apps/api/src/storage-config.js';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
if (!adminUrl)
  throw new Error('TEST_DATABASE_ADMIN_URL is required for multipart API integration tests');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `sovara_upload_test_${suffix}`;
const migrationRole = `sovara_upload_migration_${suffix}`;
const runtimeRole = `sovara_upload_runtime_${suffix}`;
const migrationPassword = randomUUID();
const runtimePassword = randomUUID();
const appOrigin = 'http://localhost:5173';
const storageConfiguration = parseStorageConfiguration({
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:19000',
  S3_PRESIGN_ENDPOINT: process.env.S3_PRESIGN_ENDPOINT ?? 'http://localhost:19000',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_BUCKET: process.env.S3_BUCKET ?? 'sovara-uploads',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PRESIGNED_PART_TTL_SECONDS: '900',
  S3_MULTIPART_UPLOAD_TTL_SECONDS: '86400',
  UPLOAD_MAX_SIZE_BYTES: String(100 * 1024 ** 2),
  UPLOAD_MIN_PART_SIZE_BYTES: String(5 * 1024 ** 2),
  UPLOAD_PREFERRED_PART_SIZE_BYTES: String(5 * 1024 ** 2),
  UPLOAD_TARGET_MAX_PARTS: '1000',
  UPLOAD_SIGN_BATCH_MAX: '4',
  UPLOAD_MAX_CONCURRENCY: '2',
  UPLOAD_SIGN_RATE_LIMIT_PER_MINUTE: '20',
});
let databaseUrl: string;
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<typeof Fastify>;
let storageClient: ReturnType<typeof createS3Client>;
let presignClient: ReturnType<typeof createS3Client>;
let ownerEmail: string;
let ownerPassword: string;
let otherEmail: string;
let otherPassword: string;
let ownerId: string;
let apiRequestCount = 0;

describe('TASK-005 multipart upload API', () => {
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
    await applyMigrations(migrationDatabase);
    await migrationDatabase.pool.end();

    const owner = new Client({ connectionString: baseUrl.toString() });
    await owner.connect();
    try {
      await owner.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${runtimeRole}`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user", account, session, verification, video, multipart_upload, upload_part TO ${runtimeRole}`,
      );
    } finally {
      await owner.end();
    }

    const runtimeUrl = new URL(baseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    databaseUrl = runtimeUrl.toString();
    database = createDatabase(databaseUrl);
    const auth = createAuth(database, {
      secret: 'multipart-api-test-secret-that-is-at-least-32-bytes',
      appOrigin,
    });
    const provisioningAuth = createAuth(database, {
      secret: 'multipart-api-test-secret-that-is-at-least-32-bytes',
      appOrigin,
      provisioning: true,
    });
    ownerEmail = `upload-owner-${suffix}@example.com`;
    ownerPassword = `upload-${randomUUID()}-password`;
    otherEmail = `upload-other-${suffix}@example.com`;
    otherPassword = `upload-${randomUUID()}-password`;
    const provisioned = await provisioningAuth.api.signUpEmail({
      body: {
        email: ownerEmail,
        name: 'Upload Owner',
        password: ownerPassword,
      },
    });
    if (!provisioned.user) throw new Error('Upload integration user was not created');
    ownerId = provisioned.user.id;
    const otherProvisioned = await provisioningAuth.api.signUpEmail({
      body: {
        email: otherEmail,
        name: 'Other Upload Owner',
        password: otherPassword,
      },
    });
    if (!otherProvisioned.user) throw new Error('Other upload integration user was not created');

    storageClient = createS3Client({ ...storageConfiguration.s3, maxAttempts: 1 });
    presignClient = createS3Client({
      ...storageConfiguration.s3,
      endpoint: storageConfiguration.s3.presignEndpoint,
      maxAttempts: 1,
    });
    const uploadService = createMultipartUploadService({
      videos: createVideoRepository(database.db),
      uploads: createMultipartUploadRepository(database.db),
      storage: createS3MultipartStorage(
        storageClient,
        { bucket: storageConfiguration.s3.bucket },
        presignClient,
      ),
      configuration: storageConfiguration,
    });
    server = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    server.addHook('onRequest', async () => {
      apiRequestCount += 1;
    });
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
      uploadService,
    });
    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    storageClient?.destroy();
    presignClient?.destroy();
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

  test('creates, signs, directly uploads, records, and resumes a private multipart upload', async () => {
    const login = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: {
        email: ownerEmail,
        password: ownerPassword,
      },
    });
    expect(login.statusCode).toBe(200);
    const cookies = login.headers['set-cookie'];
    if (!cookies) throw new Error('Authentication cookie was not returned');
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const otherLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: otherEmail, password: otherPassword },
    });
    expect(otherLogin.statusCode).toBe(200);
    const otherCookies = otherLogin.headers['set-cookie'];
    if (!otherCookies) throw new Error('Second authentication cookie was not returned');
    const otherCookie = (Array.isArray(otherCookies) ? otherCookies : [otherCookies])
      .map((value) => value.split(';', 1)[0])
      .join('; ');

    const created = await server.inject({
      method: 'POST',
      url: '/api/videos',
      headers: { cookie, origin: appOrigin },
      payload: {
        originalFilename: 'browser-selected-name.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 6 * 1024 * 1024,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as {
      videoId: string;
      upload: {
        uploadId: string;
        partSizeBytes: number;
        expectedPartCount: number;
        revision: number;
      };
    };
    expect(createdBody.upload.expectedPartCount).toBe(2);
    expect(JSON.stringify(createdBody)).not.toContain('sovara-uploads');

    const otherInspect = await server.inject({
      method: 'GET',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}`,
      headers: { cookie: otherCookie },
    });
    expect(otherInspect.statusCode).toBe(404);
    const otherSign = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/part-urls`,
      headers: { cookie: otherCookie, origin: appOrigin },
      payload: { partNumbers: [1] },
    });
    expect(otherSign.statusCode).toBe(404);
    const otherRecord = await server.inject({
      method: 'PUT',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/parts/1`,
      headers: { cookie: otherCookie, origin: appOrigin },
      payload: { etag: '"other-user"', reportedSizeBytes: 5 * 1024 * 1024 },
    });
    expect(otherRecord.statusCode).toBe(404);
    const otherAbort = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/abort`,
      headers: { cookie: otherCookie, origin: appOrigin },
      payload: { revision: createdBody.upload.revision },
    });
    expect(otherAbort.statusCode).toBe(404);

    const duplicateSign = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/part-urls`,
      headers: { cookie, origin: appOrigin },
      payload: { partNumbers: [1, 1] },
    });
    expect(duplicateSign.statusCode).toBe(400);
    const outOfRangeSign = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/part-urls`,
      headers: { cookie, origin: appOrigin },
      payload: { partNumbers: [3] },
    });
    expect(outOfRangeSign.statusCode).toBe(400);

    const signed = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/part-urls`,
      headers: { cookie, origin: appOrigin },
      payload: { partNumbers: [1] },
    });
    expect(signed.statusCode).toBe(200);
    const partRowsBeforeRecord = await database.pool.query(
      'SELECT count(*)::int AS count FROM upload_part WHERE multipart_upload_id = $1',
      [createdBody.upload.uploadId],
    );
    expect(partRowsBeforeRecord.rows[0]?.count).toBe(0);
    const signedBody = signed.json() as { parts: Array<{ partNumber: number; url: string }> };
    const partUrl = signedBody.parts[0]?.url;
    if (!partUrl) throw new Error('Presigned part URL was not returned');
    expect(new URL(partUrl).port).toBe('19000');
    const requestsBeforeDirectPut = apiRequestCount;

    const preflight = await fetch(partUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: appOrigin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(appOrigin);
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/PUT/);

    const directPut = await fetch(partUrl, {
      method: 'PUT',
      headers: { Origin: appOrigin, 'Content-Type': 'video/mp4' },
      body: Buffer.alloc(createdBody.upload.partSizeBytes, 7),
    });
    expect(directPut.ok).toBe(true);
    expect(apiRequestCount).toBe(requestsBeforeDirectPut);
    const etag = directPut.headers.get('etag');
    if (!etag) throw new Error('MinIO did not return an ETag');
    expect(directPut.headers.get('access-control-expose-headers')).toMatch(/etag/i);

    const recorded = await server.inject({
      method: 'PUT',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/parts/1`,
      headers: { cookie, origin: appOrigin },
      payload: {
        etag: '"opaque-not-md5"',
        reportedSizeBytes: createdBody.upload.partSizeBytes,
      },
    });
    expect(recorded.statusCode).toBe(200);

    const replacement = await server.inject({
      method: 'PUT',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/parts/1`,
      headers: { cookie, origin: appOrigin },
      payload: {
        etag: '"opaque-replacement"',
        reportedSizeBytes: createdBody.upload.partSizeBytes,
      },
    });
    expect(replacement.statusCode).toBe(200);

    const status = await server.inject({
      method: 'GET',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}`,
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as {
      parts: Array<{ partNumber: number; etag: string }>;
      state: string;
      providerUploadId?: string;
      objectKey?: string;
      storageBucket?: string;
    };
    expect(statusBody.state).toBe('active');
    expect(statusBody.parts).toEqual([
      {
        partNumber: 1,
        etag: '"opaque-replacement"',
        reportedSizeBytes: createdBody.upload.partSizeBytes,
        providerChecksumAlgorithm: null,
        providerChecksumValue: null,
        revision: 1,
      },
    ]);
    expect(statusBody.providerUploadId).toBeUndefined();
    expect(statusBody.objectKey).toBeUndefined();
    expect(statusBody.storageBucket).toBeUndefined();

    await database.pool.query(
      "UPDATE multipart_upload SET state = 'completing', completion_requested_at = NOW(), revision = revision + 1 WHERE id = $1",
      [createdBody.upload.uploadId],
    );
    const completing = await database.pool.query(
      'SELECT revision FROM multipart_upload WHERE id = $1',
      [createdBody.upload.uploadId],
    );
    const postCompletingRecord = await server.inject({
      method: 'PUT',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/parts/1`,
      headers: { cookie, origin: appOrigin },
      payload: { etag: '"post-completing"', reportedSizeBytes: 5 * 1024 * 1024 },
    });
    expect(postCompletingRecord.statusCode).toBe(409);

    const providerIdentity = await database.pool.query(
      'SELECT object_key, provider_upload_id FROM video JOIN multipart_upload ON multipart_upload.video_id = video.id WHERE video.id = $1',
      [createdBody.videoId],
    );
    const objectKey = providerIdentity.rows[0]?.object_key as string;
    const providerUploadId = providerIdentity.rows[0]?.provider_upload_id as string;
    const beforeAbort = await storageClient.send(
      new ListMultipartUploadsCommand({
        Bucket: storageConfiguration.s3.bucket,
        Prefix: objectKey,
      }),
    );
    expect(beforeAbort.Uploads?.some((item) => item.UploadId === providerUploadId)).toBe(true);

    const aborted = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/abort`,
      headers: { cookie, origin: appOrigin },
      payload: { revision: completing.rows[0]?.revision },
    });
    expect(aborted.statusCode).toBe(200);
    const afterAbort = await storageClient.send(
      new ListMultipartUploadsCommand({
        Bucket: storageConfiguration.s3.bucket,
        Prefix: objectKey,
      }),
    );
    expect(afterAbort.Uploads?.some((item) => item.UploadId === providerUploadId) ?? false).toBe(
      false,
    );

    const postAbortSign = await server.inject({
      method: 'POST',
      url: `/api/videos/${createdBody.videoId}/uploads/${createdBody.upload.uploadId}/part-urls`,
      headers: { cookie, origin: appOrigin },
      payload: { partNumbers: [1] },
    });
    expect(postAbortSign.statusCode).toBe(409);

    const [replacementVideo] = await createVideoRepository(database.db).createOwnedVideo(ownerId, {
      originalFilename: 'blocked-replacement.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 5 * 1024 * 1024,
      storageBackend: 's3-compatible',
      storageBucket: storageConfiguration.s3.bucket,
      objectKey: 'sources/replacement-blocked',
    });
    const [pendingUpload] = await createMultipartUploadRepository(database.db).createOwnedUpload(
      ownerId,
      {
        videoId: replacementVideo!.id,
        providerUploadId: 'pending-provider-upload',
        partSizeBytes: 5 * 1024 * 1024,
        expectedPartCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      },
    );
    const [claimedPending] = await createMultipartUploadRepository(database.db).requestAbort(
      ownerId,
      pendingUpload!.id,
      'active',
      pendingUpload!.revision,
    );
    expect(claimedPending?.state).toBe('abort_pending');
    await expect(
      createMultipartUploadRepository(database.db).createOwnedUpload(ownerId, {
        videoId: replacementVideo!.id,
        providerUploadId: 'replacement-provider-upload',
        partSizeBytes: 5 * 1024 * 1024,
        expectedPartCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow();
  });

  test('serializes initiation association and reconciliation with a durable CAS claim', async () => {
    const videos = createVideoRepository(database.db);
    const uploads = createMultipartUploadRepository(database.db);
    const createInitiatingUpload = async (filename: string) => {
      const [createdVideo] = await videos.createOwnedVideo(ownerId, {
        originalFilename: filename,
        contentType: 'video/mp4',
        expectedSizeBytes: 5 * 1024 * 1024,
        storageBackend: 's3-compatible',
        storageBucket: storageConfiguration.s3.bucket,
        objectKey: `sources/race-${randomUUID()}`,
      });
      if (!createdVideo) throw new Error('Race test video was not created');
      const [createdUpload] = await uploads.createOwnedUpload(ownerId, {
        videoId: createdVideo.id,
        providerUploadId: null,
        state: 'initiating',
        partSizeBytes: 5 * 1024 * 1024,
        expectedPartCount: 1,
        expiresAt: new Date(Date.now() + 60_000),
      });
      if (!createdUpload) throw new Error('Race test upload was not created');
      return { video: createdVideo, upload: createdUpload };
    };
    const storageFor = (
      reconcileUntrackedExactKey: MultipartStorage['reconcileUntrackedExactKey'],
      abortMultipartUpload: MultipartStorage['abortMultipartUpload'],
      createMultipartUpload: MultipartStorage['createMultipartUpload'] = async () => {
        throw new Error('Unexpected provider initiation');
      },
    ): MultipartStorage => ({
      createMultipartUpload,
      presignUploadPart: async () => 'https://unused.example/part',
      abortMultipartUpload,
      inspectMultipartUpload: async () => ({ parts: [] }),
      completeMultipartUpload: async () => ({
        etag: null,
        versionId: null,
        checksumAlgorithm: null,
        checksumValue: null,
      }),
      headObject: async () => 'absent',
      reconcileUntrackedExactKey,
    });

    const associationWinner = await createInitiatingUpload('association-winner.mp4');
    let claimEntered!: () => void;
    const claimEnteredPromise = new Promise<void>((resolve) => {
      claimEntered = resolve;
    });
    let releaseClaim!: () => void;
    const claimReleasePromise = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const realUploads = createMultipartUploadRepository(database.db);
    const gatedUploads = {
      ...realUploads,
      claimInitiationReconciliation: async (
        ...args: Parameters<typeof realUploads.claimInitiationReconciliation>
      ) => {
        claimEntered();
        await claimReleasePromise;
        return realUploads.claimInitiationReconciliation(...args);
      },
    };
    let associationWinnerReconcileCalls = 0;
    const associationWinnerService = createMultipartUploadService({
      videos,
      uploads: gatedUploads,
      storage: storageFor(
        async () => {
          associationWinnerReconcileCalls += 1;
          return 'cleaned';
        },
        async () => {
          throw new Error('Associated provider upload must not be aborted');
        },
      ),
      configuration: storageConfiguration,
    });
    const associationRecovery = associationWinnerService.recoverInitiation(
      ownerId,
      associationWinner.video.id,
      associationWinner.upload.id,
    );
    await claimEnteredPromise;
    const associated = await realUploads.associateProviderUpload(
      ownerId,
      associationWinner.upload.id,
      associationWinner.upload.revision,
      'provider-association-winner',
    );
    expect(associated[0]?.state).toBe('active');
    expect(associated[0]?.revision).toBe(associationWinner.upload.revision + 1);
    releaseClaim();
    const associationRecoveryResult = await associationRecovery;
    expect(associationRecoveryResult.state).toBe('active');
    expect(associationRecoveryResult.uploadId).toBe(associationWinner.upload.id);
    expect(associationWinnerReconcileCalls).toBe(0);
    const associationWinnerRow = await realUploads.findByIdForUser(
      ownerId,
      associationWinner.upload.id,
    );
    expect(associationWinnerRow[0]?.providerUploadId).toBe('provider-association-winner');
    expect(associationWinnerRow[0]?.state).toBe('active');

    let providerCreateRelease!: () => void;
    const providerCreateReleasePromise = new Promise<void>((resolve) => {
      providerCreateRelease = resolve;
    });
    let providerCreateStarted!: () => void;
    const providerCreateStartedPromise = new Promise<void>((resolve) => {
      providerCreateStarted = resolve;
    });
    let providerReconcileStarted!: () => void;
    const providerReconcileStartedPromise = new Promise<void>((resolve) => {
      providerReconcileStarted = resolve;
    });
    let providerReconcileRelease!: () => void;
    const providerReconcileReleasePromise = new Promise<void>((resolve) => {
      providerReconcileRelease = resolve;
    });
    const lateProviderUploadId = 'provider-late-result';
    const abortedProviderUploadIds: string[] = [];
    let reconcileCalls = 0;
    const reconciliationWinnerStorage = storageFor(
      async () => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          providerReconcileStarted();
          await providerReconcileReleasePromise;
          return 'pending';
        }
        return 'pending';
      },
      async ({ providerUploadId }) => {
        abortedProviderUploadIds.push(providerUploadId);
        return 'aborted';
      },
      async () => {
        providerCreateStarted();
        await providerCreateReleasePromise;
        return { providerUploadId: lateProviderUploadId };
      },
    );
    const reconciliationWinnerService = createMultipartUploadService({
      videos,
      uploads: realUploads,
      storage: reconciliationWinnerStorage,
      configuration: storageConfiguration,
    });
    const createWithLateProviderResult = reconciliationWinnerService.create(ownerId, {
      originalFilename: 'reconciliation-winner.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 5 * 1024 * 1024,
    });
    await providerCreateStartedPromise;
    const pendingRow = await database.pool.query(
      "SELECT id, video_id, revision FROM multipart_upload WHERE user_id = $1 AND state = 'initiating' ORDER BY created_at DESC LIMIT 1",
      [ownerId],
    );
    const pendingUploadId = pendingRow.rows[0]?.id as string;
    const pendingVideoId = pendingRow.rows[0]?.video_id as string;
    const pendingInitiatingRevision = pendingRow.rows[0]?.revision as number;
    expect(pendingUploadId).toBeTruthy();
    const recoveryWhileProviderInFlight = reconciliationWinnerService.recoverInitiation(
      ownerId,
      pendingVideoId,
      pendingUploadId,
    );
    await providerReconcileStartedPromise;
    const lateAssociation = await realUploads.associateProviderUpload(
      ownerId,
      pendingUploadId,
      pendingInitiatingRevision,
      lateProviderUploadId,
    );
    expect(lateAssociation).toHaveLength(0);
    providerReconcileRelease();
    await expect(recoveryWhileProviderInFlight).resolves.toMatchObject({
      state: 'initiation_reconciling',
    });
    providerCreateRelease();
    await expect(createWithLateProviderResult).rejects.toMatchObject({
      code: 'PROVIDER_CLEANUP_REQUIRED',
    });
    expect(abortedProviderUploadIds).toEqual([lateProviderUploadId]);
    const reconciledRow = await realUploads.findByIdForUser(ownerId, pendingUploadId);
    expect(reconciledRow[0]?.state).toBe('aborted');
    expect(reconciledRow[0]?.providerUploadId).toBeNull();
    expect(reconciledRow[0]?.revision).toBeGreaterThan(1);

    const staleCas = await createInitiatingUpload('stale-cas.mp4');
    const staleRevision = staleCas.upload.revision + 1;
    const staleAssociation = await realUploads.associateProviderUpload(
      ownerId,
      staleCas.upload.id,
      staleRevision,
      'provider-stale-revision',
    );
    expect(staleAssociation).toHaveLength(0);
    let staleCasRow = await realUploads.findByIdForUser(ownerId, staleCas.upload.id);
    expect(staleCasRow[0]?.state).toBe('initiating');
    expect(staleCasRow[0]?.providerUploadId).toBeNull();
    expect(staleCasRow[0]?.revision).toBe(staleCas.upload.revision);

    const staleClaim = await realUploads.claimInitiationReconciliation(
      ownerId,
      staleCas.upload.id,
      staleRevision,
    );
    expect(staleClaim).toHaveLength(0);
    staleCasRow = await realUploads.findByIdForUser(ownerId, staleCas.upload.id);
    expect(staleCasRow[0]?.state).toBe('initiating');
    expect(staleCasRow[0]?.providerUploadId).toBeNull();
    expect(staleCasRow[0]?.revision).toBe(staleCas.upload.revision);

    const currentAssociation = await realUploads.associateProviderUpload(
      ownerId,
      staleCas.upload.id,
      staleCas.upload.revision,
      'provider-current-revision',
    );
    expect(currentAssociation[0]?.state).toBe('active');
    expect(currentAssociation[0]?.providerUploadId).toBe('provider-current-revision');
    expect(currentAssociation[0]?.revision).toBe(staleCas.upload.revision + 1);
  });

  test('CAS-settles provider-proven abort_pending completion exactly once', async () => {
    const videos = createVideoRepository(database.db);
    const uploads = createMultipartUploadRepository(database.db);
    const expectedSizeBytes = 5 * 1024 * 1024;
    const [createdVideo] = await videos.createOwnedVideo(ownerId, {
      originalFilename: 'abort-race-cas.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes,
      storageBackend: 's3-compatible',
      storageBucket: storageConfiguration.s3.bucket,
      objectKey: `sources/abort-race-${randomUUID()}`,
    });
    if (!createdVideo) throw new Error('Abort race video was not created');
    const [activeUpload] = await uploads.createOwnedUpload(ownerId, {
      videoId: createdVideo.id,
      providerUploadId: `provider-abort-race-${randomUUID()}`,
      partSizeBytes: expectedSizeBytes,
      expectedPartCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (!activeUpload) throw new Error('Abort race upload was not created');
    await uploads.recordOrReplacePart(ownerId, activeUpload.id, {
      partNumber: 1,
      etag: 'opaque-abort-race-etag',
      reportedSizeBytes: expectedSizeBytes,
    });
    const claimed = await uploads.claimCompletion(ownerId, activeUpload.id, activeUpload.revision, [
      { partNumber: 1, etag: 'opaque-abort-race-etag' },
    ]);
    const [abortPending] = await uploads.requestAbort(
      ownerId,
      activeUpload.id,
      'completing',
      claimed.upload.revision,
    );
    if (!abortPending) throw new Error('Abort race ownership was not acquired');

    await expect(
      uploads.settleAbortPendingCompletion(
        ownerId,
        activeUpload.id,
        claimed.upload.revision,
        claimed.video.revision,
        { objectEtag: 'opaque-final-etag' },
      ),
    ).rejects.toThrow(/stale/i);

    const settlements = await Promise.allSettled([
      uploads.settleAbortPendingCompletion(
        ownerId,
        activeUpload.id,
        abortPending.revision,
        claimed.video.revision,
        { objectEtag: 'opaque-final-etag' },
      ),
      uploads.settleAbortPendingCompletion(
        ownerId,
        activeUpload.id,
        abortPending.revision,
        claimed.video.revision,
        { objectEtag: 'opaque-final-etag' },
      ),
    ]);
    expect(settlements.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settlements.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await uploads.findByIdForUser(ownerId, activeUpload.id))[0]?.state).toBe('completed');
    expect((await videos.findByIdForUser(ownerId, createdVideo.id))[0]).toMatchObject({
      state: 'uploaded',
      objectEtag: 'opaque-final-etag',
    });
  });
});
