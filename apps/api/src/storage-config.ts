import { z } from 'zod';

export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const S3_MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
export const S3_MAX_PART_COUNT = 10_000;
export const S3_MAX_OBJECT_SIZE_BYTES = 5 * 1024 ** 4;
export const PART_SIZE_ROUNDING_BYTES = 1024 * 1024;

const positiveInteger = z.coerce.number().int().positive().safe();
const optionalString = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value : undefined));

const RawStorageEnvironmentSchema = z.object({
  S3_ENDPOINT: optionalString.pipe(z.string().url().optional()),
  S3_PRESIGN_ENDPOINT: optionalString.pipe(z.string().url().optional()),
  S3_REGION: z.string().min(1).max(128).default('us-east-1'),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_BUCKET: z.string().min(1).max(255),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  S3_PRESIGNED_PART_TTL_SECONDS: positiveInteger.pipe(z.number().max(604_800)),
  S3_MULTIPART_UPLOAD_TTL_SECONDS: positiveInteger.pipe(z.number().max(604_800)),
  UPLOAD_MAX_SIZE_BYTES: positiveInteger,
  UPLOAD_MIN_PART_SIZE_BYTES: positiveInteger,
  UPLOAD_PREFERRED_PART_SIZE_BYTES: positiveInteger,
  UPLOAD_TARGET_MAX_PARTS: positiveInteger.pipe(z.number().max(S3_MAX_PART_COUNT)),
  UPLOAD_SIGN_BATCH_MAX: positiveInteger.pipe(z.number().max(100)),
  UPLOAD_MAX_CONCURRENCY: positiveInteger.pipe(z.number().max(64)),
  UPLOAD_SIGN_RATE_LIMIT_PER_MINUTE: positiveInteger.pipe(z.number().max(10_000)),
  S3_CONTROL_REQUEST_TIMEOUT_MS: positiveInteger.default(30_000),
  UPLOAD_COMPLETION_AMBIGUITY_GRACE_MS: positiveInteger.default(60_000),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().min(1).default('mp4,mov,m4v,webm,mkv,avi'),
  UPLOAD_ALLOWED_CONTENT_TYPES: z
    .string()
    .min(1)
    .default(
      'video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,application/octet-stream',
    ),
});

export type MultipartPlan = {
  partSizeBytes: number;
  expectedPartCount: number;
};

export type StorageConfiguration = {
  s3: {
    endpoint?: string;
    presignEndpoint?: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket: string;
    forcePathStyle: boolean;
  };
  presignedPartTtlSeconds: number;
  multipartUploadTtlSeconds: number;
  uploadMaxSizeBytes: number;
  uploadMinPartSizeBytes: number;
  uploadPreferredPartSizeBytes: number;
  uploadTargetMaxParts: number;
  uploadSignBatchMax: number;
  uploadMaxConcurrency: number;
  uploadSignRateLimitPerMinute: number;
  s3ControlRequestTimeoutMs: number;
  uploadCompletionAmbiguityGraceMs: number;
  uploadAllowedExtensions: readonly string[];
  uploadAllowedContentTypes: readonly string[];
};

function parseConfiguredList(value: string, name: string) {
  const values = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()))];
  if (values.some((item) => item.length === 0)) throw new Error(`${name} contains an empty value`);
  return values;
}

export function calculateMultipartPlan(
  expectedSizeBytes: number,
  configuration: Pick<
    StorageConfiguration,
    | 'uploadMaxSizeBytes'
    | 'uploadMinPartSizeBytes'
    | 'uploadPreferredPartSizeBytes'
    | 'uploadTargetMaxParts'
  >,
): MultipartPlan {
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0)
    throw new Error('Expected file size must be a positive safe integer');
  if (expectedSizeBytes > configuration.uploadMaxSizeBytes)
    throw new Error('Expected file size exceeds configured maximum');
  const effectiveMinimum = Math.max(S3_MIN_PART_SIZE_BYTES, configuration.uploadMinPartSizeBytes);
  const targetRequirement = Math.ceil(expectedSizeBytes / configuration.uploadTargetMaxParts);
  const hardRequirement = Math.ceil(expectedSizeBytes / S3_MAX_PART_COUNT);
  const rawPartSize = Math.max(
    effectiveMinimum,
    configuration.uploadPreferredPartSizeBytes,
    targetRequirement,
    hardRequirement,
  );
  const partSizeBytes =
    Math.ceil(rawPartSize / PART_SIZE_ROUNDING_BYTES) * PART_SIZE_ROUNDING_BYTES;
  if (partSizeBytes > S3_MAX_PART_SIZE_BYTES)
    throw new Error('Configured multipart policy cannot satisfy S3 part limits');
  const expectedPartCount = Math.ceil(expectedSizeBytes / partSizeBytes);
  if (expectedPartCount < 1 || expectedPartCount > S3_MAX_PART_COUNT)
    throw new Error('Configured multipart policy cannot satisfy S3 part count limits');
  return { partSizeBytes, expectedPartCount };
}

export function expectedPartSize(
  expectedSizeBytes: number,
  partSizeBytes: number,
  expectedPartCount: number,
  partNumber: number,
) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedPartCount)
    throw new Error('Part number is outside the expected upload range');
  if (partNumber < expectedPartCount) return partSizeBytes;
  return expectedSizeBytes - partSizeBytes * (expectedPartCount - 1);
}

export function parseStorageConfiguration(
  environment: Record<string, string | undefined> = process.env,
): StorageConfiguration {
  const raw = RawStorageEnvironmentSchema.parse(environment);
  if ((raw.S3_ACCESS_KEY_ID === undefined) !== (raw.S3_SECRET_ACCESS_KEY === undefined))
    throw new Error('S3 access key and secret key must be supplied together');
  if (raw.UPLOAD_MIN_PART_SIZE_BYTES > S3_MAX_PART_SIZE_BYTES)
    throw new Error('Configured minimum part size exceeds S3 maximum');
  if (raw.UPLOAD_PREFERRED_PART_SIZE_BYTES > S3_MAX_PART_SIZE_BYTES)
    throw new Error('Configured preferred part size exceeds S3 maximum');
  if (raw.UPLOAD_MAX_SIZE_BYTES > S3_MAX_OBJECT_SIZE_BYTES)
    throw new Error('Configured maximum upload size exceeds S3 maximum object size');
  if (raw.UPLOAD_COMPLETION_AMBIGUITY_GRACE_MS <= raw.S3_CONTROL_REQUEST_TIMEOUT_MS)
    throw new Error('Completion ambiguity grace must exceed the S3 control request timeout');
  if (raw.UPLOAD_TARGET_MAX_PARTS < 1)
    throw new Error('Configured target part count must be positive');
  calculateMultipartPlan(raw.UPLOAD_MAX_SIZE_BYTES, {
    uploadMaxSizeBytes: raw.UPLOAD_MAX_SIZE_BYTES,
    uploadMinPartSizeBytes: raw.UPLOAD_MIN_PART_SIZE_BYTES,
    uploadPreferredPartSizeBytes: raw.UPLOAD_PREFERRED_PART_SIZE_BYTES,
    uploadTargetMaxParts: raw.UPLOAD_TARGET_MAX_PARTS,
  });
  const uploadAllowedExtensions = parseConfiguredList(
    raw.UPLOAD_ALLOWED_EXTENSIONS,
    'UPLOAD_ALLOWED_EXTENSIONS',
  ).map((extension) => extension.replace(/^\./, ''));
  if (uploadAllowedExtensions.some((extension) => extension.length === 0))
    throw new Error('UPLOAD_ALLOWED_EXTENSIONS contains an invalid value');
  return {
    s3: {
      endpoint: raw.S3_ENDPOINT,
      presignEndpoint: raw.S3_PRESIGN_ENDPOINT,
      region: raw.S3_REGION,
      accessKeyId: raw.S3_ACCESS_KEY_ID,
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
      bucket: raw.S3_BUCKET,
      forcePathStyle: raw.S3_FORCE_PATH_STYLE,
    },
    presignedPartTtlSeconds: raw.S3_PRESIGNED_PART_TTL_SECONDS,
    multipartUploadTtlSeconds: raw.S3_MULTIPART_UPLOAD_TTL_SECONDS,
    uploadMaxSizeBytes: raw.UPLOAD_MAX_SIZE_BYTES,
    uploadMinPartSizeBytes: raw.UPLOAD_MIN_PART_SIZE_BYTES,
    uploadPreferredPartSizeBytes: raw.UPLOAD_PREFERRED_PART_SIZE_BYTES,
    uploadTargetMaxParts: raw.UPLOAD_TARGET_MAX_PARTS,
    uploadSignBatchMax: raw.UPLOAD_SIGN_BATCH_MAX,
    uploadMaxConcurrency: raw.UPLOAD_MAX_CONCURRENCY,
    uploadSignRateLimitPerMinute: raw.UPLOAD_SIGN_RATE_LIMIT_PER_MINUTE,
    s3ControlRequestTimeoutMs: raw.S3_CONTROL_REQUEST_TIMEOUT_MS,
    uploadCompletionAmbiguityGraceMs: raw.UPLOAD_COMPLETION_AMBIGUITY_GRACE_MS,
    uploadAllowedExtensions,
    uploadAllowedContentTypes: parseConfiguredList(
      raw.UPLOAD_ALLOWED_CONTENT_TYPES,
      'UPLOAD_ALLOWED_CONTENT_TYPES',
    ),
  };
}
