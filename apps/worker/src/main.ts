import { startPublicationWorker } from './runtime';
import { startHealthServer } from './health-server';
import { createWorkerProcessLifecycle } from './process-lifecycle.js';

const lifecycle = createWorkerProcessLifecycle({
  startWorker: startPublicationWorker,
  startHealth: startHealthServer,
});

const handleSignal = (signal: string) => {
  console.log(`Received ${signal}; shutting down`);
  void lifecycle.shutdown(new Error(`Received ${signal}`)).catch((err) => {
    console.error('Worker shutdown failed:', err);
    process.exitCode = 1;
  });
};

// Install handlers before invoking either startup factory. A signal can therefore close the
// monotonic gate before any BullMQ worker or readiness server is created.
process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

const startup = lifecycle.start();
void lifecycle.failure.catch((err) => {
  console.error('Worker runtime failed:', err);
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
        () => console.error('Failed to start worker:', err),
        (finalError) => console.error('Worker startup or cleanup failed:', finalError),
      )
      .finally(() => {
        process.exitCode = 1;
      });
  });
