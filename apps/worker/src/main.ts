import { startPublicationWorker } from './runtime';
import { startHealthServer } from './health-server';
import { createWorkerProcessLifecycle } from './process-lifecycle.js';
import { safeErrorFields } from '@sovara-studio/infra';

const lifecycle = createWorkerProcessLifecycle({
  startWorker: startPublicationWorker,
  startHealth: startHealthServer,
});

const handleSignal = (signal: string) => {
  console.log(`Received ${signal}; shutting down`);
  void lifecycle.shutdown(new Error(`Received ${signal}`)).catch((err) => {
    console.error(JSON.stringify({ event: 'worker_shutdown_failed', ...safeErrorFields(err) }));
    process.exitCode = 1;
  });
};

// Install handlers before invoking either startup factory. A signal can therefore close the
// monotonic gate before any BullMQ worker or readiness server is created.
process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

const startup = lifecycle.start();
void lifecycle.failure.catch((err) => {
  console.error(JSON.stringify({ event: 'worker_runtime_failed', ...safeErrorFields(err) }));
  process.exitCode = 1;
});
startup
  .then(() => {
    console.log('Worker and health server started');
  })
  .catch((err) => {
    if (lifecycle.signal.aborted) return;
    void lifecycle
      .shutdown(err)
      .then(
        () =>
          console.error(JSON.stringify({ event: 'worker_start_failed', ...safeErrorFields(err) })),
        (finalError) =>
          console.error(
            JSON.stringify({
              event: 'worker_startup_cleanup_failed',
              ...safeErrorFields(finalError),
            }),
          ),
      )
      .finally(() => {
        process.exitCode = 1;
      });
  });
