import { describe, expect, test, vi } from 'vitest';
import { DirectPutError, uploadPartDirectly } from './s3-upload-transport';

class FakeXHR {
  static instances: FakeXHR[] = [];
  static nextStatus = 200;
  static nextEtag: string | null = '"opaque"';
  static autoComplete = true;
  upload = {
    onprogress: (event: ProgressEvent) => {
      void event;
    },
  };
  onload = () => undefined;
  onerror = () => undefined;
  onabort = () => undefined;
  ontimeout = () => undefined;
  status = FakeXHR.nextStatus;
  withCredentials = true;
  sent?: Blob;
  method?: string;
  url?: string;
  async?: boolean;
  headers = new Map<string, string>();
  constructor() {
    if (FakeXHR.nextEtag) this.headers.set('ETag', FakeXHR.nextEtag);
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string, async: boolean) {
    this.method = method;
    this.url = url;
    this.async = async;
  }
  getResponseHeader(name: string) {
    return this.headers.get(name) ?? null;
  }
  abort() {
    this.onabort();
  }
  send(body: Blob) {
    this.sent = body;
    if (FakeXHR.autoComplete) queueMicrotask(() => this.onload());
  }
}

describe('uploadPartDirectly', () => {
  test('uses the exact URL and PUT without credentials or headers', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.instances = [];
    const blob = new Blob(['part']);
    const result = await uploadPartDirectly({
      url: 'https://storage.example/signed?x=1',
      body: blob,
    });
    const xhr = FakeXHR.instances[0]!;
    expect(result.etag).toBe('"opaque"');
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://storage.example/signed?x=1');
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.sent).toBe(blob);
    vi.unstubAllGlobals();
  });

  test('forwards upload progress and preserves opaque quoted ETag', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.instances = [];
    const progress = vi.fn();
    const promise = uploadPartDirectly({
      url: 'url',
      body: new Blob(['part']),
      onProgress: progress,
    });
    await Promise.resolve();
    FakeXHR.instances[0]!.upload.onprogress({
      loaded: 3,
      total: 4,
      lengthComputable: true,
    } as ProgressEvent);
    expect(await promise).toEqual({ etag: '"opaque"' });
    expect(progress).toHaveBeenCalledWith(3, 4);
    vi.unstubAllGlobals();
  });

  test('rejects non-200 and missing ETag', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.nextStatus = 500;
    await expect(uploadPartDirectly({ url: 'url', body: new Blob(['x']) })).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
    FakeXHR.nextStatus = 200;
    FakeXHR.nextEtag = null;
    await expect(uploadPartDirectly({ url: 'url', body: new Blob(['x']) })).rejects.toBeInstanceOf(
      DirectPutError,
    );
    FakeXHR.nextEtag = '"opaque"';
    vi.unstubAllGlobals();
  });

  test('aborts on signal and on inactivity without a short total timeout', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.autoComplete = false;
    const controller = new AbortController();
    const aborted = uploadPartDirectly({
      url: 'url',
      body: new Blob(['x']),
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ kind: 'aborted' });

    vi.useFakeTimers();
    const inactive = uploadPartDirectly({
      url: 'url',
      body: new Blob(['x']),
      inactivityTimeoutMs: 60_000,
    });
    const inactiveExpectation = expect(inactive).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(FakeXHR.instances.at(-1)?.onabort).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(1);
    await inactiveExpectation;
    vi.useRealTimers();
    FakeXHR.autoComplete = true;
    vi.unstubAllGlobals();
  });
});
