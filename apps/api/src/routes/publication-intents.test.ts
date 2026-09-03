import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { publicationIntentRoutes } from './publication-intents.js';
import { PublicationIntentError } from '../services/publication-intent-service.js';

const intentId = 'c4cf8e30-e24e-4cde-9534-a43f4b3f98e8';

describe('publication intent routes', () => {
  let server: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  test('passes a validated preview request to the authenticated user service', async () => {
    const preparePreview = vi.fn().mockResolvedValue({
      uploadUrl: 'https://storage.example/upload',
      revision: 1,
    });
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationIntentRoutes, {
      service: { preparePreview } as never,
      appOrigin: 'http://localhost:5173',
      prefix: '/api',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/publication-intents/${intentId}/preview`,
      headers: { origin: 'http://localhost:5173' },
      payload: { contentType: 'image/png', sizeBytes: 10, revision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(preparePreview).toHaveBeenCalledWith('owner-id', intentId, {
      contentType: 'image/png',
      sizeBytes: 10,
      revision: 0,
    });
  });

  test('returns a safe storage error rather than a provider error', async () => {
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationIntentRoutes, {
      service: {
        preparePreview: vi
          .fn()
          .mockRejectedValue(
            new PublicationIntentError(
              'STORAGE_UNAVAILABLE',
              'Preview upload is temporarily unavailable',
            ),
          ),
      } as never,
      appOrigin: 'http://localhost:5173',
      prefix: '/api',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/publication-intents/${intentId}/preview`,
      headers: { origin: 'http://localhost:5173' },
      payload: { contentType: 'image/png', sizeBytes: 10, revision: 0 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'STORAGE_UNAVAILABLE',
        message: 'Preview upload is temporarily unavailable',
      },
    });
  });

  test('passes a revision-CAS preview removal to the authenticated user service', async () => {
    const removePreview = vi.fn().mockResolvedValue({ id: intentId, preview: null, revision: 1 });
    server = Fastify();
    server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    server.decorateRequest('studioAuth', null);
    server.decorate('requireStudioUser', async (request) => {
      request.studioAuth = { userId: 'owner-id', sessionId: 'session-id' };
    });
    await server.register(publicationIntentRoutes, {
      service: { removePreview } as never,
      appOrigin: 'http://localhost:5173',
      prefix: '/api',
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/publication-intents/${intentId}/preview`,
      headers: { origin: 'http://localhost:5173' },
      payload: { revision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(removePreview).toHaveBeenCalledWith('owner-id', intentId, 0);
  });
});
