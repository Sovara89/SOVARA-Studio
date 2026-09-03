import { Resolver } from 'node:dns/promises';
import { request as nodeHttpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
const ABORT_TEARDOWN_TIMEOUT_MS = 1_000;

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedIpv4.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blockedIpv6.addSubnet(network, prefix, 'ipv6');

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type PinnedHttpsTarget = {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
};

export type ResolveHostname = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

export class PinnedHttpsError extends Error {
  constructor(readonly code: 'DNS_FAILED' | 'DNS_UNSAFE' | 'UPLOAD_FAILED') {
    super(code);
    this.name = 'PinnedHttpsError';
  }
}

export class TransportTeardownUnconfirmedError extends Error {
  constructor(
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(`Transport teardown was not confirmed (${operation})`, options);
    this.name = 'TransportTeardownUnconfirmedError';
  }
}

function abortError() {
  const error = new Error('Operation aborted');
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
      // Timing out confirms only that teardown is slow. It must never be reported as completed
      // while a request, response, socket, or stream owned by this transport is still active.
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
  steps: ReadonlyArray<() => unknown | Promise<unknown>>,
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

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const settlement = promise.then<Settlement<T>, Settlement<T>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
  if (signal.aborted) {
    await waitForBoundedTeardown(settlement, 'aborted operation');
    throw abortError();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ status: 'aborted' }>((resolve) => {
    onAbort = () => resolve({ status: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([settlement, aborted]);
    if (result.status === 'aborted' || signal.aborted) {
      await waitForBoundedTeardown(settlement, 'aborted operation');
      throw abortError();
    }
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export const resolveHostname: ResolveHostname = async (hostname, signal) => {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const settled = await raceAbort(
      Promise.allSettled([
        resolver.resolve4(hostname, { ttl: true }),
        resolver.resolve6(hostname, { ttl: true }),
      ]),
      signal,
    );
    const addresses: ResolvedAddress[] = [];
    const ipv4 = settled[0];
    const ipv6 = settled[1];
    if (ipv4.status === 'fulfilled')
      addresses.push(
        ...ipv4.value.map((entry) => ({ address: entry.address, family: 4 as const })),
      );
    if (ipv6.status === 'fulfilled')
      addresses.push(
        ...ipv6.value.map((entry) => ({ address: entry.address, family: 6 as const })),
      );
    if (addresses.length === 0) throw new PinnedHttpsError('DNS_FAILED');
    return addresses;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

export function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) return !blockedIpv4.check(address, 'ipv4');
  const firstHextet = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
  if (!Number.isInteger(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return false;
  return !blockedIpv6.check(address, 'ipv6');
}

export async function resolvePinnedHttpsTarget(input: {
  url: URL;
  signal: AbortSignal;
  resolve?: ResolveHostname;
}): Promise<PinnedHttpsTarget> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await raceAbort(
      (input.resolve ?? resolveHostname)(input.url.hostname, input.signal),
      input.signal,
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof PinnedHttpsError) throw error;
    throw new PinnedHttpsError('DNS_FAILED');
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => !isPublicAddress(address, family))
  )
    throw new PinnedHttpsError('DNS_UNSAFE');
  const unique = new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry]));
  const selected = unique.values().next().value as ResolvedAddress | undefined;
  if (!selected) throw new PinnedHttpsError('DNS_FAILED');
  return { url: input.url, address: selected.address, family: selected.family };
}

type HttpsRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: import('node:http').IncomingMessage) => void,
) => import('node:http').ClientRequest;

const pinnedResponseTeardown = new WeakMap<Response, () => Promise<void>>();

export async function closePinnedHttpsResponse(response: Response): Promise<boolean> {
  const close = pinnedResponseTeardown.get(response);
  if (!close) return false;
  await close();
  return true;
}

function waitForClose(
  stream: NodeJS.EventEmitter & { closed?: boolean; destroyed?: boolean },
  operation: string,
): Promise<void> {
  if (stream.closed) return Promise.resolve();
  let onClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
    stream.once('close', onClose);
    if (stream.closed) onClose();
  });
  return waitForBoundedTeardown(closed, operation).finally(() => {
    if (onClose) stream.removeListener('close', onClose);
  });
}

export async function postPinnedHttps(input: {
  target: PinnedHttpsTarget;
  headers: Readonly<Record<string, string>>;
  body: Readable;
  signal: AbortSignal;
  request?: HttpsRequest;
}): Promise<Response> {
  const { target } = input;
  const request = input.request ?? (nodeHttpsRequest as HttpsRequest);
  let responseStream: import('node:http').IncomingMessage | undefined;
  let clientRequest: import('node:http').ClientRequest | undefined;
  let socket: import('node:net').Socket | undefined;
  let pipelinePromise: Promise<void> | undefined;
  let teardownPromise: Promise<void> | undefined;
  let teardownStarted = false;
  let rejectForAbort: ((reason: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const captureSocket = (connectedSocket: import('node:net').Socket) => {
    socket = connectedSocket;
    if (teardownStarted) connectedSocket.destroy();
  };
  let rejectResponse: ((reason?: unknown) => void) | undefined;
  const responsePromise = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    rejectResponse = reject;
    clientRequest = request(
      target.url,
      {
        method: 'POST',
        headers: { ...input.headers, host: target.url.host },
        agent: false,
        family: target.family,
        servername: target.url.hostname,
        signal: input.signal,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      },
      (response) => {
        responseStream = response;
        if (teardownStarted) response.destroy();
        resolve(response);
      },
    );
    clientRequest.once('socket', captureSocket);
    if (clientRequest.socket) socket = clientRequest.socket;
    clientRequest.once('error', reject);
  });
  const teardown = () => {
    if (teardownPromise) return teardownPromise;
    teardownStarted = true;
    // Defer execution until after teardownPromise is assigned so synchronous destroy/error events
    // cannot recursively create a second teardown.
    teardownPromise = Promise.resolve().then(async () => {
      try {
        const initialResponse = responseStream;
        const destruction = runTeardownSteps(
          [
            () => input.body.destroy(),
            () => initialResponse?.destroy(),
            () => clientRequest?.destroy(),
            () => socket?.destroy(),
          ],
          'HTTPS transport destruction',
        );

        const pipelineSettlement = pipelinePromise?.then(
          () => undefined,
          () => undefined,
        );
        const firstPhase = await Promise.allSettled([
          destruction,
          ...(pipelineSettlement
            ? [waitForBoundedTeardown(pipelineSettlement, 'HTTPS upload pipeline')]
            : []),
          waitForClose(input.body, 'HTTPS upload body'),
          ...(initialResponse ? [waitForClose(initialResponse, 'HTTPS response')] : []),
          ...(clientRequest ? [waitForClose(clientRequest, 'HTTPS request')] : []),
        ]);

        // A response or socket may be assigned immediately before request closure. Re-read both
        // only after the first phase, destroy them idempotently, and confirm the live resources.
        const lateResponse = responseStream !== initialResponse ? responseStream : undefined;
        socket ??= clientRequest?.socket ?? undefined;
        const secondPhase = await Promise.allSettled([
          ...(lateResponse
            ? [
                Promise.resolve().then(() => lateResponse.destroy()),
                waitForClose(lateResponse, 'HTTPS response'),
              ]
            : []),
          ...(socket
            ? [
                Promise.resolve().then(() => socket?.destroy()),
                waitForClose(socket, 'HTTPS socket'),
              ]
            : []),
        ]);
        const failed = [...firstPhase, ...secondPhase].find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) {
          if (failed.reason instanceof TransportTeardownUnconfirmedError) throw failed.reason;
          throw new TransportTeardownUnconfirmedError('HTTPS transport', {
            cause: failed.reason,
          });
        }
      } finally {
        input.signal.removeEventListener('abort', destroy);
        clientRequest?.removeListener('socket', captureSocket);
        if (rejectResponse) clientRequest?.removeListener('error', rejectResponse);
      }
    });
    return teardownPromise;
  };
  const destroy = () => {
    rejectForAbort?.(abortError());
    void teardown().catch(() => undefined);
  };
  input.signal.addEventListener('abort', destroy, { once: true });
  try {
    pipelinePromise = pipeline(input.body, clientRequest!, { signal: input.signal });
    if (input.signal.aborted) destroy();
    const [, response] = await Promise.race([
      Promise.all([pipelinePromise, responsePromise]),
      abortPromise,
    ]);
    const headers = new Headers();
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index];
      const value = response.rawHeaders[index + 1];
      if (name !== undefined && value !== undefined) headers.append(name, value);
    }
    const status = response.statusCode ?? 500;
    const noBody = status === 204 || status === 205 || status === 304;
    if (noBody) await teardown();
    const iterator = response[Symbol.asyncIterator]();
    const body = noBody
      ? null
      : new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await iterator.next();
              if (part.done) {
                await teardown();
                controller.close();
              } else {
                controller.enqueue(
                  Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value as Uint8Array),
                );
              }
            } catch (error) {
              try {
                await teardown();
              } catch (teardownError) {
                controller.error(teardownError);
                return;
              }
              controller.error(error);
            }
          },
          async cancel() {
            await runTeardownSteps(
              [() => iterator.return?.(), () => teardown()],
              'HTTPS response cancellation',
            );
          },
        });
    const webResponse = new Response(body, {
      status,
      headers,
    });
    pinnedResponseTeardown.set(webResponse, teardown);
    return webResponse;
  } catch (error) {
    await teardown();
    if (input.signal.aborted) throw error;
    if (error instanceof TransportTeardownUnconfirmedError) throw error;
    throw new PinnedHttpsError('UPLOAD_FAILED');
  }
}
