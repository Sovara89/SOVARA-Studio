import { describe, expect, test, vi } from 'vitest';
import {
  createPartialPublicationStartupCleanup,
  createPublicationRuntimeTeardown,
  createWorkerRuntime,
  observePublicationWorkerRunLoop,
  startWorker,
  type WorkerDependency,
} from './runtime';
import { createHealthServer } from './health-server';

describe('Worker runtime', () => {
  test('starts with a successful dependency and closes it once', async () => {
    let quitCalls = 0;
    const redis: WorkerDependency = {
      quit: async () => {
        quitCalls += 1;
      },
      ping: async () => 'PONG',
    };
    const runtime = createWorkerRuntime(redis);
    await runtime.close();
    await runtime.close();
    expect(quitCalls).toBe(1);
  });

  test('reports not-ready before initialization and ready after successful initialization', async () => {
    let resolveRuntime!: (runtime: ReturnType<typeof createWorkerRuntime>) => void;
    const runtimePromise = new Promise<ReturnType<typeof createWorkerRuntime>>((resolve) => {
      resolveRuntime = resolve;
    });
    const server = createHealthServer(runtimePromise);

    expect((await server.inject('/ready')).statusCode).toBe(503);
    resolveRuntime(createWorkerRuntime({ ping: async () => 'PONG', quit: async () => undefined }));
    await runtimePromise;
    expect((await server.inject('/ready')).statusCode).toBe(200);
    const runtime = await runtimePromise;
    runtime.requestShutdown(new Error('runtime no longer accepting work'));
    expect((await server.inject('/ready')).statusCode).toBe(503);
    expect((await server.inject('/ready')).statusCode).toBe(503);
    await server.close();
  });

  test('reports dependency initialization failure', async () => {
    const runtimePromise = Promise.reject(new Error('redis unavailable'));
    const server = createHealthServer(runtimePromise);
    await expect(runtimePromise).rejects.toThrow('redis unavailable');
    await new Promise((resolve) => setImmediate(resolve));
    expect((await server.inject('/ready')).statusCode).toBe(503);
    await server.close();
  });

  test('startWorker pings its production Redis dependency', async () => {
    let pinged = false;
    let quitCalls = 0;
    const runtime = await startWorker(() => ({
      ping: async () => {
        pinged = true;
        return 'PONG';
      },
      quit: async () => {
        quitCalls += 1;
      },
    }));
    expect(pinged).toBe(true);
    await runtime.close();
    await runtime.close();
    expect(quitCalls).toBe(1);
  });

  test('cleans up a dependency when initialization fails', async () => {
    let quitCalls = 0;
    const dependency: WorkerDependency = {
      ping: async () => {
        throw new Error('redis unavailable');
      },
      quit: async () => {
        quitCalls += 1;
      },
    };
    await expect(startWorker(() => dependency)).rejects.toThrow('redis unavailable');
    expect(quitCalls).toBe(1);
  });

  test('partial startup cleanup is ordered, failure-tolerant, and idempotent', async () => {
    const events: string[] = [];
    const cleanup = createPartialPublicationStartupCleanup({
      closeWorker: async () => {
        events.push('worker_closed');
        throw new Error('worker close failed');
      },
      closeQueue: async () => {
        events.push('queue_closed');
      },
      closeDatabase: async () => {
        events.push('database_closed');
      },
      destroyStorage: () => {
        events.push('storage_destroyed');
      },
    });

    const first = cleanup();
    const second = cleanup();
    expect(second).toBe(first);
    const result = await first.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(AggregateError);
    expect(events).toEqual([
      'worker_closed',
      'queue_closed',
      'database_closed',
      'storage_destroyed',
    ]);
    await expect(cleanup()).rejects.toThrow('Partial worker startup cleanup failed');
    expect(events).toHaveLength(4);
  });

  test('run-loop rejection synchronously aborts active work and initiates teardown once', async () => {
    const controller = new AbortController();
    const runError = new Error('BullMQ run rejected');
    let rejectRun!: (error: Error) => void;
    const running = new Promise<void>((_resolve, reject) => {
      rejectRun = reject;
    });
    const activeProvider = new AbortController();
    controller.signal.addEventListener(
      'abort',
      () => activeProvider.abort(controller.signal.reason),
      { once: true },
    );
    const close = vi.fn(() => {
      controller.abort(runError);
      return Promise.resolve();
    });
    const failure = observePublicationWorkerRunLoop({
      run: () => running,
      shutdownSignal: controller.signal,
      close,
    });

    rejectRun(runError);
    await expect(failure).rejects.toBe(runError);
    expect(controller.signal.aborted).toBe(true);
    expect(activeProvider.signal.aborted).toBe(true);
    expect(activeProvider.signal.reason).toBe(runError);
    expect(close).toHaveBeenCalledOnce();
  });

  test('unexpected normal run-loop resolution is fatal and withdraws readiness permanently', async () => {
    const controller = new AbortController();
    let resolveRun!: () => void;
    const running = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const close = vi.fn(() => {
      controller.abort(new Error('runtime shutting down'));
      return Promise.resolve();
    });
    const runtime = {
      redis: { ping: async () => 'PONG', quit: async () => undefined },
      shutdownSignal: controller.signal,
      failure: observePublicationWorkerRunLoop({
        run: () => running,
        shutdownSignal: controller.signal,
        close,
      }),
      requestShutdown: (reason?: unknown) => controller.abort(reason),
      close,
    };
    const server = createHealthServer(Promise.resolve(runtime));
    await vi.waitFor(async () => expect((await server.inject('/ready')).statusCode).toBe(200));

    resolveRun();
    await expect(runtime.failure).rejects.toThrow('exited unexpectedly');
    expect(controller.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect((await server.inject('/ready')).statusCode).toBe(503);
    expect((await server.inject('/ready')).statusCode).toBe(503);
    await server.close();
  });

  test.each(['resolve', 'reject'] as const)(
    'run-loop %s after requested shutdown is expected and does not restart teardown',
    async (settlement) => {
      const controller = new AbortController();
      let resolveRun!: () => void;
      let rejectRun!: (error: Error) => void;
      const running = new Promise<void>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
      const close = vi.fn().mockResolvedValue(undefined);
      const failure = observePublicationWorkerRunLoop({
        run: () => running,
        shutdownSignal: controller.signal,
        close,
      });

      controller.abort(new Error('SIGTERM'));
      if (settlement === 'resolve') resolveRun();
      else rejectRun(new Error('BullMQ ended during close'));
      const observation = await Promise.race([
        failure.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
      ]);

      expect(observation).toBe('pending');
      expect(close).not.toHaveBeenCalled();
    },
  );

  test('aborts active work and awaits handler quiescence before shared-resource destruction', async () => {
    const events: string[] = [];
    let releaseHandler!: () => void;
    const handlerIdle = new Promise<void>((resolve) => {
      releaseHandler = () => {
        events.push('handler_idle');
        resolve();
      };
    });
    const teardown = createPublicationRuntimeTeardown({
      reconcilerClose: async () => {
        events.push('reconciler_closed');
      },
      pauseWorker: async () => {
        events.push('worker_paused');
      },
      closeWorker: async () => {
        events.push('worker_closed');
      },
      waitForHandlers: async () => {
        events.push('waiting_for_handlers');
        await handlerIdle;
      },
      closeQueue: async () => {
        events.push('queue_closed');
      },
      closeDatabase: async () => {
        events.push('database_closed');
      },
      destroyStorage: () => {
        events.push('storage_destroyed');
      },
      shutdownTimeoutMs: 1_000,
    });
    teardown.signal.addEventListener('abort', () => events.push('signal_aborted'), { once: true });

    const firstClose = teardown.close();
    const secondClose = teardown.close();
    expect(secondClose).toBe(firstClose);
    await vi.waitFor(() => expect(events).toContain('waiting_for_handlers'));
    expect(events).toEqual([
      'signal_aborted',
      'reconciler_closed',
      'worker_paused',
      'worker_closed',
      'waiting_for_handlers',
    ]);
    expect(events).not.toContain('storage_destroyed');

    releaseHandler();
    await firstClose;
    expect(events).toEqual([
      'signal_aborted',
      'reconciler_closed',
      'worker_paused',
      'worker_closed',
      'waiting_for_handlers',
      'handler_idle',
      'queue_closed',
      'database_closed',
      'storage_destroyed',
    ]);
  });

  test('force-closes BullMQ exactly once and independently awaits active handlers', async () => {
    const events: string[] = [];
    const closeArguments: Array<boolean | undefined> = [];
    let releaseHandler!: () => void;
    const handlerIdle = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const teardown = createPublicationRuntimeTeardown({
      reconcilerClose: async () => undefined,
      pauseWorker: async () => undefined,
      closeWorker: (force) => {
        closeArguments.push(force);
        events.push('worker_force_closed');
        return Promise.resolve();
      },
      waitForHandlers: async () => {
        events.push('waiting_for_handlers');
        await handlerIdle;
        events.push('handler_idle');
      },
      closeQueue: async () => {
        events.push('queue_closed');
      },
      closeDatabase: async () => {
        events.push('database_closed');
      },
      destroyStorage: () => {
        events.push('storage_destroyed');
      },
      shutdownTimeoutMs: 1_000,
    });

    const closing = teardown.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(events).toContain('waiting_for_handlers'));
    expect(events).toEqual(['worker_force_closed', 'waiting_for_handlers']);
    expect(closeArguments).toEqual([true]);
    expect(events).not.toContain('storage_destroyed');

    releaseHandler();
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual([
      'worker_force_closed',
      'waiting_for_handlers',
      'handler_idle',
      'queue_closed',
      'database_closed',
      'storage_destroyed',
    ]);
  });

  test('does not detach BullMQ cached close after timeout and observes a late rejection', async () => {
    vi.useFakeTimers();
    try {
      const closeArguments: Array<boolean | undefined> = [];
      const events: string[] = [];
      let rejectClose!: (error: Error) => void;
      const cachedClosing = new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
      });
      const teardown = createPublicationRuntimeTeardown({
        reconcilerClose: async () => undefined,
        pauseWorker: async () => undefined,
        closeWorker: (force) => {
          closeArguments.push(force);
          // BullMQ 5.81 caches and returns the first Worker.close(force) promise.
          return cachedClosing;
        },
        waitForHandlers: async () => undefined,
        closeQueue: async () => {
          events.push('queue_closed');
        },
        closeDatabase: async () => {
          events.push('database_closed');
        },
        destroyStorage: () => {
          events.push('storage_destroyed');
        },
        shutdownTimeoutMs: 10,
      });

      let settled = false;
      const closing = teardown.close().then(
        () => undefined,
        (error: unknown) => error,
      );
      void closing.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(settled).toBe(false);
      expect(closeArguments).toEqual([true]);
      expect(events).toEqual([]);

      rejectClose(new Error('late BullMQ close rejection'));
      const result = await closing;
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'Worker force-close timed out' }),
        expect.objectContaining({ message: 'late BullMQ close rejection' }),
      ]);
      expect(events).toEqual(['queue_closed', 'database_closed', 'storage_destroyed']);
    } finally {
      vi.useRealTimers();
    }
  });
});
