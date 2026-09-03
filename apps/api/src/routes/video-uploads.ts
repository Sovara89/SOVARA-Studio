import type { FastifyInstance } from 'fastify';
import {
  abortUploadRequestSchema,
  completeUploadRequestSchema,
  createVideoUploadRequestSchema,
  partNumberParamsSchema,
  partUrlRequestSchema,
  recordUploadPartRequestSchema,
  videoUploadParamsSchema,
} from '@sovara-studio/contracts';
import type { createMultipartUploadService } from '../services/multipart-upload-service.js';
import { parseJsonBody } from '../http/parse-json-body.js';
import { UploadError, sendUploadError } from '../upload-errors.js';

type UploadService = ReturnType<typeof createMultipartUploadService>;

function authenticatedUserId(request: { studioAuth: { userId: string } | null }) {
  if (!request.studioAuth) throw new UploadError('UNAUTHORIZED', 'Authentication is required');
  return request.studioAuth.userId;
}

function requireOrigin(origin: string | undefined, appOrigin: string) {
  if (origin !== appOrigin) throw new UploadError('UNAUTHORIZED', 'Request origin is not allowed');
}

function parseParams<T>(
  params: unknown,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
) {
  const parsed = schema.safeParse(params);
  if (!parsed.success || !parsed.data)
    throw new UploadError('INVALID_REQUEST', 'Route parameters are invalid');
  return parsed.data;
}

export async function videoUploadRoutes(
  fastify: FastifyInstance,
  options: { uploadService: UploadService; appOrigin: string },
) {
  const { uploadService } = options;

  fastify.post('/videos', { preHandler: fastify.requireStudioUser }, async (request, reply) => {
    try {
      requireOrigin(request.headers.origin, options.appOrigin);
      const response = await uploadService.create(
        authenticatedUserId(request),
        parseJsonBody(request.body, createVideoUploadRequestSchema),
      );
      return reply.code(201).send(response);
    } catch (error) {
      return sendUploadError(reply, error, request.id);
    }
  });

  fastify.post(
    '/videos/:videoId/uploads/:uploadId/part-urls',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = parseParams(request.params, videoUploadParamsSchema);
        const response = await uploadService.signParts(
          authenticatedUserId(request),
          params.videoId,
          params.uploadId,
          parseJsonBody(request.body, partUrlRequestSchema),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return sendUploadError(reply, error, request.id);
      }
    },
  );

  fastify.put(
    '/videos/:videoId/uploads/:uploadId/parts/:partNumber',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = parseParams(request.params, partNumberParamsSchema);
        const response = await uploadService.recordPart(
          authenticatedUserId(request),
          params.videoId,
          params.uploadId,
          params.partNumber,
          parseJsonBody(request.body, recordUploadPartRequestSchema),
        );
        return reply.code(200).send(response);
      } catch (error) {
        return sendUploadError(reply, error, request.id);
      }
    },
  );

  fastify.get(
    '/videos/:videoId/uploads/:uploadId',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        const params = parseParams(request.params, videoUploadParamsSchema);
        return reply
          .code(200)
          .send(
            await uploadService.status(
              authenticatedUserId(request),
              params.videoId,
              params.uploadId,
            ),
          );
      } catch (error) {
        return sendUploadError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    '/videos/:videoId/uploads/:uploadId/abort',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = parseParams(request.params, videoUploadParamsSchema);
        return reply
          .code(200)
          .send(
            await uploadService.abort(
              authenticatedUserId(request),
              params.videoId,
              params.uploadId,
              parseJsonBody(request.body, abortUploadRequestSchema),
            ),
          );
      } catch (error) {
        return sendUploadError(reply, error, request.id);
      }
    },
  );

  fastify.post(
    '/videos/:videoId/uploads/:uploadId/complete',
    { preHandler: fastify.requireStudioUser },
    async (request, reply) => {
      try {
        requireOrigin(request.headers.origin, options.appOrigin);
        const params = parseParams(request.params, videoUploadParamsSchema);
        return reply
          .code(200)
          .send(
            await uploadService.complete(
              authenticatedUserId(request),
              params.videoId,
              params.uploadId,
              parseJsonBody(request.body, completeUploadRequestSchema),
            ),
          );
      } catch (error) {
        return sendUploadError(reply, error, request.id);
      }
    },
  );
}
