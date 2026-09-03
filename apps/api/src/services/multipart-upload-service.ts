import { randomUUID } from 'node:crypto';
import {
  abortUploadRequestSchema,
  completeUploadRequestSchema,
  createVideoUploadRequestSchema,
  partUrlRequestSchema,
  recordUploadPartRequestSchema,
  type AbortUploadRequest,
  type CreateVideoUploadRequest,
  type CreateVideoUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type PartUrlRequest,
  type PartUrlResponse,
  type RecordUploadPartRequest,
  type UploadPartResponse,
  type UploadStatusResponse,
} from '@sovara-studio/contracts';
import type { MultipartStorage } from '@sovara-studio/infra';
import { S3StorageError as StorageError } from '@sovara-studio/infra';
import type { createMultipartUploadRepository } from '@sovara-studio/db';
import type { createVideoRepository } from '@sovara-studio/db';
import {
  calculateMultipartPlan,
  expectedPartSize,
  type StorageConfiguration,
} from '../storage-config.js';
import { UploadError, fromStorageError } from '../upload-errors.js';

type VideoRepository = ReturnType<typeof createVideoRepository>;
type UploadRepository = ReturnType<typeof createMultipartUploadRepository>;
type UploadRow = Awaited<ReturnType<UploadRepository['findByIdForUser']>>[number];
type UploadPartRow = Awaited<ReturnType<UploadRepository['listPartsForUser']>>[number];
type VideoRow = Awaited<ReturnType<VideoRepository['findByIdForUser']>>[number];
type UploadState = UploadStatusResponse['state'];
type AbortableUploadState = 'active' | 'completing' | 'failed';
type CompletionEvidence = {
  objectEtag?: string | null;
  objectVersionId?: string | null;
  checksumAlgorithm?: string | null;
  checksumValue?: string | null;
};

function uploadState(state: string): UploadState {
  if (
    ![
      'initiating',
      'initiation_reconciling',
      'active',
      'completing',
      'completed',
      'abort_pending',
      'aborted',
      'expired',
      'failed',
    ].includes(state)
  )
    throw new UploadError('INTERNAL_ERROR', 'Upload has an invalid persisted state');
  return state as UploadState;
}

export type MultipartUploadServiceDependencies = {
  videos: VideoRepository;
  uploads: UploadRepository;
  storage: MultipartStorage;
  configuration: StorageConfiguration;
  now?: () => Date;
};

function createObjectKey() {
  const id = randomUUID();
  return `sources/${id.slice(0, 2)}/${id}`;
}

function mapRepositoryError(error: unknown, fallback: UploadError) {
  if (error instanceof UploadError) return error;
  if (error instanceof StorageError) return fromStorageError(error);
  if (error instanceof Error && /stale|revision/i.test(error.message))
    return new UploadError('STALE_REVISION', 'The upload changed; refresh and retry');
  return fallback;
}

function assertContentType(contentType: string, allowedContentTypes: readonly string[]) {
  if (contentType.length > 255 || !allowedContentTypes.includes(contentType.toLowerCase()))
    throw new UploadError('INVALID_REQUEST', 'Content type is not allowed');
}

function assertFilename(filename: string, allowedExtensions: readonly string[]) {
  if (filename.length > 255 || filename.includes('\u0000') || filename.trim().length === 0)
    throw new UploadError('INVALID_REQUEST', 'Original filename is invalid');
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (!filename.includes('.') || !allowedExtensions.includes(extension))
    throw new UploadError('INVALID_REQUEST', 'Filename extension is not allowed');
}

class SignRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly now: () => Date,
  ) {}

  consume(userId: string) {
    const timestamp = this.now().getTime();
    const current = this.windows.get(userId);
    if (!current || timestamp - current.startedAt >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(userId, { startedAt: timestamp, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

export function createMultipartUploadService(dependencies: MultipartUploadServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const rateLimiter = new SignRateLimiter(
    dependencies.configuration.uploadSignRateLimitPerMinute,
    now,
  );

  const getContext = async (userId: string, videoId: string, uploadId: string) => {
    const uploads = await dependencies.uploads.findByIdForUser(userId, uploadId);
    const upload = uploads[0];
    if (!upload || upload.videoId !== videoId)
      throw new UploadError('RESOURCE_NOT_FOUND', 'Upload was not found');
    const videos = await dependencies.videos.findByIdForUser(userId, videoId);
    const video = videos[0];
    if (!video) throw new UploadError('RESOURCE_NOT_FOUND', 'Upload was not found');
    return { upload, video };
  };

  const status = async (userId: string, videoId: string, uploadId: string) => {
    const { upload, video } = await getContext(userId, videoId, uploadId);
    const parts = await dependencies.uploads.listPartsForUser(userId, upload.id);
    return {
      videoId: video.id,
      uploadId: upload.id,
      state: uploadState(upload.state),
      expectedSizeBytes: video.expectedSizeBytes,
      partSizeBytes: upload.partSizeBytes,
      expectedPartCount: upload.expectedPartCount,
      expiresAt: upload.expiresAt.toISOString(),
      revision: upload.revision,
      maxConcurrency: dependencies.configuration.uploadMaxConcurrency,
      parts: parts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
        reportedSizeBytes: part.reportedSizeBytes,
        providerChecksumAlgorithm: part.providerChecksumAlgorithm,
        providerChecksumValue: part.providerChecksumValue,
        revision: part.revision,
      })),
    } satisfies UploadStatusResponse;
  };

  const createResponse = (upload: UploadStatusResponse): CreateVideoUploadResponse => ({
    videoId: upload.videoId,
    upload: {
      uploadId: upload.uploadId,
      state: upload.state,
      expectedSizeBytes: upload.expectedSizeBytes,
      partSizeBytes: upload.partSizeBytes,
      expectedPartCount: upload.expectedPartCount,
      expiresAt: upload.expiresAt,
      revision: upload.revision,
      maxConcurrency: upload.maxConcurrency,
    },
  });

  const reconcileInitiation = async (
    userId: string,
    videoId: string,
    uploadId: string,
    lateProviderUploadId?: string,
  ): Promise<UploadStatusResponse> => {
    let context = await getContext(userId, videoId, uploadId);
    if (context.upload.state === 'active') return status(userId, videoId, uploadId);
    if (context.upload.state === 'initiating') {
      const [claimed] = await dependencies.uploads.claimInitiationReconciliation(
        userId,
        context.upload.id,
        context.upload.revision,
      );
      if (claimed) {
        context = { upload: claimed, video: context.video };
      } else {
        context = await getContext(userId, videoId, uploadId);
        if (context.upload.state !== 'initiation_reconciling')
          return status(userId, videoId, uploadId);
      }
    }
    const { upload, video } = context;
    if (upload.state !== 'initiation_reconciling') return status(userId, videoId, uploadId);
    if (upload.providerUploadId)
      throw new UploadError('INTERNAL_ERROR', 'Reconciliation state has a provider upload ID');
    let lateProviderCleaned = false;
    if (lateProviderUploadId) {
      try {
        const lateProviderResult = await dependencies.storage.abortMultipartUpload({
          objectKey: video.objectKey,
          providerUploadId: lateProviderUploadId,
        });
        lateProviderCleaned =
          lateProviderResult === 'aborted' ||
          (lateProviderResult === 'already_absent' && upload.completionRequestedAt === null);
      } catch (error) {
        throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Storage cleanup requires retry', {
          retryable: true,
          cause: error,
        });
      }
    }
    let reconciliation: 'cleaned' | 'pending';
    try {
      reconciliation = await dependencies.storage.reconcileUntrackedExactKey(video.objectKey);
    } catch (error) {
      throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Storage cleanup requires retry', {
        retryable: true,
        cause: error,
      });
    }
    if (reconciliation === 'pending' && !lateProviderCleaned)
      return status(userId, videoId, uploadId);
    try {
      const settled = await dependencies.uploads.settleInitiationReconciliation(
        userId,
        upload.id,
        upload.revision,
        'PROVIDER_INITIATION_CLEANED',
      );
      if (settled.length === 0) return status(userId, videoId, uploadId);
    } catch (error) {
      throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Upload cleanup requires retry', {
        retryable: true,
        cause: error,
      });
    }
    return status(userId, videoId, uploadId);
  };

  const create = async (
    userId: string,
    input: CreateVideoUploadRequest,
  ): Promise<CreateVideoUploadResponse> => {
    const parsed = createVideoUploadRequestSchema.safeParse(input);
    if (!parsed.success) throw new UploadError('INVALID_REQUEST', 'Upload metadata is invalid');
    assertFilename(
      parsed.data.originalFilename,
      dependencies.configuration.uploadAllowedExtensions,
    );
    assertContentType(
      parsed.data.contentType,
      dependencies.configuration.uploadAllowedContentTypes,
    );
    let plan;
    try {
      plan = calculateMultipartPlan(parsed.data.expectedSizeBytes, dependencies.configuration);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new UploadError(
        /maximum/i.test(message) ? 'UPLOAD_TOO_LARGE' : 'INVALID_REQUEST',
        /maximum/i.test(message)
          ? 'Upload exceeds the configured maximum size'
          : 'Upload policy is invalid',
      );
    }
    const objectKey = createObjectKey();
    const [createdVideo] = await dependencies.videos.createOwnedVideo(userId, {
      originalFilename: parsed.data.originalFilename,
      contentType: parsed.data.contentType,
      expectedSizeBytes: parsed.data.expectedSizeBytes,
      storageBackend: 's3-compatible',
      storageBucket: dependencies.configuration.s3.bucket,
      objectKey,
    });
    if (!createdVideo) throw new UploadError('INTERNAL_ERROR', 'Upload could not be created');

    let [initiation] = await dependencies.uploads.createOwnedUpload(userId, {
      videoId: createdVideo.id,
      providerUploadId: null,
      state: 'initiating',
      partSizeBytes: plan.partSizeBytes,
      expectedPartCount: plan.expectedPartCount,
      expiresAt: new Date(
        now().getTime() + dependencies.configuration.multipartUploadTtlSeconds * 1000,
      ),
    });
    if (!initiation) throw new UploadError('INTERNAL_ERROR', 'Upload could not be created');

    let providerUploadId: string;
    try {
      providerUploadId = (
        await dependencies.storage.createMultipartUpload({
          objectKey,
          contentType: parsed.data.contentType,
        })
      ).providerUploadId;
    } catch (error) {
      if (error instanceof StorageError && error.ambiguous) {
        let reconciled: UploadStatusResponse;
        try {
          reconciled = await reconcileInitiation(userId, createdVideo.id, initiation.id);
        } catch (reconciliationError) {
          if (reconciliationError instanceof UploadError) throw reconciliationError;
          throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Storage cleanup requires retry', {
            retryable: true,
            cause: reconciliationError,
          });
        }
        if (reconciled.state === 'initiating')
          throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Storage cleanup requires retry', {
            retryable: true,
          });
        throw new UploadError(
          'STORAGE_TEMPORARILY_UNAVAILABLE',
          'Storage provider initiation was reconciled; retry the upload',
          { retryable: true, cause: error },
        );
      } else {
        try {
          await dependencies.uploads.settleInitiationFailure(
            userId,
            initiation.id,
            'PROVIDER_INITIATION_FAILED',
          );
        } catch (settlementError) {
          throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Upload cleanup requires retry', {
            retryable: true,
            cause: settlementError,
          });
        }
      }
      throw mapRepositoryError(
        error,
        new UploadError('STORAGE_TEMPORARILY_UNAVAILABLE', 'Storage provider is unavailable', {
          retryable: true,
          cause: error,
        }),
      );
    }

    try {
      const [upload] = await dependencies.uploads.associateProviderUpload(
        userId,
        initiation.id,
        initiation.revision,
        providerUploadId,
      );
      if (upload) {
        const uploadStatus = await status(userId, createdVideo.id, upload.id);
        return createResponse(uploadStatus);
      }
      throw new Error('Upload provider association returned no row');
    } catch {
      try {
        const reconciled = await reconcileInitiation(
          userId,
          createdVideo.id,
          initiation.id,
          providerUploadId,
        );
        if (reconciled.state === 'active') return createResponse(reconciled);
        throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Storage cleanup requires retry', {
          retryable: true,
        });
      } catch (reconciliationError) {
        if (reconciliationError instanceof UploadError) throw reconciliationError;
        throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Upload cleanup requires retry', {
          retryable: true,
          cause: reconciliationError,
        });
      }
    }
  };

  const signParts = async (
    userId: string,
    videoId: string,
    uploadId: string,
    input: PartUrlRequest,
  ): Promise<PartUrlResponse> => {
    const parsed = partUrlRequestSchema.safeParse(input);
    if (!parsed.success) throw new UploadError('INVALID_PART', 'Part request is invalid');
    if (!rateLimiter.consume(userId))
      throw new UploadError('SIGNING_RATE_LIMITED', 'Part signing rate limit exceeded', {
        retryable: true,
      });
    const { upload, video } = await getContext(userId, videoId, uploadId);
    if (upload.state !== 'active')
      throw new UploadError('INVALID_UPLOAD_STATE', 'Upload is not active');
    if (!upload.providerUploadId)
      throw new UploadError('INTERNAL_ERROR', 'Active upload has no provider upload ID');
    const providerUploadId = upload.providerUploadId;
    const currentTime = now();
    const remainingMs = upload.expiresAt.getTime() - currentTime.getTime();
    if (remainingMs <= 0) throw new UploadError('UPLOAD_EXPIRED', 'Upload has expired');
    if (
      new Set(parsed.data.partNumbers).size !== parsed.data.partNumbers.length ||
      parsed.data.partNumbers.some(
        (partNumber) => partNumber < 1 || partNumber > upload.expectedPartCount,
      )
    )
      throw new UploadError('INVALID_PART', 'Part number is outside the upload range');
    if (parsed.data.partNumbers.length > dependencies.configuration.uploadSignBatchMax)
      throw new UploadError('INVALID_PART', 'Too many parts requested');
    const expiresInSeconds = Math.floor(
      Math.min(dependencies.configuration.presignedPartTtlSeconds * 1000, remainingMs) / 1000,
    );
    if (expiresInSeconds < 1)
      throw new UploadError('UPLOAD_EXPIRED', 'Upload has insufficient signing lifetime');
    try {
      const parts = await Promise.all(
        parsed.data.partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await dependencies.storage.presignUploadPart({
            objectKey: video.objectKey,
            providerUploadId,
            partNumber,
            expiresInSeconds,
          }),
          expiresAt: new Date(currentTime.getTime() + expiresInSeconds * 1000).toISOString(),
        })),
      );
      return {
        uploadId: upload.id,
        uploadRevision: upload.revision,
        expiresAt: upload.expiresAt.toISOString(),
        parts,
      };
    } catch (error) {
      throw mapRepositoryError(
        error,
        new UploadError('STORAGE_TEMPORARILY_UNAVAILABLE', 'Part URL could not be created', {
          retryable: true,
          cause: error,
        }),
      );
    }
  };

  const recordPart = async (
    userId: string,
    videoId: string,
    uploadId: string,
    partNumber: number,
    input: RecordUploadPartRequest,
  ): Promise<UploadPartResponse> => {
    const parsed = recordUploadPartRequestSchema.safeParse(input);
    if (!parsed.success) throw new UploadError('INVALID_PART', 'Part metadata is invalid');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000)
      throw new UploadError('INVALID_PART', 'Part number is invalid');
    const { upload, video } = await getContext(userId, videoId, uploadId);
    const currentTime = now();
    if (upload.expiresAt.getTime() <= currentTime.getTime())
      throw new UploadError('UPLOAD_EXPIRED', 'Upload has expired');
    if (upload.state !== 'active')
      throw new UploadError('INVALID_UPLOAD_STATE', 'Upload is not active');
    if (partNumber > upload.expectedPartCount)
      throw new UploadError('INVALID_PART', 'Part number is outside the upload range');
    if (
      parsed.data.reportedSizeBytes !== undefined &&
      parsed.data.reportedSizeBytes !==
        expectedPartSize(
          video.expectedSizeBytes,
          upload.partSizeBytes,
          upload.expectedPartCount,
          partNumber,
        )
    )
      throw new UploadError('INVALID_PART', 'Reported part size is invalid');
    try {
      const [part] = await dependencies.uploads.recordOrReplacePart(userId, upload.id, {
        partNumber,
        etag: parsed.data.etag,
        reportedSizeBytes: parsed.data.reportedSizeBytes,
        providerChecksumAlgorithm: parsed.data.providerChecksumAlgorithm,
        providerChecksumValue: parsed.data.providerChecksumValue,
      });
      if (!part) throw new Error('Part was not persisted');
      return {
        partNumber: part.partNumber,
        etag: part.etag,
        reportedSizeBytes: part.reportedSizeBytes,
        providerChecksumAlgorithm: part.providerChecksumAlgorithm,
        providerChecksumValue: part.providerChecksumValue,
        revision: part.revision,
      };
    } catch (error) {
      throw mapRepositoryError(
        error,
        new UploadError('INVALID_UPLOAD_STATE', 'Part cannot be recorded'),
      );
    }
  };

  const completionResponse = async (
    userId: string,
    videoId: string,
    uploadId: string,
    retryable = false,
  ): Promise<CompleteUploadResponse> => {
    const context = await getContext(userId, videoId, uploadId);
    const currentStatus = await status(userId, videoId, uploadId);
    const outcome =
      context.video.state === 'ready'
        ? 'ready'
        : context.video.state === 'invalid'
          ? 'invalid'
          : context.video.state === 'failed'
            ? 'failed'
            : 'pending';
    return {
      videoId: context.video.id,
      uploadId: context.upload.id,
      uploadState: currentStatus.state,
      uploadRevision: currentStatus.revision,
      videoState: context.video.state as CompleteUploadResponse['videoState'],
      videoRevision: context.video.revision,
      outcome,
      retryable,
    };
  };

  const markCompletionPending = async (
    userId: string,
    uploadId: string,
    revision: number,
    failureCode: string,
    message: string,
  ) => {
    const rows = await dependencies.uploads.markCompletionPending(userId, uploadId, revision, {
      failureCode,
      failureMessage: message,
    });
    return rows.length > 0;
  };

  const providerPartsMatch = (
    inspection: Awaited<ReturnType<MultipartStorage['inspectMultipartUpload']>>,
    upload: UploadRow,
    video: VideoRow,
    persisted: UploadPartRow[],
  ) => {
    if (inspection === 'absent' || inspection.parts.length !== upload.expectedPartCount)
      return false;
    return inspection.parts.every((providerPart, index) => {
      const dbPart = persisted[index];
      const expectedSize =
        providerPart.partNumber < upload.expectedPartCount
          ? upload.partSizeBytes
          : video.expectedSizeBytes - upload.partSizeBytes * (upload.expectedPartCount - 1);
      return (
        dbPart !== undefined &&
        dbPart.partNumber === providerPart.partNumber &&
        dbPart.etag === providerPart.etag &&
        providerPart.sizeBytes === expectedSize
      );
    });
  };

  const compareObject = (
    video: VideoRow,
    object: Exclude<Awaited<ReturnType<MultipartStorage['headObject']>>, 'absent'>,
    evidence: CompletionEvidence = {},
  ) => {
    if (object.contentLength !== video.expectedSizeBytes)
      throw new UploadError('INVALID_REQUEST', 'Completed object size does not match the upload');
    if (
      !object.contentType ||
      object.contentType.split(';', 1)[0]!.trim().toLowerCase() !== video.contentType.toLowerCase()
    )
      throw new UploadError(
        'INVALID_REQUEST',
        'Completed object content type does not match the upload',
      );
    if (
      evidence.objectEtag !== null &&
      evidence.objectEtag !== undefined &&
      evidence.objectEtag !== object.etag
    )
      throw new UploadError('INVALID_REQUEST', 'Completed object ETag changed during verification');
    if (
      evidence.objectVersionId !== null &&
      evidence.objectVersionId !== undefined &&
      evidence.objectVersionId !== object.versionId
    )
      throw new UploadError(
        'INVALID_REQUEST',
        'Completed object version changed during verification',
      );
    if (
      evidence.checksumAlgorithm !== null &&
      evidence.checksumAlgorithm !== undefined &&
      (evidence.checksumAlgorithm !== object.checksumAlgorithm ||
        evidence.checksumValue !== object.checksumValue)
    )
      throw new UploadError(
        'INVALID_REQUEST',
        'Completed object checksum changed during verification',
      );
  };

  const persistedCompletionEvidence = (video: VideoRow): CompletionEvidence => ({
    objectEtag: video.objectEtag,
    objectVersionId: video.objectVersionId,
    checksumAlgorithm: video.verifiedChecksumAlgorithm,
    checksumValue: video.verifiedChecksumValue,
  });

  const mergePersistedAndObservedEvidence = (
    video: VideoRow,
    observed: Exclude<Awaited<ReturnType<MultipartStorage['headObject']>>, 'absent'>,
  ): CompletionEvidence => {
    const persisted = persistedCompletionEvidence(video);
    return {
      objectEtag: persisted.objectEtag ?? observed.etag,
      objectVersionId: persisted.objectVersionId ?? observed.versionId,
      checksumAlgorithm: persisted.checksumAlgorithm ?? observed.checksumAlgorithm,
      checksumValue: persisted.checksumValue ?? observed.checksumValue,
    };
  };

  const verifyCompletedObject = async (
    userId: string,
    videoId: string,
    uploadId: string,
  ): Promise<CompleteUploadResponse> => {
    const context = await getContext(userId, videoId, uploadId);
    if (context.video.state === 'ready') return completionResponse(userId, videoId, uploadId);
    let verifying = context.video;
    if (verifying.state === 'uploaded') {
      const [claimed] = await dependencies.videos.beginVerification(
        userId,
        verifying.id,
        verifying.revision,
      );
      if (!claimed) return completionResponse(userId, videoId, uploadId, true);
      verifying = claimed;
    }
    if (verifying.state !== 'verifying') return completionResponse(userId, videoId, uploadId);
    let object;
    try {
      object = await dependencies.storage.headObject(verifying.objectKey);
    } catch (error) {
      if (error instanceof StorageError && error.ambiguous) {
        return completionResponse(userId, videoId, uploadId, true);
      }
      return completionResponse(userId, videoId, uploadId, true);
    }
    if (object === 'absent') return completionResponse(userId, videoId, uploadId, true);
    try {
      compareObject(verifying, object, persistedCompletionEvidence(verifying));
    } catch (error) {
      if (error instanceof UploadError && error.code === 'INVALID_REQUEST') {
        await dependencies.videos.recordInvalid(userId, verifying.id, verifying.revision, {
          failureCode: 'OBJECT_VERIFICATION_MISMATCH',
          failureMessage: error.message,
          verifiedAt: now(),
        });
        return completionResponse(userId, videoId, uploadId);
      }
      throw error;
    }
    const [ready] = await dependencies.videos.recordVerified(
      userId,
      verifying.id,
      verifying.revision,
      {
        verifiedSizeBytes: object.contentLength,
        objectEtag: object.etag,
        objectVersionId: object.versionId,
        verifiedChecksumAlgorithm: object.checksumAlgorithm,
        verifiedChecksumValue: object.checksumValue,
        verifiedAt: now(),
      },
    );
    if (!ready) return completionResponse(userId, videoId, uploadId, true);
    return completionResponse(userId, videoId, uploadId);
  };

  const reconcileCompleting = async (
    userId: string,
    videoId: string,
    uploadId: string,
    uploadRevision: number,
  ) => {
    const context = await getContext(userId, videoId, uploadId);
    if (context.upload.state !== 'completing')
      return completionResponse(userId, videoId, uploadId, true);
    if (context.upload.revision !== uploadRevision)
      return completionResponse(userId, videoId, uploadId, true);
    let object: Awaited<ReturnType<MultipartStorage['headObject']>>;
    let inspection: Awaited<ReturnType<MultipartStorage['inspectMultipartUpload']>>;
    try {
      [object, inspection] = await Promise.all([
        dependencies.storage.headObject(context.video.objectKey),
        dependencies.storage.inspectMultipartUpload({
          objectKey: context.video.objectKey,
          providerUploadId: context.upload.providerUploadId!,
        }),
      ]);
    } catch {
      await markCompletionPending(
        userId,
        uploadId,
        context.upload.revision,
        'COMPLETION_RECONCILIATION_PENDING',
        'Completion outcome requires provider reconciliation',
      );
      return completionResponse(userId, videoId, uploadId, true);
    }
    if (object !== 'absent' && inspection === 'absent') {
      const settled = await dependencies.uploads.settleCompletion(
        userId,
        uploadId,
        context.upload.revision,
        context.video.revision,
        mergePersistedAndObservedEvidence(context.video, object),
      );
      if (!settled) return completionResponse(userId, videoId, uploadId, true);
      return verifyCompletedObject(userId, videoId, uploadId);
    }
    const reason =
      object !== 'absent' && inspection !== 'absent'
        ? 'COMPLETION_PROVIDER_CONFLICT'
        : 'COMPLETION_AMBIGUOUS_PENDING';
    await markCompletionPending(
      userId,
      uploadId,
      context.upload.revision,
      reason,
      'Completion remains pending until provider state is unambiguous',
    );
    return completionResponse(userId, videoId, uploadId, true);
  };

  const reconcileAbortPendingCompletion = async (
    userId: string,
    videoId: string,
    uploadId: string,
    uploadRevision: number,
  ): Promise<CompleteUploadResponse> => {
    const context = await getContext(userId, videoId, uploadId);
    if (
      context.upload.state !== 'abort_pending' ||
      context.upload.revision !== uploadRevision ||
      !context.upload.completionRequestedAt ||
      !context.upload.providerUploadId
    )
      return completionResponse(userId, videoId, uploadId, true);
    let object: Awaited<ReturnType<MultipartStorage['headObject']>>;
    let inspection: Awaited<ReturnType<MultipartStorage['inspectMultipartUpload']>>;
    try {
      [object, inspection] = await Promise.all([
        dependencies.storage.headObject(context.video.objectKey),
        dependencies.storage.inspectMultipartUpload({
          objectKey: context.video.objectKey,
          providerUploadId: context.upload.providerUploadId,
        }),
      ]);
    } catch {
      return completionResponse(userId, videoId, uploadId, true);
    }
    if (object === 'absent' || inspection !== 'absent')
      return completionResponse(userId, videoId, uploadId, true);
    try {
      await dependencies.uploads.settleAbortPendingCompletion(
        userId,
        uploadId,
        context.upload.revision,
        context.video.revision,
        mergePersistedAndObservedEvidence(context.video, object),
      );
    } catch {
      return completionResponse(userId, videoId, uploadId, true);
    }
    return verifyCompletedObject(userId, videoId, uploadId);
  };

  const complete = async (
    userId: string,
    videoId: string,
    uploadId: string,
    request: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse> => {
    const parsed = completeUploadRequestSchema.safeParse(request);
    if (!parsed.success) throw new UploadError('INVALID_REQUEST', 'Completion request is invalid');
    const context = await getContext(userId, videoId, uploadId);
    if (context.video.state === 'ready' && context.upload.state === 'completed')
      return completionResponse(userId, videoId, uploadId);
    if (context.upload.state === 'completing')
      return reconcileCompleting(userId, videoId, uploadId, parsed.data.revision);
    if (context.upload.state === 'abort_pending')
      return reconcileAbortPendingCompletion(userId, videoId, uploadId, parsed.data.revision);
    if (context.upload.state === 'completed')
      return verifyCompletedObject(userId, videoId, uploadId);
    if (context.upload.state !== 'active' || context.video.state !== 'uploading')
      throw new UploadError('INVALID_UPLOAD_STATE', 'Upload is not ready for completion');
    let claimed;
    try {
      claimed = await dependencies.uploads.claimCompletion(
        userId,
        uploadId,
        parsed.data.revision,
        (await dependencies.uploads.listPartsForUser(userId, uploadId)).map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
        })),
      );
    } catch (error) {
      throw mapRepositoryError(
        error,
        new UploadError('INVALID_PART', 'Upload parts are incomplete'),
      );
    }
    let inspection;
    try {
      inspection = await dependencies.storage.inspectMultipartUpload({
        objectKey: claimed.video.objectKey,
        providerUploadId: claimed.upload.providerUploadId!,
      });
    } catch (error) {
      await markCompletionPending(
        userId,
        uploadId,
        claimed.upload.revision,
        'COMPLETION_RECONCILIATION_PENDING',
        'Provider parts could not be inspected safely',
      );
      throw fromStorageError(
        error instanceof StorageError
          ? error
          : new StorageError('inspection failed', { ambiguous: true, retryable: true }),
      );
    }
    if (!providerPartsMatch(inspection, claimed.upload, claimed.video, claimed.parts)) {
      await dependencies.uploads.failCompletion(userId, uploadId, claimed.upload.revision, {
        failureCode: 'PROVIDER_PART_MISMATCH',
        failureMessage: 'Provider parts do not match authoritative recorded parts',
      });
      throw new UploadError('INVALID_PART', 'Provider parts do not match recorded parts');
    }
    let evidence: CompletionEvidence;
    try {
      const result = await dependencies.storage.completeMultipartUpload({
        objectKey: claimed.video.objectKey,
        providerUploadId: claimed.upload.providerUploadId!,
        parts: claimed.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.etag,
          sizeBytes: part.reportedSizeBytes!,
        })),
      });
      evidence = {
        objectEtag: result.etag,
        objectVersionId: result.versionId,
        checksumAlgorithm: result.checksumAlgorithm,
        checksumValue: result.checksumValue,
      };
    } catch (error) {
      if (error instanceof StorageError && error.ambiguous) {
        await markCompletionPending(
          userId,
          uploadId,
          claimed.upload.revision,
          'COMPLETION_AMBIGUOUS_PENDING',
          'Provider completion outcome is ambiguous; reconciliation is required',
        );
        return reconcileCompleting(userId, videoId, uploadId, claimed.upload.revision + 1);
      }
      await dependencies.uploads.failCompletion(userId, uploadId, claimed.upload.revision, {
        failureCode: 'PROVIDER_COMPLETION_FAILED',
        failureMessage: 'Provider rejected multipart completion',
      });
      throw fromStorageError(
        error instanceof StorageError
          ? error
          : new StorageError('completion failed', { ambiguous: false, retryable: false }),
      );
    }
    const settled = await dependencies.uploads.settleCompletion(
      userId,
      uploadId,
      claimed.upload.revision,
      claimed.video.revision,
      evidence,
    );
    if (!settled) return completionResponse(userId, videoId, uploadId, true);
    return verifyCompletedObject(userId, videoId, uploadId);
  };

  const abort = async (
    userId: string,
    videoId: string,
    uploadId: string,
    request: AbortUploadRequest,
    finalState: 'aborted' | 'expired' = 'aborted',
  ) => {
    const parsed = abortUploadRequestSchema.safeParse(request);
    if (!parsed.success) throw new UploadError('STALE_REVISION', 'Upload revision is invalid');
    const { upload, video } = await getContext(userId, videoId, uploadId);
    if (
      upload.state !== 'active' &&
      upload.state !== 'completing' &&
      upload.state !== 'failed' &&
      upload.state !== 'abort_pending'
    ) {
      if (upload.state === 'aborted' || upload.state === 'expired')
        return status(userId, videoId, uploadId);
      throw new UploadError('INVALID_UPLOAD_STATE', 'Upload cannot be aborted');
    }
    let claimed = upload;
    if (upload.state === 'abort_pending') {
      if (upload.revision !== parsed.data.revision)
        throw new UploadError('STALE_REVISION', 'Upload revision is stale');
    } else {
      const [requestedAbort] = await dependencies.uploads.requestAbort(
        userId,
        upload.id,
        upload.state as AbortableUploadState,
        parsed.data.revision,
      );
      if (!requestedAbort) throw new UploadError('STALE_REVISION', 'Upload revision is stale');
      claimed = requestedAbort;
    }
    if (!claimed.providerUploadId)
      throw new UploadError('INTERNAL_ERROR', 'Abortable upload has no provider upload ID');
    let providerResult: Awaited<ReturnType<MultipartStorage['abortMultipartUpload']>>;
    try {
      providerResult = await dependencies.storage.abortMultipartUpload({
        objectKey: video.objectKey,
        providerUploadId: claimed.providerUploadId,
      });
    } catch (error) {
      throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Provider cleanup requires retry', {
        retryable: true,
        cause: error,
      });
    }
    if (providerResult === 'already_absent' && claimed.completionRequestedAt) {
      const reconciled = await reconcileAbortPendingCompletion(
        userId,
        videoId,
        uploadId,
        claimed.revision,
      );
      if (reconciled.outcome !== 'pending') return status(userId, videoId, uploadId);
      throw new UploadError('PROVIDER_CLEANUP_REQUIRED', 'Provider cleanup outcome is ambiguous', {
        retryable: true,
      });
    }
    const [settled] = await dependencies.uploads.settleAbort(
      userId,
      claimed.id,
      claimed.revision,
      finalState,
    );
    if (!settled) throw new UploadError('STALE_REVISION', 'Upload changed during cleanup');
    return status(userId, videoId, uploadId);
  };

  const cleanupExpired = async (userId: string, videoId: string, uploadId: string) => {
    const { upload } = await getContext(userId, videoId, uploadId);
    if (['aborted', 'expired', 'completed'].includes(upload.state))
      return status(userId, videoId, uploadId);
    if (upload.state !== 'abort_pending' && upload.expiresAt.getTime() > now().getTime())
      throw new UploadError('INVALID_UPLOAD_STATE', 'Upload has not expired');
    return abort(userId, videoId, uploadId, { revision: upload.revision }, 'expired');
  };

  const recoverStaleAwaitingIntent = async (userId: string, videoId: string) => {
    const rows = await dependencies.videos.findByIdForUser(userId, videoId);
    const video = rows[0];
    if (!video) throw new UploadError('RESOURCE_NOT_FOUND', 'Video was not found');
    if (video.state !== 'awaiting_upload') return video;
    if (
      video.createdAt.getTime() + dependencies.configuration.multipartUploadTtlSeconds * 1000 >
      now().getTime()
    )
      throw new UploadError('INVALID_UPLOAD_STATE', 'Video intent is not stale');
    const [failed] = await dependencies.videos.markFailed(
      userId,
      video.id,
      'awaiting_upload',
      video.revision,
      {
        failureCode: 'STALE_UPLOAD_INTENT',
        failureMessage: null,
      },
    );
    if (!failed) throw new UploadError('STALE_REVISION', 'Video intent changed during recovery');
    return failed;
  };

  const recoverPendingInitiations = async (limit = 100) => {
    const pending = await dependencies.uploads.listInitiationReconciliationRequired(limit);
    return Promise.all(
      pending.map((upload) => reconcileInitiation(upload.userId, upload.videoId, upload.id)),
    );
  };

  return {
    create,
    status,
    signParts,
    recordPart,
    abort,
    cleanupExpired,
    recoverStaleAwaitingIntent,
    recoverInitiation: reconcileInitiation,
    recoverPendingInitiations,
    complete,
  };
}
