export type DirectPutProgress = (loadedBytes: number, totalBytes: number) => void;

export class DirectPutError extends Error {
  constructor(
    readonly kind: 'network' | 'http' | 'missing_etag' | 'timeout' | 'aborted',
    readonly status?: number,
    message = 'Direct storage upload failed',
  ) {
    super(message);
    this.name = 'DirectPutError';
  }
}

export type DirectPutInput = {
  url: string;
  body: Blob;
  signal?: AbortSignal;
  onProgress?: DirectPutProgress;
  inactivityTimeoutMs?: number;
};

function abortError() {
  return new DirectPutError('aborted', undefined, 'Direct upload was cancelled');
}

export function uploadPartDirectly(input: DirectPutInput): Promise<{ etag: string }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    const timeout = input.inactivityTimeoutMs ?? 120_000;
    const finish = (error?: Error, value?: { etag: string }) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      input.signal?.removeEventListener('abort', onSignalAbort);
      if (error) reject(error);
      else resolve(value!);
    };
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        xhr.abort();
        finish(new DirectPutError('timeout', undefined, 'Direct upload became inactive'));
      }, timeout);
    };
    const onSignalAbort = () => {
      xhr.abort();
      finish(abortError());
    };
    xhr.open('PUT', input.url, true);
    xhr.withCredentials = false;
    xhr.upload.onprogress = (event) => {
      armWatchdog();
      input.onProgress?.(event.loaded, event.lengthComputable ? event.total : input.body.size);
    };
    xhr.onload = () => {
      if (xhr.status !== 200) {
        finish(new DirectPutError('http', xhr.status, `Storage upload failed (${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader('ETag');
      if (!etag) {
        finish(new DirectPutError('missing_etag', xhr.status, 'Storage did not return an ETag'));
        return;
      }
      finish(undefined, { etag });
    };
    xhr.onerror = () => finish(new DirectPutError('network'));
    xhr.ontimeout = () => finish(new DirectPutError('timeout'));
    xhr.onabort = () => {
      if (!settled && !timedOut) finish(abortError());
    };
    input.signal?.addEventListener('abort', onSignalAbort, { once: true });
    armWatchdog();
    xhr.send(input.body);
  });
}
