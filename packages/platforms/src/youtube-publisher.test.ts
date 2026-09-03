import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { createYouTubePublisher } from './youtube-publisher.js';
import type { PublicationContext } from './publication.js';

const chunkSize = 256 * 1024;
const videoId1 = 'video-00001';
const videoId2 = 'video-00002';
type FetchInput = Parameters<typeof fetch>[0];

function context(overrides: Partial<PublicationContext> = {}): PublicationContext {
  return {
    publicationId: 'publication-1',
    attemptId: 'attempt-1',
    operationKey: 'attempt-1',
    platform: 'youtube',
    title: 'Studio upload',
    description: 'A description',
    metadata: { categoryId: 22, privacyStatus: 'private', tags: ['studio'] },
    credential: {
      accountId: 'account-1',
      userId: 'user-1',
      platform: 'youtube',
      credentialRevision: 4,
      accessToken: 'access-token',
      providerAccountId: 'channel-1',
      scopes: [
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/youtube.upload',
      ],
      getAccessToken: vi.fn().mockResolvedValue('access-token'),
    },
    media: {
      sizeBytes: chunkSize * 2,
      contentType: 'video/mp4',
      openReadStream: vi.fn(async ({ start = 0, endExclusive = chunkSize * 2 } = {}) =>
        Readable.from([Buffer.alloc(endExclusive - start)]),
      ),
    },
    signal: new AbortController().signal,
    evidence: {},
    checkpointEvidence: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers });
}

describe('YouTube publisher', () => {
  test('uploads bounded ranges and verifies the resulting channel ownership', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (calls.length === 1)
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1',
          },
        });
      if (calls.length === 2)
        return new Response(null, { status: 308, headers: { range: `bytes=0-${chunkSize - 1}` } });
      if (calls.length === 3) return jsonResponse({ id: videoId1 }, 201);
      return jsonResponse({ items: [{ id: videoId1, snippet: { channelId: 'channel-1' } }] });
    });
    const publisher = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize });
    const result = await publisher.publish!(context());

    expect(result).toEqual({
      kind: 'published',
      remote: {
        remoteMediaId: videoId1,
        remoteUrl: `https://youtu.be/${videoId1}`,
      },
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.init?.headers).toMatchObject({
      'x-upload-content-length': String(chunkSize * 2),
      'x-upload-content-type': 'video/mp4',
    });
    expect(calls[1]?.init?.headers).toMatchObject({
      'content-length': String(chunkSize),
      'content-range': `bytes 0-${chunkSize - 1}/${chunkSize * 2}`,
    });
    expect(calls[2]?.init?.headers).toMatchObject({
      'content-range': `bytes ${chunkSize}-${chunkSize * 2 - 1}/${chunkSize * 2}`,
    });
    expect(calls[0]?.url).toContain('notifySubscribers=false');
  });

  test('probes the resumable session after a transient upload response', async () => {
    let uploadCalls = 0;
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-2',
          },
        });
      if (init?.headers && new Headers(init.headers).get('content-length') === '0')
        return new Response(null, { status: 308, headers: { range: `bytes=0-${chunkSize - 1}` } });
      uploadCalls += 1;
      if (uploadCalls === 1) return jsonResponse({ error: 'backend' }, 503);
      if (uploadCalls === 2) return jsonResponse({ id: videoId2 }, 201);
      return jsonResponse({ items: [{ id: videoId2, snippet: { channelId: 'channel-1' } }] });
    });
    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context());
    expect(result.kind).toBe('published');
    expect(request).toHaveBeenCalledTimes(5);
  });

  test('checkpoints a final video ID before verification so reconciliation never inserts again', async () => {
    const checkpointEvidence = vi.fn().mockResolvedValue(undefined);
    let verificationCalls = 0;
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-checkpoint',
          },
        });
      if (init?.method === 'PUT') return jsonResponse({ id: videoId1 }, 201);
      verificationCalls += 1;
      expect(String(input)).toContain(`id=${videoId1}`);
      if (verificationCalls === 1) return new Response('not-json', { status: 200 });
      return jsonResponse({ items: [{ id: videoId1, snippet: { channelId: 'channel-1' } }] });
    });
    const publisher = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize });
    const publishContext = context({
      checkpointEvidence,
      media: {
        sizeBytes: chunkSize,
        contentType: 'video/mp4',
        openReadStream: vi.fn(async () => Readable.from([Buffer.alloc(chunkSize)])),
      },
    });

    await expect(publisher.publish!(publishContext)).rejects.toThrow();
    expect(checkpointEvidence).toHaveBeenCalledOnce();
    expect(checkpointEvidence).toHaveBeenCalledWith({
      remoteMediaId: videoId1,
      remoteUrl: `https://youtu.be/${videoId1}`,
    });

    const result = await publisher.reconcile({
      ...publishContext,
      evidence: checkpointEvidence.mock.calls[0]![0],
    });
    expect(result).toMatchObject({
      kind: 'published',
      remote: { remoteMediaId: videoId1, remoteUrl: `https://youtu.be/${videoId1}` },
    });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(verificationCalls).toBe(2);
  });

  test('reconciles to the same validated query-free public URL', async () => {
    const request = vi.fn(async () =>
      jsonResponse({ items: [{ id: videoId1, snippet: { channelId: 'channel-1' } }] }),
    );
    const publisher = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize });
    const base = context();
    const result = await publisher.reconcile({ ...base, evidence: { remoteMediaId: videoId1 } });

    expect(result).toEqual({
      kind: 'published',
      remote: { remoteMediaId: videoId1, remoteUrl: `https://youtu.be/${videoId1}` },
    });
    expect(new URL((result as { remote: { remoteUrl: string } }).remote.remoteUrl).search).toBe('');
  });

  test('keeps no-ID reconciliation unresolved without making any provider request', async () => {
    const request = vi.fn();
    const publisher = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize });
    const result = await publisher.reconcile({ ...context(), evidence: {} });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'YOUTUBE_REMOTE_ID_UNAVAILABLE' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('refreshes a chunk 401 and retries the same session URL and range', async () => {
    const session =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-auth-chunk';
    const puts: Array<{ url: string; range: string | null; token: string | null }> = [];
    let chunkAttempts = 0;
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, { status: 200, headers: { location: session } });
      if (init?.method === 'PUT') {
        const headers = new Headers(init.headers);
        puts.push({
          url: String(input),
          range: headers.get('content-range'),
          token: headers.get('authorization'),
        });
        chunkAttempts += 1;
        if (chunkAttempts === 1) return new Response(null, { status: 401 });
        if (chunkAttempts === 2)
          return new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${chunkSize - 1}` },
          });
        return jsonResponse({ id: videoId1 }, 201);
      }
      return jsonResponse({ items: [{ id: videoId1, snippet: { channelId: 'channel-1' } }] });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) =>
      input?.forceRefresh ? 'new-token' : 'old-token',
    );

    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context({ credential: { ...context().credential, getAccessToken } }));

    expect(result.kind).toBe('published');
    expect(puts.slice(0, 2)).toEqual([
      {
        url: session,
        range: `bytes 0-${chunkSize - 1}/${chunkSize * 2}`,
        token: 'Bearer old-token',
      },
      {
        url: session,
        range: `bytes 0-${chunkSize - 1}/${chunkSize * 2}`,
        token: 'Bearer new-token',
      },
    ]);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  test('refreshes a status-probe 401 on the same session without another initiation', async () => {
    const session =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-auth-probe';
    let chunks = 0;
    let probes = 0;
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, { status: 200, headers: { location: session } });
      if (init?.method === 'PUT') {
        expect(String(input)).toBe(session);
        const headers = new Headers(init.headers);
        if (headers.get('content-length') === '0') {
          probes += 1;
          if (probes === 1) return new Response(null, { status: 401 });
          expect(headers.get('authorization')).toBe('Bearer new-token');
          return new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${chunkSize - 1}` },
          });
        }
        chunks += 1;
        if (chunks === 1) return new Response(null, { status: 503 });
        return jsonResponse({ id: videoId2 }, 201);
      }
      return jsonResponse({ items: [{ id: videoId2, snippet: { channelId: 'channel-1' } }] });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) =>
      input?.forceRefresh ? 'new-token' : 'old-token',
    );

    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context({ credential: { ...context().credential, getAccessToken } }));

    expect(result.kind).toBe('published');
    expect(probes).toBe(2);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(getAccessToken.mock.calls.filter(([input]) => input?.forceRefresh)).toHaveLength(1);
  });

  test('refreshes a continuation 401 and retries exactly that byte range', async () => {
    const session =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-auth-continuation';
    const continuationRanges: string[] = [];
    let puts = 0;
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, { status: 200, headers: { location: session } });
      if (init?.method === 'PUT') {
        puts += 1;
        const range = new Headers(init.headers).get('content-range')!;
        if (puts === 1)
          return new Response(null, {
            status: 308,
            headers: { range: `bytes=0-${chunkSize - 1}` },
          });
        continuationRanges.push(range);
        if (puts === 2) return new Response(null, { status: 401 });
        return jsonResponse({ id: videoId1 }, 201);
      }
      return jsonResponse({ items: [{ id: videoId1, snippet: { channelId: 'channel-1' } }] });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) =>
      input?.forceRefresh ? 'new-token' : 'old-token',
    );

    await expect(
      createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize }).publish!(
        context({ credential: { ...context().credential, getAccessToken } }),
      ),
    ).resolves.toMatchObject({ kind: 'published' });
    expect(continuationRanges).toEqual([
      `bytes ${chunkSize}-${chunkSize * 2 - 1}/${chunkSize * 2}`,
      `bytes ${chunkSize}-${chunkSize * 2 - 1}/${chunkSize * 2}`,
    ]);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  test('marks failed post-initiation refresh ambiguous and never starts another upload', async () => {
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-refresh-fails',
          },
        });
      return new Response(null, { status: 401 });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) => {
      if (input?.forceRefresh) throw new Error('refresh unavailable');
      return 'old-token';
    });

    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context({ credential: { ...context().credential, getAccessToken } }));
    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'YOUTUBE_UPLOAD_AUTH_REFRESH_FAILED' },
    });
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  test('bounds repeated session 401 responses to one refresh and no second initiation', async () => {
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-repeated-401',
          },
        });
      return new Response(null, { status: 401 });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) =>
      input?.forceRefresh ? 'new-token' : 'old-token',
    );

    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context({ credential: { ...context().credential, getAccessToken } }));

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'YOUTUBE_UPLOAD_AUTHENTICATION', status: 401 },
    });
    expect(getAccessToken.mock.calls.filter(([input]) => input?.forceRefresh)).toHaveLength(1);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  });

  test('never turns an expired established session into an ordinary upload retry', async () => {
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-expired',
          },
        });
      return new Response(null, { status: 404 });
    });

    const result = await createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context());

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'YOUTUBE_UPLOAD_SESSION_EXPIRED' },
    });
    expect(result.kind).not.toBe('definite_failure');
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  test('aborts an active upload and awaits its operation-owned media stream teardown', async () => {
    const controller = new AbortController();
    let resolveUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      resolveUploadStarted = resolve;
    });
    let finishDestroy!: () => void;
    let streamActive = 0;
    let publishSettled = false;
    const sharedPoolDestroy = vi.fn();
    const media = {
      sizeBytes: chunkSize,
      contentType: 'video/mp4',
      sharedPoolDestroy,
      openReadStream: vi.fn(async () => {
        streamActive += 1;
        return new Readable({
          read() {
            this.push(Buffer.alloc(1024));
          },
          destroy(error, callback) {
            finishDestroy = () => {
              streamActive -= 1;
              callback(error);
            };
          },
        });
      }),
    };
    const request = vi.fn(async (_input: FetchInput, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-abort',
          },
        });
      resolveUploadStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAborted = () => reject(new Error('upload aborted'));
        if (signal?.aborted) rejectAborted();
        else signal?.addEventListener('abort', rejectAborted, { once: true });
      });
    });
    const publishing = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context({ signal: controller.signal, media }));
    void publishing.finally(() => {
      publishSettled = true;
    });

    await uploadStarted;
    expect(streamActive).toBe(1);
    controller.abort(new Error('runtime shutdown'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishSettled).toBe(false);
    expect(streamActive).toBe(1);

    finishDestroy();
    await expect(publishing).resolves.toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'YOUTUBE_UPLOAD_STATUS_UNRESOLVED' },
    });
    expect(streamActive).toBe(0);
    expect(sharedPoolDestroy).not.toHaveBeenCalled();
  });

  test('awaits cancellation of an unconsumed provider response before returning', async () => {
    let finishCancel!: () => void;
    let cancelStarted = false;
    let settled = false;
    const body = new ReadableStream({
      cancel: () =>
        new Promise<void>((resolve) => {
          cancelStarted = true;
          finishCancel = resolve;
        }),
    });
    const request = vi.fn(async () => new Response(body, { status: 200 }));
    const publishing = createYouTubePublisher({ fetch: request, chunkSizeBytes: chunkSize })
      .publish!(context());
    void publishing.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(cancelStarted).toBe(true));
    expect(settled).toBe(false);
    finishCancel();
    await expect(publishing).resolves.toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'YOUTUBE_INVALID_SESSION_URL' },
    });
  });
});
