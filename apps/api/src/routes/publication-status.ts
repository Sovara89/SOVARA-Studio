import type { FastifyInstance } from 'fastify';
import type { createPublicationStatusService } from '../services/publication-status-service.js';

type Service = ReturnType<typeof createPublicationStatusService>;

/** Returns only publications owned by the authenticated Studio user. */
export async function publicationStatusRoutes(
  fastify: FastifyInstance,
  options: { service: Service },
) {
  fastify.get('/publication-status', { preHandler: fastify.requireStudioUser }, async (request) =>
    options.service.list(request.studioAuth!.userId),
  );
}
