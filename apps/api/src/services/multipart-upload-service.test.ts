import { describe, expect, test, vi } from 'vitest';
import type { createMultipartUploadRepository, createVideoRepository } from '@sovara-studio/db';
import { S3StorageError, type MultipartStorage } from '@sovara-studio/infra';
import { calculateMultipartPlan, parseStorageConfiguration } from '../storage-config.js';
import { createMultipartUploadService } from './multipart-upload-service.js';

const configuration = parseStorageConfiguration({
  S3_ENDPOINT: 'http://localhost:19000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'minioadmin',
  S3_SECRET_ACCESS_KEY: 'minioadmin',
  S3_BUCKET: 'sovara-uploads',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PRESIGNED_PART_TTL_SECONDS: '900',
  S3_MULTIPART_UPLOAD_TTL_SECONDS: '86400',
  UPLOAD_MAX_SIZE_BYTES: String(100 * 1024 ** 3),
  UPLOAD_MIN_PART_SIZE_BYTES: String(5 * 1024 ** 2),
  UPLOAD_PREFERRED_PART_SIZE_BYTES: String(64 * 1024 ** 2),
  UPLOAD_TARGET_MAX_PARTS: '1000',
  UPLOAD_SIGN_BATCH_MAX: '2',
  UPLOAD_MAX_CONCURRENCY: '6',
  UPLOAD_SIGN_RATE_LIMIT_PER_MINUTE: '2',
});

const videoRow = {
  id: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  userId: 'owner-id',
  originalFilename: 'source.mp4',
  contentType: 'video/mp4',
  expectedSizeBytes: 50 * 1024 * 1024,
  storageBackend: 's3-compatible',
  storageBucket: 'sovara-uploads',
  objectKey: 'sources/4c/4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  state: 'awaiting_upload',
  revision: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
} as unknown as Awaited<
  ReturnType<ReturnType<typeof createVideoRepository>['createOwnedVideo']>
>[number];

const uploadRow = {
  id: '6fb4dc69-1981-47ef-9d4b-f0f7dd8b2f3a',
  userId: 'owner-id',
  videoId: videoRow.id,
  providerUploadId: 'provider-upload-id',
  state: 'active',
  partSizeBytes: 64 * 1024 * 1024,
  expectedPartCount: 1,
  expiresAt: new Date('2027-01-02T00:00:00Z'),
  revision: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  completionRequestedAt: null,
} as unknown as Awaited<
  ReturnType<ReturnType<typeof createMultipartUploadRepository>['createOwnedUpload']>
>[number];

function makeStorage(overrides: Partial<MultipartStorage> = {}): MultipartStorage {
  return {
    createMultipartUpload: vi
      .fn()
      .mockResolvedValue({ providerUploadId: uploadRow.providerUploadId }),
    presignUploadPart: vi.fn().mockResolvedValue('https://minio.example/signed-part'),
    abortMultipartUpload: vi.fn().mockResolvedValue('aborted'),
    inspectMultipartUpload: vi.fn().mockResolvedValue({ parts: [] }),
    completeMultipartUpload: vi.fn(),
    headObject: vi.fn(),
    reconcileUntrackedExactKey: vi.fn().mockResolvedValue('pending'),
    ...overrides,
  };
}

function makeRepositories() {
  const videos = {
    createOwnedVideo: vi.fn().mockResolvedValue([videoRow]),
    findByIdForUser: vi.fn().mockResolvedValue([videoRow]),
    beginVerification: vi.fn(),
    recordVerified: vi.fn(),
    recordInvalid: vi.fn(),
    markFailed: vi
      .fn()
      .mockResolvedValue([{ ...videoRow, state: 'failed', failureCode: 'failed' }]),
  } as unknown as ReturnType<typeof createVideoRepository>;
  const uploads = {
    createOwnedUpload: vi
      .fn()
      .mockImplementation(async (_userId, input) => [{ ...uploadRow, ...input }]),
    associateProviderUpload: vi.fn().mockResolvedValue([uploadRow]),
    findByIdForUser: vi.fn().mockResolvedValue([uploadRow]),
    findUnresolvedForVideoForUser: vi.fn().mockResolvedValue([]),
    listPartsForUser: vi.fn().mockResolvedValue([]),
    listInitiationReconciliationRequired: vi.fn().mockResolvedValue([]),
    claimInitiationReconciliation: vi
      .fn()
      .mockResolvedValue([
        { ...uploadRow, state: 'initiation_reconciling', providerUploadId: null, revision: 1 },
      ]),
    claimCompletion: vi.fn(),
    settleCompletion: vi.fn(),
    settleAbortPendingCompletion: vi.fn(),
    markCompletionPending: vi.fn().mockResolvedValue([]),
    failCompletion: vi.fn().mockResolvedValue([]),
    recordOrReplacePart: vi.fn().mockResolvedValue([
      {
        partNumber: 1,
        etag: 'opaque-etag',
        reportedSizeBytes: videoRow.expectedSizeBytes,
        providerChecksumAlgorithm: null,
        providerChecksumValue: null,
        revision: 0,
      },
    ]),
    requestAbort: vi
      .fn()
      .mockResolvedValue([{ ...uploadRow, state: 'abort_pending', revision: 1 }]),
    settleAbort: vi.fn().mockResolvedValue([{ ...uploadRow, state: 'aborted', revision: 2 }]),
    settleInitiationFailure: vi
      .fn()
      .mockResolvedValue([{ ...uploadRow, state: 'aborted', revision: 1 }]),
    settleInitiationReconciliation: vi
      .fn()
      .mockResolvedValue([{ ...uploadRow, state: 'aborted', revision: 2 }]),
  } as unknown as ReturnType<typeof createMultipartUploadRepository>;
  return { videos, uploads };
}

describe('multipart upload service', () => {
  test('creates a server-keyed upload using the deterministic policy', async () => {
    const repositories = makeRepositories();
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    const response = await service.create('owner-id', {
      originalFilename: 'user-selected-name.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: videoRow.expectedSizeBytes,
    });
    const videoInput = repositories.videos.createOwnedVideo.mock.calls[0]?.[1];
    const uploadInput = repositories.uploads.createOwnedUpload.mock.calls[0]?.[1];
    expect(response.videoId).toBe(videoRow.id);
    expect(videoInput?.objectKey).toMatch(/^sources\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    expect(videoInput?.objectKey).not.toContain('user-selected-name');
    expect(uploadInput?.partSizeBytes).toBe(
      calculateMultipartPlan(videoRow.expectedSizeBytes, configuration).partSizeBytes,
    );
    expect(storage.createMultipartUpload).toHaveBeenCalledWith({
      objectKey: videoInput?.objectKey,
      contentType: 'video/mp4',
    });
    expect(repositories.uploads.associateProviderUpload).toHaveBeenCalledWith(
      'owner-id',
      uploadRow.id,
      uploadRow.revision,
      uploadRow.providerUploadId,
    );
  });

  test('rejects an unapproved filename extension before creating a database intent', async () => {
    const repositories = makeRepositories();
    const service = createMultipartUploadService({
      ...repositories,
      storage: makeStorage(),
      configuration,
    });
    await expect(
      service.create('owner-id', {
        originalFilename: 'source.exe',
        contentType: 'video/mp4',
        expectedSizeBytes: videoRow.expectedSizeBytes,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(repositories.videos.createOwnedVideo).not.toHaveBeenCalled();
  });

  test('reconciles ambiguous initiation by cleaning exact-key orphan uploads', async () => {
    const repositories = makeRepositories();
    const storage = makeStorage({
      createMultipartUpload: vi
        .fn()
        .mockRejectedValue(
          new S3StorageError('provider timeout', { ambiguous: true, retryable: true }),
        ),
    });
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, state: 'initiating', providerUploadId: null },
    ]);
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.create('owner-id', {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: videoRow.expectedSizeBytes,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLEANUP_REQUIRED' });
    expect(storage.reconcileUntrackedExactKey).toHaveBeenCalledTimes(1);
    expect(repositories.uploads.settleInitiationFailure).not.toHaveBeenCalled();
  });

  test('does not abort a provider upload when persistence uncertainty finds its durable row', async () => {
    const repositories = makeRepositories();
    repositories.uploads.associateProviderUpload.mockRejectedValue(
      new Error('connection closed after commit'),
    );
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, state: 'active', providerUploadId: 'provider-upload-id' },
    ]);
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.create('owner-id', {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: videoRow.expectedSizeBytes,
      }),
    ).resolves.toMatchObject({ upload: { uploadId: uploadRow.id } });
    expect(storage.reconcileUntrackedExactKey).not.toHaveBeenCalled();
  });

  test('settles a definite provider initiation failure without cleanup', async () => {
    const repositories = makeRepositories();
    const storage = makeStorage({
      createMultipartUpload: vi
        .fn()
        .mockRejectedValue(
          new S3StorageError('provider rejected', { ambiguous: false, retryable: false }),
        ),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.create('owner-id', {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: videoRow.expectedSizeBytes,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_TEMPORARILY_UNAVAILABLE' });
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(repositories.uploads.settleInitiationFailure).toHaveBeenCalledWith(
      'owner-id',
      uploadRow.id,
      'PROVIDER_INITIATION_FAILED',
    );
  });

  test('signs bounded exact parts without recording part rows', async () => {
    const repositories = makeRepositories();
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    const response = await service.signParts('owner-id', videoRow.id, uploadRow.id, {
      partNumbers: [1],
    });
    expect(response.parts[0]?.url).toBe('https://minio.example/signed-part');
    expect(storage.presignUploadPart).toHaveBeenCalledWith({
      objectKey: videoRow.objectKey,
      providerUploadId: uploadRow.providerUploadId,
      partNumber: 1,
      expiresInSeconds: 900,
    });
    expect(repositories.uploads.recordOrReplacePart).not.toHaveBeenCalled();
  });

  test('records opaque ETags and validates the exact reported part size', async () => {
    const repositories = makeRepositories();
    const service = createMultipartUploadService({
      ...repositories,
      storage: makeStorage(),
      configuration,
    });
    const response = await service.recordPart('owner-id', videoRow.id, uploadRow.id, 1, {
      etag: '"not-an-md5"',
      reportedSizeBytes: videoRow.expectedSizeBytes,
    });
    expect(response.etag).toBe('opaque-etag');
    expect(repositories.uploads.recordOrReplacePart).toHaveBeenCalledWith(
      'owner-id',
      uploadRow.id,
      expect.objectContaining({ etag: '"not-an-md5"' }),
    );
  });

  test('requires cleanup for an uncertain abort after completion was requested', async () => {
    const repositories = makeRepositories();
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, completionRequestedAt: new Date() },
    ]);
    repositories.uploads.requestAbort.mockResolvedValue([
      { ...uploadRow, state: 'abort_pending', revision: 1, completionRequestedAt: new Date() },
    ]);
    const storage = makeStorage({
      abortMultipartUpload: vi.fn().mockResolvedValue('already_absent'),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.abort('owner-id', videoRow.id, uploadRow.id, { revision: uploadRow.revision }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLEANUP_REQUIRED' });
    expect(repositories.uploads.settleAbort).not.toHaveBeenCalled();
  });

  test('retries abort_pending cleanup and settles after a confirmed abort', async () => {
    const repositories = makeRepositories();
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, state: 'abort_pending', revision: 1 },
    ]);
    const storage = makeStorage({
      abortMultipartUpload: vi
        .fn()
        .mockRejectedValueOnce(new S3StorageError('timeout', { ambiguous: true, retryable: true }))
        .mockResolvedValueOnce('aborted'),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.abort('owner-id', videoRow.id, uploadRow.id, { revision: 1 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CLEANUP_REQUIRED' });
    await service.abort('owner-id', videoRow.id, uploadRow.id, { revision: 1 });
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
    expect(repositories.uploads.settleAbort).toHaveBeenCalledTimes(1);
  });

  test('rejects an expired upload before signing', async () => {
    const repositories = makeRepositories();
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, expiresAt: new Date('2025-01-01T00:00:00Z') },
    ]);
    const service = createMultipartUploadService({
      ...repositories,
      storage: makeStorage(),
      configuration,
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(
      service.signParts('owner-id', videoRow.id, uploadRow.id, { partNumbers: [1] }),
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
  });

  test('retries exact-key initiation reconciliation without closing on an empty scan', async () => {
    const repositories = makeRepositories();
    const storage = makeStorage({
      reconcileUntrackedExactKey: vi
        .fn()
        .mockResolvedValueOnce('pending')
        .mockResolvedValueOnce('cleaned'),
    });
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, state: 'initiating', providerUploadId: null },
    ]);
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.recoverInitiation('owner-id', videoRow.id, uploadRow.id),
    ).resolves.toMatchObject({ state: 'initiating' });
    await service.recoverInitiation('owner-id', videoRow.id, uploadRow.id);
    expect(storage.reconcileUntrackedExactKey).toHaveBeenCalledTimes(2);
    expect(repositories.uploads.settleInitiationReconciliation).toHaveBeenCalledTimes(1);
  });

  test('rejects completion before provider mutation when a recorded part is missing', async () => {
    const repositories = makeRepositories();
    repositories.videos.findByIdForUser.mockResolvedValue([
      { ...videoRow, state: 'uploading', revision: 1 },
    ]);
    repositories.uploads.claimCompletion.mockRejectedValue(
      new Error('Completion part set is incomplete'),
    );
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: uploadRow.revision }),
    ).rejects.toMatchObject({ code: 'INVALID_PART' });
    expect(storage.inspectMultipartUpload).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  test('does not complete when provider parts differ from authoritative recorded parts', async () => {
    const repositories = makeRepositories();
    const completing = { ...uploadRow, state: 'completing', revision: 1 };
    const uploading = { ...videoRow, state: 'uploading', revision: 1 };
    const part = {
      partNumber: 1,
      etag: 'db-etag',
      reportedSizeBytes: videoRow.expectedSizeBytes,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 0,
    };
    repositories.videos.findByIdForUser.mockResolvedValue([uploading]);
    repositories.uploads.listPartsForUser.mockResolvedValue([part]);
    repositories.uploads.claimCompletion.mockResolvedValue({
      upload: completing,
      video: uploading,
      parts: [part],
    });
    const storage = makeStorage({
      inspectMultipartUpload: vi.fn().mockResolvedValue({
        parts: [{ partNumber: 1, etag: 'provider-etag', sizeBytes: videoRow.expectedSizeBytes }],
      }),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: uploadRow.revision }),
    ).rejects.toMatchObject({ code: 'INVALID_PART' });
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(repositories.uploads.failCompletion).toHaveBeenCalledWith(
      'owner-id',
      uploadRow.id,
      completing.revision,
      expect.objectContaining({ failureCode: 'PROVIDER_PART_MISMATCH' }),
    );
  });

  test('keeps an ambiguous completion pending without a blind second Complete call', async () => {
    const repositories = makeRepositories();
    const uploading = { ...videoRow, state: 'uploading', revision: 1 };
    let currentUpload = { ...uploadRow };
    const part = {
      partNumber: 1,
      etag: 'opaque-etag',
      reportedSizeBytes: videoRow.expectedSizeBytes,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 0,
    };
    const authoritativeParts = {
      parts: [{ partNumber: 1, etag: part.etag, sizeBytes: part.reportedSizeBytes }],
    };
    repositories.videos.findByIdForUser.mockImplementation(async () => [
      currentUpload.state === 'completed' ? { ...uploading, state: 'ready' } : uploading,
    ]);
    repositories.uploads.findByIdForUser.mockImplementation(async () => [currentUpload]);
    repositories.uploads.listPartsForUser.mockResolvedValue([part]);
    repositories.uploads.claimCompletion.mockImplementation(async () => {
      currentUpload = { ...currentUpload, state: 'completing', revision: 1 };
      return { upload: currentUpload, video: uploading, parts: [part] };
    });
    repositories.uploads.markCompletionPending.mockImplementation(async (_u, _id, revision) => {
      currentUpload = { ...currentUpload, state: 'completing', revision: revision + 1 };
      return [currentUpload];
    });
    const storage = makeStorage({
      inspectMultipartUpload: vi.fn().mockResolvedValue(authoritativeParts),
      headObject: vi.fn().mockResolvedValue('absent'),
      completeMultipartUpload: vi
        .fn()
        .mockRejectedValue(new S3StorageError('timeout', { ambiguous: true, retryable: true })),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    const response = await service.complete('owner-id', videoRow.id, uploadRow.id, {
      revision: uploadRow.revision,
    });
    expect(response.outcome).toBe('pending');
    expect(currentUpload.state).toBe('completing');
    expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
    expect(storage.headObject).toHaveBeenCalled();
    expect(storage.inspectMultipartUpload).toHaveBeenCalled();
  });

  test.each([
    ['size', { contentLength: videoRow.expectedSizeBytes + 1 }],
    ['ETag', { etag: 'replacement-etag' }],
    ['version', { versionId: 'replacement-version' }],
    ['full-object checksum', { checksumValue: 'replacement-checksum' }],
  ])(
    'never readies a completed upload with contradictory persisted %s evidence',
    async (_name, change) => {
      const repositories = makeRepositories();
      let currentVideo = {
        ...videoRow,
        state: 'uploaded',
        revision: 2,
        objectEtag: 'persisted-etag',
        objectVersionId: 'persisted-version',
        verifiedChecksumAlgorithm: 'sha256',
        verifiedChecksumValue: 'persisted-checksum',
      };
      const completedUpload = {
        ...uploadRow,
        state: 'completed',
        revision: 2,
        completedAt: new Date(),
      };
      repositories.videos.findByIdForUser.mockImplementation(async () => [currentVideo] as never);
      repositories.uploads.findByIdForUser.mockResolvedValue([completedUpload] as never);
      repositories.videos.beginVerification.mockImplementation(async () => {
        currentVideo = { ...currentVideo, state: 'verifying', revision: 3 };
        return [currentVideo] as never;
      });
      repositories.videos.recordInvalid.mockImplementation(async () => {
        currentVideo = { ...currentVideo, state: 'invalid', revision: 4 };
        return [currentVideo] as never;
      });
      const storage = makeStorage({
        headObject: vi.fn().mockResolvedValue({
          contentLength: videoRow.expectedSizeBytes,
          contentType: videoRow.contentType,
          etag: 'persisted-etag',
          versionId: 'persisted-version',
          checksumAlgorithm: 'sha256',
          checksumValue: 'persisted-checksum',
          ...change,
        }),
      });
      const service = createMultipartUploadService({ ...repositories, storage, configuration });
      await expect(
        service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
      ).resolves.toMatchObject({ outcome: 'invalid', videoState: 'invalid' });
      expect(repositories.videos.recordVerified).not.toHaveBeenCalled();
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['matching evidence reaches READY', 'persisted-etag', 'ready'],
    ['replacement evidence becomes invalid', 'replacement-etag', 'invalid'],
  ])(
    'reloads persisted identity after transient HEAD: %s',
    async (_name, retryEtag, expectedState) => {
      const repositories = makeRepositories();
      let currentVideo = {
        ...videoRow,
        state: 'uploaded',
        revision: 2,
        objectEtag: 'persisted-etag',
        objectVersionId: 'persisted-version',
        verifiedChecksumAlgorithm: 'sha256',
        verifiedChecksumValue: 'persisted-checksum',
      };
      const completedUpload = {
        ...uploadRow,
        state: 'completed',
        revision: 2,
        completedAt: new Date(),
      };
      repositories.videos.findByIdForUser.mockImplementation(async () => [currentVideo] as never);
      repositories.uploads.findByIdForUser.mockResolvedValue([completedUpload] as never);
      repositories.videos.beginVerification.mockImplementation(async () => {
        currentVideo = { ...currentVideo, state: 'verifying', revision: 3 };
        return [currentVideo] as never;
      });
      repositories.videos.recordVerified.mockImplementation(async () => {
        currentVideo = { ...currentVideo, state: 'ready', revision: 4 };
        return [currentVideo] as never;
      });
      repositories.videos.recordInvalid.mockImplementation(async () => {
        currentVideo = { ...currentVideo, state: 'invalid', revision: 4 };
        return [currentVideo] as never;
      });
      const storage = makeStorage({
        headObject: vi
          .fn()
          .mockRejectedValueOnce(
            new S3StorageError('transient HEAD', { ambiguous: true, retryable: true }),
          )
          .mockResolvedValueOnce({
            contentLength: videoRow.expectedSizeBytes,
            contentType: videoRow.contentType,
            etag: retryEtag,
            versionId: 'persisted-version',
            checksumAlgorithm: 'sha256',
            checksumValue: 'persisted-checksum',
          }),
      });
      const service = createMultipartUploadService({ ...repositories, storage, configuration });
      await expect(
        service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
      ).resolves.toMatchObject({ outcome: 'pending', videoState: 'verifying' });
      await expect(
        service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
      ).resolves.toMatchObject({ outcome: expectedState, videoState: expectedState });
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    },
  );

  test('returns an already READY completion without provider mutation', async () => {
    const repositories = makeRepositories();
    repositories.videos.findByIdForUser.mockResolvedValue([
      { ...videoRow, state: 'ready', revision: 4 },
    ] as never);
    repositories.uploads.findByIdForUser.mockResolvedValue([
      { ...uploadRow, state: 'completed', revision: 2, completedAt: new Date() },
    ] as never);
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
    ).resolves.toMatchObject({ outcome: 'ready', videoState: 'ready' });
    expect(storage.inspectMultipartUpload).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  test('does not touch the provider for another user', async () => {
    const repositories = makeRepositories();
    repositories.uploads.findByIdForUser.mockResolvedValue([]);
    const storage = makeStorage();
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('other-user', videoRow.id, uploadRow.id, { revision: 0 }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(storage.inspectMultipartUpload).not.toHaveBeenCalled();
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  test('keeps object-absent and multipart-absent ambiguity pending without Complete retry', async () => {
    const repositories = makeRepositories();
    const uploading = { ...videoRow, state: 'uploading', revision: 1 };
    let completing = {
      ...uploadRow,
      state: 'completing',
      revision: 1,
      completionRequestedAt: new Date(),
    };
    repositories.videos.findByIdForUser.mockResolvedValue([uploading] as never);
    repositories.uploads.findByIdForUser.mockImplementation(async () => [completing] as never);
    repositories.uploads.markCompletionPending.mockImplementation(async (_u, _id, revision) => {
      completing = { ...completing, revision: revision + 1 };
      return [completing] as never;
    });
    const storage = makeStorage({
      headObject: vi.fn().mockResolvedValue('absent'),
      inspectMultipartUpload: vi.fn().mockResolvedValue('absent'),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 1 }),
    ).resolves.toMatchObject({ outcome: 'pending', uploadState: 'completing' });
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(repositories.uploads.settleCompletion).not.toHaveBeenCalled();
  });

  test('allows exactly one provider Complete when two active completion callers race', async () => {
    const repositories = makeRepositories();
    const part = {
      partNumber: 1,
      etag: 'opaque-etag',
      reportedSizeBytes: videoRow.expectedSizeBytes,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 0,
    };
    let currentUpload = { ...uploadRow };
    let currentVideo = { ...videoRow, state: 'uploading', revision: 1 };
    repositories.uploads.findByIdForUser.mockImplementation(async () => [currentUpload] as never);
    repositories.videos.findByIdForUser.mockImplementation(async () => [currentVideo] as never);
    repositories.uploads.listPartsForUser.mockResolvedValue([part] as never);
    repositories.uploads.claimCompletion.mockImplementation(async () => {
      if (currentUpload.state !== 'active') throw new Error('Multipart completion claim was stale');
      currentUpload = {
        ...currentUpload,
        state: 'completing',
        revision: 1,
        completionRequestedAt: new Date(),
      };
      return { upload: currentUpload, video: currentVideo, parts: [part] } as never;
    });
    repositories.uploads.settleCompletion.mockImplementation(async () => {
      currentUpload = { ...currentUpload, state: 'completed', revision: 2 };
      currentVideo = {
        ...currentVideo,
        state: 'uploaded',
        revision: 2,
        objectEtag: 'completed-etag',
      };
      return { upload: currentUpload, video: currentVideo } as never;
    });
    repositories.videos.beginVerification.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'verifying', revision: 3 };
      return [currentVideo] as never;
    });
    repositories.videos.recordVerified.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'ready', revision: 4 };
      return [currentVideo] as never;
    });
    const object = {
      contentLength: videoRow.expectedSizeBytes,
      contentType: videoRow.contentType,
      etag: 'completed-etag',
      versionId: null,
      checksumAlgorithm: null,
      checksumValue: null,
    };
    const storage = makeStorage({
      inspectMultipartUpload: vi.fn().mockResolvedValue({
        parts: [{ partNumber: 1, etag: part.etag, sizeBytes: part.reportedSizeBytes }],
      }),
      completeMultipartUpload: vi.fn().mockResolvedValue({
        etag: object.etag,
        versionId: null,
        checksumAlgorithm: null,
        checksumValue: null,
      }),
      headObject: vi.fn().mockResolvedValue(object),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    const results = await Promise.allSettled([
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 0 }),
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 0 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  test('reconciles ambiguous remote success without a second Complete and reaches READY', async () => {
    const repositories = makeRepositories();
    const part = {
      partNumber: 1,
      etag: 'opaque-etag',
      reportedSizeBytes: videoRow.expectedSizeBytes,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 0,
    };
    let currentUpload = { ...uploadRow };
    let currentVideo = { ...videoRow, state: 'uploading', revision: 1 };
    let providerCompleted = false;
    repositories.uploads.findByIdForUser.mockImplementation(async () => [currentUpload] as never);
    repositories.videos.findByIdForUser.mockImplementation(async () => [currentVideo] as never);
    repositories.uploads.listPartsForUser.mockResolvedValue([part] as never);
    repositories.uploads.claimCompletion.mockImplementation(async () => {
      currentUpload = {
        ...currentUpload,
        state: 'completing',
        revision: 1,
        completionRequestedAt: new Date(),
      };
      return { upload: currentUpload, video: currentVideo, parts: [part] } as never;
    });
    repositories.uploads.markCompletionPending.mockImplementation(async (_u, _id, revision) => {
      currentUpload = { ...currentUpload, revision: revision + 1 };
      return [currentUpload] as never;
    });
    repositories.uploads.settleCompletion.mockImplementation(
      async (_u, _id, revision, _v, evidence) => {
        currentUpload = { ...currentUpload, state: 'completed', revision: revision + 1 };
        currentVideo = {
          ...currentVideo,
          state: 'uploaded',
          revision: 2,
          objectEtag: evidence.objectEtag ?? null,
          objectVersionId: evidence.objectVersionId ?? null,
        };
        return { upload: currentUpload, video: currentVideo } as never;
      },
    );
    repositories.videos.beginVerification.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'verifying', revision: 3 };
      return [currentVideo] as never;
    });
    repositories.videos.recordVerified.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'ready', revision: 4 };
      return [currentVideo] as never;
    });
    const object = {
      contentLength: videoRow.expectedSizeBytes,
      contentType: videoRow.contentType,
      etag: 'completed-etag',
      versionId: 'version-1',
      checksumAlgorithm: null,
      checksumValue: null,
    };
    const storage = makeStorage({
      inspectMultipartUpload: vi
        .fn()
        .mockImplementation(async () =>
          providerCompleted
            ? 'absent'
            : { parts: [{ partNumber: 1, etag: part.etag, sizeBytes: part.reportedSizeBytes }] },
        ),
      completeMultipartUpload: vi.fn().mockImplementation(async () => {
        providerCompleted = true;
        throw new S3StorageError('response lost', { ambiguous: true, retryable: true });
      }),
      headObject: vi.fn().mockImplementation(async () => (providerCompleted ? object : 'absent')),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 0 }),
    ).resolves.toMatchObject({ outcome: 'ready', videoState: 'ready' });
    expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
    expect(repositories.uploads.settleCompletion).toHaveBeenCalledTimes(1);
  });

  test('reconciles a completion-won abort race from abort_pending without resending Complete', async () => {
    const repositories = makeRepositories();
    const part = {
      partNumber: 1,
      etag: 'opaque-etag',
      reportedSizeBytes: videoRow.expectedSizeBytes,
      providerChecksumAlgorithm: null,
      providerChecksumValue: null,
      revision: 0,
    };
    let currentUpload = { ...uploadRow };
    let currentVideo = { ...videoRow, state: 'uploading', revision: 1 };
    repositories.uploads.findByIdForUser.mockImplementation(async () => [currentUpload] as never);
    repositories.videos.findByIdForUser.mockImplementation(async () => [currentVideo] as never);
    repositories.uploads.listPartsForUser.mockResolvedValue([part] as never);
    repositories.uploads.claimCompletion.mockImplementation(async () => {
      currentUpload = {
        ...currentUpload,
        state: 'completing',
        revision: 1,
        completionRequestedAt: new Date(),
      };
      return { upload: currentUpload, video: currentVideo, parts: [part] } as never;
    });
    repositories.uploads.settleCompletion.mockRejectedValue(
      new Error('Multipart completion settlement is stale'),
    );
    repositories.uploads.settleAbortPendingCompletion.mockImplementation(
      async (_u, _id, revision, _v, evidence) => {
        if (currentUpload.state !== 'abort_pending' || currentUpload.revision !== revision)
          throw new Error('Multipart completion settlement is stale');
        currentUpload = { ...currentUpload, state: 'completed', revision: revision + 1 };
        currentVideo = {
          ...currentVideo,
          state: 'uploaded',
          revision: 2,
          objectEtag: evidence.objectEtag ?? null,
        };
        return { upload: currentUpload, video: currentVideo } as never;
      },
    );
    repositories.videos.beginVerification.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'verifying', revision: 3 };
      return [currentVideo] as never;
    });
    repositories.videos.recordVerified.mockImplementation(async () => {
      currentVideo = { ...currentVideo, state: 'ready', revision: 4 };
      return [currentVideo] as never;
    });
    const object = {
      contentLength: videoRow.expectedSizeBytes,
      contentType: videoRow.contentType,
      etag: 'completed-etag',
      versionId: null,
      checksumAlgorithm: null,
      checksumValue: null,
    };
    const storage = makeStorage({
      inspectMultipartUpload: vi
        .fn()
        .mockResolvedValueOnce({
          parts: [{ partNumber: 1, etag: part.etag, sizeBytes: part.reportedSizeBytes }],
        })
        .mockResolvedValue('absent'),
      completeMultipartUpload: vi.fn().mockImplementation(async () => {
        currentUpload = { ...currentUpload, state: 'abort_pending', revision: 2 };
        return {
          etag: object.etag,
          versionId: null,
          checksumAlgorithm: null,
          checksumValue: null,
        };
      }),
      abortMultipartUpload: vi.fn().mockResolvedValue('already_absent'),
      headObject: vi.fn().mockResolvedValue(object),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 0 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/stale/i) });
    await expect(
      service.abort('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
    ).resolves.toMatchObject({ state: 'completed' });
    expect(currentVideo.state).toBe('ready');
    expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
    expect(repositories.uploads.settleAbort).not.toHaveBeenCalled();
  });

  test('cannot settle abort_pending completion with stale revision ownership', async () => {
    const repositories = makeRepositories();
    const abortPending = {
      ...uploadRow,
      state: 'abort_pending',
      revision: 2,
      completionRequestedAt: new Date(),
    };
    repositories.uploads.findByIdForUser.mockResolvedValue([abortPending] as never);
    repositories.videos.findByIdForUser.mockResolvedValue([
      { ...videoRow, state: 'uploading', revision: 1 },
    ] as never);
    repositories.uploads.settleAbortPendingCompletion.mockRejectedValue(
      new Error('Multipart completion settlement is stale'),
    );
    const storage = makeStorage({
      headObject: vi.fn().mockResolvedValue({
        contentLength: videoRow.expectedSizeBytes,
        contentType: videoRow.contentType,
        etag: 'completed-etag',
        versionId: null,
        checksumAlgorithm: null,
        checksumValue: null,
      }),
      inspectMultipartUpload: vi.fn().mockResolvedValue('absent'),
    });
    const service = createMultipartUploadService({ ...repositories, storage, configuration });
    await expect(
      service.complete('owner-id', videoRow.id, uploadRow.id, { revision: 2 }),
    ).resolves.toMatchObject({ outcome: 'pending', uploadState: 'abort_pending' });
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(repositories.videos.beginVerification).not.toHaveBeenCalled();
  });
});
