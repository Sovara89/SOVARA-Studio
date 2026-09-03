import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable, Writable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import {
  closePinnedHttpsResponse,
  isPublicAddress,
  PinnedHttpsError,
  postPinnedHttps,
  resolvePinnedHttpsTarget,
  TransportTeardownUnconfirmedError,
} from './pinned-https.js';

describe('pinned HTTPS upload transport', () => {
  test.each([
    ['127.0.0.1', 4],
    ['10.4.5.6', 4],
    ['169.254.169.254', 4],
    ['192.168.1.1', 4],
    ['198.51.100.3', 4],
    ['::1', 6],
    ['::2', 6],
    ['::ffff:8.8.8.8', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['2001:db8::1', 6],
    ['3fff::1', 6],
  ] as const)('rejects non-public address %s', (address, family) => {
    expect(isPublicAddress(address, family)).toBe(false);
  });

  test.each([
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['2001:4860:4860::8888', 6],
    ['2606:4700:4700::1111', 6],
  ] as const)('accepts globally routable address %s', (address, family) => {
    expect(isPublicAddress(address, family)).toBe(true);
  });

  test('rejects the complete DNS result when any answer is unsafe', async () => {
    await expect(
      resolvePinnedHttpsTarget({
        url: new URL('https://upload.example/video'),
        signal: new AbortController().signal,
        resolve: vi.fn(async () => [
          { address: '8.8.8.8', family: 4 as const },
          { address: '127.0.0.1', family: 4 as const },
        ]),
      }),
    ).rejects.toMatchObject({ code: 'DNS_UNSAFE' } satisfies Partial<PinnedHttpsError>);
  });

  test('aborts DNS resolution and awaits resolver teardown before rejecting', async () => {
    const controller = new AbortController();
    let activeResolutions = 0;
    const pending = resolvePinnedHttpsTarget({
      url: new URL('https://upload.example/video'),
      signal: controller.signal,
      resolve: (_hostname, signal) =>
        new Promise((_resolve, reject) => {
          activeResolutions += 1;
          signal.addEventListener(
            'abort',
            () => {
              queueMicrotask(() => {
                activeResolutions -= 1;
                reject(new Error('resolver closed'));
              });
            },
            { once: true },
          );
        }),
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(activeResolutions).toBe(0);
  });

  test('pins the validated address in the actual socket lookup while preserving TLS and Host names', async () => {
    let capturedOptions: RequestOptions | undefined;
    const request = vi.fn(
      (_url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        capturedOptions = options;
        const sink = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            const response = Readable.from([Buffer.from('{"ok":true}')]) as IncomingMessage;
            response.statusCode = 200;
            response.rawHeaders = ['content-type', 'application/json'];
            callback(response);
            done();
          },
        });
        return sink as ClientRequest;
      },
    );

    const response = await postPinnedHttps({
      target: {
        url: new URL('https://upload.example/video?opaque=value'),
        address: '8.8.8.8',
        family: 4,
      },
      headers: { 'content-length': '3' },
      body: Readable.from([Buffer.from('abc')]),
      signal: new AbortController().signal,
      request,
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledOnce();
    expect(capturedOptions).toMatchObject({
      agent: false,
      family: 4,
      servername: 'upload.example',
      headers: { host: 'upload.example', 'content-length': '3' },
    });
    const lookup = capturedOptions?.lookup as unknown as (
      hostname: string,
      options: object,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) =>
      lookup('rebinding.example', {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      }),
    );
    expect(resolved).toEqual({ address: '8.8.8.8', family: 4 });
  });

  test('destroys and awaits the active request and upload body on abort', async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    let activeRequests = 0;
    let clientRequest: Writable | undefined;
    const request = vi.fn(() => {
      activeRequests += 1;
      clientRequest = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      clientRequest.once('close', () => {
        activeRequests -= 1;
      });
      return clientRequest as ClientRequest;
    });
    const pending = postPinnedHttps({
      target: {
        url: new URL('https://upload.example/video'),
        address: '8.8.8.8',
        family: 4,
      },
      headers: { 'content-length': '3' },
      body,
      signal: controller.signal,
      request,
    });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(activeRequests).toBe(0);
    expect(clientRequest?.destroyed).toBe(true);
    expect(body.destroyed).toBe(true);
    expect(body.closed).toBe(true);
  });

  test('confirms delayed request, socket, and source closure across an error and abort race', async () => {
    const controller = new AbortController();
    let activeOperationCount = 0;
    let sourceReads = 0;
    let requestWrites = 0;
    const body = new Readable({
      read() {
        sourceReads += 1;
        this.push(Buffer.from('abc'));
      },
      destroy(_error, done) {
        setTimeout(() => {
          activeOperationCount -= 1;
          done();
        }, 20);
      },
    });
    activeOperationCount += 1;
    const socket = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      destroy(_error, done) {
        setTimeout(() => {
          activeOperationCount -= 1;
          done();
        }, 20);
      },
    });
    activeOperationCount += 1;
    const request = vi.fn(() => {
      const sink = new Writable({
        write(_chunk, _encoding, done) {
          requestWrites += 1;
          queueMicrotask(() => controller.abort(new Error('concurrent abort')));
          done(new Error('request failed'));
        },
        destroy(_error, done) {
          setTimeout(() => {
            activeOperationCount -= 1;
            done();
          }, 20);
        },
      });
      activeOperationCount += 1;
      (sink as unknown as { socket: Writable }).socket = socket;
      return sink as ClientRequest;
    });

    await expect(
      postPinnedHttps({
        target: {
          url: new URL('https://upload.example/video'),
          address: '8.8.8.8',
          family: 4,
        },
        headers: { 'content-length': '3' },
        body,
        signal: controller.signal,
        request,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(activeOperationCount).toBe(0);
    const readsAtReturn = sourceReads;
    const writesAtReturn = requestWrites;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sourceReads).toBe(readsAtReturn);
    expect(requestWrites).toBe(writesAtReturn);
  });

  test('does not surface a response failure until delayed response and socket teardown completes', async () => {
    let activeOperationCount = 0;
    const socket = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      destroy(_error, done) {
        setTimeout(() => {
          activeOperationCount -= 1;
          done();
        }, 20);
      },
    });
    activeOperationCount += 1;
    let responseStarted = false;
    const response = new Readable({
      read() {
        if (responseStarted) return;
        responseStarted = true;
        this.push(Buffer.from('{"ok":'));
        setTimeout(() => this.destroy(new Error('response failed')), 0);
      },
      destroy(error, done) {
        setTimeout(() => {
          activeOperationCount -= 1;
          done(error);
        }, 20);
      },
    }) as IncomingMessage;
    activeOperationCount += 1;
    response.statusCode = 200;
    response.rawHeaders = ['content-type', 'application/json'];
    const request = vi.fn(
      (_url: URL, _options: RequestOptions, callback: (value: IncomingMessage) => void) => {
        const sink = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            callback(response);
            done();
          },
          destroy(_error, done) {
            setTimeout(() => {
              activeOperationCount -= 1;
              done();
            }, 20);
          },
        });
        activeOperationCount += 1;
        (sink as unknown as { socket: Writable }).socket = socket;
        return sink as ClientRequest;
      },
    );

    const webResponse = await postPinnedHttps({
      target: {
        url: new URL('https://upload.example/video'),
        address: '8.8.8.8',
        family: 4,
      },
      headers: { 'content-length': '3' },
      body: Readable.from([Buffer.from('abc')]),
      signal: new AbortController().signal,
      request,
    });

    await expect(webResponse.json()).rejects.toBeInstanceOf(Error);
    expect(activeOperationCount).toBe(0);
  });

  test('runs every teardown step and keeps teardown idempotent when response cleanup rejects', async () => {
    const socket = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const response = new Readable({ read() {} }) as IncomingMessage;
    response.statusCode = 200;
    response.rawHeaders = [];
    let clientRequest: Writable | undefined;
    const request = vi.fn(
      (_url: URL, _options: RequestOptions, callback: (value: IncomingMessage) => void) => {
        clientRequest = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            callback(response);
            done();
          },
        });
        (clientRequest as unknown as { socket: Writable }).socket = socket;
        return clientRequest as ClientRequest;
      },
    );
    const webResponse = await postPinnedHttps({
      target: {
        url: new URL('https://upload.example/video'),
        address: '8.8.8.8',
        family: 4,
      },
      headers: { 'content-length': '3' },
      body: Readable.from([Buffer.from('abc')]),
      signal: new AbortController().signal,
      request,
    });
    const originalDestroy = response.destroy.bind(response);
    const responseDestroy = vi.fn(((error?: Error) => {
      originalDestroy(error);
      throw new Error('response destroy failed');
    }) as typeof response.destroy);
    response.destroy = responseDestroy;
    const acquiredRequest = clientRequest;
    if (!acquiredRequest) throw new Error('request was not acquired');
    const socketListenersBefore = acquiredRequest.listenerCount('socket');
    const errorListenersBefore = acquiredRequest.listenerCount('error');

    await expect(closePinnedHttpsResponse(webResponse)).rejects.toBeInstanceOf(
      TransportTeardownUnconfirmedError,
    );
    await expect(closePinnedHttpsResponse(webResponse)).rejects.toBeInstanceOf(
      TransportTeardownUnconfirmedError,
    );

    expect(responseDestroy).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    expect(socket.closed).toBe(true);
    expect(acquiredRequest.listenerCount('socket')).toBe(socketListenersBefore - 1);
    expect(acquiredRequest.listenerCount('error')).toBe(errorListenersBefore - 1);
  });

  test('stays unsettled past the teardown bound until an unclosed request actually closes', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const request = vi.fn(
        () =>
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
            destroy() {
              // Deliberately non-cooperative: the transport must report, not conceal, this defect.
            },
          }) as ClientRequest,
      );
      let settled = false;
      const pending = postPinnedHttps({
        target: {
          url: new URL('https://upload.example/video'),
          address: '8.8.8.8',
          family: 4,
        },
        headers: { 'content-length': '3' },
        body: new Readable({ read() {} }),
        signal: controller.signal,
        request,
      }).finally(() => {
        settled = true;
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(TransportTeardownUnconfirmedError);
      const clientRequest = request.mock.results[0]?.value;
      const closeListenersBefore = clientRequest?.listenerCount('close');
      const socketListenersBefore = clientRequest?.listenerCount('socket');
      const errorListenersBefore = clientRequest?.listenerCount('error');

      controller.abort();
      await vi.advanceTimersByTimeAsync(1_001);

      expect(settled).toBe(false);
      clientRequest?.emit('error', new Error('request finally aborted'));
      clientRequest?.emit('close');
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      expect(settled).toBe(true);
      expect(clientRequest?.listenerCount('close')).toBeLessThan(closeListenersBefore ?? 1);
      expect(clientRequest?.listenerCount('socket')).toBe((socketListenersBefore ?? 1) - 1);
      expect(clientRequest?.listenerCount('error')).toBeLessThan(errorListenersBefore ?? 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
