import { Readable } from 'node:stream';
import type {
  PublicationContext,
  PublishOutcome,
  ReconcileOutcome,
  ReconciliationContext,
  YouTubePublisher,
} from './publication.js';

type FetchLike = typeof fetch;

export type YouTubePublisherOptions = {
  fetch?: FetchLike;
  uploadEndpoint?: string;
  apiBaseUrl?: string;
  chunkSizeBytes?: number;
  maxStatusProbes?: number;
  maxSessionAuthRefreshes?: number;
};

type MutationPhase =
  | 'pre_initiation'
  | 'initiation_sent'
  | 'session_established'
  | 'uploading'
  | 'completion_received';

type YoutubeVideo = {
  id?: unknown;
  snippet?: { channelId?: unknown };
};

class YouTubeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly phase: 'initiation' | 'upload' | 'probe' | 'verification',
  ) {
    super(`YouTube request failed (${status}, ${code})`);
    this.name = 'YouTubeHttpError';
  }
}

class YouTubeNetworkError extends Error {
  constructor(readonly phase: 'initiation' | 'upload' | 'probe' | 'verification') {
    super(`YouTube ${phase} request was not completed`);
    this.name = 'YouTubeNetworkError';
  }
}

async function destroyReadable(stream: Readable): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve, reject) => {
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    stream.once('close', onClose);
    stream.once('error', onError);
    stream.destroy();
    if (stream.closed) onClose();
  });
}

class YouTubeOperation {
  readonly controller = new AbortController();
  readonly responses = new Set<Response>();
  readonly streams = new Set<Readable>();
  readonly #parent: AbortSignal;
  readonly #onParentAbort: () => void;

  constructor(parent: AbortSignal) {
    this.#parent = parent;
    this.#onParentAbort = () => this.controller.abort(parent.reason);
    if (parent.aborted) this.#onParentAbort();
    else parent.addEventListener('abort', this.#onParentAbort, { once: true });
  }

  get signal() {
    return this.controller.signal;
  }

  own(response: Response): Response;
  own(stream: Readable): Readable;
  own(resource: Response | Readable) {
    if (resource instanceof Readable) this.streams.add(resource);
    else this.responses.add(resource);
    return resource;
  }

  async release(response: Response) {
    try {
      if (response.body && !response.bodyUsed) await response.body.cancel();
    } finally {
      this.responses.delete(response);
    }
  }

  async releaseStream(stream: Readable) {
    try {
      await destroyReadable(stream);
    } finally {
      this.streams.delete(stream);
    }
  }

  async close() {
    this.#parent.removeEventListener('abort', this.#onParentAbort);
    this.controller.abort(new Error('YouTube operation completed'));
    const results = await Promise.allSettled([
      ...[...this.responses].map((response) => this.release(response)),
      ...[...this.streams].map((stream) => this.releaseStream(stream)),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0)
      throw new AggregateError(failures, 'YouTube operation teardown failed');
  }
}

async function runYouTubeOperation<T>(
  parentSignal: AbortSignal,
  operation: (owned: YouTubeOperation) => Promise<T>,
): Promise<T> {
  const owned = new YouTubeOperation(parentSignal);
  try {
    return await operation(owned);
  } finally {
    await owned.close();
  }
}

function errorCode(value: unknown) {
  if (!value || typeof value !== 'object') return 'provider_error';
  const error = value as { error?: unknown; errors?: unknown };
  if (typeof error.error === 'string') return error.error;
  if (Array.isArray(error.errors)) {
    const first = error.errors[0];
    if (
      first &&
      typeof first === 'object' &&
      typeof (first as { reason?: unknown }).reason === 'string'
    )
      return (first as { reason: string }).reason;
  }
  return 'provider_error';
}

async function responseCode(response: Response) {
  const text = await response.text();
  try {
    return errorCode(JSON.parse(text));
  } catch {
    return 'provider_error';
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // The caller receives a safe malformed-response code, never the response body.
  }
  throw new YouTubeHttpError(response.status, 'malformed_response', 'verification');
}

function isAuthStatus(status: number) {
  return status === 401 || status === 403;
}

function validatedVideoId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(value))
    throw new Error('YOUTUBE_INVALID_VIDEO_ID');
  return value;
}

function remoteVideo(videoId: string) {
  return { remoteMediaId: videoId, remoteUrl: `https://youtu.be/${videoId}` };
}

function parseRange(value: string | null, sizeBytes: number) {
  if (!value) return 0;
  const match = /^bytes=(\d+)-(\d+)$/.exec(value.trim());
  if (!match) throw new Error('YOUTUBE_INVALID_RANGE');
  const last = Number(match[2]);
  if (!Number.isSafeInteger(last) || last < 0 || last >= sizeBytes)
    throw new Error('YOUTUBE_INVALID_RANGE');
  return last + 1;
}

function sessionUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('YOUTUBE_INVALID_SESSION_URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.googleapis.com' ||
    url.pathname !== '/upload/youtube/v3/videos' ||
    url.searchParams.get('uploadType') !== 'resumable' ||
    !url.searchParams.get('upload_id')
  )
    throw new Error('YOUTUBE_INVALID_SESSION_URL');
  return url.toString();
}

function metadataFor(context: PublicationContext) {
  const metadata = context.metadata;
  const tags = metadata.tags;
  const categoryId = metadata.categoryId;
  const privacyStatus = metadata.privacyStatus;
  if (
    tags !== undefined &&
    (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.trim() === ''))
  )
    throw new Error('YOUTUBE_INVALID_TAGS');
  if (categoryId !== undefined && typeof categoryId !== 'string' && typeof categoryId !== 'number')
    throw new Error('YOUTUBE_INVALID_CATEGORY');
  if (
    privacyStatus !== undefined &&
    privacyStatus !== 'private' &&
    privacyStatus !== 'public' &&
    privacyStatus !== 'unlisted'
  )
    throw new Error('YOUTUBE_INVALID_PRIVACY_STATUS');
  return {
    snippet: {
      title: context.title,
      description: context.description ?? '',
      ...(tags ? { tags: tags as string[] } : {}),
      ...(categoryId !== undefined ? { categoryId: String(categoryId) } : {}),
    },
    status: {
      privacyStatus: (privacyStatus as string | undefined) ?? 'private',
      ...(typeof metadata.selfDeclaredMadeForKids === 'boolean'
        ? { selfDeclaredMadeForKids: metadata.selfDeclaredMadeForKids }
        : {}),
    },
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
      failure: { classification, code, ...(status ? { status } : {}) },
    };
  const disposition =
    classification === 'definite_retryable'
      ? 'retryable'
      : classification === 'reauthorization_required'
        ? 'reauthorization_required'
        : 'terminal';
  return {
    kind: 'definite_failure',
    disposition,
    failure: {
      classification,
      code,
      ...(status ? { status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
}

function reconciliationFailure(
  classification: 'ambiguous' | 'definite_retryable' | 'definite_terminal',
  code: string,
  status?: number,
) {
  return {
    classification,
    code,
    ...(status ? { status } : {}),
  } as const;
}

export function createYouTubePublisher(options: YouTubePublisherOptions = {}): YouTubePublisher {
  const request = options.fetch ?? fetch;
  const uploadEndpoint =
    options.uploadEndpoint ??
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false';
  const apiBaseUrl = options.apiBaseUrl ?? 'https://www.googleapis.com/youtube/v3';
  const chunkSizeBytes = options.chunkSizeBytes ?? 8 * 1024 * 1024;
  const maxStatusProbes = options.maxStatusProbes ?? 3;
  const maxSessionAuthRefreshes = options.maxSessionAuthRefreshes ?? 1;
  if (
    !Number.isSafeInteger(chunkSizeBytes) ||
    chunkSizeBytes < 256 * 1024 ||
    chunkSizeBytes % (256 * 1024) !== 0
  )
    throw new Error('YouTube chunk size must be a multiple of 256 KiB');
  if (!Number.isSafeInteger(maxSessionAuthRefreshes) || maxSessionAuthRefreshes < 1)
    throw new Error('YouTube session auth refresh limit must be a positive integer');

  const requestResponse = async (
    operation: YouTubeOperation,
    input: Parameters<FetchLike>[0],
    init: Parameters<FetchLike>[1],
    phase: 'initiation' | 'upload' | 'probe' | 'verification',
  ) => {
    try {
      return operation.own(await request(input, { ...init, signal: operation.signal }));
    } catch {
      throw new YouTubeNetworkError(phase);
    }
  };

  const verifyVideo = async (
    operation: YouTubeOperation,
    accessToken: string,
    channelId: string,
    videoId: string,
  ): Promise<
    | { kind: 'published'; remote: { remoteMediaId: string; remoteUrl: string } }
    | { kind: 'failure'; failure: ReturnType<typeof reconciliationFailure> }
  > => {
    let response: Response;
    try {
      response = await requestResponse(
        operation,
        `${apiBaseUrl}/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
        'verification',
      );
    } catch (error) {
      if (error instanceof YouTubeNetworkError)
        return {
          kind: 'failure',
          failure: reconciliationFailure('ambiguous', 'YOUTUBE_VERIFY_NETWORK'),
        };
      throw error;
    }
    try {
      if (!response.ok) {
        const code = await responseCode(response);
        return {
          kind: 'failure',
          failure: reconciliationFailure(
            isAuthStatus(response.status) || response.status >= 500 || response.status === 429
              ? 'ambiguous'
              : 'definite_terminal',
            isAuthStatus(response.status)
              ? 'YOUTUBE_VERIFY_AUTHENTICATION'
              : `YOUTUBE_VERIFY_${code}`,
            response.status,
          ),
        };
      }
      const value = await responseJson(response);
      const items = Array.isArray(value.items) ? value.items : [];
      const item = items.find(
        (candidate): candidate is YoutubeVideo =>
          !!candidate &&
          typeof candidate === 'object' &&
          (candidate as YoutubeVideo).id === videoId,
      );
      if (!item)
        return {
          kind: 'failure',
          failure: reconciliationFailure('definite_retryable', 'YOUTUBE_VIDEO_NOT_VISIBLE'),
        };
      if (item.snippet?.channelId !== channelId)
        return {
          kind: 'failure',
          failure: reconciliationFailure('definite_terminal', 'YOUTUBE_CHANNEL_MISMATCH'),
        };
      return {
        kind: 'published',
        remote: remoteVideo(videoId),
      };
    } finally {
      await operation.release(response);
    }
  };

  const reconcileOperation = async (
    context: ReconciliationContext,
    operation: YouTubeOperation,
  ): Promise<ReconcileOutcome> => {
    const evidenceVideoId = context.evidence.remoteMediaId;
    // A videos.insert request may have succeeded without returning a video ID. There is no
    // provider operation key with which to prove absence, so another insert is never safe.
    if (!evidenceVideoId)
      return {
        kind: 'unresolved',
        failure: reconciliationFailure('ambiguous', 'YOUTUBE_REMOTE_ID_UNAVAILABLE'),
      };
    let videoId: string;
    try {
      videoId = validatedVideoId(evidenceVideoId);
    } catch {
      return {
        kind: 'manual_review',
        failure: reconciliationFailure('definite_terminal', 'YOUTUBE_INVALID_VIDEO_ID'),
      };
    }
    try {
      const result = await verifyVideo(
        operation,
        await context.credential.getAccessToken(),
        context.credential.providerAccountId,
        videoId,
      );
      if (result.kind === 'published') return result;
      if (result.failure.classification === 'definite_retryable')
        return { kind: 'unresolved', failure: result.failure };
      if (result.failure.classification === 'definite_terminal')
        return { kind: 'manual_review', failure: result.failure };
      return { kind: 'unresolved', failure: result.failure };
    } catch {
      return {
        kind: 'unresolved',
        failure: reconciliationFailure('ambiguous', 'YOUTUBE_RECONCILIATION_FAILED'),
      };
    }
  };

  const reconcile = (context: ReconciliationContext): Promise<ReconcileOutcome> =>
    runYouTubeOperation(context.signal, (operation) => reconcileOperation(context, operation));

  const publishOperation = async (
    context: PublicationContext,
    operation: YouTubeOperation,
  ): Promise<PublishOutcome> => {
    if (!context.media) return failure('definite_terminal', 'YOUTUBE_MEDIA_REQUIRED');
    if (context.credential.platform !== 'youtube')
      return failure('definite_terminal', 'YOUTUBE_CREDENTIAL_REQUIRED');
    if (!context.credential.providerAccountId)
      return failure('reauthorization_required', 'YOUTUBE_CHANNEL_REQUIRED');
    if (!context.credential.scopes.includes('https://www.googleapis.com/auth/youtube.upload'))
      return failure('reauthorization_required', 'YOUTUBE_UPLOAD_SCOPE_REQUIRED');

    let mutationPhase: MutationPhase = 'pre_initiation';
    const unresolvedMutation = (code: string, status?: number) => {
      if (mutationPhase === 'pre_initiation')
        throw new Error('Mutation ambiguity cannot precede YouTube initiation');
      return failure('ambiguous', code, status);
    };

    let accessToken: string;
    try {
      accessToken = await context.credential.getAccessToken();
    } catch {
      return failure('ambiguous', 'YOUTUBE_ACCESS_TOKEN_UNAVAILABLE');
    }
    let body: string;
    try {
      body = JSON.stringify(metadataFor(context));
    } catch (error) {
      return failure(
        'definite_terminal',
        error instanceof Error ? error.message : 'YOUTUBE_INVALID_METADATA',
      );
    }

    let initiation: Response;
    mutationPhase = 'initiation_sent';
    try {
      initiation = await requestResponse(
        operation,
        uploadEndpoint,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json; charset=UTF-8',
            'content-length': String(Buffer.byteLength(body)),
            'x-upload-content-length': String(context.media.sizeBytes),
            'x-upload-content-type': context.media.contentType,
          },
          body,
        },
        'initiation',
      );
    } catch (error) {
      return unresolvedMutation(
        error instanceof YouTubeNetworkError
          ? 'YOUTUBE_INITIATION_NETWORK'
          : 'YOUTUBE_INITIATION_FAILED',
      );
    }
    if (!initiation.ok) {
      if (isAuthStatus(initiation.status)) {
        try {
          accessToken = await context.credential.getAccessToken({ forceRefresh: true });
        } catch {
          return failure(
            'reauthorization_required',
            'YOUTUBE_INITIATION_AUTHENTICATION',
            initiation.status,
          );
        }
        await operation.release(initiation);
        try {
          initiation = await requestResponse(
            operation,
            uploadEndpoint,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${accessToken}`,
                'content-type': 'application/json; charset=UTF-8',
                'content-length': String(Buffer.byteLength(body)),
                'x-upload-content-length': String(context.media.sizeBytes),
                'x-upload-content-type': context.media.contentType,
              },
              body,
            },
            'initiation',
          );
        } catch {
          return unresolvedMutation('YOUTUBE_INITIATION_AUTHENTICATION', initiation.status);
        }
      }
      if (!initiation.ok) {
        if (isAuthStatus(initiation.status))
          return failure(
            'reauthorization_required',
            'YOUTUBE_INITIATION_AUTHENTICATION',
            initiation.status,
          );
        const code = await responseCode(initiation);
        const retryAfter = Number(initiation.headers.get('retry-after'));
        return failure(
          initiation.status === 429 || initiation.status >= 500
            ? 'definite_retryable'
            : 'definite_terminal',
          `YOUTUBE_INITIATION_${code}`,
          initiation.status,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }
    }

    let uploadUrl: string;
    try {
      uploadUrl = sessionUrl(initiation.headers.get('location') ?? '');
    } catch (error) {
      return unresolvedMutation(
        error instanceof Error ? error.message : 'YOUTUBE_INVALID_SESSION_URL',
      );
    } finally {
      await operation.release(initiation);
    }
    mutationPhase = 'session_established';

    let sessionAuthRefreshes = 0;
    type SessionRequestResult =
      | { kind: 'response'; response: Response }
      | { kind: 'network' }
      | { kind: 'credential_refresh_failed' }
      | { kind: 'media_read_failed' };

    const sessionRequest = async (
      phase: 'upload' | 'probe',
      init: () => Promise<{
        request: RequestInit & { duplex?: 'half' };
        stream?: Readable;
      }>,
    ): Promise<SessionRequestResult> => {
      for (;;) {
        let requestInit: RequestInit & { duplex?: 'half' };
        let stream: Readable | undefined;
        try {
          const prepared = await init();
          requestInit = prepared.request;
          stream = prepared.stream;
        } catch {
          return { kind: 'media_read_failed' };
        }
        let response: Response;
        try {
          response = await requestResponse(operation, uploadUrl, requestInit, phase);
        } catch {
          return { kind: 'network' };
        } finally {
          if (stream) await operation.releaseStream(stream);
        }
        if (response.status !== 401) return { kind: 'response', response };
        if (sessionAuthRefreshes >= maxSessionAuthRefreshes) return { kind: 'response', response };
        await operation.release(response);
        sessionAuthRefreshes += 1;
        try {
          // The accepted credential lifecycle performs the generation-bound refresh. The
          // process-local upload session URL and byte range are deliberately not replaced.
          accessToken = await context.credential.getAccessToken({ forceRefresh: true });
        } catch {
          return { kind: 'credential_refresh_failed' };
        }
      }
    };

    const statusProbe = () =>
      sessionRequest('probe', async () => ({
        request: {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-length': '0',
            'content-range': `bytes */${context.media.sizeBytes}`,
          },
        },
      }));

    const completedOutcome = async (response: Response): Promise<PublishOutcome> => {
      let value: Record<string, unknown>;
      try {
        value = await responseJson(response);
      } catch {
        return failure('ambiguous', 'YOUTUBE_FINAL_RESPONSE_MALFORMED');
      }
      let videoId: string;
      try {
        videoId = validatedVideoId(value.id);
      } catch {
        return unresolvedMutation(
          typeof value.id === 'string'
            ? 'YOUTUBE_INVALID_VIDEO_ID'
            : 'YOUTUBE_FINAL_VIDEO_ID_MISSING',
        );
      }
      mutationPhase = 'completion_received';
      await context.checkpointEvidence(remoteVideo(videoId));
      context.reportProgress?.({
        uploadedBytes: context.media.sizeBytes,
        totalBytes: context.media.sizeBytes,
      });
      const verified = await verifyVideo(
        operation,
        accessToken,
        context.credential.providerAccountId,
        videoId,
      );
      if (verified.kind === 'published') return verified;
      return {
        kind: 'ambiguous',
        failure: {
          classification: 'ambiguous',
          code: verified.failure.code,
          ...(verified.failure.status ? { status: verified.failure.status } : {}),
        },
        evidence: {
          ...remoteVideo(videoId),
        },
      };
    };

    let offset = 0;
    let probes = 0;
    let noProgressResponses = 0;
    while (offset < context.media.sizeBytes) {
      mutationPhase = 'uploading';
      const endExclusive = Math.min(offset + chunkSizeBytes, context.media.sizeBytes);
      const upload = await sessionRequest('upload', async () => {
        const stream: Readable = operation.own(
          await context.media.openReadStream({
            start: offset,
            endExclusive,
            signal: operation.signal,
          }),
        );
        return {
          request: {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': context.media.contentType,
              'content-length': String(endExclusive - offset),
              'content-range': `bytes ${offset}-${endExclusive - 1}/${context.media.sizeBytes}`,
            },
            body: stream as unknown as BodyInit,
            duplex: 'half',
          } as RequestInit & { duplex: 'half' },
          stream,
        };
      });

      let response: Response;
      let fromProbe = false;
      if (upload.kind === 'credential_refresh_failed')
        return unresolvedMutation('YOUTUBE_UPLOAD_AUTH_REFRESH_FAILED', 401);
      if (upload.kind === 'media_read_failed')
        return unresolvedMutation('YOUTUBE_MEDIA_READ_FAILED');
      if (upload.kind === 'network') {
        if (probes >= maxStatusProbes)
          return unresolvedMutation('YOUTUBE_UPLOAD_STATUS_UNRESOLVED');
        probes += 1;
        const status = await statusProbe();
        if (status.kind === 'credential_refresh_failed')
          return unresolvedMutation('YOUTUBE_UPLOAD_AUTH_REFRESH_FAILED', 401);
        if (status.kind !== 'response')
          return unresolvedMutation('YOUTUBE_UPLOAD_STATUS_UNRESOLVED');
        response = status.response;
        fromProbe = true;
      } else {
        response = upload.response;
      }

      if (!fromProbe && (response.status === 429 || response.status >= 500)) {
        if (probes >= maxStatusProbes)
          return unresolvedMutation('YOUTUBE_UPLOAD_STATUS_UNRESOLVED', response.status);
        probes += 1;
        await operation.release(response);
        const status = await statusProbe();
        if (status.kind === 'credential_refresh_failed')
          return unresolvedMutation('YOUTUBE_UPLOAD_AUTH_REFRESH_FAILED', 401);
        if (status.kind !== 'response')
          return unresolvedMutation('YOUTUBE_UPLOAD_STATUS_UNRESOLVED');
        response = status.response;
        fromProbe = true;
      }

      try {
        if (response.status === 200 || response.status === 201)
          return await completedOutcome(response);
        if (response.status === 308) {
          try {
            const nextOffset = parseRange(response.headers.get('range'), context.media.sizeBytes);
            if (nextOffset > endExclusive) throw new Error('YOUTUBE_INVALID_RANGE');
            if (nextOffset === offset) {
              noProgressResponses += 1;
              if (noProgressResponses >= maxStatusProbes)
                return unresolvedMutation('YOUTUBE_UPLOAD_NO_PROGRESS', response.status);
            } else {
              noProgressResponses = 0;
              probes = 0;
            }
            offset = nextOffset;
            context.reportProgress?.({
              uploadedBytes: offset,
              totalBytes: context.media.sizeBytes,
            });
          } catch {
            return unresolvedMutation('YOUTUBE_INVALID_RANGE', response.status);
          }
          continue;
        }
        if (response.status === 401)
          return unresolvedMutation('YOUTUBE_UPLOAD_AUTHENTICATION', response.status);
        if (response.status === 404)
          return unresolvedMutation('YOUTUBE_UPLOAD_SESSION_EXPIRED', response.status);
        return unresolvedMutation(
          fromProbe ? 'YOUTUBE_UPLOAD_STATUS_UNRESOLVED' : 'YOUTUBE_UPLOAD_REJECTED',
          response.status,
        );
      } finally {
        await operation.release(response);
      }
    }
    return unresolvedMutation('YOUTUBE_UPLOAD_INCOMPLETE');
  };

  const publish = (context: PublicationContext): Promise<PublishOutcome> =>
    runYouTubeOperation(context.signal, (operation) => publishOperation(context, operation));

  return { platform: 'youtube', publish, reconcile };
}
