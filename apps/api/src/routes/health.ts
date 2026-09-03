import type { FastifyInstance } from 'fastify';
import type { createDatabase } from '@sovara-studio/db';
import { HealthResponseSchema } from '@sovara-studio/contracts';

export const healthRoutes = async (
  fastify: FastifyInstance,
  options: { database?: ReturnType<typeof createDatabase> } = {},
) => {
  fastify.get('/health', async () => {
    return HealthResponseSchema.parse({ status: 'ok' });
  });

  fastify.get('/ready', async (_request, reply) => {
    if (!options.database) return reply.code(503).send({ error: 'Database unavailable' });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        options.database.pool.query('select 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Database readiness timeout')), 1000);
        }),
      ]);
    } catch {
      return reply.code(503).send({ error: 'Database unavailable' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    return HealthResponseSchema.parse({ status: 'ready' });
  });
};
