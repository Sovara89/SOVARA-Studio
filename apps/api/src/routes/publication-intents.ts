import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createPublicationIntentRequestSchema,
  previewCompleteRequestSchema,
  previewRemoveRequestSchema,
  previewUploadRequestSchema,
  publicationIntentParamsSchema,
  updatePublicationIntentRequestSchema,
} from '@sovara-studio/contracts';
import { parseJsonBody } from '../http/parse-json-body.js';
import {
  createPublicationIntentService,
  PublicationIntentError,
} from '../services/publication-intent-service.js';
type Service = ReturnType<typeof createPublicationIntentService>;
function origin(value: string | undefined, expected: string) {
  if (value !== expected)
    throw new PublicationIntentError('CONFLICT', 'Request origin is not allowed');
}
function params(value: unknown) {
  const parsed = publicationIntentParamsSchema.safeParse(value);
  if (!parsed.success)
    throw new PublicationIntentError('NOT_FOUND', 'Publication intent was not found');
  return parsed.data;
}
function send(reply: FastifyReply, error: unknown, requestId?: string) {
  const known =
    error instanceof PublicationIntentError
      ? error
      : new PublicationIntentError('STORAGE_UNAVAILABLE', 'Request could not be completed');
  const status =
    known.code === 'NOT_FOUND'
      ? 404
      : known.code === 'VIDEO_NOT_READY' ||
          known.code === 'ACCOUNT_NOT_AVAILABLE' ||
          known.code === 'PREVIEW_INVALID'
        ? 400
        : known.code === 'STORAGE_UNAVAILABLE'
          ? 503
          : 409;
  return reply.code(status).send({
    error: { code: known.code, message: known.message, ...(requestId ? { requestId } : {}) },
  });
}
export async function publicationIntentRoutes(
  fastify: FastifyInstance,
  options: { service: Service; appOrigin: string },
) {
  fastify.get(
    '/publication-intents',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => reply.send(await options.service.list(request.studioAuth!.userId)),
  );
  fastify.post(
    '/publication-intents',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        origin(request.headers.origin, options.appOrigin);
        const input = parseJsonBody(request.body, createPublicationIntentRequestSchema);
        return reply
          .code(201)
          .send(await options.service.create(request.studioAuth!.userId, input));
      } catch (error) {
        return send(reply, error, request.id);
      }
    },
  );
  fastify.put(
    '/publication-intents/:intentId',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        origin(request.headers.origin, options.appOrigin);
        return reply.send(
          await options.service.update(
            request.studioAuth!.userId,
            params(request.params).intentId,
            parseJsonBody(request.body, updatePublicationIntentRequestSchema),
          ),
        );
      } catch (error) {
        return send(reply, error, request.id);
      }
    },
  );
  fastify.post(
    '/publication-intents/:intentId/preview',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        origin(request.headers.origin, options.appOrigin);
        return reply.send(
          await options.service.preparePreview(
            request.studioAuth!.userId,
            params(request.params).intentId,
            parseJsonBody(request.body, previewUploadRequestSchema),
          ),
        );
      } catch (error) {
        return send(reply, error, request.id);
      }
    },
  );
  fastify.post(
    '/publication-intents/:intentId/preview/complete',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        origin(request.headers.origin, options.appOrigin);
        const body = parseJsonBody(request.body, previewCompleteRequestSchema);
        return reply.send(
          await options.service.completePreview(
            request.studioAuth!.userId,
            params(request.params).intentId,
            body.revision,
          ),
        );
      } catch (error) {
        return send(reply, error, request.id);
      }
    },
  );
  fastify.delete(
    '/publication-intents/:intentId/preview',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        origin(request.headers.origin, options.appOrigin);
        const body = parseJsonBody(request.body, previewRemoveRequestSchema);
        return reply.send(
          await options.service.removePreview(
            request.studioAuth!.userId,
            params(request.params).intentId,
            body.revision,
          ),
        );
      } catch (error) {
        return send(reply, error, request.id);
      }
    },
  );
}
