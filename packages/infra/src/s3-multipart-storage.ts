import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type MultipartStorageConfig = {
  bucket: string;
  controlRequestTimeoutMs?: number;
};

export type CreateProviderMultipartInput = {
  objectKey: string;
  contentType: string;
};

export type PresignProviderPartInput = {
  objectKey: string;
  providerUploadId: string;
  partNumber: number;
  expiresInSeconds: number;
};

export type AbortProviderMultipartInput = {
  objectKey: string;
  providerUploadId: string;
};

export type InspectProviderMultipartInput = AbortProviderMultipartInput;
export type ProviderMultipartPart = { partNumber: number; etag: string; sizeBytes: number };
export type ProviderMultipartInspection = { parts: ProviderMultipartPart[] } | 'absent';
export type CompleteProviderMultipartInput = AbortProviderMultipartInput & {
  parts: readonly ProviderMultipartPart[];
};
export type ProviderCompletionResult = {
  etag: string | null;
  versionId: string | null;
  checksumAlgorithm: string | null;
  checksumValue: string | null;
};
export type ProviderObjectMetadata = {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  versionId: string | null;
  checksumAlgorithm: string | null;
  checksumValue: string | null;
};

function fullObjectChecksum(response: {
  ChecksumType?: string;
  ChecksumCRC32?: string;
  ChecksumCRC32C?: string;
  ChecksumCRC64NVME?: string;
  ChecksumSHA1?: string;
  ChecksumSHA256?: string;
}) {
  if (response.ChecksumType && response.ChecksumType !== 'FULL_OBJECT') return null;
  if (response.ChecksumCRC64NVME)
    return { checksumAlgorithm: 'crc64nvme', checksumValue: response.ChecksumCRC64NVME };
  if (response.ChecksumCRC32C)
    return { checksumAlgorithm: 'crc32c', checksumValue: response.ChecksumCRC32C };
  if (response.ChecksumCRC32)
    return { checksumAlgorithm: 'crc32', checksumValue: response.ChecksumCRC32 };
  if (response.ChecksumSHA256)
    return { checksumAlgorithm: 'sha256', checksumValue: response.ChecksumSHA256 };
  if (response.ChecksumSHA1)
    return { checksumAlgorithm: 'sha1', checksumValue: response.ChecksumSHA1 };
  return null;
}

export type ProviderAbortResult = 'aborted' | 'already_absent';

export type MultipartStorage = {
  createMultipartUpload(input: CreateProviderMultipartInput): Promise<{ providerUploadId: string }>;
  presignUploadPart(input: PresignProviderPartInput): Promise<string>;
  abortMultipartUpload(input: AbortProviderMultipartInput): Promise<ProviderAbortResult>;
  inspectMultipartUpload(
    input: InspectProviderMultipartInput,
  ): Promise<ProviderMultipartInspection>;
  completeMultipartUpload(input: CompleteProviderMultipartInput): Promise<ProviderCompletionResult>;
  headObject(objectKey: string): Promise<ProviderObjectMetadata | 'absent'>;
  reconcileUntrackedExactKey(objectKey: string): Promise<'cleaned' | 'pending'>;
};

export type S3ErrorInfo = {
  providerCode?: string;
  statusCode?: number;
  retryable: boolean;
  ambiguous: boolean;
};

export class S3StorageError extends Error {
  readonly providerCode?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(message: string, info: S3ErrorInfo, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'S3StorageError';
    this.providerCode = info.providerCode;
    this.statusCode = info.statusCode;
    this.retryable = info.retryable;
    this.ambiguous = info.ambiguous;
  }
}

function getErrorProperty(error: unknown, property: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return property in error ? error[property as keyof typeof error] : undefined;
}

export function normalizeS3Error(operation: string, error: unknown): S3StorageError {
  const providerCode = getErrorProperty(error, 'name');
  const metadata = getErrorProperty(error, '$metadata');
  const statusCode =
    typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata
      ? Number(metadata.httpStatusCode)
      : undefined;
  const code = typeof providerCode === 'string' ? providerCode : undefined;
  const definiteClientFailure = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
  const retryable = !definiteClientFailure || statusCode === 408 || statusCode === 429;
  const ambiguous = retryable;
  return new S3StorageError(
    `S3 ${operation} failed`,
    {
      providerCode: code,
      statusCode,
      retryable,
      ambiguous,
    },
    { cause: error },
  );
}

function isNoSuchUpload(error: unknown) {
  return (
    getErrorProperty(error, 'name') === 'NoSuchUpload' ||
    getErrorProperty(error, 'Code') === 'NoSuchUpload'
  );
}

export function createS3MultipartStorage(
  client: S3Client,
  config: MultipartStorageConfig,
  presignClient: S3Client = client,
  controlRequestTimeoutMs = config.controlRequestTimeoutMs ?? 30_000,
): MultipartStorage {
  const send = async <T>(command: T) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), controlRequestTimeoutMs);
    try {
      return await client.send(command as never, { abortSignal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const create = async (input: CreateProviderMultipartInput) => {
    try {
      const response = (await send(
        new CreateMultipartUploadCommand({
          Bucket: config.bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
        }),
      )) as { UploadId?: string };
      if (!response.UploadId) {
        throw new S3StorageError('S3 CreateMultipartUpload returned no upload ID', {
          retryable: false,
          ambiguous: true,
        });
      }
      return { providerUploadId: response.UploadId };
    } catch (error) {
      if (error instanceof S3StorageError) throw error;
      throw normalizeS3Error('CreateMultipartUpload', error);
    }
  };

  const presign = async (input: PresignProviderPartInput) => {
    try {
      return await getSignedUrl(
        presignClient,
        new UploadPartCommand({
          Bucket: config.bucket,
          Key: input.objectKey,
          UploadId: input.providerUploadId,
          PartNumber: input.partNumber,
        }),
        { expiresIn: input.expiresInSeconds },
      );
    } catch (error) {
      throw normalizeS3Error('presign UploadPart', error);
    }
  };

  const abort = async (input: AbortProviderMultipartInput): Promise<ProviderAbortResult> => {
    try {
      await send(
        new AbortMultipartUploadCommand({
          Bucket: config.bucket,
          Key: input.objectKey,
          UploadId: input.providerUploadId,
        }),
      );
      return 'aborted';
    } catch (error) {
      if (isNoSuchUpload(error)) return 'already_absent';
      throw normalizeS3Error('AbortMultipartUpload', error);
    }
  };

  const inspect = async ({ objectKey, providerUploadId }: InspectProviderMultipartInput) => {
    const parts: ProviderMultipartPart[] = [];
    let partNumberMarker: string | undefined;
    do {
      try {
        const response = (await send(
          new ListPartsCommand({
            Bucket: config.bucket,
            Key: objectKey,
            UploadId: providerUploadId,
            PartNumberMarker: partNumberMarker,
          }),
        )) as {
          Parts?: Array<{ PartNumber?: number; ETag?: string; Size?: number }>;
          IsTruncated?: boolean;
          NextPartNumberMarker?: string;
        };
        for (const part of response.Parts ?? []) {
          if (part.PartNumber === undefined || part.ETag === undefined || part.Size === undefined)
            throw new S3StorageError('S3 ListParts returned incomplete part metadata', {
              retryable: false,
              ambiguous: false,
            });
          parts.push({ partNumber: part.PartNumber, etag: part.ETag, sizeBytes: part.Size });
        }
        if (!response.IsTruncated) break;
        partNumberMarker = response.NextPartNumberMarker;
      } catch (error) {
        if (isNoSuchUpload(error)) return 'absent' as const;
        if (error instanceof S3StorageError) throw error;
        throw normalizeS3Error('ListParts', error);
      }
    } while (partNumberMarker !== undefined);
    return { parts };
  };

  const complete = async ({
    objectKey,
    providerUploadId,
    parts,
  }: CompleteProviderMultipartInput) => {
    try {
      const response = (await send(
        new CompleteMultipartUploadCommand({
          Bucket: config.bucket,
          Key: objectKey,
          UploadId: providerUploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      )) as {
        ETag?: string;
        VersionId?: string;
        ChecksumType?: string;
        ChecksumCRC32C?: string;
        ChecksumCRC32?: string;
        ChecksumCRC64NVME?: string;
        ChecksumSHA1?: string;
        ChecksumSHA256?: string;
      };
      const checksum = fullObjectChecksum(response);
      return {
        etag: response.ETag ?? null,
        versionId: response.VersionId ?? null,
        checksumAlgorithm: checksum?.checksumAlgorithm ?? null,
        checksumValue: checksum?.checksumValue ?? null,
      };
    } catch (error) {
      if (error instanceof S3StorageError) throw error;
      if (isNoSuchUpload(error))
        throw new S3StorageError('S3 CompleteMultipartUpload outcome is ambiguous', {
          providerCode: 'NoSuchUpload',
          statusCode: 404,
          retryable: false,
          ambiguous: true,
        });
      throw normalizeS3Error('CompleteMultipartUpload', error);
    }
  };

  const head = async (objectKey: string) => {
    try {
      const response = (await send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey, ChecksumMode: 'ENABLED' }),
      )) as {
        ContentLength?: number;
        ContentType?: string;
        ETag?: string;
        VersionId?: string;
        ChecksumType?: string;
        ChecksumCRC32C?: string;
        ChecksumCRC32?: string;
        ChecksumCRC64NVME?: string;
        ChecksumSHA1?: string;
        ChecksumSHA256?: string;
      };
      const checksum = fullObjectChecksum(response);
      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
        versionId: response.VersionId ?? null,
        checksumAlgorithm: checksum?.checksumAlgorithm ?? null,
        checksumValue: checksum?.checksumValue ?? null,
      };
    } catch (error) {
      const name = getErrorProperty(error, 'name');
      if (name === 'NotFound' || name === 'NoSuchKey') return 'absent' as const;
      if (error instanceof S3StorageError) throw error;
      throw normalizeS3Error('HeadObject', error);
    }
  };

  const listExactKey = async (objectKey: string) => {
    const uploadIds: string[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      try {
        const response = (await send(
          new ListMultipartUploadsCommand({
            Bucket: config.bucket,
            Prefix: objectKey,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        )) as {
          Uploads?: Array<{ Key?: string; UploadId?: string }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextUploadIdMarker?: string;
        };
        for (const upload of response.Uploads ?? []) {
          if (upload.Key === objectKey && upload.UploadId) uploadIds.push(upload.UploadId);
        }
        if (!response.IsTruncated) break;
        keyMarker = response.NextKeyMarker;
        uploadIdMarker = response.NextUploadIdMarker;
      } catch (error) {
        throw normalizeS3Error('ListMultipartUploads', error);
      }
    } while (keyMarker !== undefined || uploadIdMarker !== undefined);
    return uploadIds;
  };

  return {
    createMultipartUpload: create,
    presignUploadPart: presign,
    abortMultipartUpload: abort,
    inspectMultipartUpload: inspect,
    completeMultipartUpload: complete,
    headObject: head,
    reconcileUntrackedExactKey: async (objectKey) => {
      const uploadIds = await listExactKey(objectKey);
      if (uploadIds.length === 0) return 'pending';
      for (const providerUploadId of uploadIds) {
        await abort({ objectKey, providerUploadId });
      }
      const remainingUploadIds = await listExactKey(objectKey);
      return remainingUploadIds.length === 0 ? 'cleaned' : 'pending';
    },
  };
}
