import type { FastifyReply } from 'fastify';
import type { UploadErrorCode } from '@sovara-studio/contracts';
import { S3StorageError } from '@sovara-studio/infra';

const statusByCode: Record<UploadErrorCode, number> = {
  UNAUTHORIZED: 401,
  RESOURCE_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  UPLOAD_TOO_LARGE: 413,
  INVALID_PART: 400,
  INVALID_UPLOAD_STATE: 409,
  STALE_REVISION: 409,
  UPLOAD_EXPIRED: 410,
  SIGNING_RATE_LIMITED: 429,
  STORAGE_TEMPORARILY_UNAVAILABLE: 503,
  PROVIDER_CLEANUP_REQUIRED: 202,
  INTERNAL_ERROR: 500,
};

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(
    code: UploadErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UploadError';
    this.code = code;
    this.statusCode = statusByCode[code];
    this.retryable = options?.retryable ?? false;
  }
}

export function fromStorageError(error: S3StorageError) {
  return new UploadError(
    error.ambiguous ? 'PROVIDER_CLEANUP_REQUIRED' : 'STORAGE_TEMPORARILY_UNAVAILABLE',
    error.ambiguous
      ? 'Storage cleanup requires retry'
      : 'Storage provider is temporarily unavailable',
    { retryable: error.retryable, cause: error },
  );
}

export function toUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  if (error instanceof S3StorageError) return fromStorageError(error);
  return new UploadError('INTERNAL_ERROR', 'Upload operation failed', { cause: error });
}

export function sendUploadError(reply: FastifyReply, error: unknown, requestId?: string) {
  const normalized = toUploadError(error);
  return reply.code(normalized.statusCode).send({
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(requestId ? { requestId } : {}),
    },
  });
}
