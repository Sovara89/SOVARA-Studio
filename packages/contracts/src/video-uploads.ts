import { z } from 'zod';

const nonBlankText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);

export const createVideoUploadRequestSchema = z
  .object({
    originalFilename: nonBlankText(255),
    contentType: nonBlankText(255),
    expectedSizeBytes: z.number().int().positive().safe(),
  })
  .strict();

export const videoUploadParamsSchema = z
  .object({
    videoId: z.string().uuid(),
    uploadId: z.string().uuid(),
  })
  .strict();

export const videoIdParamsSchema = z.object({ videoId: z.string().uuid() }).strict();

export const partNumberParamsSchema = videoUploadParamsSchema.extend({
  partNumber: z.coerce.number().int().min(1).max(10_000),
});

export const uploadChecksumAlgorithmSchema = z.enum([
  'sha256',
  'sha1',
  'crc32',
  'crc32c',
  'crc64nvme',
]);

export const partUrlRequestSchema = z
  .object({
    partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(10_000),
  })
  .strict();

export const recordUploadPartRequestSchema = z
  .object({
    etag: nonBlankText(1024),
    reportedSizeBytes: z.number().int().positive().safe().optional(),
    providerChecksumAlgorithm: uploadChecksumAlgorithmSchema.optional(),
    providerChecksumValue: nonBlankText(1024).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.providerChecksumAlgorithm === undefined) ===
      (value.providerChecksumValue === undefined),
    { message: 'Checksum algorithm and value must be supplied together' },
  );

export const abortUploadRequestSchema = z
  .object({ revision: z.number().int().nonnegative() })
  .strict();

export const completeUploadRequestSchema = abortUploadRequestSchema;

export const uploadStateSchema = z.enum([
  'initiating',
  'initiation_reconciling',
  'active',
  'completing',
  'completed',
  'abort_pending',
  'aborted',
  'expired',
  'failed',
]);

export const uploadPartResponseSchema = z.object({
  partNumber: z.number().int(),
  etag: z.string(),
  reportedSizeBytes: z.number().int().nullable(),
  providerChecksumAlgorithm: z.string().nullable(),
  providerChecksumValue: z.string().nullable(),
  revision: z.number().int(),
});

export const uploadStatusResponseSchema = z.object({
  videoId: z.string().uuid(),
  uploadId: z.string().uuid(),
  state: uploadStateSchema,
  expectedSizeBytes: z.number().int(),
  partSizeBytes: z.number().int(),
  expectedPartCount: z.number().int(),
  expiresAt: z.string().datetime(),
  revision: z.number().int(),
  maxConcurrency: z.number().int(),
  parts: z.array(uploadPartResponseSchema),
});

export const createVideoUploadResponseSchema = z.object({
  videoId: z.string().uuid(),
  upload: uploadStatusResponseSchema.omit({ videoId: true, parts: true }).extend({
    uploadId: z.string().uuid(),
  }),
});

export const partUrlResponseSchema = z.object({
  uploadId: z.string().uuid(),
  uploadRevision: z.number().int(),
  expiresAt: z.string().datetime(),
  parts: z.array(
    z.object({
      partNumber: z.number().int(),
      url: z.string().url(),
      expiresAt: z.string().datetime(),
    }),
  ),
});

export const uploadErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'RESOURCE_NOT_FOUND',
  'INVALID_REQUEST',
  'UPLOAD_TOO_LARGE',
  'INVALID_PART',
  'INVALID_UPLOAD_STATE',
  'STALE_REVISION',
  'UPLOAD_EXPIRED',
  'SIGNING_RATE_LIMITED',
  'STORAGE_TEMPORARILY_UNAVAILABLE',
  'PROVIDER_CLEANUP_REQUIRED',
  'INTERNAL_ERROR',
]);

export const uploadErrorResponseSchema = z.object({
  error: z.object({
    code: uploadErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    requestId: z.string().optional(),
  }),
});

export const videoStateSchema = z.enum([
  'awaiting_upload',
  'uploading',
  'uploaded',
  'verifying',
  'ready',
  'invalid',
  'failed',
  'deletion_pending',
  'deleted',
]);

export const completeUploadResponseSchema = z.object({
  videoId: z.string().uuid(),
  uploadId: z.string().uuid(),
  uploadState: uploadStateSchema,
  uploadRevision: z.number().int().nonnegative(),
  videoState: videoStateSchema,
  videoRevision: z.number().int().nonnegative(),
  outcome: z.enum(['pending', 'ready', 'invalid', 'failed']),
  retryable: z.boolean(),
});

export type CreateVideoUploadRequest = z.infer<typeof createVideoUploadRequestSchema>;
export type VideoUploadParams = z.infer<typeof videoUploadParamsSchema>;
export type PartNumberParams = z.infer<typeof partNumberParamsSchema>;
export type PartUrlRequest = z.infer<typeof partUrlRequestSchema>;
export type RecordUploadPartRequest = z.infer<typeof recordUploadPartRequestSchema>;
export type UploadChecksumAlgorithm = z.infer<typeof uploadChecksumAlgorithmSchema>;
export type AbortUploadRequest = z.infer<typeof abortUploadRequestSchema>;
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;
export type UploadStatusResponse = z.infer<typeof uploadStatusResponseSchema>;
export type CreateVideoUploadResponse = z.infer<typeof createVideoUploadResponseSchema>;
export type PartUrlResponse = z.infer<typeof partUrlResponseSchema>;
export type UploadPartResponse = z.infer<typeof uploadPartResponseSchema>;
export type UploadErrorCode = z.infer<typeof uploadErrorCodeSchema>;
export type CompleteUploadResponse = z.infer<typeof completeUploadResponseSchema>;
