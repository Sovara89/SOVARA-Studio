import type { HealthServer } from './health-server.js';
import type { WorkerRuntime } from './runtime.js';

export type WorkerProcessLifecycleDependencies = {
  startWorker: (signal: AbortSignal) => Promise<WorkerRuntime>;
  startHealth: (runtime: Promise<WorkerRuntime>) => Promise<HealthServer>;
};

/**
 * Coordinates startup and shutdown without allowing startup promises to become detached.
 * Signal registration intentionally belongs to the caller and can happen before start().
 */
export function createWorkerProcessLifecycle(dependencies: WorkerProcessLifecycleDependencies) {
  const controller = new AbortController();
  let workerPromise: Promise<WorkerRuntime> | undefined;
  let healthPromise: Promise<HealthServer> | undefined;
  let startupPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let workerRuntime: WorkerRuntime | undefined;
  let workerShutdownRequested = false;
  let workerShutdownFailure: unknown;
  let runtimeFailure: unknown;
  let rejectFailure!: (reason: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // Consumers should observe this (main does), but the lifecycle itself guarantees that a delayed
  // or omitted consumer can never turn a runtime failure into an unhandled rejection.
  void failure.catch(() => undefined);

  const requestWorkerShutdown = (reason: unknown) => {
    if (!workerRuntime || workerShutdownRequested) return;
    workerShutdownRequested = true;
    try {
      workerRuntime.requestShutdown(reason);
    } catch (error) {
      // A malformed runtime gate must not prevent the remaining resources from being disposed.
      workerShutdownFailure = error;
    }
  };

  const start = () => {
    if (startupPromise) return startupPromise;
    if (controller.signal.aborted) {
      startupPromise = Promise.reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Worker process startup aborted'),
      );
      // A caller may intentionally signal before start and only await shutdown. Observe this
      // rejected startup promise even if it is never requested again.
      void startupPromise.catch(() => undefined);
      return startupPromise;
    }

    // Promise.resolve().then turns synchronous factory failures into the same observed lifecycle
    // path as asynchronous startup failures.
    workerPromise = Promise.resolve()
      .then(() => dependencies.startWorker(controller.signal))
      .then((runtime) => {
        workerRuntime = runtime;
        if (controller.signal.aborted) requestWorkerShutdown(controller.signal.reason);
        void runtime.failure.catch((error: unknown) => {
          if (controller.signal.aborted || runtimeFailure !== undefined) return;
          runtimeFailure = error;
          const stopping = shutdown(error);
          void stopping.then(
            () => rejectFailure(error),
            (shutdownError: unknown) => rejectFailure(shutdownError),
          );
        });
        return runtime;
      });
    healthPromise = Promise.resolve().then(() => dependencies.startHealth(workerPromise!));
    startupPromise = Promise.all([workerPromise, healthPromise]).then(() => undefined);
    void startupPromise.catch(() => undefined);
    return startupPromise;
  };

  const shutdown = (reason: unknown = new Error('Worker process shutting down')) => {
    if (shutdownPromise) return shutdownPromise;
    controller.abort(reason);
    // For a fully-started runtime this call is synchronous and precedes the first shutdown await.
    // The lifecycle signal forwarding remains a second monotonic path for startup races.
    requestWorkerShutdown(reason);
    shutdownPromise = (async () => {
      const [workerResult, healthResult] = await Promise.all([
        workerPromise ? Promise.allSettled([workerPromise]).then(([result]) => result) : undefined,
        healthPromise ? Promise.allSettled([healthPromise]).then(([result]) => result) : undefined,
      ]);
      const failures: unknown[] = [];
      const addFailure = (failure: unknown) => {
        if (!failures.includes(failure)) failures.push(failure);
      };
      if (runtimeFailure !== undefined) addFailure(runtimeFailure);
      if (workerResult?.status === 'rejected') addFailure(workerResult.reason);
      if (healthResult?.status === 'rejected') addFailure(healthResult.reason);
      if (workerShutdownFailure !== undefined) addFailure(workerShutdownFailure);

      // Health closes before the worker so readiness/intake is withdrawn before shared teardown.
      const disposalResults = await Promise.allSettled([
        healthResult?.status === 'fulfilled' ? healthResult.value.close() : Promise.resolve(),
        workerResult?.status === 'fulfilled' ? workerResult.value.close() : Promise.resolve(),
      ]);
      for (const result of disposalResults)
        if (result.status === 'rejected') addFailure(result.reason);

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Worker process shutdown failed');
    })();
    void shutdownPromise.catch(() => undefined);
    return shutdownPromise;
  };

  return { signal: controller.signal, failure, start, shutdown };
}
