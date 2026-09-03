import Fastify from 'fastify';
import type { WorkerRuntime } from './runtime';
import { environment } from './env';

export interface HealthServer {
  close: () => Promise<void>;
  address: string;
}

export function createHealthServer(runtimePromise: Promise<WorkerRuntime>) {
  const server = Fastify({ logger: true });
  let readiness: 'starting' | 'ready' | 'unavailable' = 'starting';
  void runtimePromise
    .then(
      (runtime) => {
        const withdrawReadiness = () => {
          readiness = 'unavailable';
        };
        runtime.shutdownSignal.addEventListener('abort', withdrawReadiness, { once: true });
        // Listener registration precedes the state check, so shutdown cannot win a check/use race
        // and allow readiness to be re-established afterward.
        if (runtime.shutdownSignal.aborted) withdrawReadiness();
        else readiness = 'ready';
      },
      () => {
        readiness = 'unavailable';
      },
    )
    .catch(() => {
      // Defensive observation of an unexpected readiness callback failure.
      readiness = 'unavailable';
    });

  server.get('/health', async () => {
    return { status: 'ok' };
  });

  server.get('/ready', async (_request, reply) => {
    if (readiness === 'unavailable')
      return reply.code(503).send({ status: 'dependency_unavailable' });
    if (readiness === 'starting') return reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready' };
  });

  return server;
}

export async function startHealthServer(
  runtimePromise: Promise<WorkerRuntime>,
): Promise<HealthServer> {
  const server = createHealthServer(runtimePromise);
  const address = await server.listen({ host: '0.0.0.0', port: environment.WORKER_PORT });
  let closed = false;
  return {
    address,
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}
