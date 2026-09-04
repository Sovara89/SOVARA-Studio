import * as contracts from '@sovara-studio/contracts';
import type {
  CreateVideoUploadRequest,
  PartUrlRequest,
  RecordUploadPartRequest,
  UploadErrorCode,
} from '@sovara-studio/contracts';
import { apiBaseUrl } from '../env';
import { notifyUnauthorized } from './auth-client';

export class UploadApiError extends Error {
  constructor(
    readonly code: UploadErrorCode | 'HTTP_ERROR',
    readonly status: number,
    message: string,
    readonly retryable = false,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'UploadApiError';
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function errorFromResponse(status: number, body: unknown) {
  const parsed = contracts.uploadErrorResponseSchema.safeParse(body);
  if (parsed.success) {
    return new UploadApiError(
      parsed.data.error.code,
      status,
      parsed.data.error.message,
      parsed.data.error.retryable,
      parsed.data.error.requestId,
    );
  }
  return new UploadApiError('HTTP_ERROR', status, `Studio API request failed (${status})`);
}

export function createUploadApi(
  options: { baseUrl?: string; fetchImpl?: typeof fetch; headers?: HeadersInit } = {},
) {
  const baseUrl = options.baseUrl ?? apiBaseUrl;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    createUpload(input: CreateVideoUploadRequest) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        '/videos',
        contracts.createVideoUploadResponseSchema,
        { method: 'POST', body: JSON.stringify(input) },
        [201],
      );
    },
    signParts(videoId: string, uploadId: string, input: PartUrlRequest) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        `/videos/${videoId}/uploads/${uploadId}/part-urls`,
        contracts.partUrlResponseSchema,
        { method: 'POST', body: JSON.stringify(input) },
      );
    },
    recordPart(
      videoId: string,
      uploadId: string,
      partNumber: number,
      input: RecordUploadPartRequest,
    ) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        `/videos/${videoId}/uploads/${uploadId}/parts/${partNumber}`,
        schemaForRecord,
        { method: 'PUT', body: JSON.stringify(input) },
      );
    },
    getStatus(videoId: string, uploadId: string) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        `/videos/${videoId}/uploads/${uploadId}`,
        contracts.uploadStatusResponseSchema,
        { method: 'GET', headers: {} },
      );
    },
    abort(videoId: string, uploadId: string, revision: number) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        `/videos/${videoId}/uploads/${uploadId}/abort`,
        contracts.uploadStatusResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify(contracts.abortUploadRequestSchema.parse({ revision })),
        },
        [200],
      );
    },
    complete(videoId: string, uploadId: string, revision: number) {
      return requestWithOptions(
        baseUrl,
        fetchImpl,
        options.headers,
        `/videos/${videoId}/uploads/${uploadId}/complete`,
        contracts.completeUploadResponseSchema,
        {
          method: 'POST',
          body: JSON.stringify(contracts.completeUploadRequestSchema.parse({ revision })),
        },
        [200, 202],
      );
    },
  };
}

async function requestWithOptions<T>(
  baseUrl: string,
  fetchImpl: typeof fetch,
  extraHeaders: HeadersInit | undefined,
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit,
  acceptedStatuses = [200],
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(extraHeaders ?? {}),
      ...(init.headers ?? {}),
    },
  });
  notifyUnauthorized(response);
  const body = await readJson(response);
  if (!acceptedStatuses.includes(response.status)) throw errorFromResponse(response.status, body);
  try {
    return schema.parse(body);
  } catch {
    throw new UploadApiError(
      'HTTP_ERROR',
      response.status,
      'Studio API returned an invalid response',
    );
  }
}

const schemaForRecord = contracts.uploadPartResponseSchema;

export type UploadApi = ReturnType<typeof createUploadApi>;
