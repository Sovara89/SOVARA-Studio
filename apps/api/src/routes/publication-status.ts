import type { FastifyInstance } from 'fastify';
import {
  publicationStatusParamsSchema,
  retryPublicationRequestSchema,
} from '@sovara-studio/contracts';
import {
  PublicationStatusError,
  type createPublicationStatusService,
} from '../services/publication-status-service.js';
import { parseJsonBody } from '../http/parse-json-body.js';

type Service = ReturnType<typeof createPublicationStatusService>;

/** Returns only publications owned by the authenticated Studio user. */
export async function publicationStatusRoutes(
  fastify: FastifyInstance,
  options: { service: Service; appOrigin: string },
) {
  fastify.get('/publication-status', { logLevel: 'warn', preHandler: fastify.requireStudioUser }, async (request) =>
    options.service.list(request.studioAuth!.userId),
  );
  fastify.post(
    '/publication-status/:publicationId/retry',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        if (request.headers.origin !== options.appOrigin)
          throw new PublicationStatusError('CONFLICT', 'Request origin is not allowed');
        const params = publicationStatusParamsSchema.safeParse(request.params);
        if (!params.success)
          throw new PublicationStatusError('NOT_FOUND', 'Publication was not found');
        const body = parseJsonBody(request.body, retryPublicationRequestSchema);
        return reply.send(
          await options.service.retry(
            request.studioAuth!.userId,
            params.data.publicationId,
            body.revision,
          ),
        );
      } catch (error) {
        const known =
          error instanceof PublicationStatusError
            ? error
            : new PublicationStatusError('CONFLICT', 'Publication could not be retried');
        return reply
          .code(known.code === 'NOT_FOUND' ? 404 : 409)
          .send({ error: { code: known.code, message: known.message, requestId: request.id } });
      }
    },
  );
}
