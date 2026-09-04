import { describe, expect, test, vi } from 'vitest';
import { DirectPutError } from '../../lib/s3-upload-transport';
import { UploadApiError } from '../../lib/upload-api';
import { computeResumeFingerprint } from './file-resume-fingerprint';
import { UploadCoordinator } from './upload-coordinator';

const status = {
  videoId: '00000000-0000-4000-8000-000000000001',
  uploadId: '00000000-0000-4000-8000-000000000002',
  state: 'active' as const,
  expectedSizeBytes: 12,
  partSizeBytes: 4,
  expectedPartCount: 3,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  revision: 0,
  maxConcurrency: 2,
  parts: [],
};
const sessions = () => ({ load: () => null, save: () => undefined, clear: vi.fn() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
function signedParts(uploadId: string) {
  return {
    uploadId,
    uploadRevision: 0,
    expiresAt: status.expiresAt,
    parts: [{ partNumber: 1, url: 'https://storage.test/1', expiresAt: status.expiresAt }],
  };
}
function signedAll(uploadId: string, input: { partNumbers: number[] }) {
  return {
    uploadId,
    uploadRevision: 0,
    expiresAt: status.expiresAt,
    parts: input.partNumbers.map((partNumber) => ({
      partNumber,
      url: `https://storage.test/${partNumber}`,
      expiresAt: status.expiresAt,
    })),
  };
}
function statusFor(videoId: string, uploadId: string) {
  return { ...status, videoId, uploadId };
}
function storedFor(videoId: string, uploadId: string, resumeFingerprint: string) {
  return { version: 1 as const, videoId, uploadId, resumeFingerprint };
}

describe('UploadCoordinator', () => {
  test('limits direct PUT concurrency and records every completed part', async () => {
    let active = 0;
    let peak = 0;
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(
        async (_videoId: string, uploadId: string, input: { partNumbers: number[] }) => ({
          uploadId,
          uploadRevision: 0,
          expiresAt: status.expiresAt,
          parts: input.partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://storage.test/${partNumber}`,
            expiresAt: status.expiresAt,
          })),
        }),
      ),
      recordPart: vi.fn(
        async (
          _videoId: string,
          _uploadId: string,
          partNumber: number,
          input: { etag: string; reportedSizeBytes: number },
        ) => ({
          partNumber,
          etag: input.etag,
          reportedSizeBytes: input.reportedSizeBytes,
          providerChecksumAlgorithm: null,
          providerChecksumValue: null,
          revision: 0,
        }),
      ),
      complete: vi.fn(async () => ({
        videoId: status.videoId,
        uploadId: status.uploadId,
        uploadState: 'completed',
        uploadRevision: 1,
        videoState: 'ready',
        videoRevision: 1,
        outcome: 'ready',
        retryable: false,
      })),
      abort: vi.fn(),
    };
    const transport = vi.fn(async ({ body }: { body: Blob }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { etag: `etag-${body.size}` };
    });
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      dispatch: vi.fn(),
      policy: { maxConcurrency: 2, retryMaxDelayMs: 1 },
      sessions: sessions(),
    });
    await coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    expect(peak).toBeLessThanOrEqual(2);
    expect(api.recordPart).toHaveBeenCalledTimes(3);
    expect(api.complete).toHaveBeenCalledWith(status.videoId, status.uploadId, status.revision);
    expect(coordinator.getState().phase).toBe('ready');
  });

  test('pause while signing discards the URL before slicing or PUT', async () => {
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof signedParts>>();
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async () => {
        started.resolve();
        return result.promise;
      }),
      recordPart: vi.fn(),
      abort: vi.fn(),
    };
    const transport = vi.fn();
    const file = new File([new Uint8Array(12)], 'video.mp4');
    const slice = vi.spyOn(file, 'slice');
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
    });
    const upload = coordinator.start(file);
    await started.promise;
    slice.mockClear();
    coordinator.pause();
    result.resolve(signedParts(status.uploadId));
    await upload;
    expect(slice).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(coordinator.getState().phase).toBe('paused');
  });

  test('cancel while signing only proceeds through server abort', async () => {
    const started = deferred<void>();
    const result = deferred<ReturnType<typeof signedParts>>();
    const abortStarted = deferred<void>();
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async () => {
        started.resolve();
        return result.promise;
      }),
      recordPart: vi.fn(),
      abort: vi.fn(async () => {
        abortStarted.resolve();
        return { ...status, state: 'aborted' as const };
      }),
    };
    const transport = vi.fn();
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
    });
    const upload = coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    await started.promise;
    const cancel = coordinator.cancel();
    await abortStarted.promise;
    result.resolve(signedParts(status.uploadId));
    await Promise.all([upload, cancel]);
    expect(transport).not.toHaveBeenCalled();
    expect(api.abort).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().phase).toBe('aborted');
  });

  test('does not server-abort when retries are exhausted', async () => {
    let attempts = 0;
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) => ({
        uploadId,
        uploadRevision: 0,
        expiresAt: status.expiresAt,
        parts: input.partNumbers.map((partNumber) => ({
          partNumber,
          url: 'https://storage.test/1',
          expiresAt: status.expiresAt,
        })),
      })),
      recordPart: vi.fn(
        async (
          _v: string,
          _u: string,
          partNumber: number,
          input: { etag: string; reportedSizeBytes: number },
        ) => ({
          partNumber,
          etag: input.etag,
          reportedSizeBytes: input.reportedSizeBytes,
          providerChecksumAlgorithm: null,
          providerChecksumValue: null,
          revision: 0,
        }),
      ),
      abort: vi.fn(),
    };
    const transport = vi.fn(
      async ({ onProgress, body }: { onProgress: (n: number, t: number) => void; body: Blob }) => {
        attempts += 1;
        onProgress(body.size, body.size);
        if (attempts === 1) throw new DirectPutError('network');
        return { etag: 'etag' };
      },
    );
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
      policy: { maxAttempts: 1 },
    });
    await coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    expect(coordinator.getState().phase).toBe('failed');
    expect(api.abort).not.toHaveBeenCalled();
  });
});

describe('UploadCoordinator authoritative cancel states', () => {
  const cases = [
    ['aborted', 'aborted', undefined],
    ['expired', 'failed', 'upload_expired'],
    ['abort_pending', 'cleanup_pending', 'provider_cleanup_pending'],
    ['completed', 'failed', 'invalid_state'],
  ] as const;
  test.each(cases)(
    'handles post-stale state %s without manufacturing abort success',
    async (authoritative, expectedPhase, category) => {
      const store = { ...sessions(), save: vi.fn() };
      const api = {
        getStatus: vi
          .fn()
          .mockResolvedValueOnce(status)
          .mockResolvedValueOnce({ ...status, state: authoritative }),
        abort: vi.fn().mockRejectedValue(new UploadApiError('STALE_REVISION', 409, 'stale')),
      };
      const coordinator = new UploadCoordinator({
        api: api as never,
        sessions: {
          ...store,
          load: () => ({
            version: 1 as const,
            videoId: status.videoId,
            uploadId: status.uploadId,
            resumeFingerprint: 'fingerprint',
          }),
        },
      });
      await coordinator.cancel();
      expect(coordinator.getState().phase).toBe(expectedPhase);
      if (authoritative === 'aborted') expect(store.clear).toHaveBeenCalledTimes(1);
      else expect(store.clear).not.toHaveBeenCalled();
      if (category) expect(coordinator.getState().error?.category).toBe(category);
    },
  );
});

describe('UploadCoordinator generation ownership', () => {
  test('ignores a stale rejected create without failing the newer run', async () => {
    const firstCreate = deferred<never>();
    const firstCreateStarted = deferred<void>();
    const transportStarted = deferred<void>();
    let currentSignal: AbortSignal | undefined;
    let createCalls = 0;
    const api = {
      createUpload: vi.fn(async () => {
        createCalls += 1;
        if (createCalls === 1) {
          firstCreateStarted.resolve();
          return firstCreate.promise;
        }
        return { videoId: status.videoId, upload: { ...status, parts: [] } };
      }),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) =>
        signedAll(uploadId, input),
      ),
      recordPart: vi.fn(),
      abort: vi.fn(),
    };
    const transport = vi.fn(({ signal }: { signal: AbortSignal }) => {
      currentSignal = signal;
      transportStarted.resolve();
      return new Promise<{ etag: string }>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DirectPutError('aborted')), {
          once: true,
        }),
      );
    });
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
      policy: { maxConcurrency: 1 },
    });
    const stale = coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    await firstCreateStarted.promise;
    const current = coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    await transportStarted.promise;
    firstCreate.reject(new Error('stale create failed'));
    await stale;
    expect(coordinator.getState().phase).toBe('uploading');
    expect(currentSignal?.aborted).toBe(false);
    coordinator.pause();
    await current;
  });

  test('ignores a stale rejected resume status without failing the newer run', async () => {
    const file = new File([new Uint8Array(12)], 'video.mp4');
    const fingerprint = await computeResumeFingerprint(file);
    const staleStatus = deferred<never>();
    const staleStatusStarted = deferred<void>();
    const transportStarted = deferred<void>();
    let statusCalls = 0;
    let currentSignal: AbortSignal | undefined;
    const statusB = statusFor(
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    );
    const api = {
      getStatus: vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          staleStatusStarted.resolve();
          return staleStatus.promise;
        }
        return statusB;
      }),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) =>
        signedAll(uploadId, input),
      ),
      recordPart: vi.fn(),
      abort: vi.fn(),
    };
    const transport = vi.fn(({ signal }: { signal: AbortSignal }) => {
      currentSignal = signal;
      transportStarted.resolve();
      return new Promise<{ etag: string }>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DirectPutError('aborted')), {
          once: true,
        }),
      );
    });
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
      policy: { maxConcurrency: 1 },
    });
    const stale = coordinator.resume(file, storedFor(status.videoId, status.uploadId, fingerprint));
    await staleStatusStarted.promise;
    const current = coordinator.resume(
      file,
      storedFor(statusB.videoId, statusB.uploadId, fingerprint),
    );
    await transportStarted.promise;
    staleStatus.reject(new Error('stale status failed'));
    await stale;
    expect(coordinator.getState().phase).toBe('uploading');
    expect(coordinator.getState().status?.videoId).toBe(statusB.videoId);
    expect(currentSignal?.aborted).toBe(false);
    coordinator.pause();
    await current;
  });

  test('discards a late cancel result without mutating the newer session', async () => {
    const cancelStatus = deferred<typeof status>();
    const cancelStatusStarted = deferred<void>();
    const aTransportStarted = deferred<void>();
    const abortStarted = deferred<void>();
    const abortResult = deferred<{ state: 'aborted'; videoId: string; uploadId: string }>();
    const bTransportStarted = deferred<void>();
    let createCalls = 0;
    let statusCalls = 0;
    let bSignal: AbortSignal | undefined;
    const statusB = statusFor(
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    );
    const store = { ...sessions(), save: vi.fn() };
    const api = {
      createUpload: vi.fn(async () => {
        createCalls += 1;
        return createCalls === 1
          ? { videoId: status.videoId, upload: { ...status, parts: [] } }
          : { videoId: statusB.videoId, upload: { ...statusB, parts: [] } };
      }),
      getStatus: vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls === 1) return status;
        if (statusCalls === 2) {
          cancelStatusStarted.resolve();
          return cancelStatus.promise;
        }
        return statusB;
      }),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) =>
        signedAll(uploadId, input),
      ),
      recordPart: vi.fn(),
      abort: vi.fn(async () => {
        abortStarted.resolve();
        return abortResult.promise;
      }),
    };
    const transport = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (createCalls > 1) {
        bSignal = signal;
        bTransportStarted.resolve();
      } else {
        aTransportStarted.resolve();
      }
      return new Promise<{ etag: string }>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DirectPutError('aborted')), {
          once: true,
        }),
      );
    });
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: store,
      policy: { maxConcurrency: 1 },
    });
    const a = coordinator.start(new File([new Uint8Array(12)], 'a.mp4'));
    await aTransportStarted.promise;
    const cancel = coordinator.cancel();
    await cancelStatusStarted.promise;
    cancelStatus.resolve(status);
    await abortStarted.promise;
    const b = coordinator.start(new File([new Uint8Array(12)], 'b.mp4'));
    await bTransportStarted.promise;
    abortResult.resolve({ ...status, state: 'aborted' });
    await cancel;
    expect(coordinator.getState().phase).toBe('uploading');
    expect(coordinator.getState().status?.videoId).toBe(statusB.videoId);
    expect(coordinator.getStoredSession()?.videoId).toBe(statusB.videoId);
    expect(store.clear).not.toHaveBeenCalled();
    expect(bSignal?.aborted).toBe(false);
    coordinator.pause();
    await Promise.all([a, b]);
  });

  test('stale run cleanup cannot clear the newer running owner', async () => {
    const firstRecord = deferred<unknown>();
    const firstRecordStarted = deferred<void>();
    const bTransportStarted = deferred<void>();
    let createCalls = 0;
    let recordCalls = 0;
    let bSignal: AbortSignal | undefined;
    const statusB = statusFor(
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    );
    const api = {
      createUpload: vi.fn(async () => {
        createCalls += 1;
        return createCalls === 1
          ? { videoId: status.videoId, upload: { ...status, parts: [] } }
          : { videoId: statusB.videoId, upload: { ...statusB, parts: [] } };
      }),
      getStatus: vi.fn(async () => (createCalls === 1 ? status : statusB)),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) =>
        signedAll(uploadId, input),
      ),
      recordPart: vi.fn(async () => {
        recordCalls += 1;
        if (recordCalls === 1) {
          firstRecordStarted.resolve();
          return firstRecord.promise;
        }
        return {};
      }),
      abort: vi.fn(),
    };
    const transport = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (createCalls > 1) {
        bSignal = signal;
        bTransportStarted.resolve();
        return new Promise<{ etag: string }>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DirectPutError('aborted')), {
            once: true,
          }),
        );
      }
      return Promise.resolve({ etag: 'etag-a' });
    });
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
      policy: { maxConcurrency: 1 },
    });
    const a = coordinator.start(new File([new Uint8Array(12)], 'a.mp4'));
    await firstRecordStarted.promise;
    const b = coordinator.start(new File([new Uint8Array(12)], 'b.mp4'));
    await bTransportStarted.promise;
    firstRecord.resolve({});
    await a;
    expect(coordinator.getState().phase).toBe('uploading');
    coordinator.pause();
    expect(bSignal?.aborted).toBe(true);
    await b;
  });
});

describe('UploadCoordinator late async results', () => {
  test('does not persist a late create result and cleans up the remote upload', async () => {
    const createStarted = deferred<void>();
    const createResult = deferred<{ videoId: string; upload: typeof status }>();
    const store = { ...sessions(), save: vi.fn() };
    const api = {
      createUpload: vi.fn(async () => {
        createStarted.resolve();
        return createResult.promise;
      }),
      getStatus: vi.fn(async () => status),
      abort: vi.fn(async () => ({ ...status, state: 'aborted' as const })),
      signParts: vi.fn(),
      recordPart: vi.fn(),
    };
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: vi.fn() as never,
      sessions: store,
    });
    const upload = coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    await createStarted.promise;
    const cancel = coordinator.cancel();
    createResult.resolve({ videoId: status.videoId, upload: status });
    await Promise.all([upload, cancel]);
    expect(store.save).not.toHaveBeenCalled();
    expect(api.abort).toHaveBeenCalledTimes(1);
    expect(api.signParts).not.toHaveBeenCalled();
    expect(coordinator.getState().phase).toBe('aborted');
  });

  test('does not apply a late record acknowledgement to a paused operation', async () => {
    const recordStarted = deferred<void>();
    const recordResult = deferred<unknown>();
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) => ({
        uploadId,
        uploadRevision: 0,
        expiresAt: status.expiresAt,
        parts: input.partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://storage.test/${partNumber}`,
          expiresAt: status.expiresAt,
        })),
      })),
      recordPart: vi.fn(async () => {
        recordStarted.resolve();
        return recordResult.promise;
      }),
      abort: vi.fn(),
    };
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: vi.fn(async () => ({ etag: 'etag' })) as never,
      sessions: sessions(),
      policy: { maxConcurrency: 1 },
    });
    const upload = coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    await recordStarted.promise;
    coordinator.pause();
    recordResult.resolve({});
    await upload;
    expect(coordinator.getState().phase).toBe('paused');
    expect(coordinator.getState().confirmedBytes).toBe(0);
  });
});

describe('UploadCoordinator retry and authoritative resume', () => {
  test('retries the same part and confirms its bytes exactly once', async () => {
    let firstPartAttempt = true;
    const putUrls: string[] = [];
    const api = {
      createUpload: vi.fn(async () => ({
        videoId: status.videoId,
        upload: { ...status, parts: [] },
      })),
      getStatus: vi.fn(async () => status),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) => ({
        uploadId,
        uploadRevision: 0,
        expiresAt: status.expiresAt,
        parts: input.partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://storage.test/${partNumber}`,
          expiresAt: status.expiresAt,
        })),
      })),
      recordPart: vi.fn(
        async (
          _v: string,
          _u: string,
          partNumber: number,
          input: { etag: string; reportedSizeBytes: number },
        ) => ({
          partNumber,
          etag: input.etag,
          reportedSizeBytes: input.reportedSizeBytes,
          providerChecksumAlgorithm: null,
          providerChecksumValue: null,
          revision: 0,
        }),
      ),
      abort: vi.fn(),
    };
    const transport = vi.fn(
      async ({
        url,
        onProgress,
        body,
      }: {
        url: string;
        onProgress: (n: number, t: number) => void;
        body: Blob;
      }) => {
        putUrls.push(url);
        if (url.endsWith('/1') && firstPartAttempt) {
          firstPartAttempt = false;
          onProgress(2, body.size);
          throw new DirectPutError('network');
        }
        onProgress(body.size, body.size);
        return { etag: 'etag' };
      },
    );
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: transport as never,
      sessions: sessions(),
      policy: { maxAttempts: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0 },
    });
    await coordinator.start(new File([new Uint8Array(12)], 'video.mp4'));
    expect(putUrls.filter((url) => url.endsWith('/1'))).toHaveLength(2);
    expect(coordinator.getState().confirmedBytes).toBe(12);
    expect(coordinator.getState().inFlightBytes).toEqual({});
  });

  test('skips authoritative recorded parts and signs only missing parts', async () => {
    const file = new File([new Uint8Array(12)], 'video.mp4');
    const fingerprint = await computeResumeFingerprint(file);
    const authoritative = {
      ...status,
      expectedPartCount: 4,
      partSizeBytes: 3,
      parts: [1, 3].map((partNumber) => ({
        partNumber,
        etag: `etag-${partNumber}`,
        reportedSizeBytes: 3,
        providerChecksumAlgorithm: null,
        providerChecksumValue: null,
        revision: 1,
      })),
    };
    const requested: number[] = [];
    const api = {
      getStatus: vi.fn(async () => authoritative),
      signParts: vi.fn(async (_v: string, uploadId: string, input: { partNumbers: number[] }) => {
        requested.push(...input.partNumbers);
        return {
          uploadId,
          uploadRevision: 1,
          expiresAt: status.expiresAt,
          parts: input.partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://storage.test/${partNumber}`,
            expiresAt: status.expiresAt,
          })),
        };
      }),
      recordPart: vi.fn(
        async (
          _v: string,
          _u: string,
          partNumber: number,
          input: { etag: string; reportedSizeBytes: number },
        ) => ({
          partNumber,
          etag: input.etag,
          reportedSizeBytes: input.reportedSizeBytes,
          providerChecksumAlgorithm: null,
          providerChecksumValue: null,
          revision: 2,
        }),
      ),
      abort: vi.fn(),
    };
    const coordinator = new UploadCoordinator({
      api: api as never,
      transport: vi.fn(async () => ({ etag: 'etag' })) as never,
      sessions: {
        load: () => ({
          version: 1 as const,
          videoId: status.videoId,
          uploadId: status.uploadId,
          resumeFingerprint: fingerprint,
        }),
        save: () => undefined,
        clear: () => undefined,
      },
    });
    await coordinator.resume(file);
    expect(requested.sort()).toEqual([2, 4]);
    expect(coordinator.getState().confirmedBytes).toBe(file.size);
  });
});
