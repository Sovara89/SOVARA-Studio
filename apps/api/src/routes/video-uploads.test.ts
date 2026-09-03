import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { videoUploadRoutes } from './video-uploads.js';
import type { createMultipartUploadService } from '../services/multipart-upload-service.js';

const uploadResponse = {
  videoId: '4c4f8e30-e24e-4cde-9534-a43f4b3f98e8',
  upload: {
    uploadId: '6fb4dc69-1981-47ef-9d4b-f0f7dd8b2f3a',
    state: 'active' as const,
    expectedSizeBytes: 100,
    partSizeBytes: 5 * 1024 * 1024,
    expectedPartCount: 1,
    expiresAt: '2026-01-02T00:00:00.000Z',
    revision: 0,
    maxConcurrency: 6,
  },
};

describe('video upload routes', () => {
  let server: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  test('requires an authenticated Studio-origin request for creation', async () => {
    const create = vi.fn().mockResolvedValue(uploadResponse);
    const uploadService = { create } as unknown as ReturnType<typeof createMultipartUploadService>;
    server = Fastify({ logger: false });
    server.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(videoUploadRoutes, {
      uploadService,
      appOrigin: 'http://localhost:5173',
      prefix: '/api',
    });
    await server.ready();

    const response = await server.inject({
      method: 'POST',
      url: '/api/videos',
      headers: { origin: 'http://localhost:5173' },
      payload: {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 100,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith('owner-id', {
      originalFilename: 'source.mp4',
      contentType: 'video/mp4',
      expectedSizeBytes: 100,
    });

    const wrongOrigin = await server.inject({
      method: 'POST',
      url: '/api/videos',
      headers: { origin: 'http://attacker.example' },
      payload: {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 100,
      },
    });
    expect(wrongOrigin.statusCode).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('does not allow unauthenticated creation', async () => {
    const uploadService = { create: vi.fn() } as unknown as ReturnType<
      typeof createMultipartUploadService
    >;
    server = Fastify({ logger: false });
    server.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded'],
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request, reply) => {
      if (!request.studioAuth) return reply.code(401).send({ error: 'Unauthorized' });
    });
    await server.register(videoUploadRoutes, {
      uploadService,
      appOrigin: 'http://localhost:5173',
      prefix: '/api',
    });
    await server.ready();
    const response = await server.inject({
      method: 'POST',
      url: '/api/videos',
      headers: { origin: 'http://localhost:5173' },
      payload: {
        originalFilename: 'source.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 100,
      },
    });
    expect(response.statusCode).toBe(401);
  });
});
