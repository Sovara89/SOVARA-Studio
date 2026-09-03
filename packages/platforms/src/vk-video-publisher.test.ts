import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { TransportTeardownUnconfirmedError } from './pinned-https.js';
import type { PublicationContext } from './publication.js';
import { createVKVideoPublisher, type VKVideoPublisherOptions } from './vk-video-publisher.js';

type FetchInput = Parameters<typeof fetch>[0];

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function context(overrides: Partial<PublicationContext> = {}): PublicationContext {
  return {
    publicationId: 'publication-vk-1',
    attemptId: 'attempt-vk-1',
    operationKey: 'attempt-vk-1',
    platform: 'vk',
    title: 'Studio upload',
    description: 'Description',
    metadata: {},
    credential: {
      accountId: 'account-vk-1',
      userId: 'user-1',
      platform: 'vk',
      credentialRevision: 3,
      accessToken: 'snapshot-token-must-not-be-read',
      providerAccountId: '12345',
      scopes: ['vkid.personal_info', 'video'],
      getAccessToken: vi.fn().mockResolvedValue('user-access-token'),
    },
    media: {
      sizeBytes: 6,
      contentType: 'video/mp4',
      openReadStream: vi.fn(async () => Readable.from([Buffer.from('ab'), Buffer.from('cdef')])),
    },
    signal: new AbortController().signal,
    evidence: {},
    checkpointEvidence: vi.fn().mockResolvedValue(undefined),
    reportProgress: vi.fn(),
    ...overrides,
  };
}

function acceptedEvidence(sizeBytes = 6) {
  return {
    providerRequestId: `vk-upload-accepted:v1:-54321:77:${sizeBytes}`,
    remoteOwnerId: '-54321',
    remoteMediaId: '77',
    remoteUrl: 'https://vk.com/video-54321_77',
  };
}

type TestRequest = (input: FetchInput, init?: RequestInit) => Promise<Response>;

function createTestPublisher(
  request: TestRequest,
  overrides: Partial<VKVideoPublisherOptions> = {},
) {
  return createVKVideoPublisher({
    groupId: '54321',
    fetch: request as typeof fetch,
    resolveHostname: vi.fn(async () => [{ address: '8.8.8.8', family: 4 as const }]),
    uploadTransport: async ({ target, headers, body, signal }) =>
      request(target.url.toString(), {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
        redirect: 'manual',
        signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    ...overrides,
  });
}

async function readRequestBody(body: BodyInit | null | undefined) {
  if (typeof body === 'string') return Buffer.from(body);
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('VK video publisher', () => {
  test('saves once, checkpoints safe identity, streams exact multipart, and verifies exact ownership', async () => {
    const order: string[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let multipart = Buffer.alloc(0);
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/video.save')) {
        const form = new URLSearchParams(String(init?.body));
        expect([...form.keys()].sort()).toEqual([
          'access_token',
          'description',
          'group_id',
          'name',
          'v',
        ]);
        expect(Object.fromEntries(form)).toEqual({
          name: 'Studio upload',
          description: 'Description',
          group_id: '54321',
          access_token: 'user-access-token',
          v: '5.199',
        });
        expect(form.has('wallpost')).toBe(false);
        expect(init?.redirect).toBe('manual');
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video?key=opaque-secret',
            access_key: 'must-not-be-persisted',
          },
        });
      }
      if (url.startsWith('https://upload.example.test/')) {
        order.push('upload');
        expect(init?.body).toBeInstanceOf(Readable);
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        multipart = await readRequestBody(init?.body);
        expect(new Headers(init?.headers).get('content-length')).toBe(String(multipart.byteLength));
        return jsonResponse({ video_id: 77, size: 6 });
      }
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('videos')).toBe('-54321_77');
      return jsonResponse({ response: { count: 1, items: [{ owner_id: -54321, id: 77 }] } });
    });
    const base = context();
    const openReadStream = vi.fn(async () => {
      order.push('open');
      return Readable.from([Buffer.from('ab'), Buffer.from('cdef')]);
    });
    const checkpointEvidence = vi.fn(async () => {
      order.push('checkpoint');
    });

    const result = await createTestPublisher(request, {
      boundaryFactory: () => 'sovara-vk-test-boundary',
    }).publish!({
      ...base,
      media: { ...base.media, openReadStream },
      checkpointEvidence,
    });

    expect(result).toEqual({
      kind: 'published',
      remote: {
        remoteOwnerId: '-54321',
        remoteMediaId: '77',
        remoteUrl: 'https://vk.com/video-54321_77',
      },
    });
    expect(order).toEqual(['checkpoint', 'open', 'upload', 'checkpoint']);
    expect(checkpointEvidence).toHaveBeenNthCalledWith(1, {
      remoteOwnerId: '-54321',
      remoteMediaId: '77',
      remoteUrl: 'https://vk.com/video-54321_77',
    });
    expect(checkpointEvidence).toHaveBeenNthCalledWith(2, acceptedEvidence());
    expect(base.reportProgress).toHaveBeenCalledTimes(2);
    expect(base.reportProgress).toHaveBeenNthCalledWith(1, {
      uploadedBytes: 2,
      totalBytes: 6,
    });
    expect(base.reportProgress).toHaveBeenNthCalledWith(2, {
      uploadedBytes: 6,
      totalBytes: 6,
    });
    const framed = multipart.toString();
    expect(framed).toContain('name="video_file"; filename="video.mp4"');
    expect(framed).toContain('\r\n\r\nabcdef\r\n--sovara-vk-test-boundary--\r\n');
    expect(JSON.stringify(checkpointEvidence.mock.calls)).not.toContain('opaque-secret');
    expect(JSON.stringify(checkpointEvidence.mock.calls)).not.toContain('access_key');
    expect(calls.filter((call) => call.url.endsWith('/video.save'))).toHaveLength(1);
  });

  test('does not retry an ambiguous video.save request or expose the access token', async () => {
    const request = vi.fn(async () => {
      throw new Error('network includes user-access-token');
    });
    const base = context();
    const result = await createTestPublisher(request).publish!(base);

    expect(result).toEqual({
      kind: 'ambiguous',
      failure: { classification: 'ambiguous', code: 'VK_SAVE_NETWORK' },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(base.media.openReadStream).not.toHaveBeenCalled();
    expect(base.checkpointEvidence).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('user-access-token');
  });

  test('treats a definitive save authentication error as reauthorization without a second save', async () => {
    const getAccessToken = vi.fn().mockResolvedValue('expired-user-token');
    const request = vi.fn(async () =>
      jsonResponse({ error: { error_code: 5, error_msg: 'auth' } }),
    );
    const base = context();
    const result = await createTestPublisher(request).publish!({
      ...base,
      credential: { ...base.credential, getAccessToken },
    });

    expect(result).toMatchObject({
      kind: 'definite_failure',
      disposition: 'reauthorization_required',
      failure: { code: 'VK_SAVE_AUTHENTICATION' },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getAccessToken).not.toHaveBeenCalledWith({ forceRefresh: true });
  });

  test('checkpoints an unexpected owner and never uploads media', async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        response: {
          owner_id: 99999,
          video_id: 77,
          upload_url: 'https://upload.example.test/video',
        },
      }),
    );
    const base = context();
    const result = await createTestPublisher(request).publish!(base);

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_OWNER_MISMATCH' },
      evidence: { remoteOwnerId: '99999', remoteMediaId: '77' },
    });
    expect(base.checkpointEvidence).toHaveBeenCalledOnce();
    expect(base.media.openReadStream).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  test.each([
    'http://upload.example.test/video',
    'https://127.0.0.1/video',
    'https://localhost/video',
    'https://user:password@upload.example.test/video',
    'https://upload.example.test/video#fragment',
  ])('rejects unsafe provider upload URL %s without leaking or using it', async (uploadUrl) => {
    const request = vi.fn(async () =>
      jsonResponse({ response: { owner_id: -54321, video_id: 77, upload_url: uploadUrl } }),
    );
    const base = context();
    const result = await createTestPublisher(request).publish!(base);

    expect(result).toMatchObject({ kind: 'ambiguous', failure: { code: 'VK_INVALID_UPLOAD_URL' } });
    expect(request).toHaveBeenCalledOnce();
    expect(base.checkpointEvidence).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(uploadUrl);
  });

  test('keeps every post-save upload uncertainty ambiguous with durable exact evidence', async () => {
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (String(input).endsWith('/video.save'))
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video?secret=never-store',
          },
        });
      await readRequestBody(init?.body);
      return new Response('gateway failure', { status: 503 });
    });
    const base = context();
    const result = await createTestPublisher(request).publish!(base);

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_REJECTED', status: 503 },
      evidence: { remoteOwnerId: '-54321', remoteMediaId: '77' },
    });
    expect(JSON.stringify(result)).not.toContain('never-store');
    expect(base.checkpointEvidence).toHaveBeenCalledOnce();
  });

  test.each([
    [{}, 'VK_UPLOAD_RESPONSE_MALFORMED'],
    [{ video_id: 77 }, 'VK_UPLOAD_RESPONSE_MALFORMED'],
    [{ size: 6 }, 'VK_UPLOAD_RESPONSE_MALFORMED'],
    [{ video_id: '77', size: 6 }, 'VK_UPLOAD_RESPONSE_MALFORMED'],
    [{ video_id: 78, size: 6 }, 'VK_UPLOAD_VIDEO_MISMATCH'],
    [{ video_id: 77, size: 5 }, 'VK_UPLOAD_SIZE_MISMATCH'],
  ] as const)('rejects an unproven upload response %#', async (uploadResponse, expectedCode) => {
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (String(input).endsWith('/video.save'))
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        });
      await readRequestBody(init?.body);
      return jsonResponse(uploadResponse);
    });
    const base = context();

    const result = await createTestPublisher(request).publish!(base);

    expect(result).toMatchObject({ kind: 'ambiguous', failure: { code: expectedCode } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(base.checkpointEvidence).toHaveBeenCalledOnce();
    expect(base.checkpointEvidence).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerRequestId: expect.any(String) }),
    );
  });

  test('throttles deterministic incremental progress while the media stream is consumed', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/video.save'))
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        });
      if (url.startsWith('https://upload.example.test/')) {
        await readRequestBody(init?.body);
        return jsonResponse({ video_id: 77, size: 6 });
      }
      return jsonResponse({ response: { count: 1, items: [{ owner_id: -54321, id: 77 }] } });
    });
    const base = context();
    try {
      const result = await createTestPublisher(request).publish!({
        ...base,
        media: {
          ...base.media,
          openReadStream: vi.fn(async () =>
            Readable.from(['a', 'b', 'c', 'd', 'e', 'f'].map((value) => Buffer.from(value))),
          ),
        },
      });

      expect(result.kind).toBe('published');
      expect(base.reportProgress).toHaveBeenCalledTimes(2);
      expect(base.reportProgress).toHaveBeenNthCalledWith(1, {
        uploadedBytes: 1,
        totalBytes: 6,
      });
      expect(base.reportProgress).toHaveBeenNthCalledWith(2, {
        uploadedBytes: 6,
        totalBytes: 6,
      });
    } finally {
      now.mockRestore();
    }
  });

  test('detects a short media stream through streaming backpressure without buffering it first', async () => {
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      if (String(input).endsWith('/video.save'))
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        });
      await readRequestBody(init?.body);
      return jsonResponse({});
    });
    const base = context();
    const result = await createTestPublisher(request).publish!({
      ...base,
      media: {
        ...base.media,
        openReadStream: vi.fn(async () => Readable.from([Buffer.from('short')])),
      },
    });

    expect(result).toMatchObject({ kind: 'ambiguous', failure: { code: 'VK_UPLOAD_NETWORK' } });
    expect(base.checkpointEvidence).toHaveBeenCalledOnce();
  });

  test('keeps processing and temporary non-visibility unresolved rather than claiming absence', async () => {
    const processingRequest = vi.fn(async () =>
      jsonResponse({
        response: { count: 1, items: [{ owner_id: -54321, id: 77, processing: 1 }] },
      }),
    );
    const publisher = createTestPublisher(processingRequest);
    const base = context();
    const processing = await publisher.reconcile({
      ...base,
      evidence: acceptedEvidence(),
    });
    expect(processing).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_VIDEO_PROCESSING' },
    });

    const absentPublisher = createTestPublisher(
      vi.fn(async () => jsonResponse({ response: { count: 0, items: [] } })),
    );
    const absent = await absentPublisher.reconcile({
      ...base,
      evidence: acceptedEvidence(),
    });
    expect(absent).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_VIDEO_NOT_VISIBLE' },
    });
    expect(absent.kind).not.toBe('definitely_absent');
  });

  test('reconciliation performs only exact video.get and safely refreshes its user access token', async () => {
    const methods: string[] = [];
    let gets = 0;
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      methods.push(String(input));
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('videos')).toBe('-54321_77');
      gets += 1;
      if (gets === 1) return jsonResponse({ error: { error_code: 5 } });
      expect(form.get('access_token')).toBe('refreshed-user-token');
      return jsonResponse({ response: { count: 1, items: [{ owner_id: -54321, id: 77 }] } });
    });
    const getAccessToken = vi.fn(async (input?: { forceRefresh?: boolean }) =>
      input?.forceRefresh ? 'refreshed-user-token' : 'old-user-token',
    );
    const base = context();
    const result = await createTestPublisher(request).reconcile({
      ...base,
      credential: { ...base.credential, getAccessToken },
      evidence: acceptedEvidence(),
    });

    expect(result).toMatchObject({
      kind: 'published',
      remote: { remoteOwnerId: '-54321', remoteMediaId: '77' },
    });
    expect(methods).toHaveLength(2);
    expect(methods.every((method) => method.endsWith('/video.get'))).toBe(true);
    expect(getAccessToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  test('does not publish from video.get after a crash before upload acceptance was checkpointed', async () => {
    const request = vi.fn(async () =>
      jsonResponse({ response: { count: 1, items: [{ owner_id: -54321, id: 77 }] } }),
    );
    const base = context();
    const publisher = createTestPublisher(request);
    const crashEvidence = { remoteOwnerId: '-54321', remoteMediaId: '77' };

    const reconciled = await publisher.reconcile({ ...base, evidence: crashEvidence });
    const resumedPublish = await publisher.publish!({ ...base, evidence: crashEvidence });

    expect(reconciled).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_UPLOAD_ACCEPTANCE_UNEVIDENCED' },
    });
    expect(resumedPublish).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_ACCEPTANCE_UNEVIDENCED' },
    });
    expect(request).not.toHaveBeenCalled();
    expect(base.credential.getAccessToken).not.toHaveBeenCalled();
    expect(base.media.openReadStream).not.toHaveBeenCalled();
    expect(base.checkpointEvidence).not.toHaveBeenCalled();
  });

  test('unknown or mismatched reconciliation identity never saves, uploads, or searches broadly', async () => {
    const request = vi.fn();
    const publisher = createTestPublisher(request);
    const base = context();
    const unknown = await publisher.reconcile({ ...base, evidence: { remoteMediaId: '77' } });
    expect(unknown).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_REMOTE_ID_UNAVAILABLE' },
    });
    const mismatch = await publisher.reconcile({
      ...base,
      evidence: { remoteOwnerId: '99999', remoteMediaId: '77' },
    });
    expect(mismatch).toMatchObject({
      kind: 'manual_review',
      failure: { code: 'VK_OWNER_MISMATCH' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  test('bounds provider responses and never includes raw bodies in outcomes', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ response: { secret: 'x'.repeat(2048) } }), { status: 200 }),
    );
    const result = await createTestPublisher(request, { maxResponseBytes: 1024 }).publish!(
      context(),
    );
    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_SAVE_RESPONSE_MALFORMED' },
    });
    expect(JSON.stringify(result)).not.toContain('xxxx');
  });

  test('always sends credential-bearing API calls to the exact production VK method endpoint', async () => {
    const request = vi.fn(async (input: FetchInput) => {
      void input;
      return jsonResponse({}, 408);
    });
    const result = await createTestPublisher(request).publish!(context());

    expect(result).toMatchObject({ kind: 'ambiguous', failure: { status: 408 } });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe('https://api.vk.com/method/video.save');
    expect(() =>
      createTestPublisher(request, { apiBaseUrl: 'https://credentials.example/video' }),
    ).toThrow('VK API base URL is unsafe');
    expect(() => createTestPublisher(request, { apiBaseUrl: 'http://api.vk.com/method' })).toThrow(
      'VK API base URL is unsafe',
    );
    expect(() =>
      createTestPublisher(request, { apiBaseUrl: 'https://api.vk.com:444/method' }),
    ).toThrow('VK API base URL is unsafe');
    expect(() => createTestPublisher(request, { apiBaseUrl: 'https://api.vk.com/other' })).toThrow(
      'VK API base URL is unsafe',
    );
  });

  test('classifies save HTTP 408 as ambiguous without retrying', async () => {
    const request = vi.fn(async () => new Response('', { status: 408 }));
    const base = context();

    const result = await createTestPublisher(request).publish!(base);

    expect(result).toEqual({
      kind: 'ambiguous',
      failure: { classification: 'ambiguous', code: 'VK_SAVE_STATUS_UNCERTAIN', status: 408 },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(base.media.openReadStream).not.toHaveBeenCalled();
  });

  test('classifies save HTTP 429 as definitely retryable with bounded Retry-After and no blind retry', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { error_code: 6 } }), {
          status: 429,
          headers: { 'retry-after': '999999999', 'content-type': 'application/json' },
        }),
    );
    const base = context();

    const result = await createTestPublisher(request).publish!(base);

    expect(result).toEqual({
      kind: 'definite_failure',
      disposition: 'retryable',
      failure: {
        classification: 'definite_retryable',
        code: 'VK_SAVE_THROTTLED',
        status: 429,
        retryAfterMs: 86_400_000,
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(base.media.openReadStream).not.toHaveBeenCalled();
  });

  test('preflights exact configured community administration capability without mutation', async () => {
    const request = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.vk.com/method/groups.getById');
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({
        group_ids: '54321',
        fields: 'is_admin,admin_level,deactivated',
        access_token: 'user-access-token',
        v: '5.199',
      });
      expect(init?.redirect).toBe('manual');
      return jsonResponse({
        response: { groups: [{ id: 54321, is_admin: 1, admin_level: 2 }] },
      });
    });
    const base = context();
    const result = await createTestPublisher(request).capabilityPreflight!({
      publicationId: base.publicationId,
      platform: base.platform,
      credential: base.credential,
      signal: base.signal,
    });

    expect(result).toEqual({ kind: 'ready' });
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).not.toContain('video.save');
  });

  test('rejects a connected user that cannot manage video for the exact configured community', async () => {
    const request = vi.fn(async () =>
      jsonResponse({ response: { groups: [{ id: 54321, is_admin: 1, admin_level: 1 }] } }),
    );
    const base = context();
    const result = await createTestPublisher(request).capabilityPreflight!({
      publicationId: base.publicationId,
      platform: base.platform,
      credential: base.credential,
      signal: base.signal,
    });

    expect(result).toEqual({
      kind: 'failure',
      failure: {
        classification: 'definite_terminal',
        code: 'VK_GROUP_CAPABILITY_DENIED',
      },
    });
  });

  test('aborts and awaits capability API cleanup before returning', async () => {
    let activeRequests = 0;
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
      (_input: FetchInput, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          activeRequests += 1;
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            'abort',
            () => {
              queueMicrotask(() => {
                activeRequests -= 1;
                reject(new Error('request aborted'));
              });
            },
            { once: true },
          );
        }),
    );
    const base = context();
    const result = await createTestPublisher(request, {
      capabilityTimeoutMs: 10,
    }).capabilityPreflight!({
      publicationId: base.publicationId,
      platform: base.platform,
      credential: base.credential,
      signal: base.signal,
    });

    expect(result).toMatchObject({
      kind: 'failure',
      failure: { classification: 'definite_retryable', code: 'VK_CAPABILITY_UNAVAILABLE' },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    expect(activeRequests).toBe(0);
  });

  test('aborts and awaits save/get API cleanup without opening or duplicating upload', async () => {
    let activeRequests = 0;
    const requestSignals: AbortSignal[] = [];
    const request = vi.fn(
      (_input: FetchInput, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('request signal is required');
          activeRequests += 1;
          requestSignals.push(signal);
          signal.addEventListener(
            'abort',
            () => {
              queueMicrotask(() => {
                activeRequests -= 1;
                reject(new Error('request aborted'));
              });
            },
            { once: true },
          );
        }),
    );
    const base = context();
    const publisher = createTestPublisher(request, { saveTimeoutMs: 10, getTimeoutMs: 10 });

    const saved = await publisher.publish!(base);
    const reconciled = await publisher.reconcile({ ...base, evidence: acceptedEvidence() });

    expect(saved).toMatchObject({ kind: 'ambiguous', failure: { code: 'VK_SAVE_NETWORK' } });
    expect(reconciled).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_VERIFY_NETWORK' },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
    expect(activeRequests).toBe(0);
    expect(base.media.openReadStream).not.toHaveBeenCalled();
  });

  test('rejects mixed public/private DNS answers and never opens the source', async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        response: {
          owner_id: -54321,
          video_id: 77,
          upload_url: 'https://upload.example.test/video',
        },
      }),
    );
    const base = context();
    const result = await createTestPublisher(request, {
      resolveHostname: vi.fn(async () => [
        { address: '8.8.8.8', family: 4 as const },
        { address: '169.254.169.254', family: 4 as const },
      ]),
    }).publish!(base);

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_DNS_UNSAFE' },
      evidence: { remoteOwnerId: '-54321', remoteMediaId: '77' },
    });
    expect(base.media.openReadStream).not.toHaveBeenCalled();
  });

  test('aborts and awaits DNS, source-open, and upload cleanup and closes the media source', async () => {
    const save = vi.fn(async () =>
      jsonResponse({
        response: {
          owner_id: -54321,
          video_id: 77,
          upload_url: 'https://upload.example.test/video',
        },
      }),
    );
    const base = context();
    let activeDns = 0;
    let dnsSignal: AbortSignal | undefined;
    const dnsResult = await createTestPublisher(save, {
      dnsTimeoutMs: 10,
      resolveHostname: vi.fn(
        (_hostname, signal) =>
          new Promise<readonly { address: string; family: 4 | 6 }[]>((_resolve, reject) => {
            activeDns += 1;
            dnsSignal = signal;
            signal.addEventListener(
              'abort',
              () => {
                queueMicrotask(() => {
                  activeDns -= 1;
                  reject(new Error('DNS aborted'));
                });
              },
              { once: true },
            );
          }),
      ),
    }).publish!(base);
    expect(dnsResult).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_DNS_TIMEOUT' },
    });
    expect(dnsSignal?.aborted).toBe(true);
    expect(activeDns).toBe(0);
    expect(base.media.openReadStream).not.toHaveBeenCalled();

    let activeSourceOpens = 0;
    let sourceOpenSignal: AbortSignal | undefined;
    const sourceOpenResult = await createTestPublisher(save, {
      uploadTimeoutMs: 10,
    }).publish!(
      context({
        media: {
          ...base.media,
          openReadStream: vi.fn(
            ({ signal }) =>
              new Promise<Readable>((_resolve, reject) => {
                activeSourceOpens += 1;
                sourceOpenSignal = signal;
                signal.addEventListener(
                  'abort',
                  () => {
                    queueMicrotask(() => {
                      activeSourceOpens -= 1;
                      reject(new Error('source open aborted'));
                    });
                  },
                  { once: true },
                );
              }),
          ),
        },
      }),
    );
    expect(sourceOpenResult).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_TIMEOUT' },
    });
    expect(sourceOpenSignal?.aborted).toBe(true);
    expect(activeSourceOpens).toBe(0);

    const source = new Readable({ read() {} });
    let activeUploads = 0;
    let uploadSignal: AbortSignal | undefined;
    const uploadBase = context({
      media: {
        ...base.media,
        openReadStream: vi.fn(async () => source),
      },
    });
    const uploadResult = await createTestPublisher(save, {
      uploadTimeoutMs: 10,
      uploadTransport: vi.fn(
        ({ signal }) =>
          new Promise<Response>((_resolve, reject) => {
            activeUploads += 1;
            uploadSignal = signal;
            signal.addEventListener(
              'abort',
              () => {
                queueMicrotask(() => {
                  activeUploads -= 1;
                  reject(new Error('upload aborted'));
                });
              },
              { once: true },
            );
          }),
      ),
    }).publish!(uploadBase);
    expect(uploadResult).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_TIMEOUT' },
    });
    expect(uploadSignal?.aborted).toBe(true);
    expect(activeUploads).toBe(0);
    expect(source.destroyed).toBe(true);
    expect(source.closed).toBe(true);
  });

  test('cancels a delayed acquired upload response despite cleanup rejection and always disposes the upload deadline', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const parentListenerBaseline = getEventListeners(controller.signal, 'abort').length;
      let markUploadStarted: (() => void) | undefined;
      const uploadStarted = new Promise<void>((resolve) => {
        markUploadStarted = resolve;
      });
      const cancelResponseBody = vi.fn();
      const request = vi.fn(async () =>
        jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        }),
      );
      const pending = createTestPublisher(request, {
        uploadTimeoutMs: 10,
        uploadTransport: vi.fn(({ body, signal }) => {
          const originalDestroy = body.destroy.bind(body);
          body.destroy = vi.fn(((error?: Error) => {
            originalDestroy(error);
            throw new Error('multipart cleanup failed');
          }) as typeof body.destroy);
          markUploadStarted?.();
          return new Promise<Response>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                setTimeout(
                  () =>
                    resolve(
                      new Response(
                        new ReadableStream<Uint8Array>({
                          pull() {},
                          cancel() {
                            cancelResponseBody();
                          },
                        }),
                      ),
                    ),
                  20,
                );
              },
              { once: true },
            );
          });
        }),
      }).publish!(context({ signal: controller.signal }));
      const rejection = expect(pending).rejects.toBeInstanceOf(TransportTeardownUnconfirmedError);

      await uploadStarted;
      await vi.advanceTimersByTimeAsync(30);
      await rejection;

      expect(cancelResponseBody).toHaveBeenCalledOnce();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(parentListenerBaseline);
    } finally {
      vi.useRealTimers();
    }
  });

  test('consumes a delayed upload rejection across the abort and cleanup-failure race', async () => {
    const controller = new AbortController();
    let markUploadStarted: (() => void) | undefined;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const request = vi.fn(async () =>
        jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        }),
      );
      const pending = createTestPublisher(request, {
        uploadTransport: vi.fn(({ body, signal }) => {
          const originalDestroy = body.destroy.bind(body);
          body.destroy = vi.fn(((error?: Error) => {
            originalDestroy(error);
            throw new Error('multipart cleanup failed');
          }) as typeof body.destroy);
          markUploadStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => queueMicrotask(() => reject(new Error('late upload rejection'))),
              { once: true },
            );
          });
        }),
      }).publish!(context({ signal: controller.signal }));
      const rejection = expect(pending).rejects.toBeInstanceOf(TransportTeardownUnconfirmedError);

      await uploadStarted;
      controller.abort(new Error('publication canceled'));
      await rejection;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  test('aborts the response reader and awaits body cancellation before returning', async () => {
    let activeReaders = 0;
    const cancel = vi.fn();
    const request = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              activeReaders += 1;
            },
            pull() {},
            cancel(reason) {
              cancel(reason);
              return new Promise<void>((resolve) => {
                queueMicrotask(() => {
                  activeReaders -= 1;
                  resolve();
                });
              });
            },
          }),
        ),
    );
    const result = await createTestPublisher(request, { responseReadTimeoutMs: 10 }).publish!(
      context(),
    );

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_SAVE_RESPONSE_MALFORMED' },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(activeReaders).toBe(0);
  });

  test('awaits delayed reconciliation request closure on timeout', async () => {
    let activeOperationCount = 0;
    let operationsAfterReturn = 0;
    let returned = false;
    const request = vi.fn(
      (_input: FetchInput, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('request signal is required');
          activeOperationCount += 1;
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                if (returned) operationsAfterReturn += 1;
                activeOperationCount -= 1;
                reject(new Error('socket closed after abort'));
              }, 20);
            },
            { once: true },
          );
        }),
    );
    const base = context();

    const result = await createTestPublisher(request, { getTimeoutMs: 10 }).reconcile({
      ...base,
      evidence: acceptedEvidence(),
    });
    returned = true;

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'VK_VERIFY_NETWORK' },
    });
    expect(activeOperationCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(operationsAfterReturn).toBe(0);
  });

  test('remains unsettled past the teardown bound until a delayed request actually closes', async () => {
    vi.useFakeTimers();
    try {
      let activeRequests = 0;
      let providerSettled = false;
      const request = vi.fn(
        (_input: FetchInput, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('request signal is required');
            activeRequests += 1;
            signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  activeRequests -= 1;
                  reject(new Error('socket finally closed'));
                }, 1_500);
              },
              { once: true },
            );
          }),
      );
      const base = context();
      const pending = createTestPublisher(request, { getTimeoutMs: 10 })
        .reconcile({ ...base, evidence: acceptedEvidence() })
        .finally(() => {
          providerSettled = true;
        });
      const rejection = expect(pending).rejects.toBeInstanceOf(TransportTeardownUnconfirmedError);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(activeRequests).toBe(1);
      expect(providerSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(410);
      await rejection;
      expect(activeRequests).toBe(0);
      expect(providerSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('stops delayed media reads and multipart writes across a source-error and abort race', async () => {
    const controller = new AbortController();
    let activeOperationCount = 0;
    let sourceReads = 0;
    let multipartWrites = 0;
    let started = false;
    const source = new Readable({
      read() {
        sourceReads += 1;
        if (started) return;
        started = true;
        this.push(Buffer.from('abc'));
        queueMicrotask(() => {
          controller.abort(new Error('publication aborted'));
          this.destroy(new Error('source failed'));
        });
      },
      destroy(error, done) {
        setTimeout(() => {
          activeOperationCount -= 1;
          done(error);
        }, 20);
      },
    });
    activeOperationCount += 1;
    const request = vi.fn(async (input: FetchInput) => {
      if (String(input).endsWith('/video.save'))
        return jsonResponse({
          response: {
            owner_id: -54321,
            video_id: 77,
            upload_url: 'https://upload.example.test/video',
          },
        });
      throw new Error('unexpected API request');
    });
    const base = context({
      signal: controller.signal,
      media: {
        sizeBytes: 6,
        contentType: 'video/mp4',
        openReadStream: vi.fn(async () => source),
      },
    });
    const publisher = createTestPublisher(request, {
      uploadTransport: vi.fn(async ({ body }) => {
        for await (const chunk of body) {
          void chunk;
          multipartWrites += 1;
        }
        return jsonResponse({ video_id: 77, size: 6 });
      }),
    });

    const result = await publisher.publish!(base);

    expect(result).toMatchObject({
      kind: 'ambiguous',
      failure: { code: 'VK_UPLOAD_NETWORK' },
    });
    expect(activeOperationCount).toBe(0);
    const readsAtReturn = sourceReads;
    const writesAtReturn = multipartWrites;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sourceReads).toBe(readsAtReturn);
    expect(multipartWrites).toBe(writesAtReturn);
  });

  test.each(['', '0', '-54321', '054321', '9007199254740992'])(
    'rejects non-canonical configured group ID %s',
    (groupId) => {
      expect(() => createVKVideoPublisher({ groupId })).toThrow('VK group ID is invalid');
    },
  );
});
