import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type {
  CapabilityOutcome,
  DefiniteProviderFailure,
  PublicationCapabilityContext,
  PublicationContext,
  ProviderEvidence,
  PublishOutcome,
  ReconcileOutcome,
  ReconciliationContext,
  RemotePublication,
  SafeProviderFailure,
  VKVideoPublisher,
} from './publication.js';
import {
  closePinnedHttpsResponse,
  PinnedHttpsError,
  postPinnedHttps,
  resolvePinnedHttpsTarget,
  TransportTeardownUnconfirmedError,
  type PinnedHttpsTarget,
  type ResolveHostname,
} from './pinned-https.js';

const VK_API_VERSION = '5.199';
const DEFAULT_API_BASE_URL = 'https://api.vk.com/method';
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const PROGRESS_BYTE_INTERVAL = 1024 * 1024;
const PROGRESS_TIME_INTERVAL_MS = 500;
const UPLOAD_ACCEPTED_EVIDENCE_PREFIX = 'vk-upload-accepted:v1';
const DEFAULT_CAPABILITY_TIMEOUT_MS = 10_000;
const DEFAULT_SAVE_TIMEOUT_MS = 15_000;
const DEFAULT_GET_TIMEOUT_MS = 15_000;
const DEFAULT_DNS_TIMEOUT_MS = 5_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RESPONSE_READ_TIMEOUT_MS = 15_000;
const ABORT_TEARDOWN_TIMEOUT_MS = 1_000;

type FetchLike = typeof fetch;

export type VKVideoPublisherOptions = {
  groupId: string;
  fetch?: FetchLike;
  apiBaseUrl?: string;
  maxResponseBytes?: number;
  boundaryFactory?: () => string;
  resolveHostname?: ResolveHostname;
  uploadTransport?: (input: {
    target: PinnedHttpsTarget;
    headers: Readonly<Record<string, string>>;
    body: Readable;
    signal: AbortSignal;
  }) => Promise<Response>;
  capabilityTimeoutMs?: number;
  saveTimeoutMs?: number;
  getTimeoutMs?: number;
  dnsTimeoutMs?: number;
  uploadTimeoutMs?: number;
  responseReadTimeoutMs?: number;
};

type ApiFailure = {
  kind: 'network' | 'http' | 'api' | 'malformed';
  status?: number;
  apiCode?: number;
  retryAfterMs?: number;
};

type ApiResult = { kind: 'success'; value: unknown } | { kind: 'failure'; failure: ApiFailure };

type VerificationResult =
  | { kind: 'published'; remote: RemotePublication }
  | { kind: 'pending'; failure: SafeProviderFailure }
  | { kind: 'owner_mismatch'; failure: SafeProviderFailure };

type Deadline = {
  signal: AbortSignal;
  timedOut: () => boolean;
  abort: (reason?: unknown) => void;
  dispose: () => void;
};

function deadline(parent: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error('VK_DEADLINE_EXCEEDED'));
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

function abortError() {
  const error = new Error('VK_OPERATION_ABORTED');
  error.name = 'AbortError';
  return error;
}

type Settlement<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

async function waitForBoundedTeardown(promise: Promise<unknown>, operation: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settlement = promise.then<{ status: 'fulfilled' }, { status: 'rejected'; reason: unknown }>(
    () => ({ status: 'fulfilled' }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
  const timeout = new Promise<{ status: 'timed_out' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed_out' }), ABORT_TEARDOWN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    let result = await Promise.race([settlement, timeout]);
    if (result.status === 'timed_out') {
      // The deadline is an escalation/error boundary, not evidence that teardown happened. Keep
      // the provider-facing promise pending until the owned operation actually settles so callers
      // can safely treat settlement as a quiescence boundary.
      const eventual = await settlement;
      result =
        eventual.status === 'fulfilled'
          ? { status: 'timed_out' }
          : { status: 'rejected', reason: eventual.reason };
    }
    if (result.status === 'fulfilled') return;
    if (result.status === 'rejected' && result.reason instanceof TransportTeardownUnconfirmedError)
      throw result.reason;
    throw new TransportTeardownUnconfirmedError(
      operation,
      result.status === 'rejected' ? { cause: result.reason } : undefined,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runTeardownSteps(
  steps: ReadonlyArray<() => void | Promise<unknown>>,
  operation: string,
): Promise<void> {
  const results = await Promise.allSettled(
    steps.map((step) => Promise.resolve().then(() => step())),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (!failed) return;
  if (failed.reason instanceof TransportTeardownUnconfirmedError) throw failed.reason;
  throw new TransportTeardownUnconfirmedError(operation, { cause: failed.reason });
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  cleanup: {
    abort?: () => void | Promise<void>;
    disposeResult?: (value: T) => void | Promise<void>;
  } = {},
): Promise<T> {
  const settlement = promise.then<Settlement<T>, Settlement<T>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
  const teardown = async () => {
    const abortCleanup = Promise.resolve().then(() => cleanup.abort?.());
    const operationCleanup = settlement.then(async (result) => {
      if (result.status === 'fulfilled') await cleanup.disposeResult?.(result.value);
    });
    await waitForBoundedTeardown(
      runTeardownSteps(
        [() => abortCleanup, () => operationCleanup],
        'VK aborted operation cleanup',
      ),
      'VK aborted operation',
    );
  };
  if (signal.aborted) {
    await teardown();
    throw abortError();
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<{ status: 'aborted' }>((resolve) => {
    abortListener = () => resolve({ status: 'aborted' });
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const result = await Promise.race([settlement, aborted]);
    if (result.status === 'aborted' || signal.aborted) {
      await teardown();
      throw abortError();
    }
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

async function cancelResponse(response: Response): Promise<void> {
  await waitForBoundedTeardown(
    runTeardownSteps(
      [() => response.body?.cancel(), () => closePinnedHttpsResponse(response)],
      'VK response cleanup',
    ),
    'VK response body',
  );
}

async function destroyReadable(stream: Readable): Promise<void> {
  if (stream.closed) return;
  let onClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
    stream.once('close', onClose);
  });
  try {
    stream.destroy();
    await waitForBoundedTeardown(closed, 'VK media stream');
  } catch (error) {
    if (error instanceof TransportTeardownUnconfirmedError) throw error;
    throw new TransportTeardownUnconfirmedError('VK media stream destruction', { cause: error });
  } finally {
    if (onClose) stream.removeListener('close', onClose);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalPositiveInteger(value: unknown, code: string): string {
  let candidate: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(code);
    candidate = String(value);
  } else if (typeof value === 'string') {
    candidate = value;
  } else {
    throw new Error(code);
  }
  if (!/^[1-9]\d*$/.test(candidate)) throw new Error(code);
  return candidate;
}

function canonicalOwnerId(value: unknown, code: string): string {
  let candidate: string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value === 0) throw new Error(code);
    candidate = String(value);
  } else if (typeof value === 'string') {
    candidate = value;
  } else {
    throw new Error(code);
  }
  if (!/^-?[1-9]\d*$/.test(candidate)) throw new Error(code);
  return candidate;
}

function validatedGroupId(value: string): string {
  const groupId = canonicalPositiveInteger(value, 'VK group ID is invalid');
  if (BigInt(groupId) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('VK group ID is invalid');
  return groupId;
}

function remoteVideo(ownerId: string, videoId: string): RemotePublication {
  return {
    remoteOwnerId: ownerId,
    remoteMediaId: videoId,
    remoteUrl: `https://vk.com/video${ownerId}_${videoId}`,
  };
}

function evidenceFor(remote: RemotePublication): ProviderEvidence {
  return {
    remoteOwnerId: remote.remoteOwnerId ?? undefined,
    remoteMediaId: remote.remoteMediaId,
    remoteUrl: remote.remoteUrl ?? undefined,
  };
}

function failure(
  classification:
    'ambiguous' | 'definite_retryable' | 'definite_terminal' | 'reauthorization_required',
  code: string,
  status?: number,
  retryAfterMs?: number,
): PublishOutcome {
  if (classification === 'ambiguous')
    return {
      kind: 'ambiguous',
      failure: {
        classification,
        code,
        ...(status !== undefined ? { status } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  return {
    kind: 'definite_failure',
    disposition:
      classification === 'definite_retryable'
        ? 'retryable'
        : classification === 'reauthorization_required'
          ? 'reauthorization_required'
          : 'terminal',
    failure: {
      classification,
      code,
      ...(status !== undefined ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
}

function ambiguousWithEvidence(
  code: string,
  remote: RemotePublication,
  status?: number,
  acceptedEvidence?: ProviderEvidence,
): Extract<PublishOutcome, { kind: 'ambiguous' }> {
  return {
    kind: 'ambiguous',
    failure: {
      classification: 'ambiguous',
      code,
      ...(status !== undefined ? { status } : {}),
    },
    evidence: acceptedEvidence ?? evidenceFor(remote),
  };
}

function safeFailure(
  classification: SafeProviderFailure['classification'],
  code: string,
  status?: number,
): SafeProviderFailure {
  return { classification, code, ...(status !== undefined ? { status } : {}) };
}

function capabilityFailure(
  classification: DefiniteProviderFailure['classification'],
  code: string,
  status?: number,
): CapabilityOutcome {
  return {
    kind: 'failure',
    failure: { classification, code, ...(status !== undefined ? { status } : {}) },
  };
}

async function boundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error('VK_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let completed = false;
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal, {
        abort: () => reader.cancel(abortError()),
      });
      if (part.done) {
        completed = true;
        break;
      }
      length += part.value.byteLength;
      if (length > maxBytes) {
        throw new Error('VK_RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      if (!completed)
        await waitForBoundedTeardown(reader.cancel(abortError()), 'VK response reader');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A non-cooperative custom stream may keep a read pending beyond bounded teardown.
      }
    }
  }
  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('VK_MALFORMED_RESPONSE');
  }
}

function apiErrorCode(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const code = value.error.error_code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
}

function validateApiBaseUrl(value: string): string {
  // OAuth credentials may only be sent to VK's exact documented method endpoint. Tests should
  // replace fetch, not redirect credential-bearing requests to a custom server.
  if (value !== DEFAULT_API_BASE_URL) throw new Error('VK API base URL is unsafe');
  return DEFAULT_API_BASE_URL;
}

function boundedRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return MAX_RETRY_AFTER_MS;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
}

function validateUploadUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192)
    throw new Error('VK_INVALID_UPLOAD_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VK_INVALID_UPLOAD_URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    !hostname ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )
    throw new Error('VK_INVALID_UPLOAD_URL');
  return url;
}

function validateMedia(context: PublicationContext): string | undefined {
  if (!context.media) return 'VK_MEDIA_REQUIRED';
  if (!Number.isSafeInteger(context.media.sizeBytes) || context.media.sizeBytes <= 0)
    return 'VK_INVALID_MEDIA_SIZE';
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(context.media.contentType))
    return 'VK_INVALID_MEDIA_CONTENT_TYPE';
  return undefined;
}

function multipartBody(input: {
  source: Readable;
  signal: AbortSignal;
  preamble: Buffer;
  closing: Buffer;
  expectedMediaBytes: number;
  reportProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void;
}) {
  const onAbort = () => input.source.destroy();
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener('abort', onAbort, { once: true });

  const stream = Readable.from(
    (async function* () {
      let mediaBytes = 0;
      let lastReportedBytes = 0;
      let lastReportedAt = 0;
      try {
        yield input.preamble;
        for await (const value of input.source) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
          mediaBytes += chunk.byteLength;
          if (mediaBytes > input.expectedMediaBytes) throw new Error('VK_MEDIA_SIZE_MISMATCH');
          yield chunk;
          const now = Date.now();
          if (
            input.reportProgress &&
            (lastReportedBytes === 0 ||
              mediaBytes === input.expectedMediaBytes ||
              mediaBytes - lastReportedBytes >= PROGRESS_BYTE_INTERVAL ||
              now - lastReportedAt >= PROGRESS_TIME_INTERVAL_MS)
          ) {
            try {
              input.reportProgress({
                uploadedBytes: mediaBytes,
                totalBytes: input.expectedMediaBytes,
              });
            } catch {
              // Progress is best-effort observability and must not alter publication integrity.
            }
            lastReportedBytes = mediaBytes;
            lastReportedAt = now;
          }
        }
        if (mediaBytes !== input.expectedMediaBytes) throw new Error('VK_MEDIA_SIZE_MISMATCH');
        yield input.closing;
      } finally {
        input.signal.removeEventListener('abort', onAbort);
        if (!input.source.destroyed) input.source.destroy();
      }
    })(),
  );
  stream.once('close', () => {
    input.signal.removeEventListener('abort', onAbort);
    if (!input.source.destroyed) input.source.destroy();
  });
  return stream;
}

function uploadAcceptedEvidence(
  remote: RemotePublication,
  authoritativeSize: number,
): ProviderEvidence {
  return {
    ...evidenceFor(remote),
    providerRequestId: `${UPLOAD_ACCEPTED_EVIDENCE_PREFIX}:${remote.remoteOwnerId}:${remote.remoteMediaId}:${authoritativeSize}`,
  };
}

function validateDurableUploadAcceptance(
  context: ReconciliationContext,
  ownerId: string,
  videoId: string,
): SafeProviderFailure | undefined {
  const marker = context.evidence.providerRequestId;
  if (marker === undefined) return safeFailure('ambiguous', 'VK_UPLOAD_ACCEPTANCE_UNEVIDENCED');
  const match = /^vk-upload-accepted:v1:(-[1-9]\d*):([1-9]\d*):([1-9]\d*)$/.exec(marker);
  if (!match) return safeFailure('definite_terminal', 'VK_UPLOAD_ACCEPTANCE_EVIDENCE_INVALID');
  const [, markerOwnerId, markerVideoId, markerSize] = match;
  if (markerOwnerId !== ownerId || markerVideoId !== videoId)
    return safeFailure('definite_terminal', 'VK_UPLOAD_ACCEPTANCE_EVIDENCE_MISMATCH');
  if (!context.media) return safeFailure('ambiguous', 'VK_UPLOAD_ACCEPTANCE_SIZE_UNAVAILABLE');
  if (
    !Number.isSafeInteger(context.media.sizeBytes) ||
    context.media.sizeBytes <= 0 ||
    markerSize !== String(context.media.sizeBytes)
  )
    return safeFailure('definite_terminal', 'VK_UPLOAD_ACCEPTANCE_SIZE_MISMATCH');
  return undefined;
}

function classifyDefiniteSaveFailure(result: ApiFailure): PublishOutcome {
  const authentication =
    result.status === 401 ||
    result.status === 403 ||
    (result.kind === 'api' && result.apiCode === 5);
  if (authentication)
    return failure('reauthorization_required', 'VK_SAVE_AUTHENTICATION', result.status);
  if (result.kind === 'http' && result.status === 408)
    return failure('ambiguous', 'VK_SAVE_STATUS_UNCERTAIN', result.status);
  if (result.kind === 'http' && result.status === 429)
    return failure('definite_retryable', 'VK_SAVE_THROTTLED', result.status, result.retryAfterMs);
  if (result.kind === 'api' && (result.apiCode === 6 || result.apiCode === 9))
    return failure('definite_retryable', `VK_SAVE_API_${result.apiCode}`);
  if (result.kind === 'http' && result.status !== undefined && result.status < 500)
    return failure('definite_terminal', 'VK_SAVE_REJECTED', result.status);
  if (result.kind === 'api')
    return failure('definite_terminal', `VK_SAVE_API_${result.apiCode ?? 'ERROR'}`);
  return failure(
    'ambiguous',
    result.kind === 'network'
      ? 'VK_SAVE_NETWORK'
      : result.kind === 'malformed'
        ? 'VK_SAVE_RESPONSE_MALFORMED'
        : 'VK_SAVE_STATUS_UNCERTAIN',
    result.status,
  );
}

export function createVKVideoPublisher(options: VKVideoPublisherOptions): VKVideoPublisher {
  const request = options.fetch ?? fetch;
  const apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const groupId = validatedGroupId(options.groupId);
  const expectedOwner = `-${groupId}`;
  const makeBoundary =
    options.boundaryFactory ?? (() => `sovara-vk-${randomBytes(18).toString('hex')}`);
  const timeouts = {
    capability: options.capabilityTimeoutMs ?? DEFAULT_CAPABILITY_TIMEOUT_MS,
    save: options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS,
    get: options.getTimeoutMs ?? DEFAULT_GET_TIMEOUT_MS,
    dns: options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    upload: options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS,
    responseRead: options.responseReadTimeoutMs ?? DEFAULT_RESPONSE_READ_TIMEOUT_MS,
  };
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1024 ||
    maxResponseBytes > 1024 * 1024
  )
    throw new Error('VK response limit is invalid');
  if (
    Object.values(timeouts).some(
      (value) => !Number.isSafeInteger(value) || value < 10 || value > 24 * 60 * 60 * 1000,
    )
  )
    throw new Error('VK timeout is invalid');

  const readResponse = async (response: Response, parent: AbortSignal) => {
    const readDeadline = deadline(parent, timeouts.responseRead);
    try {
      return await boundedJson(response, maxResponseBytes, readDeadline.signal);
    } finally {
      try {
        await cancelResponse(response);
      } finally {
        readDeadline.dispose();
      }
    }
  };

  const apiRequest = async (
    method: 'video.save' | 'video.get' | 'groups.getById',
    accessToken: string,
    params: Record<string, string>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<ApiResult> => {
    const form = new URLSearchParams({
      ...params,
      access_token: accessToken,
      v: VK_API_VERSION,
    }).toString();
    let response: Response;
    const requestDeadline = deadline(signal, timeoutMs);
    try {
      const pending = request(`${apiBaseUrl}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(form)),
        },
        body: form,
        redirect: 'manual',
        signal: requestDeadline.signal,
      });
      response = await abortable(pending, requestDeadline.signal, {
        disposeResult: cancelResponse,
      });
    } catch (error) {
      requestDeadline.abort(error);
      if (error instanceof TransportTeardownUnconfirmedError) throw error;
      return { kind: 'failure', failure: { kind: 'network' } };
    } finally {
      requestDeadline.dispose();
    }
    let value: unknown;
    try {
      value = await readResponse(response, signal);
    } catch (error) {
      if (error instanceof TransportTeardownUnconfirmedError) throw error;
      return {
        kind: 'failure',
        failure: {
          kind: response.ok ? 'malformed' : 'http',
          status: response.status,
          ...(response.status === 429 ? { retryAfterMs: boundedRetryAfter(response) } : {}),
        },
      };
    }
    const code = apiErrorCode(value);
    if (!response.ok)
      return {
        kind: 'failure',
        failure: {
          kind: 'http',
          status: response.status,
          ...(response.status === 429 ? { retryAfterMs: boundedRetryAfter(response) } : {}),
        },
      };
    if (code !== undefined) return { kind: 'failure', failure: { kind: 'api', apiCode: code } };
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'response'))
      return { kind: 'failure', failure: { kind: 'malformed', status: response.status } };
    return { kind: 'success', value: value.response };
  };

  const verifyOnce = async (
    accessToken: string,
    ownerId: string,
    videoId: string,
    signal: AbortSignal,
  ) =>
    apiRequest('video.get', accessToken, { videos: `${ownerId}_${videoId}` }, signal, timeouts.get);

  const capabilityPreflight = async (
    context: PublicationCapabilityContext,
  ): Promise<CapabilityOutcome> => {
    if (context.credential.platform !== 'vk')
      return capabilityFailure('definite_terminal', 'VK_CREDENTIAL_REQUIRED');
    if (!context.credential.scopes.includes('video'))
      return capabilityFailure('reauthorization_required', 'VK_VIDEO_SCOPE_REQUIRED');
    let accessToken: string;
    try {
      accessToken = await context.credential.getAccessToken();
    } catch {
      return capabilityFailure('reauthorization_required', 'VK_ACCESS_TOKEN_UNAVAILABLE');
    }
    const result = await apiRequest(
      'groups.getById',
      accessToken,
      { group_ids: groupId, fields: 'is_admin,admin_level,deactivated' },
      context.signal,
      timeouts.capability,
    );
    if (result.kind === 'failure') {
      const authentication =
        result.failure.status === 401 ||
        result.failure.status === 403 ||
        (result.failure.kind === 'api' && result.failure.apiCode === 5);
      if (authentication)
        return capabilityFailure(
          'reauthorization_required',
          'VK_CAPABILITY_AUTHENTICATION',
          result.failure.status,
        );
      const retryable =
        result.failure.kind === 'network' ||
        result.failure.kind === 'malformed' ||
        result.failure.status === 408 ||
        result.failure.status === 429 ||
        (result.failure.status !== undefined && result.failure.status >= 500) ||
        (result.failure.kind === 'api' &&
          (result.failure.apiCode === 6 ||
            result.failure.apiCode === 9 ||
            result.failure.apiCode === 10));
      return capabilityFailure(
        retryable ? 'definite_retryable' : 'definite_terminal',
        retryable ? 'VK_CAPABILITY_UNAVAILABLE' : 'VK_GROUP_CAPABILITY_DENIED',
        result.failure.status,
      );
    }
    const groups = Array.isArray(result.value)
      ? result.value
      : isRecord(result.value) && Array.isArray(result.value.groups)
        ? result.value.groups
        : undefined;
    if (!groups) return capabilityFailure('definite_retryable', 'VK_CAPABILITY_RESPONSE_MALFORMED');
    const exact = groups.find((candidate) => {
      if (!isRecord(candidate)) return false;
      try {
        return canonicalPositiveInteger(candidate.id, 'VK_INVALID_GROUP_ID') === groupId;
      } catch {
        return false;
      }
    });
    if (!isRecord(exact) || exact.deactivated !== undefined)
      return capabilityFailure('definite_terminal', 'VK_GROUP_UNAVAILABLE');
    const adminLevel = exact.admin_level;
    const canManageVideo =
      (exact.is_admin === 1 || exact.is_admin === true || exact.is_admin === '1') &&
      ((typeof adminLevel === 'number' && Number.isInteger(adminLevel) && adminLevel >= 2) ||
        adminLevel === 'editor' ||
        adminLevel === 'administrator');
    if (!canManageVideo)
      return capabilityFailure('definite_terminal', 'VK_GROUP_CAPABILITY_DENIED');
    return { kind: 'ready' };
  };

  const verifyVideo = async (
    context: Pick<ReconciliationContext, 'credential' | 'signal'>,
    initialAccessToken: string,
    ownerId: string,
    videoId: string,
  ): Promise<VerificationResult> => {
    let result = await verifyOnce(initialAccessToken, ownerId, videoId, context.signal);
    if (
      result.kind === 'failure' &&
      (result.failure.status === 401 ||
        result.failure.status === 403 ||
        (result.failure.kind === 'api' && result.failure.apiCode === 5))
    ) {
      try {
        const refreshed = await context.credential.getAccessToken({ forceRefresh: true });
        result = await verifyOnce(refreshed, ownerId, videoId, context.signal);
      } catch {
        return {
          kind: 'pending',
          failure: safeFailure('ambiguous', 'VK_VERIFY_AUTHENTICATION'),
        };
      }
    }
    if (result.kind === 'failure') {
      const code =
        result.failure.kind === 'network'
          ? 'VK_VERIFY_NETWORK'
          : result.failure.kind === 'malformed'
            ? 'VK_VERIFY_RESPONSE_MALFORMED'
            : result.failure.status === 401 ||
                result.failure.status === 403 ||
                result.failure.apiCode === 5
              ? 'VK_VERIFY_AUTHENTICATION'
              : result.failure.kind === 'api'
                ? `VK_VERIFY_API_${result.failure.apiCode ?? 'ERROR'}`
                : 'VK_VERIFY_REJECTED';
      return {
        kind: 'pending',
        failure: safeFailure('ambiguous', code, result.failure.status),
      };
    }
    if (!isRecord(result.value) || !Array.isArray(result.value.items))
      return {
        kind: 'pending',
        failure: safeFailure('ambiguous', 'VK_VERIFY_RESPONSE_MALFORMED'),
      };
    let ownerMismatch = false;
    for (const candidate of result.value.items) {
      if (!isRecord(candidate)) continue;
      let candidateOwner: string;
      let candidateVideo: string;
      try {
        candidateOwner = canonicalOwnerId(candidate.owner_id, 'VK_INVALID_OWNER_ID');
        candidateVideo = canonicalPositiveInteger(candidate.id, 'VK_INVALID_VIDEO_ID');
      } catch {
        continue;
      }
      if (candidateVideo === videoId && candidateOwner !== ownerId) ownerMismatch = true;
      if (candidateOwner !== ownerId || candidateVideo !== videoId) continue;
      const processing =
        candidate.processing === 1 ||
        candidate.processing === true ||
        candidate.processing === '1' ||
        candidate.converting === 1 ||
        candidate.converting === true ||
        candidate.converting === '1';
      if (processing)
        return {
          kind: 'pending',
          failure: safeFailure('ambiguous', 'VK_VIDEO_PROCESSING'),
        };
      return { kind: 'published', remote: remoteVideo(ownerId, videoId) };
    }
    if (ownerMismatch)
      return {
        kind: 'owner_mismatch',
        failure: safeFailure('definite_terminal', 'VK_OWNER_MISMATCH'),
      };
    return {
      kind: 'pending',
      failure: safeFailure('ambiguous', 'VK_VIDEO_NOT_VISIBLE'),
    };
  };

  const reconcile = async (context: ReconciliationContext): Promise<ReconcileOutcome> => {
    let ownerId: string;
    let videoId: string;
    try {
      canonicalPositiveInteger(
        context.credential.providerAccountId,
        'VK_INVALID_PROVIDER_ACCOUNT_ID',
      );
      ownerId = canonicalOwnerId(context.evidence.remoteOwnerId, 'VK_REMOTE_ID_UNAVAILABLE');
      videoId = canonicalPositiveInteger(
        context.evidence.remoteMediaId,
        'VK_REMOTE_ID_UNAVAILABLE',
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : 'VK_REMOTE_ID_UNAVAILABLE';
      return code === 'VK_REMOTE_ID_UNAVAILABLE'
        ? { kind: 'unresolved', failure: safeFailure('ambiguous', code) }
        : { kind: 'manual_review', failure: safeFailure('definite_terminal', code) };
    }
    if (ownerId !== expectedOwner)
      return {
        kind: 'manual_review',
        failure: safeFailure('definite_terminal', 'VK_OWNER_MISMATCH'),
      };
    const acceptanceFailure = validateDurableUploadAcceptance(context, ownerId, videoId);
    if (acceptanceFailure)
      return acceptanceFailure.classification === 'definite_terminal'
        ? { kind: 'manual_review', failure: acceptanceFailure }
        : { kind: 'unresolved', failure: acceptanceFailure };
    let accessToken: string;
    try {
      accessToken = await context.credential.getAccessToken();
    } catch {
      return {
        kind: 'unresolved',
        failure: safeFailure('ambiguous', 'VK_ACCESS_TOKEN_UNAVAILABLE'),
      };
    }
    const verified = await verifyVideo(context, accessToken, ownerId, videoId);
    if (verified.kind === 'published') return verified;
    if (verified.kind === 'owner_mismatch')
      return { kind: 'manual_review', failure: verified.failure };
    return { kind: 'unresolved', failure: verified.failure };
  };

  const publish = async (context: PublicationContext): Promise<PublishOutcome> => {
    if (context.credential.platform !== 'vk')
      return failure('definite_terminal', 'VK_CREDENTIAL_REQUIRED');
    const mediaError = validateMedia(context);
    if (mediaError) return failure('definite_terminal', mediaError);
    if (!context.credential.scopes.includes('video'))
      return failure('reauthorization_required', 'VK_VIDEO_SCOPE_REQUIRED');
    try {
      canonicalPositiveInteger(
        context.credential.providerAccountId,
        'VK_INVALID_PROVIDER_ACCOUNT_ID',
      );
    } catch (error) {
      return failure(
        'reauthorization_required',
        error instanceof Error ? error.message : 'VK_INVALID_PROVIDER_ACCOUNT_ID',
      );
    }

    if (Object.keys(context.evidence).length > 0) {
      const reconciled = await reconcile(context);
      if (reconciled.kind === 'published') return reconciled;
      return {
        kind: 'ambiguous',
        failure: {
          classification: 'ambiguous',
          code: reconciled.failure?.code ?? 'VK_ATTEMPT_REQUIRES_RECONCILIATION',
        },
        evidence: { ...context.evidence },
      };
    }

    let accessToken: string;
    try {
      // TASK-009 exposes the user OAuth access token through this generation-bound accessor.
      // VK ID tokens and the application service token never enter the publication contract.
      accessToken = await context.credential.getAccessToken();
    } catch {
      return failure('reauthorization_required', 'VK_ACCESS_TOKEN_UNAVAILABLE');
    }

    // This is the sole video.save call in a publication attempt. No auth refresh or retry may
    // repeat it: VK documents neither a resume operation nor an idempotency key for this flow.
    const saved = await apiRequest(
      'video.save',
      accessToken,
      { group_id: groupId, name: context.title, description: context.description ?? '' },
      context.signal,
      timeouts.save,
    );
    if (saved.kind === 'failure') return classifyDefiniteSaveFailure(saved.failure);
    if (!isRecord(saved.value)) return failure('ambiguous', 'VK_SAVE_RESPONSE_MALFORMED');

    let ownerId: string;
    let videoId: string;
    try {
      ownerId = canonicalOwnerId(saved.value.owner_id, 'VK_INVALID_OWNER_ID');
      videoId = canonicalPositiveInteger(saved.value.video_id, 'VK_INVALID_VIDEO_ID');
    } catch (error) {
      return failure('ambiguous', error instanceof Error ? error.message : 'VK_INVALID_SAVE_IDS');
    }
    const remote = remoteVideo(ownerId, videoId);
    let checkpointedVideoId: string | undefined;
    let uploadAccepted: ProviderEvidence | undefined;

    let uploadUrl: URL;
    try {
      uploadUrl = validateUploadUrl(saved.value.upload_url);
    } catch {
      await context.checkpointEvidence(evidenceFor(remote));
      return ambiguousWithEvidence('VK_INVALID_UPLOAD_URL', remote);
    }
    await context.checkpointEvidence(evidenceFor(remote));
    checkpointedVideoId = videoId;
    if (ownerId !== expectedOwner) return ambiguousWithEvidence('VK_OWNER_MISMATCH', remote);

    let uploadTarget: PinnedHttpsTarget;
    const dnsDeadline = deadline(context.signal, timeouts.dns);
    try {
      uploadTarget = await abortable(
        resolvePinnedHttpsTarget({
          url: uploadUrl,
          signal: dnsDeadline.signal,
          resolve: options.resolveHostname,
        }),
        dnsDeadline.signal,
      );
    } catch (error) {
      if (error instanceof TransportTeardownUnconfirmedError) throw error;
      const code = dnsDeadline.timedOut()
        ? 'VK_UPLOAD_DNS_TIMEOUT'
        : error instanceof PinnedHttpsError && error.code === 'DNS_UNSAFE'
          ? 'VK_UPLOAD_DNS_UNSAFE'
          : 'VK_UPLOAD_DNS_FAILED';
      return ambiguousWithEvidence(code, remote);
    } finally {
      dnsDeadline.dispose();
    }

    const boundary = makeBoundary();
    if (!/^[A-Za-z0-9-]{16,70}$/.test(boundary))
      return ambiguousWithEvidence('VK_INVALID_MULTIPART_BOUNDARY', remote);
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="video_file"; filename="video.mp4"\r\n' +
        `Content-Type: ${context.media.contentType}\r\n\r\n`,
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = preamble.byteLength + context.media.sizeBytes + closing.byteLength;
    if (!Number.isSafeInteger(contentLength))
      return ambiguousWithEvidence('VK_MULTIPART_SIZE_OVERFLOW', remote);

    const uploadDeadline = deadline(context.signal, timeouts.upload);
    let uploaded: Response;
    try {
      let source: Readable;
      try {
        source = await abortable(
          context.media.openReadStream({ signal: uploadDeadline.signal }),
          uploadDeadline.signal,
          { disposeResult: destroyReadable },
        );
      } catch (error) {
        if (error instanceof TransportTeardownUnconfirmedError) throw error;
        return ambiguousWithEvidence(
          uploadDeadline.timedOut() ? 'VK_UPLOAD_TIMEOUT' : 'VK_MEDIA_READ_FAILED',
          remote,
        );
      }
      const body = multipartBody({
        source,
        signal: uploadDeadline.signal,
        preamble,
        closing,
        expectedMediaBytes: context.media.sizeBytes,
        reportProgress: context.reportProgress,
      });
      let streamTeardownPromise: Promise<void> | undefined;
      const teardownStreams = () => {
        streamTeardownPromise ??= runTeardownSteps(
          [() => destroyReadable(body), () => destroyReadable(source)],
          'VK upload stream cleanup',
        );
        return streamTeardownPromise;
      };
      try {
        const headers = {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(contentLength),
        };
        const pending = options.uploadTransport
          ? options.uploadTransport({
              target: uploadTarget,
              headers,
              body,
              signal: uploadDeadline.signal,
            })
          : postPinnedHttps({
              target: uploadTarget,
              headers,
              body,
              signal: uploadDeadline.signal,
            });
        uploaded = await abortable(pending, uploadDeadline.signal, {
          abort: teardownStreams,
          disposeResult: cancelResponse,
        });
      } catch (error) {
        uploadDeadline.abort(error);
        const cleanup = await Promise.allSettled([teardownStreams()]);
        const cleanupFailure = cleanup.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (error instanceof TransportTeardownUnconfirmedError) throw error;
        if (cleanupFailure) {
          if (cleanupFailure.reason instanceof TransportTeardownUnconfirmedError)
            throw cleanupFailure.reason;
          throw new TransportTeardownUnconfirmedError('VK upload stream cleanup', {
            cause: cleanupFailure.reason,
          });
        }
        const code = uploadDeadline.timedOut() ? 'VK_UPLOAD_TIMEOUT' : 'VK_UPLOAD_NETWORK';
        return ambiguousWithEvidence(code, remote);
      }
      try {
        await teardownStreams();
      } catch (error) {
        // A transport response is a live resource even when local stream cleanup fails. Cancel it
        // before surfacing unconfirmed teardown; abortable's result disposer handles the abort race.
        await runTeardownSteps([() => cancelResponse(uploaded)], 'VK acquired upload response');
        throw error;
      }
    } finally {
      uploadDeadline.dispose();
    }
    if (!uploaded.ok) {
      await cancelResponse(uploaded);
      return ambiguousWithEvidence('VK_UPLOAD_REJECTED', remote, uploaded.status);
    }
    let uploadValue: unknown;
    try {
      uploadValue = await readResponse(uploaded, context.signal);
    } catch (error) {
      if (error instanceof TransportTeardownUnconfirmedError) throw error;
      return ambiguousWithEvidence('VK_UPLOAD_RESPONSE_MALFORMED', remote);
    }
    if (!isRecord(uploadValue) || Object.prototype.hasOwnProperty.call(uploadValue, 'error'))
      return ambiguousWithEvidence('VK_UPLOAD_RESPONSE_MALFORMED', remote);
    if (
      typeof uploadValue.video_id !== 'number' ||
      !Number.isSafeInteger(uploadValue.video_id) ||
      uploadValue.video_id <= 0 ||
      typeof uploadValue.size !== 'number' ||
      !Number.isSafeInteger(uploadValue.size) ||
      uploadValue.size <= 0
    )
      return ambiguousWithEvidence('VK_UPLOAD_RESPONSE_MALFORMED', remote);
    if (String(uploadValue.video_id) !== checkpointedVideoId)
      return ambiguousWithEvidence('VK_UPLOAD_VIDEO_MISMATCH', remote);
    if (uploadValue.size !== context.media.sizeBytes)
      return ambiguousWithEvidence('VK_UPLOAD_SIZE_MISMATCH', remote);

    uploadAccepted = uploadAcceptedEvidence(remote, context.media.sizeBytes);
    await context.checkpointEvidence(uploadAccepted);
    if (!uploadAccepted) return ambiguousWithEvidence('VK_UPLOAD_ACCEPTANCE_UNEVIDENCED', remote);
    const verified = await verifyVideo(context, accessToken, ownerId, videoId);
    if (verified.kind === 'published') return verified;
    return ambiguousWithEvidence(
      verified.failure.code,
      remote,
      verified.failure.status,
      uploadAccepted,
    );
  };

  return { platform: 'vk', capabilityPreflight, publish, reconcile };
}
