import { describe, expect, test, vi } from 'vitest';
import { createWorkerProcessLifecycle } from './process-lifecycle.js';

describe('worker process lifecycle', () => {
  test('a signal before startup is monotonic and no intake or health factory is invoked', async () => {
    const startWorker = vi.fn();
    const startHealth = vi.fn();
    const lifecycle = createWorkerProcessLifecycle({ startWorker, startHealth });

    const firstShutdown = lifecycle.shutdown(new Error('SIGTERM'));
    const secondShutdown = lifecycle.shutdown(new Error('SIGINT'));

    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    await expect(lifecycle.start()).rejects.toThrow('SIGTERM');
    expect(lifecycle.signal.aborted).toBe(true);
    expect(startWorker).not.toHaveBeenCalled();
    expect(startHealth).not.toHaveBeenCalled();
  });

  test('SIGTERM during startup prevents readiness and closes a partially started health server', async () => {
    let rejectWorker!: (error: Error) => void;
    let startupSignal: AbortSignal | undefined;
    const workerStartup = new Promise<never>((_resolve, reject) => {
      rejectWorker = reject;
    });
    const healthClose = vi.fn().mockResolvedValue(undefined);
    let ready = false;
    const lifecycle = createWorkerProcessLifecycle({
      startWorker: vi.fn((signal) => {
        startupSignal = signal;
        signal.addEventListener(
          'abort',
          () => rejectWorker(new Error('startup aborted before intake')),
          { once: true },
        );
        return workerStartup;
      }),
      startHealth: vi.fn(async (runtime) => {
        void runtime.then(
          () => {
            ready = true;
          },
          () => undefined,
        );
        return { address: 'test', close: healthClose };
      }),
    });

    const startup = lifecycle.start();
    await vi.waitFor(() => expect(startupSignal).toBeDefined());
    const shutdown = lifecycle.shutdown(new Error('SIGTERM'));

    expect(startupSignal?.aborted).toBe(true);
    await expect(startup).rejects.toThrow('startup aborted before intake');
    await expect(shutdown).rejects.toThrow('startup aborted before intake');
    expect(ready).toBe(false);
    expect(healthClose).toHaveBeenCalledOnce();
  });

  test('shutdown waits for both startup branches and disposes each fulfilled resource once', async () => {
    const events: string[] = [];
    let resolveHealth!: (value: { address: string; close: () => Promise<void> }) => void;
    const runtime = {
      redis: { ping: async () => 'PONG', quit: async () => undefined },
      shutdownSignal: new AbortController().signal,
      failure: new Promise<never>(() => undefined),
      requestShutdown: vi.fn(),
      close: vi.fn(async () => {
        events.push('worker_closed');
      }),
    };
    const startWorker = vi.fn().mockResolvedValue(runtime);
    const lifecycle = createWorkerProcessLifecycle({
      startWorker,
      startHealth: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveHealth = resolve;
          }),
      ),
    });
    const startup = lifecycle.start();
    await vi.waitFor(() => expect(startWorker).toHaveBeenCalledOnce());

    const shutdown = lifecycle.shutdown(new Error('SIGTERM'));
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    const healthClose = vi.fn(async () => {
      events.push('health_closed');
    });
    resolveHealth({ address: 'test', close: healthClose });
    await startup;
    await shutdown;
    await lifecycle.shutdown(new Error('duplicate signal'));

    expect(events).toEqual(['health_closed', 'worker_closed']);
    expect(healthClose).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  test('fully-started SIGTERM synchronously aborts processor and reconciler runtime signals', async () => {
    const processor = new AbortController();
    const reconciler = new AbortController();
    let releaseHealthClose!: () => void;
    const healthClosing = new Promise<void>((resolve) => {
      releaseHealthClose = resolve;
    });
    const requestShutdown = vi.fn((reason?: unknown) => {
      processor.abort(reason);
      reconciler.abort(reason);
    });
    const runtime = {
      redis: { ping: async () => 'PONG', quit: async () => undefined },
      shutdownSignal: processor.signal,
      failure: new Promise<never>(() => undefined),
      requestShutdown,
      close: vi.fn(async () => undefined),
    };
    const lifecycle = createWorkerProcessLifecycle({
      startWorker: vi.fn().mockResolvedValue(runtime),
      startHealth: vi.fn().mockResolvedValue({
        address: 'test',
        close: vi.fn(() => healthClosing),
      }),
    });
    await lifecycle.start();

    const reason = new Error('SIGTERM');
    const shutdown = lifecycle.shutdown(reason);

    // No timer, microtask, or shutdown await is advanced before these assertions.
    expect(requestShutdown).toHaveBeenCalledOnce();
    expect(requestShutdown).toHaveBeenCalledWith(reason);
    expect(processor.signal.aborted).toBe(true);
    expect(processor.signal.reason).toBe(reason);
    expect(reconciler.signal.aborted).toBe(true);
    expect(reconciler.signal.reason).toBe(reason);
    expect(runtime.close).not.toHaveBeenCalled();

    releaseHealthClose();
    await shutdown;
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  test('preserves startup as the primary reason and every partial cleanup failure on signal', async () => {
    const startupError = new Error('database startup failed');
    const healthCloseError = new Error('health close failed');
    const workerCleanupError = new Error('partial worker cleanup failed');
    const partialFailure = new AggregateError(
      [startupError, workerCleanupError],
      'Worker startup and cleanup failed',
    );
    const healthClose = vi.fn().mockRejectedValue(healthCloseError);
    let rejectWorker!: (error: unknown) => void;
    const lifecycle = createWorkerProcessLifecycle({
      startWorker: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectWorker = reject;
          }),
      ),
      startHealth: vi.fn().mockResolvedValue({ address: 'test', close: healthClose }),
    });

    const startup = lifecycle.start();
    await vi.waitFor(() => expect(rejectWorker).toBeTypeOf('function'));
    const shutdown = lifecycle.shutdown(new Error('SIGTERM'));
    rejectWorker(partialFailure);

    await expect(startup).rejects.toBe(partialFailure);
    const result = await shutdown.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([partialFailure, healthCloseError]);
    expect((partialFailure as AggregateError).errors).toEqual([startupError, workerCleanupError]);
    expect(healthClose).toHaveBeenCalledOnce();
    await expect(lifecycle.shutdown(new Error('SIGINT'))).rejects.toBe(result);
    expect(healthClose).toHaveBeenCalledOnce();
  });

  test('observes both independently rejected startup branches', async () => {
    const workerError = new Error('worker factory failed');
    const healthError = new Error('health factory failed');
    const lifecycle = createWorkerProcessLifecycle({
      startWorker: vi.fn().mockRejectedValue(workerError),
      startHealth: vi.fn().mockRejectedValue(healthError),
    });

    await expect(lifecycle.start()).rejects.toSatisfy((error: unknown) =>
      [workerError, healthError].includes(error as Error),
    );
    const result = await lifecycle.shutdown().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([workerError, healthError]);
  });

  test('unexpected runtime failure enters process shutdown once and reports cleanup with cause', async () => {
    const runtimeController = new AbortController();
    const runError = new Error('BullMQ run failed');
    const closeError = new Error('BullMQ close failed');
    let rejectRuntimeFailure!: (error: unknown) => void;
    const runtime = {
      redis: { ping: async () => 'PONG', quit: async () => undefined },
      shutdownSignal: runtimeController.signal,
      failure: new Promise<never>((_resolve, reject) => {
        rejectRuntimeFailure = reject;
      }),
      requestShutdown: vi.fn((reason?: unknown) => runtimeController.abort(reason)),
      close: vi.fn().mockRejectedValue(closeError),
    };
    const healthClose = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createWorkerProcessLifecycle({
      startWorker: vi.fn().mockResolvedValue(runtime),
      startHealth: vi.fn().mockResolvedValue({ address: 'test', close: healthClose }),
    });
    await lifecycle.start();

    rejectRuntimeFailure(runError);
    const result = await lifecycle.failure.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([runError, closeError]);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toBe(runError);
    expect(runtime.requestShutdown).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(healthClose).toHaveBeenCalledOnce();
    await expect(lifecycle.shutdown()).rejects.toBe(result);
  });
});
